// Branch previews of ADE Call: each preview is one branch, PR or commit in its
// own Git worktree, built and run on 127.0.0.1 with its own configuration and
// state, next to the installed service and never instead of it. Run through
// preview.sh, which picks Node 24 and serializes the commands that change
// previews. See SKILL.md.
import { spawn, spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const USAGE = `Usage: preview.sh COMMAND
  start REF [--port N] [--no-key | --key] [--force]
        Create a preview of REF (a branch, a commit, or pr/N for GitHub pull
        request N), or move an existing one to REF's newest commit and restart it.
        Prints an opening link: open it, then press "Pair browser" once.
  link NAME        A new single-use opening link (10 minutes).
  list             Previews, whether they run, address, ref and commit.
  logs NAME        The last lines of its server log.
  stop NAME [--force]
        Stop it and delete its worktree, key copy, state and pairings.
--force restarts or stops a preview even while a call runs or when it cannot be asked.`;

export class PreviewError extends Error {}
const fail = (message: string): never => { throw new PreviewError(message); };

// --- Small helpers -------------------------------------------------------------
interface Result { status: number | null; stdout: string; stderr: string }
function exec(command: string, args: string[], options: SpawnSyncOptions = {}): Result {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error && (result.error as NodeJS.ErrnoException).code !== 'ENOENT') throw result.error;
  return { status: result.error ? 127 : result.status, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
}
function must(command: string, args: string[], options: SpawnSyncOptions = {}) {
  const result = exec(command, args, options);
  if (result.status !== 0) fail(`${command} ${args[0] ?? ''} failed: ${(result.stderr || result.stdout).trim().split('\n').slice(-3).join(' ')}`);
  return result.stdout.trim();
}
const git = (cwd: string, ...args: string[]) => exec('git', ['-C', cwd, ...args]);

/** "feat/Custom instructions" -> "feat-custom-instructions" */
export function slug(ref: string) {
  const name = ref.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return name || fail(`No usable name in '${ref}'.`);
}

/** Values of systemctl show --value Environment: space separated, quoted when needed. */
export function parseEnvironment(text: string) {
  const env = new Map<string, string>();
  for (const match of text.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)) {
    const item = match[1] !== undefined ? match[1].replace(/\\(.)/g, '$1') : match[2];
    const equals = item.indexOf('=');
    if (equals > 0) env.set(item.slice(0, equals), item.slice(equals + 1));
  }
  return env;
}

export function parsePort(value: string) {
  const port = Number(value);
  return /^\d+$/.test(value) && port >= 1 && port <= 65535 ? port : fail(`Port '${value}' is not a number from 1 to 65535.`);
}

const free = (port: number) => new Promise<boolean>(done => {
  const server = createServer().once('error', () => done(false));
  server.listen(port, '127.0.0.1', () => server.close(() => done(true)));
});

// --- Where things are ----------------------------------------------------------
const here = dirname(fileURLToPath(import.meta.url));
const env = process.env;
const repo = resolve(env.ADE_CALL_PREVIEW_REPO || must('git', ['-C', here, 'rev-parse', '--show-toplevel']));
const root = resolve(env.ADE_CALL_PREVIEW_ROOT || join(env.XDG_STATE_HOME || join(homedir(), '.local/state'), 'ade-call-previews'));
const service = env.ADE_CALL_SERVICE || 'ade-call.service';
const firstPort = parsePort(env.ADE_CALL_PREVIEW_FIRST_PORT || '18800'), lastPort = parsePort(env.ADE_CALL_PREVIEW_LAST_PORT || '18899');
const systemd = env.ADE_CALL_PREVIEW_SUPERVISOR !== 'nohup' && exec('systemctl', ['--user', 'show-environment']).status === 0 && exec('systemd-run', ['--version']).status === 0;
let serviceEnvironment: Map<string, string> | undefined;
// The installed service's environment: its ADEs, PATH, configuration and port.
// Read whenever systemd can be asked, whichever supervisor previews use.
function installed(name: string) {
  if (!serviceEnvironment) {
    const result = exec('systemctl', ['--user', 'show', service, '-p', 'Environment', '--value']);
    serviceEnvironment = result.status === 0 ? parseEnvironment(result.stdout) : new Map();
  }
  return serviceEnvironment.get(name) || '';
}

// --- One preview ---------------------------------------------------------------
// preview.json: written only by this script, in a folder only it creates.
interface Identity { pid: number; boot: string; start: string }
// gitDir: the common Git directory of the repository that owns the worktree.
// source: the checkout REF was resolved in, so HEAD~1 means the same on updates.
interface Meta { kind: 'ade-call-preview'; ref: string; gitDir: string; source: string; port: number; unit: string; supervisor: 'systemd' | 'nohup'; process?: Identity }
interface Preview { name: string; dir: string; checkout: string; meta: Meta }

function previewAt(dir: string): Preview | null {
  try {
    const meta = JSON.parse(readFileSync(join(dir, 'preview.json'), 'utf8')) as Meta;
    if (meta.kind !== 'ade-call-preview') return null;
    return { name: dir.slice(root.length + 1), dir, checkout: join(dir, 'checkout'), meta };
  } catch { return null; }
}
function existing(name: string) {
  return previewAt(join(root, slug(name))) || fail(`There is no preview called '${name}'. See: preview.sh list`);
}
function all() {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => previewAt(join(root, e.name))).filter(p => p !== null);
}
function save(preview: Preview) {
  const file = join(preview.dir, 'preview.json'), temporary = `${file}.tmp`;
  writeFileSync(temporary, JSON.stringify(preview.meta, null, 2) + '\n', { mode: 0o600 });
  renameSync(temporary, file);
}

// A recorded PID is this preview's server only if the boot, the process start
// time and the working directory all match: never signal a reused PID.
const bootId = () => readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
function startTime(pid: number) {
  try { return readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /s, '').split(' ')[19]; } catch { return ''; }
}
function identity(pid: number): Identity { return { pid, boot: bootId(), start: startTime(pid) }; }
function owned(preview: Preview) {
  const recorded = preview.meta.process;
  if (!recorded || recorded.boot !== bootId() || !recorded.start || startTime(recorded.pid) !== recorded.start) return false;
  try { return readlinkSync(`/proc/${recorded.pid}/cwd`) === realpathSync(preview.checkout); } catch { return false; }
}
/** The systemd unit of the preview in dir: its name also depends on the folder,
 * so previews of one ref under two roots never share a unit. */
export function unitName(name: string, dir: string) {
  return `ade-call-preview-${name}-${createHash('sha256').update(resolve(dir)).digest('hex').slice(0, 8)}.service`;
}
/** The unit as one systemd answer: ours only if it runs in this preview's
 * checkout; active unless inactive, failed or gone. A failed or incomplete
 * answer is an error, never "not ours" or "stopped": either would skip the busy
 * check or the stop and delete the files of a preview that still runs. */
function unitState(preview: Preview) {
  const result = exec('systemctl', ['--user', 'show', preview.meta.unit, '-p', 'LoadState', '-p', 'ActiveState', '-p', 'WorkingDirectory']);
  const values = new Map(result.stdout.split('\n').map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  if (result.status !== 0 || !values.get('LoadState') || !values.get('ActiveState'))
    fail(`systemd could not be asked about ${preview.meta.unit}: ${result.stderr.trim() || `exit ${result.status}`}`);
  return { owned: values.get('WorkingDirectory') === preview.checkout, active: !['inactive', 'failed'].includes(values.get('ActiveState')!) && values.get('LoadState') !== 'not-found' };
}
function running(preview: Preview) {
  if (preview.meta.supervisor === 'nohup') return owned(preview);
  const unit = unitState(preview);
  return unit.owned && unit.active;
}

/** idle, busy, or unknown: only an authenticated answer with serviceBusy false is idle. */
export async function status(port: number, token: string, timeout = 5000): Promise<'idle' | 'busy' | 'unknown'> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/status`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(timeout) });
    if (response.status !== 200) return 'unknown';
    const body = await response.json() as { serviceBusy?: unknown };
    return body.serviceBusy === false ? 'idle' : body.serviceBusy === true ? 'busy' : 'unknown';
  } catch { return 'unknown'; }
}
const token = (preview: Preview) => { try { return readFileSync(join(preview.dir, 'config', 'access-token'), 'utf8').trim(); } catch { return ''; } };

// Restarting or stopping ends a call: only when it says it is idle, or with --force.
async function checkIdle(preview: Preview, force: boolean) {
  if (!running(preview) || force) return;
  const state = await status(preview.meta.port, token(preview));
  if (state === 'busy') fail(`The preview '${preview.name}' has a call or a tool running. Wait for it to end, or add --force (it ends that call).`);
  if (state === 'unknown') fail(`The preview '${preview.name}' could not be asked whether it is busy. See preview.sh logs ${preview.name}; add --force to go on anyway.`);
}

async function halt(preview: Preview) {
  if (preview.meta.supervisor === 'systemd') {
    if (!unitState(preview).owned) return;
    const stopped = exec('systemctl', ['--user', 'stop', preview.meta.unit]);
    if (stopped.status !== 0) fail(`${preview.meta.unit} could not be stopped: ${stopped.stderr.trim() || `exit ${stopped.status}`}. Nothing was deleted.`);
    const after = unitState(preview);
    if (after.owned && after.active) fail(`${preview.meta.unit} is still active after stopping it. Nothing was deleted.`);
    exec('systemctl', ['--user', 'reset-failed', preview.meta.unit]);
  } else if (owned(preview)) {
    const { pid } = preview.meta.process!;
    process.kill(pid, 'SIGTERM');
    // Like systemctl stop: wait for it to exit, up to 20 s, then kill it.
    for (let i = 0; i < 40 && owned(preview); i++) await new Promise(done => setTimeout(done, 500));
    if (owned(preview)) process.kill(pid, 'SIGKILL');
  }
  delete preview.meta.process;
}

// The installed service's key, voice settings and custom instructions, copied
// into the preview's own config.json (mode 600). Nothing else: no other keys,
// no pairings. key: copy it, remove it, or keep what the preview has.
function writeConfig(preview: Preview, key: 'copy' | 'remove' | 'keep') {
  const sourceDir = env.ADE_CALL_SOURCE_CONFIG || installed('ADE_CALL_CONFIG') || join(homedir(), '.config/ade-call');
  let source: Record<string, unknown> = {}, current: Record<string, unknown> = {};
  try { source = JSON.parse(readFileSync(join(sourceDir, 'config.json'), 'utf8')); } catch { /* No installed configuration. */ }
  const file = join(preview.dir, 'config', 'config.json');
  try { current = JSON.parse(readFileSync(file, 'utf8')); } catch { /* A new preview. */ }
  const copied = existsSync(file) ? current : Object.fromEntries(Object.entries(source).filter(([field]) => field.startsWith('realtime') || field === 'customInstructions'));
  if (key === 'copy') { if (typeof source.openaiKey === 'string') copied.openaiKey = source.openaiKey; else delete copied.openaiKey; }
  if (key === 'remove') delete copied.openaiKey;
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, JSON.stringify(copied, null, 2) + '\n', { mode: 0o600 });
  renameSync(temporary, file);
  return typeof copied.openaiKey === 'string';
}

function launch(preview: Preview) {
  const variables: Record<string, string> = {
    PORT: String(preview.meta.port), ADE_CALL_HOST: '127.0.0.1', ADE_CALL_CONFIG: join(preview.dir, 'config'), ADE_CALL_STATE: join(preview.dir, 'state'),
    PATH: installed('PATH') || env.PATH || '', T3CODE_HOME: installed('T3CODE_HOME') || env.T3CODE_HOME || join(homedir(), '.t3'),
    // Only the preview's config.json may hold a key: never one from the environment.
    OPENAI_API_KEY: ''
  };
  for (const name of ['T3_BIN', 'ORCA_BIN', 'ADE_CALL_TIME_ZONE']) { const value = installed(name) || env[name]; if (value) variables[name] = value; }
  const log = join(preview.dir, 'server.log'), server = join(preview.checkout, 'dist/src/server.mjs');
  if (preview.meta.supervisor === 'systemd') {
    must('systemd-run', ['--user', '--quiet', '--collect', `--unit=${preview.meta.unit}`, `--description=ADE Call preview ${preview.meta.ref}`,
      `--property=WorkingDirectory=${preview.checkout}`, `--property=StandardOutput=append:${log}`, `--property=StandardError=append:${log}`,
      ...Object.entries(variables).map(([name, value]) => `--setenv=${name}=${value}`), process.execPath, server]);
  } else {
    const out = openSync(log, 'a');
    const child = spawn(process.execPath, [server], { cwd: preview.checkout, env: { HOME: homedir(), ...variables }, detached: true, stdio: ['ignore', out, out] });
    closeSync(out); child.unref();
    preview.meta.process = identity(child.pid!);
  }
  save(preview);
}

// Ready when this preview's server answers its own token: not any server on the port.
async function ready(preview: Preview) {
  for (let i = 0; i < 90; i++) {
    const state = token(preview) ? await status(preview.meta.port, token(preview), 2000) : 'unknown';
    if (state !== 'unknown') return;
    if (i > 4 && !running(preview)) break;
    await new Promise(done => setTimeout(done, 500));
  }
  fail(`The preview '${preview.name}' did not start:\n${logs(preview, 20)}`);
}

function logs(preview: Preview, lines: number) {
  try { return readFileSync(join(preview.dir, 'server.log'), 'utf8').trimEnd().split('\n').slice(-lines).join('\n'); } catch { return ''; }
}

function pairLink(preview: Preview) {
  const result = exec(process.execPath, ['--disable-warning=ExperimentalWarning', join(preview.checkout, 'dist/scripts/access.mjs'), 'pair', '--url', `http://localhost:${preview.meta.port}`, '--name', `Preview ${preview.name}`],
    { env: { ...env, ADE_CALL_CONFIG: join(preview.dir, 'config') } });
  let link: unknown;
  if (result.status === 0) try { link = (JSON.parse(result.stdout) as { link?: unknown }).link; } catch { /* Checked below. */ }
  return typeof link === 'string' && /#pair=/.test(link) ? link : fail(`No opening link could be created: ${result.stderr.trim() || result.stdout.trim()}`);
}

// The commit REF names now. pr/N: GitHub pull request N, pinned to the commit
// fetched now. Otherwise the local branch or commit, or origin's branch when it
// is newer or the only one.
// cwd: a checkout of the repository the preview belongs to. Only a valid branch
// name is fetched, into its own remote-tracking ref: never a refspec that could
// move a local branch. Anything else (a commit, HEAD~1) is resolved locally.
function resolveRef(ref: string, cwd: string) {
  const pull = /^(?:pr\/|#)(\d+)$/.exec(ref);
  if (pull) {
    must('git', ['-C', cwd, 'fetch', '--quiet', 'origin', `refs/pull/${pull[1]}/head`]);
    return must('git', ['-C', cwd, 'rev-parse', '--verify', 'FETCH_HEAD^{commit}']);
  }
  if (ref.startsWith('-')) fail(`No branch, commit or pull request called '${ref}'.`);
  // A full object ID needs no fetch.
  if (/^[0-9a-f]{40}([0-9a-f]{24})?$/i.test(ref)) return git(cwd, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`).stdout.trim() || fail(`No commit ${ref} in this repository.`);
  // origin/BRANCH: that branch as origin has it now, never the cached copy.
  const qualified = /^origin\/(.+)$/.exec(ref);
  if (qualified && git(cwd, 'check-ref-format', '--branch', qualified[1]).status === 0) {
    if (git(cwd, 'fetch', '--quiet', 'origin', `+refs/heads/${qualified[1]}:refs/remotes/origin/${qualified[1]}`).status !== 0)
      fail(`origin could not be fetched or has no branch '${qualified[1]}'.`);
    return must('git', ['-C', cwd, 'rev-parse', '--verify', `refs/remotes/origin/${qualified[1]}^{commit}`]);
  }
  const branch = git(cwd, 'check-ref-format', '--branch', ref).status === 0;
  // origin's branch counts only when fetched now: a cached copy may be old.
  const fetched = branch && git(cwd, 'fetch', '--quiet', 'origin', `+refs/heads/${ref}:refs/remotes/origin/${ref}`).status === 0;
  const local = git(cwd, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`).stdout.trim();
  const remote = fetched ? git(cwd, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${ref}^{commit}`).stdout.trim() : '';
  if (remote && (!local || git(cwd, 'merge-base', '--is-ancestor', local, remote).status === 0)) return remote;
  if (!local) fail(branch ? `No branch '${ref}' here, and origin could not be fetched or does not have it.` : `No branch, commit or pull request called '${ref}'.`);
  if (branch && !fetched) console.log(`origin/${ref} could not be fetched (or does not exist): using the local '${ref}'.`);
  return local;
}

async function choosePort(requested: string | undefined, name: string) {
  const servicePort = installed('PORT');
  const taken = new Set(all().filter(p => p.name !== name).map(p => p.meta.port));
  const usable = async (port: number) => String(port) !== servicePort && !taken.has(port) && await free(port);
  if (requested) {
    const port = parsePort(requested);
    if (String(port) === servicePort) fail(`Port ${port} is the installed service's.`);
    if (taken.has(port)) fail(`Port ${port} belongs to another preview.`);
    return await free(port) ? port : fail(`Port ${port} is already in use.`);
  }
  for (let port = firstPort; port <= lastPort; port++) if (await usable(port)) return port;
  return fail(`No free port between ${firstPort} and ${lastPort}.`);
}

function build(preview: Preview) {
  // Same lock file as the repository: share its node_modules; otherwise install its own.
  const modules = join(preview.checkout, 'node_modules'), shared = join(repo, 'node_modules');
  const sameLock = existsSync(shared) && readFileSync(join(preview.checkout, 'package-lock.json'), 'utf8') === readFileSync(join(repo, 'package-lock.json'), 'utf8');
  let link = false;
  try { link = readlinkSync(modules) !== ''; } catch { /* Not a link. */ }
  if (sameLock) {
    if (link) unlinkSync(modules); else if (existsSync(modules)) rmSync(modules, { recursive: true, force: true });
    symlinkSync(realpathSync(shared), modules);
  } else {
    if (link) unlinkSync(modules);
    must('npm', ['ci', '--include=dev', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: preview.checkout, env: { ...env, PATH: `${dirname(process.execPath)}:${env.PATH}` } });
  }
  must(process.execPath, ['scripts/build.mts'], { cwd: preview.checkout });
}

// --- Commands ------------------------------------------------------------------
async function start(args: string[]) {
  let ref = '', requestedPort: string | undefined, key: 'copy' | 'remove' | 'keep' | undefined, force = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--port') requestedPort = String(parsePort(args[++i] ?? fail('--port needs a number.')));
    else if (arg === '--no-key' || arg === '--key') { if (key) fail('Pass --key or --no-key once.'); key = arg === '--key' ? 'copy' : 'remove'; }
    else if (arg === '--force') force = true;
    else if (arg.startsWith('-')) fail(`Unknown option: ${arg}`);
    else if (ref) fail('Pass one ref.');
    else ref = arg;
  }
  if (!ref) fail('Usage: preview.sh start REF [--port N] [--no-key | --key] [--force]');
  const name = slug(ref.replace(/^#(\d+)$/, 'pr/$1')), dir = join(root, name);
  if (dir.startsWith(repo + '/')) fail('ADE_CALL_PREVIEW_ROOT cannot be inside the repository.');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  let preview = previewAt(dir), created = false, link: string;
  if (preview && preview.meta.ref !== ref) fail(`The name '${name}' belongs to the preview of '${preview.meta.ref}'. Stop that one first.`);
  // An existing preview resolves where it was first resolved, whichever clone runs this.
  const source = preview ? (existsSync(preview.meta.source) ? preview.meta.source : fail(`The checkout this preview came from is gone: ${preview.meta.source}. Stop the preview and start it again.`)) : repo;
  const commit = resolveRef(ref, source);

  if (preview) {
    if (requestedPort && parsePort(requestedPort) !== preview.meta.port) fail(`The preview '${name}' already uses port ${preview.meta.port}. Stop it first to change the port.`);
    if (git(preview.checkout, 'status', '--porcelain', '--untracked-files=no').stdout.trim()) fail(`The preview's checkout has local changes: ${preview.checkout}`);
    await checkIdle(preview, force);
    await halt(preview); save(preview);
    must('git', ['-C', preview.checkout, 'checkout', '--quiet', '--detach', commit]);
    // The port again: the installed service or another program may have taken it.
    if (String(preview.meta.port) === installed('PORT') || !await free(preview.meta.port)) fail(`Port ${preview.meta.port} is now in use. Stop the preview and start it again.`);
  } else {
    // The port first: a refusal leaves nothing behind.
    if (existsSync(dir)) fail(`${dir} already exists and is not a preview. Remove it or pick another ref.`);
    const port = await choosePort(requestedPort, name);
    try { mkdirSync(dir, { mode: 0o700 }); } catch { fail(`${dir} already exists and is not a preview. Remove it or pick another ref.`); }
    created = true;
    const gitDir = must('git', ['-C', repo, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
    preview = { name, dir, checkout: join(dir, 'checkout'), meta: { kind: 'ade-call-preview', ref, gitDir, source: repo, port, unit: unitName(name, dir), supervisor: systemd ? 'systemd' : 'nohup' } };
    save(preview);
  }

  try {
    if (created) {
      mkdirSync(join(dir, 'state'), { mode: 0o700 }); mkdirSync(join(dir, 'config'), { mode: 0o700 });
      must('git', ['-C', repo, 'worktree', 'add', '--quiet', '--detach', preview.checkout, commit]);
    }
    const keyed = writeConfig(preview, key ?? (created ? 'copy' : 'keep'));
    console.log(keyed ? 'The preview has the installed OpenAI key: calls work, cost money and can send work to real agents.' : 'No OpenAI key in the preview: the page works, calls do not.');
    console.log(`Building ${ref} at ${commit.slice(0, 7)}…`);
    build(preview);
    launch(preview);
    await ready(preview);
    link = pairLink(preview);
  } catch (error) {
    // A failed first start leaves nothing behind; a failed update keeps the preview, stopped.
    if (created) await remove(preview); else { await halt(preview); save(preview); }
    throw error;
  }
  console.log(`Preview '${name}': ${ref} at ${commit.slice(0, 7)}, on http://localhost:${preview.meta.port}`);
  console.log(`Open it, then press "Pair browser" once (single use, 10 minutes): ${link}`);
  console.log(`Stop and delete: skills/branch-preview/preview.sh stop ${name}`);
}

async function remove(preview: Preview) {
  await halt(preview);
  // This worktree only, in the repository that owns it (never a repository-wide
  // prune). The folder is deleted only once that repository confirms it no longer
  // lists the worktree.
  const owner = ['--git-dir', preview.meta.gitDir];
  const removed = exec('git', [...owner, 'worktree', 'remove', '--force', preview.checkout]);
  const listed = exec('git', [...owner, 'worktree', 'list', '--porcelain']);
  if (listed.status !== 0 || listed.stdout.split('\n').includes(`worktree ${preview.checkout}`))
    fail(`Its worktree could not be removed from ${preview.meta.gitDir}: ${(removed.stderr || listed.stderr).trim()}. The preview is stopped; its folder was kept.`);
  // Only a folder under the previews root that this script created.
  const dir = realpathSync(preview.dir);
  if (dir.startsWith(realpathSync(root) + '/') && existsSync(join(dir, 'preview.json'))) rmSync(dir, { recursive: true, force: true });
}

async function main(argv: string[]) {
  const [command = 'help', ...args] = argv;
  const force = args.includes('--force'), names = args.filter(a => a !== '--force');
  const one = () => { if (names.length !== 1 || names[0].startsWith('-')) fail(`Usage: preview.sh ${command} NAME`); return existing(names[0]); };
  switch (command) {
    case 'start': return start(args);
    case 'link': {
      const preview = one();
      if (!running(preview)) fail(`The preview '${preview.name}' is not running. Start it again with: preview.sh start ${preview.meta.ref}`);
      return console.log(`Open it, then press "Pair browser" once (single use, 10 minutes): ${pairLink(preview)}`);
    }
    case 'list': {
      const previews = all();
      if (!previews.length) return console.log('No previews.');
      for (const p of previews) {
        const commit = git(p.checkout, 'rev-parse', '--short', 'HEAD').stdout.trim() || '?';
        let state = 'unknown';
        try { state = running(p) ? 'running' : 'stopped'; } catch { /* systemd could not be asked. */ }
        console.log(`${p.name.padEnd(40)} ${state.padEnd(8)} http://localhost:${String(p.meta.port).padEnd(6)} ${p.meta.ref} at ${commit}`);
      }
      return;
    }
    case 'logs': return console.log(logs(one(), 80));
    case 'stop': {
      const preview = one();
      await checkIdle(preview, force);
      await remove(preview);
      return console.log(`Preview '${preview.name}' stopped and deleted.`);
    }
    case 'help': case '-h': case '--help': return console.log(USAGE);
    default: fail(`Unknown command: ${command}. See: preview.sh help`);
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(`preview: ${error instanceof PreviewError ? error.message : error instanceof Error ? error.stack : String(error)}`);
    process.exitCode = 1;
  });
}
