import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';
import { waitWhileBusy, ask, askService, BUSY, IDLE, UNKNOWN } from '../scripts/service-busy.mjs';

// The installer with simulated npm, systemctl and ADE CLIs, in a temporary
// HOME: it never touches a real service. PATH has only the simulated tools
// and the system directories, so no real T3 or Orca CLI is found.
const fake = '#!/bin/sh\nprintf "%s\\n" "$0 $*" >> "$HOME/commands"\n';
// systemctl is-active answers as FAKE_ACTIVE says (1: running), and show
// gives FAKE_PID as the MainPID of the running service.
const fakeSystemctl = fake + 'if [ "$2" = is-active ]; then [ "$FAKE_ACTIVE" = 1 ]; exit $?; fi\nif [ "$2" = show ]; then printf "%s\\n" "${FAKE_PID:-0}"; fi\n';
// sleep only logs and moves a simulated clock forward: the installer's Node
// processes read performance.now() from it (a preload in NODE_OPTIONS), so
// the 2-minute wait passes at once.
const fakeSleep = fake + 'printf "%s\\n" "$1" >> "$HOME/clock"\n';
const clockPreload = `import { readFileSync } from 'node:fs';
performance.now = () => { try { return readFileSync(process.env.HOME + '/clock', 'utf8').split('\\n').reduce((sum, s) => sum + Number(s || 0), 0) * 1000; } catch { return 0; } };
`;
function sandbox(t: test.TestContext, tools: string[]) {
  const home = mkdtempSync(join(tmpdir(), 'ade-install-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const bin = join(home, 'bin'); mkdirSync(bin);
  for (const name of tools) writeFileSync(join(bin, name), name === 'systemctl' ? fakeSystemctl : fake, { mode: 0o755 });
  writeFileSync(join(bin, 'sleep'), fakeSleep, { mode: 0o755 });
  writeFileSync(join(home, 'clock.mjs'), clockPreload);
  const env: NodeJS.ProcessEnv = { HOME: home, PATH: `${bin}:/usr/bin:/bin`, NODE_BIN: process.execPath, T3CODE_HOME: join(home, 't3 data'),
    ADE_CALL_STATE: join(home, 'state'), ADE_CALL_CONFIG: join(home, 'config'), ADE_CALL_TIME_ZONE: 'Europe/Madrid', PORT: '1',
    NODE_OPTIONS: `--import=${pathToFileURL(join(home, 'clock.mjs')).href}` };
  return { home, bin, env };
}
async function install(env: NodeJS.ProcessEnv) {
  const child = spawn('bash', ['scripts/install-user.sh'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const [status] = await once(child, 'exit') as [number];
  return { status, stdout, stderr };
}
const unitOf = (home: string) => readFileSync(join(home, '.config/systemd/user/ade-call.service'), 'utf8');
const commandsOf = (home: string) => existsSync(join(home, 'commands')) ? readFileSync(join(home, 'commands'), 'utf8') : '';
// A status endpoint that records each request and gives the answers in turn
// (the last one repeats); only `token` is accepted.
async function statusServer(t: test.TestContext, token: string, answers: (Record<string, unknown> | null)[]) {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    requests.push(`${req.url} ${req.headers.authorization}`);
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); return res.end('{}'); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(answers[Math.min(requests.length, answers.length) - 1]));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(done => server.close(done)));
  return { requests, port: String((server.address() as AddressInfo).port) };
}
// A free local port, for a process that must know it before it starts.
async function freePort() {
  const probe = http.createServer().listen(0, '127.0.0.1'); await once(probe, 'listening');
  const { port } = probe.address() as AddressInfo;
  await new Promise(done => probe.close(done));
  return String(port);
}
// The configuration of the running service, with its administrator token.
function runningConfig(env: NodeJS.ProcessEnv) {
  const config = join(env.HOME!, 'running config');
  mkdirSync(config, { recursive: true, mode: 0o700 });
  writeFileSync(join(config, 'access-token'), 'test-token', { mode: 0o600 });
  return config;
}
// A process standing in for the running service (FAKE_PID is its MainPID):
// its environment has the address and configuration of the installed unit,
// and the installer's own PORT and ADE_CALL_CONFIG stay as the sandbox
// set them, as in a reinstallation that changes them.
async function mainProcess(t: test.TestContext, env: NodeJS.ProcessEnv, vars: NodeJS.ProcessEnv, script = 'setInterval(() => {}, 1 << 30)', args: string[] = []) {
  const running = spawn(process.execPath, ['-e', script, ...args], { stdio: ['ignore', 'pipe', 'inherit'], env: { HOME: env.HOME, ...vars } });
  t.after(() => { running.kill(); });
  env.FAKE_PID = String(running.pid);
  return running;
}
// The service itself: its main process serves /api/status at its own address
// with its configuration's token, and records each request in a file.
const serving = `const http = require('node:http'), fs = require('node:fs');
const [answers, log] = [JSON.parse(process.argv[1]), process.argv[2]];
let count = 0;
http.createServer((req, res) => {
  fs.appendFileSync(log, req.url + ' ' + req.headers.authorization + '\\n'); count++;
  if (req.headers.authorization !== 'Bearer test-token') { res.writeHead(401); return res.end('{}'); }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(answers[Math.min(count, answers.length) - 1]));
}).listen(Number(process.env.PORT), process.env.ADE_CALL_HOST, () => console.log('listening'));`;
async function service(t: test.TestContext, env: NodeJS.ProcessEnv, answers: (Record<string, unknown> | null)[], host = '127.0.0.1') {
  const log = join(env.HOME!, 'requests');
  writeFileSync(log, '');
  const running = await mainProcess(t, env, { PORT: await freePort(), ADE_CALL_HOST: host, ADE_CALL_CONFIG: runningConfig(env) }, serving, [JSON.stringify(answers), log]);
  await once(running.stdout!, 'data');
  return () => readFileSync(log, 'utf8').split('\n').filter(Boolean);
}
const restartPattern = /systemctl --user restart ade-call.service/;

test('service installer generates isolated configuration with simulated npm/systemctl/T3', async t => {
  const { home, bin, env } = sandbox(t, ['npm', 'systemctl', 't3']);
  env.T3_BIN = join(bin, 't3');
  const result = await install(env);
  assert.equal(result.status, 0, result.stderr);
  const unit = unitOf(home);
  assert.equal(unit.split('\n').find(line => line.startsWith('WorkingDirectory=')),
    `WorkingDirectory=${resolve('.').replaceAll('%', '%%')}`);
  assert.ok(unit.includes(`T3CODE_HOME=${env.T3CODE_HOME}`));
  assert.ok(unit.includes(`T3_BIN=${env.T3_BIN}`));
  assert.ok(unit.includes('ADE_CALL_TIME_ZONE=Europe/Madrid'));
  assert.match(unit, /dist\/src\/server.mjs/);
  assert.match(unit, /UMask=0077/);
  const commands = commandsOf(home);
  assert.match(commands, /npm ci --include=dev --no-audit --no-fund/);
  assert.match(commands, /npm run build/);
  assert.match(commands, /systemctl --user enable --now ade-call.service/);
  assert.doesNotMatch(commands, /restart/);
  assert.doesNotMatch(commands, /\/t3 /);
});

function writeUnit(t: test.TestContext, checkoutName: string) {
  const { home, env } = sandbox(t, []);
  const cwd = join(home, checkoutName);
  mkdirSync(cwd);
  const directory = join(home, '.config/systemd/user');
  mkdirSync(directory, { recursive: true });
  const result = spawnSync(process.execPath, [resolve('dist/scripts/write-service.mjs')], { cwd, env, encoding: 'utf8' });
  assert.ifError(result.error);
  return { cwd, home, env, unitPath: join(directory, 'ade-call.service'), result };
}

test('WorkingDirectory preserves spaces, backslashes and quotes and escapes specifiers', t => {
  const { cwd, home, result } = writeUnit(t, 'checkout %n with "quotes" and a\\backslash');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(unitOf(home).split('\n').find(line => line.startsWith('WorkingDirectory=')),
    `WorkingDirectory=${cwd.replaceAll('%', '%%')}`);
});

for (const [label, separator] of [['newline', '\n'], ['carriage return', '\r']]) {
  test(`unit writer refuses a checkout path containing a ${label}`, t => {
    const { result, unitPath } = writeUnit(t, `checkout${separator}directory`);
    assert.equal(result.signal, null);
    assert.notEqual(result.status, 0, 'writer accepted a line break in the checkout path');
    assert.match(result.stderr, /newline|new line|line[ -]?break|carriage return|control character|\b(?:CR|LF)\b/i);
    assert.equal(existsSync(unitPath), false, 'no broken unit is written');
  });
}

for (const [label, ending] of [['space', ' '], ['tab', '\t'], ['backslash', '\\']]) {
  test(`WorkingDirectory keeps a checkout path ending in a ${label}`, t => {
    // systemd trims a trailing space or tab and reads a trailing backslash as
    // a line continuation, so the path ends in "/." instead.
    const { cwd, home, result } = writeUnit(t, `checkout${ending}`);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(unitOf(home).split('\n').find(line => line.startsWith('WorkingDirectory=')), `WorkingDirectory=${cwd}/.`);
  });
}

test('the installer does not drop a line break at the end of its checkout path', async t => {
  // $(pwd) would turn "checkout\n" into "checkout", a sibling folder.
  const { home, bin, env } = sandbox(t, ['systemctl']);
  writeFileSync(join(bin, 'npm'), '#!/bin/sh\nprintf "%s\\0" "$PWD" >> "$HOME/npm-dirs"\n', { mode: 0o755 });
  const checkout = join(home, 'checkout\n'), sibling = join(home, 'checkout');
  for (const dir of [checkout, sibling]) mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(join(checkout, 'scripts/install-user.sh'), readFileSync('scripts/install-user.sh'));
  mkdirSync(join(checkout, 'dist/scripts'), { recursive: true });
  writeFileSync(join(checkout, 'dist/scripts/write-service.mjs'), readFileSync('dist/scripts/write-service.mjs'));
  const child = spawnSync('bash', [join(checkout, 'scripts/install-user.sh')], { env: { ...env, T3_BIN: process.execPath }, encoding: 'utf8' });
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /line break/);
  assert.equal(existsSync(join(home, '.config/systemd/user/ade-call.service')), false);
  // NUL-separated: the checkout's own name ends in a line break.
  const npmDirs = readFileSync(join(home, 'npm-dirs'), 'utf8').split('\0');
  assert.ok(npmDirs.includes(checkout) && !npmDirs.includes(sibling), JSON.stringify(npmDirs));
});

test('systemd-analyze verifies the generated service settings', t => {
  // NODE_BIN is process.execPath, so verify checks a real ExecStart executable.
  // The trailing backslash also checks that the unit's lines stay separate.
  const { result, unitPath, env } = writeUnit(t, 'checkout with %n and \\');
  assert.equal(result.status, 0, result.stderr);
  // A minimal unit tells whether this machine's systemd can verify at all
  // (some containers lack the units every service depends on).
  const control = join(dirname(unitPath), 'control.service');
  writeFileSync(control, `[Service]\nExecStart=${process.execPath}\n`);
  const verify = (path: string) => spawnSync('systemd-analyze', ['verify', path], { env, encoding: 'utf8' });
  const probe = verify(control);
  if ((probe.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return t.skip('systemd-analyze is unavailable');
  assert.ifError(probe.error);
  if (probe.status !== 0) return t.skip(`systemd-analyze cannot verify a minimal unit here: ${probe.stderr.trim()}`);
  const generated = verify(unitPath);
  assert.equal(generated.status, 0, generated.stderr);
  assert.ok(!generated.stderr.includes(unitPath), generated.stderr);
});

test('running again restarts an active service once it reports being idle, or anyway', async t => {
  for (const { answers, asked, message } of [
    { answers: [{ serviceBusy: false }], asked: 1, message: /^(?!.*waiting).*was restarted with the new installation/s },
    { answers: [{ serviceBusy: true }, { serviceBusy: true }, { serviceBusy: false }], asked: 3, message: /in use .*waiting up to 2 minutes.*\n.*was restarted with the new installation/ },
    // Every 5 seconds of the simulated clock, until no request fits in the 2 minutes.
    { answers: [{ serviceBusy: true }], asked: 24, message: /waiting up to 2 minutes[^]*Warning: the service was still in use after 2 minutes\. It was restarted anyway/ },
    { answers: [{ serviceBusy: true }, { voiceActive: [] }], asked: 2, message: /too old to report it.*\n.*Warning: it is not known whether the service was in use\. It was restarted anyway/ },
    { answers: [null], asked: 1, message: /Warning: it is not known whether the service was in use/ }
  ]) {
    const { home, bin, env } = sandbox(t, ['npm', 'systemctl', 't3']);
    env.T3_BIN = join(bin, 't3'); env.FAKE_ACTIVE = '1';
    const requests = await service(t, env, answers);
    const result = await install(env);
    const label = JSON.stringify(answers);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout + result.stderr, message, label);
    assert.deepEqual(requests(), Array(asked).fill('/api/status Bearer test-token'), `${label}: it asks the running service, with its token`);
    const commands = commandsOf(home);
    assert.match(commands, /systemctl --user enable ade-call.service/);
    assert.doesNotMatch(commands, /enable --now/);
    assert.equal(commands.match(/\/sleep 5$/gm)?.length ?? 0, asked - 1, `${label}: it waits 5 seconds between checks`);
    assert.equal(commands.match(new RegExp(restartPattern, 'g'))?.length, 1, label);
    assert.ok(commands.lastIndexOf('/sleep ') < commands.search(restartPattern), `${label}: it restarts after the last check`);
  }
});

test('a question with a fractional time left still reaches the service', async t => {
  // The simulated clock above moves in whole milliseconds; performance.now()
  // does not, and timers reject a fractional delay.
  const { env } = sandbox(t, ['npm', 'systemctl', 't3']);
  const requests = await service(t, env, [{ serviceBusy: false }]);
  assert.equal(await askService(env.FAKE_PID!, 4980.625), IDLE);
  // The whole question, including the systemctl lookup of the main process.
  const saved = { HOME: process.env.HOME, PATH: process.env.PATH, FAKE_PID: process.env.FAKE_PID };
  Object.assign(process.env, { HOME: env.HOME, PATH: env.PATH, FAKE_PID: env.FAKE_PID });
  try { assert.equal(await ask('ade-call.service', 4980.625), IDLE); }
  finally { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
  assert.deepEqual(requests(), ['/api/status Bearer test-token', '/api/status Bearer test-token']);
});

test('a service listening on IPv6, on a name or on every address is asked at its own socket', async t => {
  for (const host of ['::1', 'localhost', '0.0.0.0', '::']) {
    const { bin, env } = sandbox(t, ['npm', 'systemctl', 't3']);
    env.T3_BIN = join(bin, 't3'); env.FAKE_ACTIVE = '1';
    const requests = await service(t, env, [{ serviceBusy: false }], host);
    const result = await install(env);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(requests(), ['/api/status Bearer test-token'], host);
    assert.match(result.stdout, /was restarted with the new installation/, host);
  }
});

test('the token goes only to the address of the running service, not to the new PORT', async t => {
  const { home, bin, env } = sandbox(t, ['npm', 'systemctl', 't3']);
  env.T3_BIN = join(bin, 't3'); env.FAKE_ACTIVE = '1';
  const requests = await service(t, env, [{ serviceBusy: false }]);
  // The reinstallation moves the service to another port, where another
  // process listens, and to another configuration with its own token.
  mkdirSync(env.ADE_CALL_CONFIG!, { recursive: true, mode: 0o700 });
  writeFileSync(join(env.ADE_CALL_CONFIG!, 'access-token'), 'new-token', { mode: 0o600 });
  const other = await statusServer(t, 'new-token', [{ serviceBusy: true }]);
  env.PORT = other.port;
  const result = await install(env);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(other.requests, [], 'nothing is sent to the new port');
  assert.deepEqual(requests(), ['/api/status Bearer test-token']);
  assert.match(result.stdout, /was restarted with the new installation/);
  assert.ok(unitOf(home).includes(`PORT=${other.port}`), 'the new unit has the new port');
});

test('the token is not sent when another process holds the port of the running service', async t => {
  // The main process has not opened its socket yet (systemd marks a simple
  // service active at once) and another process listens on its PORT.
  const { home, bin, env } = sandbox(t, ['npm', 'systemctl', 't3']);
  env.T3_BIN = join(bin, 't3'); env.FAKE_ACTIVE = '1';
  const intruder = await statusServer(t, 'test-token', [{ serviceBusy: false }]);
  const main = await mainProcess(t, env, { PORT: intruder.port, ADE_CALL_HOST: '127.0.0.1', ADE_CALL_CONFIG: runningConfig(env) });
  await once(main, 'spawn');
  const result = await install(env);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(intruder.requests, [], 'nothing is sent to the process holding the port');
  assert.match(result.stderr, new RegExp(`main process is not the one listening on port ${intruder.port}.*\\n.*Warning: it is not known whether the service was in use`));
  const commands = commandsOf(home);
  assert.doesNotMatch(commands, /\/sleep /);
  assert.equal(commands.match(new RegExp(restartPattern, 'g'))?.length, 1);
});

test('an active service that cannot be asked is restarted with a warning', async t => {
  for (const [label, prepare, reason] of [
    ['no MainPID', () => {}, /main process of the running service is not known/],
    ['no token', async (env: NodeJS.ProcessEnv) => {
      await once(await mainProcess(t, env, { ADE_CALL_CONFIG: join(env.HOME!, 'running config') }), 'spawn');
    }, /no access token in the ADE_CALL_CONFIG of the running service/]
  ] as const) {
    const { home, bin, env } = sandbox(t, ['npm', 'systemctl', 't3']);
    env.T3_BIN = join(bin, 't3'); env.FAKE_ACTIVE = '1';
    // The installer's configuration has a token; it must not be used.
    mkdirSync(env.ADE_CALL_CONFIG!, { recursive: true, mode: 0o700 });
    writeFileSync(join(env.ADE_CALL_CONFIG!, 'access-token'), 'new-token', { mode: 0o600 });
    await prepare(env);
    const result = await install(env);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, new RegExp(`${reason.source}.*\\n.*Warning: it is not known whether the service was in use`), label);
    const commands = commandsOf(home);
    assert.doesNotMatch(commands, /\/sleep /, label);
    assert.equal(commands.match(new RegExp(restartPattern, 'g'))?.length, 1, label);
  }
});

test('the wait is bounded by a monotonic 2 minutes: pauses and requests are cut to the time left', async () => {
  // Slow answers: each request takes all the time it is given, up to 7 s.
  let clock = 0;
  const asks: number[] = [], pauses: number[] = [], said: string[] = [];
  const answer = await waitWhileBusy({
    now: () => clock,
    ask: async timeoutMs => { asks.push(timeoutMs); clock += Math.min(timeoutMs, 7_000); return BUSY; },
    sleep: async ms => { pauses.push(ms); clock += ms; },
    say: text => said.push(text)
  });
  assert.equal(answer, BUSY, 'still in use when the time ran out');
  assert.ok(clock <= 120_000, `it gave up within 2 minutes (${clock} ms)`);
  assert.ok(asks.every(ms => ms > 0 && ms <= 5_000), 'each request is limited to 5 s');
  assert.ok(pauses.every(ms => ms > 0 && ms <= 5_000));
  assert.equal(asks.length, 12, 'one request every 10 s of simulated time');
  assert.equal(said.length, 1, 'the wait is announced once');

  // Near the end the pause and the request shrink to what is left.
  clock = 0; asks.length = 0; pauses.length = 0;
  const ends = await waitWhileBusy({
    now: () => clock, limitMs: 12_000,
    ask: async timeoutMs => { asks.push(timeoutMs); clock += Math.min(timeoutMs, 4_000); return BUSY; },
    sleep: async ms => { pauses.push(ms); clock += ms; }
  });
  assert.equal(ends, BUSY);
  assert.deepEqual(asks, [5_000, 3_000]);
  assert.deepEqual(pauses, [5_000]);
  assert.ok(clock <= 12_000);

  // An idle or unknown answer ends the wait at once.
  for (const result of [IDLE, UNKNOWN] as const) {
    clock = 0; let count = 0;
    const final = await waitWhileBusy({ now: () => clock, ask: async () => (++count < 3 ? BUSY : result), sleep: async ms => { clock += ms; } });
    assert.equal(final, result); assert.equal(count, 3); assert.equal(clock, 10_000);
  }
});

test('a user manager that does not answer counts as unknown within the time of the question', async t => {
  const bin = mkdtempSync(join(tmpdir(), 'ade-slow-systemctl-'));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  writeFileSync(join(bin, 'systemctl'), '#!/bin/sh\nexec /bin/sleep 30\n', { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${bin}:/usr/bin:/bin`;
  t.after(() => { process.env.PATH = path; });
  const started = performance.now();
  assert.equal(await ask('ade-test.service', 300), UNKNOWN);
  assert.ok(performance.now() - started < 3000, 'systemctl is cut at the time left, not waited for');
});

test('without the T3 CLI it installs for Orca only, and fails clearly with no ADE CLI', async t => {
  const orca = sandbox(t, ['npm', 'systemctl', 'orca-ide']);
  const result = await install(orca.env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /T3 CLI was not found: installing for Orca only \(ORCA_BIN=.*orca-ide\)/);
  const unit = unitOf(orca.home);
  assert.ok(unit.includes(`ORCA_BIN=${join(orca.bin, 'orca-ide')}`));
  assert.doesNotMatch(unit, /T3_BIN/);
  assert.match(commandsOf(orca.home), /systemctl --user enable --now ade-call.service/);

  const explicit = sandbox(t, ['npm', 'systemctl']);
  writeFileSync(join(explicit.home, 'orca'), fake, { mode: 0o755 });
  explicit.env.ORCA_BIN = join(explicit.home, 'orca');
  assert.equal((await install(explicit.env)).status, 0);
  assert.ok(unitOf(explicit.home).includes(`ORCA_BIN=${explicit.env.ORCA_BIN}`));

  const wrongT3 = sandbox(t, ['npm', 'systemctl', 'orca-ide']);
  wrongT3.env.T3_BIN = join(wrongT3.home, 'missing-t3');
  const refused = await install(wrongT3.env);
  assert.equal(refused.status, 1); assert.match(refused.stderr, /T3_BIN=.*missing-t3 was not found/);

  const none = sandbox(t, ['npm', 'systemctl']);
  const failed = await install(none.env);
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /Install an ADE CLI: T3 \(t3\) or Orca \(orca-ide\)/);
  assert.doesNotMatch(commandsOf(none.home), /npm|enable/, 'nothing is built or enabled');
});
