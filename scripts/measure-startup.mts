// Isolated HTTP benchmark: simulated CLI by default, opt-in read-only local T3.
// Never uses personal ADE Call state, providers or a browser.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, renameSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { DatabaseSync } from 'node:sqlite';

export async function startupHarness({ root = process.cwd(), delay = 600, real = false } = {}) {
  const temp = mkdtempSync(join(tmpdir(), 't3-startup-'));
  const socket = net.createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = (socket.address() as net.AddressInfo).port; await new Promise(resolve => socket.close(resolve));
  const cli = join(temp, 'cli.mjs'), calls = join(temp, 'calls'), failure = join(temp, 'failure');
  writeFileSync(cli, `#!${process.execPath}
import fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(calls)}, process.argv.slice(2,4).join(' ')+'\\n');
setTimeout(() => {
  if (fs.existsSync(${JSON.stringify(failure)})) process.exit(1);
  console.log(JSON.stringify(process.argv[2] === 'thread' ? [] : {ok:true,result:{repos:[],worktrees:[],terminals:[]}}));
}, ${delay});
`, { mode: 0o700 });
  mkdirSync(join(temp, 't3/userdata'), { recursive: true });
  const db = new DatabaseSync(join(temp, 't3/userdata/statev2.sqlite'));
  db.exec(`CREATE TABLE projection_projects(project_id,title,workspace_root,deleted_at,archived_at);
    INSERT INTO projection_projects VALUES('project','Demo',NULL,NULL,NULL);
    CREATE TABLE orchestration_v2_projection_threads(thread_id,project_id,title,archived_at,deleted_at,payload_json);`);
  db.close();
  const child = spawn(process.execPath, ['dist/src/server.mjs'], { cwd: root, env: { ...process.env,
    PORT: String(port), ADE_CALL_STATE: join(temp, 'state'), ADE_CALL_CONFIG: join(temp, 'config'),
    T3CODE_HOME: join(temp, 't3'), T3_BIN: cli, ORCA_BIN: cli,
    ...(real ? { T3CODE_HOME: process.env.T3CODE_HOME || join(homedir(), '.t3'), T3_BIN: process.env.T3_BIN || (existsSync(join(homedir(), '.local/bin/t3')) ? join(homedir(), '.local/bin/t3') : 't3') } : {}),
    OPENAI_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.resume();
  const close = async () => { if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; } rmSync(temp, { recursive: true, force: true }); };
  try {
    await Promise.race([once(child.stdout, 'data'), new Promise((_, reject) => setTimeout(() => reject(new Error('Server startup timed out')), 5000).unref())]);
    const token = readFileSync(join(temp, 'config/access-token'), 'utf8').trim();
    return { close, count: () => { try { return readFileSync(calls, 'utf8').trim().split('\n').length; } catch { return 0; } },
      unavailable: (value: boolean) => { const path = join(temp, 't3/userdata/statev2.sqlite'); renameSync(value ? path : path + '.off', value ? path + '.off' : path); },
      fail: (value: boolean) => value ? writeFileSync(failure, '') : rmSync(failure, { force: true }),
      request: async (path: string, { auth = true, origin }: { auth?: boolean; origin?: string } = {}) => {
        const start = performance.now();
        const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { ...(auth ? { Authorization: `Bearer ${token}` } : {}), ...(origin ? { Origin: origin } : {}) } });
        return { code: response.status, data: await response.json(), ms: Math.round(performance.now() - start) };
      } };
  } catch (error) { await close(); throw error; }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const real = process.argv.includes('--real');
  const harness = await startupHarness({ root: resolve(process.argv.slice(2).find(arg => !arg.startsWith('--')) || '.'), real });
  try {
    const start = performance.now();
    const status = await harness.request('/api/status');
    let projects, context;
    if (process.argv.includes('--sequential')) {
      projects = await harness.request('/api/projects'); context = await harness.request('/api/context');
    } else [projects, context] = await Promise.all([harness.request('/api/projects'), harness.request('/api/context')]);
    if ([status, projects, context].some(result => result.code !== 200) || context.data.status === 'stale')
      throw new Error('Discovery failed; do not interpret this run as a successful load.');
    console.log(JSON.stringify({ projectDiscovery: projects.data.discovery?.complete === false ? 'partial' : 'complete', contextState: context.data.status, simulation: !real, cliDelayMs: real ? null : 600, statusMs: status.ms, projectsMs: projects.ms, contextMs: context.ms,
      totalMs: Math.round(performance.now() - start), cliCalls: real ? null : harness.count() }));
  } finally { await harness.close(); }
}
