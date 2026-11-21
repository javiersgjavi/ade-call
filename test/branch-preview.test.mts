import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, statSync, existsSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import http from 'node:http';
import { once } from 'node:events';
import { parseEnvironment, parsePort, slug, status, unitName } from '../skills/branch-preview/preview.mjs';

// skills/branch-preview: pure parts here, then preview.sh end to end on a
// temporary clone of this repository (its origin is this checkout, never a
// real remote), supervised with nohup instead of systemd, with an invented
// installed configuration. Nothing reaches OpenAI or an ADE.
const script = resolve('skills/branch-preview/preview.sh');

test('preview names, systemd environments and ports are parsed strictly', () => {
  assert.equal(slug('feat/Custom instructions'), 'feat-custom-instructions');
  assert.equal(slug('pr/12'), 'pr-12');
  assert.throws(() => slug('///'), /No usable name/);
  const environment = parseEnvironment('PATH=/usr/bin "ADE_CALL_CONFIG=/home/o w/.config/ade call" T3_BIN=/x "Q=say \\"hi\\""');
  assert.equal(environment.get('ADE_CALL_CONFIG'), '/home/o w/.config/ade call', 'a quoted value keeps its spaces');
  assert.equal(environment.get('PATH'), '/usr/bin'); assert.equal(environment.get('Q'), 'say "hi"');
  assert.match(unitName('main', '/a/previews/main'), /^ade-call-preview-main-[0-9a-f]{8}\.service$/);
  assert.notEqual(unitName('main', '/a/previews/main'), unitName('main', '/b/previews/main'), 'one ref under two roots: two units');
  assert.equal(parsePort('18800'), 18800);
  for (const bad of ['0', '65536', '12a', '-1', '', '1e3']) assert.throws(() => parsePort(bad), /not a number from 1 to 65535/, bad);
});

test('a preview is idle only when its own authenticated status says so', async t => {
  let reply: (res: http.ServerResponse) => void = () => {};
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== 'Bearer right') { res.writeHead(401).end('{"error":"x"}'); return; }
    reply(res);
  }).listen(0, '127.0.0.1');
  await once(server, 'listening'); t.after(() => server.close());
  const port = (server.address() as { port: number }).port;
  const answer = (body: string) => { reply = res => res.writeHead(200, { 'Content-Type': 'application/json' }).end(body); };
  answer('{"serviceBusy":false}'); assert.equal(await status(port, 'right'), 'idle');
  answer('{"serviceBusy":true}'); assert.equal(await status(port, 'right'), 'busy');
  assert.equal(await status(port, 'wrong'), 'unknown', 'unauthorized');
  answer('{}'); assert.equal(await status(port, 'right'), 'unknown', 'no serviceBusy');
  answer('not json'); assert.equal(await status(port, 'right'), 'unknown', 'malformed');
  reply = () => {}; assert.equal(await status(port, 'right', 300), 'unknown', 'no answer in time');
});

test('a systemd preview is never deleted when systemd cannot be asked or cannot stop it', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ade-preview-systemd-'));
  try {
    const bin = join(tmp, 'bin'), root = join(tmp, 'previews'), dir = join(root, 'main');
    mkdirSync(bin, { recursive: true }); mkdirSync(join(dir, 'checkout'), { recursive: true });
    // A preview as start would leave it, run by a simulated systemd.
    writeFileSync(join(dir, 'preview.json'), JSON.stringify({ kind: 'ade-call-preview', ref: 'main', port: 28950, unit: unitName('main', dir), supervisor: 'systemd' }));
    writeFileSync(join(bin, 'systemd-run'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    // FAKE_SYSTEMD: broken (no answer), stopfails, afterstop (no answer once stopped), stillactive.
    writeFileSync(join(bin, 'systemctl'), `#!/bin/sh
case "$2" in
  show-environment) exit 0 ;;
  show)
    if [ "$FAKE_SYSTEMD" = broken ] || { [ "$FAKE_SYSTEMD" = afterstop ] && [ -e "$FAKE_STATE" ]; }; then echo 'Failed to connect to bus' >&2; exit 1; fi
    case " $* " in *" Environment "*|*" ExecStart "*) exit 0 ;; esac
    printf 'LoadState=loaded\\nActiveState=active\\nWorkingDirectory=%s\\n' "$FAKE_CHECKOUT" ;;
  stop) if [ "$FAKE_SYSTEMD" = stopfails ]; then echo 'Job failed' >&2; exit 1; fi; touch "$FAKE_STATE" ;;
  *) exit 0 ;;
esac
`, { mode: 0o755 });
    const run = (mode: string, ...args: string[]) => { rmSync(join(tmp, 'stopped'), { force: true }); return spawnSync('bash', [script, ...args], { encoding: 'utf8',
      env: { ...process.env, ADE_CALL_SOURCE_CONFIG: '', PATH: `${bin}:${process.env.PATH}`, NODE_BIN: process.execPath, ADE_CALL_PREVIEW_ROOT: root, ADE_CALL_SERVICE: 'none.service', FAKE_SYSTEMD: mode, FAKE_CHECKOUT: join(dir, 'checkout'), FAKE_STATE: join(tmp, 'stopped') } }); };
    for (const [mode, message] of [['broken', /systemd could not be asked/], ['stopfails', /could not be stopped: Job failed\. Nothing was deleted/],
      ['afterstop', /systemd could not be asked/], ['stillactive', /still active after stopping it\. Nothing was deleted/]] as const) {
      const result = run(mode, 'stop', 'main', '--force');
      assert.equal(result.status, 1, mode); assert.match(result.stderr, message, mode);
      assert.ok(existsSync(join(dir, 'preview.json')), `kept: ${mode}`);
    }
    assert.match(run('broken', 'list').stdout, /^main\s+unknown/m);
    assert.match(run('stillactive', 'list').stdout, /^main\s+running/m);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

// A new connection per request: the preview restarts, so a kept-alive socket would be stale.
function request(url: string, { method = 'GET', headers = {}, body }: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<{ status: number; cookie: string; text: string }>((resolve, reject) => {
    const req = http.request(url, { method, headers, agent: false }, res => {
      let text = ''; res.setEncoding('utf8').on('data', chunk => { text += chunk; }).on('end', () => resolve({ status: res.statusCode!, cookie: String(res.headers['set-cookie']?.[0] || '').split(';')[0], text }));
    });
    req.on('error', reject); req.end(body);
  });
}

test('a branch preview runs beside the service with its own copy of the key, updates in place and is deleted on stop', { timeout: 240_000 }, async t => {
  const tmp = mkdtempSync(join(tmpdir(), 'ade-preview-'));
  // The installed service as its systemd unit describes it (a simulated
  // systemctl): a configuration folder with a space, and the first port of the
  // preview range. Previews still run with nohup.
  const root = join(tmp, 'previews'), source = join(tmp, 'installed config'), repo = join(tmp, 'repo'), bin = join(tmp, 'bin');
  mkdirSync(source, { recursive: true }); mkdirSync(bin);
  writeFileSync(join(bin, 'systemctl'), `#!/bin/sh
case "$2 $5" in
  "show Environment") printf '%s\\n' '"ADE_CALL_CONFIG=${source}" PORT=28800 "T3CODE_HOME=${join(tmp, 't3')}"' ;;
  "show-environment "*) exit 1 ;;
  *) exit 0 ;;
esac
`, { mode: 0o755 });
  // This checkout may be shallow (CI fetches one commit): the history the test
  // needs is made here. The clone gets a second commit, and its origin becomes
  // a temporary bare copy whose HEAD is that commit.
  execFileSync('git', ['clone', '--quiet', process.cwd(), repo]);
  symlinkSync(realpathSync('node_modules'), join(repo, 'node_modules'));
  const repoGit = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { encoding: 'utf8' }).trim();
  repoGit('commit', '--quiet', '--allow-empty', '-m', 'Test commit');
  execFileSync('git', ['clone', '--quiet', '--bare', repo, join(tmp, 'origin.git')]);
  repoGit('remote', 'set-url', 'origin', join(tmp, 'origin.git'));
  repoGit('branch', 'preview-test'); repoGit('branch', 'preview/test'); repoGit('branch', 'other-name');
  // A branch one commit behind origin's HEAD: a fetch refspec HEAD:topic would fast-forward it.
  repoGit('branch', 'topic', 'HEAD~1');
  const other = join(tmp, 'other-clone');
  execFileSync('git', ['clone', '--quiet', process.cwd(), other]);
  // The installed configuration: only the key, realtime* and customInstructions may be copied.
  writeFileSync(join(source, 'config.json'), JSON.stringify({ openaiKey: 'sk-test-preview-0123456789abcdef', realtimeModel: 'gpt-realtime-2.1-mini', customInstructions: 'Be complete.', geminiKey: 'not-copied' }), { mode: 0o600 });
  // ADE_CALL_SOURCE_CONFIG emptied: an override in the caller's environment must
  // never make the test copy a real configuration.
  const env = { ...process.env, ADE_CALL_SOURCE_CONFIG: '', PATH: `${bin}:${process.env.PATH}`, ADE_CALL_SERVICE: 'simulated.service', ADE_CALL_PREVIEW_ROOT: root, ADE_CALL_PREVIEW_REPO: repo, ADE_CALL_PREVIEW_SUPERVISOR: 'nohup',
    ADE_CALL_PREVIEW_FIRST_PORT: '28800', ADE_CALL_PREVIEW_LAST_PORT: '28899', NODE_BIN: process.execPath, OPENAI_API_KEY: 'sk-test-from-environment-0123456789',
    T3CODE_HOME: join(tmp, 't3'), T3_BIN: join(tmp, 'missing-t3'), ORCA_BIN: join(tmp, 'missing-orca') };
  const run = (...args: string[]) => spawnSync('bash', [script, ...args], { env, encoding: 'utf8' });
  const meta = () => JSON.parse(readFileSync(join(root, 'preview-test', 'preview.json'), 'utf8')) as { port: number; process?: { pid: number; start: string } };
  let serverPid = 0;
  t.after(() => { run('stop', 'preview-test', '--force'); run('stop', 'head-1', '--force'); run('stop', 'origin-remote-only', '--force'); if (serverPid) try { process.kill(serverPid, 'SIGKILL'); } catch { /* Gone. */ } rmSync(tmp, { recursive: true, force: true }); });

  // A port that is taken refuses before creating anything, so the same ref can be retried.
  const blocker = http.createServer().listen(0, '127.0.0.1'); await once(blocker, 'listening');
  const blocked = run('start', 'preview-test', '--port', String((blocker.address() as { port: number }).port));
  blocker.close();
  assert.match(blocked.stderr, /already in use/);
  assert.equal(existsSync(join(root, 'preview-test')), false, 'nothing left behind');

  const started = run('start', 'preview-test');
  assert.equal(started.status, 0, started.stderr + started.stdout);
  const link = started.stdout.match(/http:\/\/localhost:(\d+)\/#pair=([0-9A-F]{6}(?:-[0-9A-F]{6}){3})/);
  assert.ok(link, started.stdout);
  const [, port, code] = link;
  assert.ok(Number(port) > 28800 && Number(port) <= 28899, 'the installed service\'s port is never taken');
  assert.match(started.stdout, /press "Pair browser" once/);
  assert.match(started.stdout, /has the installed OpenAI key/);
  assert.ok(!(started.stdout + started.stderr).includes('sk-test-'), 'no key is ever printed');

  // Its own files, private, with only the fields it needs.
  const dir = join(root, 'preview-test');
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'config', 'config.json'), 'utf8')),
    { realtimeModel: 'gpt-realtime-2.1-mini', customInstructions: 'Be complete.', openaiKey: 'sk-test-preview-0123456789abcdef' });
  assert.equal(statSync(join(dir, 'config', 'config.json')).mode & 0o777, 0o600);
  for (const path of [root, dir, join(dir, 'config'), join(dir, 'state')]) assert.equal(statSync(path).mode & 0o777, 0o700, path);
  assert.equal(execFileSync('git', ['-C', join(dir, 'checkout'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), repoGit('rev-parse', 'preview-test'));

  // The link's code pairs a browser once, at the preview's address.
  const base = `http://localhost:${port}`;
  assert.equal((await request(`${base}/api/status`)).status, 401, 'authentication stays on');
  const pair = { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ code }) };
  const paired = await request(`${base}/api/pair`, pair);
  assert.equal(paired.status, 200, paired.text);
  const cookie = paired.cookie, voiceReady = async () => (JSON.parse((await request(`${base}/api/status`, { headers: { Cookie: cookie } })).text) as { voiceReady: boolean }).voiceReady;
  assert.equal(await voiceReady(), true, 'the copied key is used');
  assert.equal((await request(`${base}/api/pair`, pair)).status, 401, 'single use');

  assert.match(run('list').stdout, new RegExp(`^preview-test\\s+running\\s+http://localhost:${port}\\s+preview-test at [0-9a-f]{7}`, 'm'));
  const relinked = run('link', 'preview-test');
  assert.match(relinked.stdout, new RegExp(`http://localhost:${port}/#pair=`)); assert.ok(!relinked.stdout.includes(code), 'a new code');

  // A new commit on the branch: start moves the preview to it on the same port,
  // keeps its pairings, and --no-key leaves calls off even with a key in the environment.
  repoGit('checkout', '--quiet', 'preview-test'); repoGit('commit', '--quiet', '--allow-empty', '-m', 'Second commit');
  const updated = run('start', 'preview-test', '--no-key');
  assert.equal(updated.status, 0, updated.stderr);
  assert.match(updated.stdout, new RegExp(`on http://localhost:${port}\\b`));
  assert.equal(execFileSync('git', ['-C', join(dir, 'checkout'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), repoGit('rev-parse', 'preview-test'));
  assert.equal(await voiceReady(), false, 'no key: no calls, the paired browser still in');
  assert.equal('openaiKey' in JSON.parse(readFileSync(join(dir, 'config', 'config.json'), 'utf8')), false);
  assert.match(run('logs', 'preview-test').stdout, /ADE Call ready/);

  // Refusals that change nothing.
  assert.match(run('start', 'preview-test', '--port', String(Number(port) + 1)).stderr, /already uses port/);
  assert.match(run('start', 'preview/test').stderr, /belongs to the preview of 'preview-test'/, 'two refs, one name');
  mkdirSync(join(root, 'other-name')); writeFileSync(join(root, 'other-name', 'keep.txt'), 'owner file');
  assert.match(run('start', 'other-name').stderr, /already exists and is not a preview/);
  assert.equal(readFileSync(join(root, 'other-name', 'keep.txt'), 'utf8'), 'owner file', 'a folder it did not create is never touched');
  assert.match(run('start', 'no-such-branch-for-preview').stderr, /origin could not be fetched or does not have it/);
  // A branch only origin has, cached here from an earlier fetch: with origin
  // unreachable it is refused, never previewed from the old cached copy.
  execFileSync('git', ['--git-dir', join(tmp, 'origin.git'), 'branch', 'remote-only', 'HEAD']);
  repoGit('fetch', '--quiet', 'origin', '+refs/heads/remote-only:refs/remotes/origin/remote-only');
  repoGit('remote', 'set-url', 'origin', join(tmp, 'unreachable.git'));
  assert.match(run('start', 'remote-only').stderr, /origin could not be fetched or does not have it/);
  repoGit('remote', 'set-url', 'origin', join(tmp, 'origin.git'));
  // origin/BRANCH is origin's branch now: after origin advances, the new commit;
  // with origin unreachable, a refusal that leaves the running preview alone.
  const originGit = (...args: string[]) => execFileSync('git', ['--git-dir', join(tmp, 'origin.git'), '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { encoding: 'utf8' }).trim();
  const advanced = originGit('commit-tree', 'remote-only^{tree}', '-p', 'remote-only', '-m', 'Advanced on origin');
  originGit('update-ref', 'refs/heads/remote-only', advanced);
  const qualified = run('start', 'origin/remote-only');
  assert.equal(qualified.status, 0, qualified.stderr);
  assert.equal(execFileSync('git', ['-C', join(root, 'origin-remote-only', 'checkout'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), advanced, 'not the cached copy');
  repoGit('remote', 'set-url', 'origin', join(tmp, 'unreachable.git'));
  assert.match(run('start', 'origin/remote-only').stderr, /origin could not be fetched or has no branch 'remote-only'/);
  assert.match(run('list').stdout, /^origin-remote-only\s+running/m, 'still running');
  repoGit('remote', 'set-url', 'origin', join(tmp, 'origin.git'));
  assert.equal(run('stop', 'origin-remote-only').status, 0);
  const topic = repoGit('rev-parse', 'topic');
  assert.match(run('start', 'HEAD:topic').stderr, /No branch, commit or pull request called 'HEAD:topic'/);
  assert.equal(repoGit('rev-parse', 'topic'), topic, 'a rejected ref never moves a local branch');
  assert.equal(existsSync(join(root, 'no-such-branch-for-preview')), false);
  assert.match(run('start', 'other', '--port', '0').stderr, /not a number from 1 to 65535/);
  assert.match(run('start', 'HEAD', '--port', '28800').stderr, /Port 28800 is the installed service's/);
  assert.match(run('link', 'missing').stderr, /no preview called 'missing'/);
  assert.equal(run('frobnicate').status, 1);

  // When it cannot be asked whether it is busy, stopping needs --force.
  const tokenFile = join(dir, 'config', 'access-token'), realToken = readFileSync(tokenFile, 'utf8');
  writeFileSync(tokenFile, 'wrong');
  assert.match(run('stop', 'preview-test').stderr, /could not be asked whether it is busy/);
  assert.ok(existsSync(dir), 'still there');
  writeFileSync(tokenFile, realToken);

  // A recorded PID whose start time does not match is not the preview's: never signaled.
  const recorded = meta(); serverPid = recorded.process!.pid;
  writeFileSync(join(dir, 'preview.json'), JSON.stringify({ ...recorded, process: { ...recorded.process, pid: process.pid } }));
  assert.match(run('list').stdout, /^preview-test\s+stopped/m, 'a PID it cannot prove is its own counts as stopped');
  writeFileSync(join(dir, 'preview.json'), JSON.stringify(recorded));

  // A relative ref means the same on every start: it resolves in the checkout it came from.
  const relative = run('start', 'HEAD~1'), again = run('start', 'HEAD~1');
  assert.equal(relative.status, 0, relative.stderr); assert.equal(again.status, 0, again.stderr);
  assert.equal(execFileSync('git', ['-C', join(root, 'head-1', 'checkout'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), repoGit('rev-parse', 'HEAD~1'));
  assert.equal(run('stop', 'head-1').status, 0);

  // Stop, run from another clone: the worktree is removed from the repository
  // that owns it, then the process, the copied key and its pairings are gone.
  const stopped = spawnSync('bash', [script, 'stop', 'preview-test'], { env: { ...env, ADE_CALL_PREVIEW_REPO: other }, encoding: 'utf8' });
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.equal(existsSync(dir), false);
  assert.ok(!repoGit('worktree', 'list').includes(root), 'worktree removed');
  await assert.rejects(request(`${base}/`), 'the server stopped');
  assert.throws(() => process.kill(serverPid, 0), 'its process ended'); serverPid = 0;
  assert.match(run('list').stdout, /^No previews\.$/m);
});
