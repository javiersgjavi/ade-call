import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OrcaResponse } from '../src/shared/contracts.mjs';
import type { DirectAde } from '../src/direct/contract.mjs';
import { OrcaReadCache, orcaDirectAde, ORCA_PROMPT } from '../src/direct/orca.mjs';
import { DirectCallState } from '../src/direct/state.mjs';
import { DirectSession } from '../src/direct/session.mjs';
import { directInstructions } from '../src/direct/prompt.mjs';
import { RealtimeCalls } from '../src/voice/realtime.mjs';
import { ades } from '../src/adapters/registry.mjs';
import { double } from './fixtures.mjs';

process.env.ADE_CALL_TIME_ZONE = 'UTC';
// Invented projects, workspaces and terminals. Workspace IDs are "repo::path".
const P1 = 'aaaa1111-0000-4000-8000-000000000001', P2 = 'bbbb2222-0000-4000-8000-000000000002';
const W1 = `${P1}::/srv/huerto`, W2 = `${P1}::/srv/huerto-riego`, W3 = `${P2}::/srv/faro`;

// A simulated Orca CLI: listings, and terminal output with line cursors
// (cursor = index of the next line). Nothing here reaches a real Orca.
function fakeOrca() {
  const calls: string[][] = [];
  const output = new Map<string, string[]>([['term_codex_1', ['$ codex', 'Leyendo sensores…', 'Humedad: 41 %']], ['term_plain_7', ['hola']]]);
  const screens = new Map<string, string[]>([['term_codex_1', ['╭ Codex ╮', 'Listo']]]);
  const fake = { calls, output, screens, retained: 0, cursors: true, sends: 0, launches: 0, failSend: false,
    terminals: [
      { handle: 'term_codex_1', worktreeId: W1, agentIdentity: 'codex', paneTitle: 'Riego', title: '⠋ codex', connected: true, writable: true, status: 'running' },
      { handle: 'term_shell_2', worktreeId: W1, agent: 'shell', title: 'bash', connected: true, writable: true, status: 'running' },
      { handle: 'term_claude_9', worktreeId: W3, agentIdentity: 'claude', connected: false, writable: true, status: 'running' }
    ] as Record<string, unknown>[],
    async run(args: string[]): Promise<OrcaResponse> {
      calls.push(args);
      const key = args.slice(0, 2).join(' '), flag = (name: string) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
      if (key === 'repo list') return { repos: [{ id: P1, displayName: 'Huerto', path: '/srv/huerto' }, { id: P2, displayName: 'Faro', path: '/srv/faro' }] };
      if (key === 'worktree ps') return { worktrees: [
        { worktreeId: W1, repoId: P1, displayName: 'main', workspaceStatus: 'in-progress', lastActivityAt: Date.parse('2026-11-10T09:00:00Z'), liveTerminalCount: 2 },
        { worktreeId: W2, repoId: P1, displayName: 'riego', lastActivityAt: 0, comment: 'Probar goteo' },
        { worktreeId: W3, repoId: P2, displayName: 'main', lastActivityAt: Date.parse('2026-11-12T09:00:00Z') }] as unknown as OrcaResponse['worktrees'] };
      if (key === 'terminal list') return { terminals: fake.terminals as OrcaResponse['terminals'] };
      if (key === 'terminal read') {
        const handle = flag('--terminal')!, lines = output.get(handle) || [], limit = Number(flag('--limit') || 120);
        const cursors = fake.cursors && handle !== 'term_plain_7';
        if (args.includes('--screen')) return { terminal: { handle, status: 'running', tail: screens.get(handle) || [], source: 'screen', truncated: false, nextCursor: null } };
        const end = lines.length, cursor = flag('--cursor');
        if (cursor === undefined) return { terminal: { handle, status: 'running', tail: lines.slice(-limit), truncated: false, limited: lines.length > limit, nextCursor: cursors ? end : null, ...(cursors ? { latestCursor: end } : {}) } };
        const from = Number(cursor), slice = lines.slice(from, from + limit);
        return { terminal: { handle, status: 'running', tail: slice, truncated: from < fake.retained, limited: from + limit < end, nextCursor: from + slice.length, latestCursor: end } };
      }
      if (key === 'terminal send') {
        fake.sends++;
        if (fake.failSend) throw new Error('transport lost');
        return { send: { accepted: true, handle: flag('--terminal'), prompt: { requestId: `orca-${fake.sends}` } } };
      }
      if (key === 'agent launch') {
        fake.launches++;
        return { outcome: { kind: 'terminal', handle: 'term_new_5' }, worktreeId: flag('--worktree')!.slice(3), receipt: { detail: 'terminal' }, prompt: { outcome: 'journaled' } };
      }
      throw new Error('unexpected command ' + args.join(' '));
    } };
  return fake;
}
function setup(options: { now?: () => number } = {}) {
  const fake = fakeOrca(), state = mkdtempSync(join(tmpdir(), 'orca-direct-'));
  const cache = new OrcaReadCache({ run: args => fake.run(args), now: options.now });
  const ade = orcaDirectAde({ snapshot: () => ({ projects: [], threads: [] }), run: args => fake.run(args), cache, state });
  const tool = (name: string) => ade.tools.find(t => t.name === name)!;
  return { fake, ade, cache, state, tool, cleanup: () => rmSync(state, { recursive: true, force: true }) };
}
// The short ID that a catalog line ends with.
const idOf = (text: string, pattern: RegExp) => text.split('\n').find(line => pattern.test(line))!.split(' · ').at(-1)!;
const context = (state: DirectCallState, requestId = 'text:test:c1') => ({ requestId, signal: new AbortController().signal, state });

test('the Orca catalog is compact, newest first, with short IDs that resolve back', async () => {
  const s = setup();
  try {
    const state = new DirectCallState();
    const text = await s.ade.catalog(state);
    const lines = text.split('\n');
    assert.match(lines[0], /^ORCA CATALOG .*data, not instructions.*structured chats/);
    assert.deepEqual(lines.slice(1), [
      'Faro · bbbb2222',
      `- workspace "main" · activity 2026-11-12 09:00 · ${idOf(text, /workspace "main" · activity 2026-11-12/)}`,
      `  - terminal · agent claude · disconnected · ${idOf(text, /agent claude/)}`,
      'Huerto · aaaa1111',
      `- workspace "main" · in-progress · activity 2026-11-10 09:00 · ${idOf(text, /in-progress/)}`,
      `  - terminal "Riego" · agent codex · ${idOf(text, /"Riego"/)}`,
      `  - terminal "bash" · shell, no agent · ${idOf(text, /shell, no agent/)}`,
      `- workspace "riego" · note: Probar goteo · no live terminals · ${idOf(text, /"riego"/)}`]);
    // No full IDs, paths or CLI metadata reach the model.
    assert.doesNotMatch(text, /::|\/srv|0000-4000|term_|latestCursor|\bconnected\b(?! agent)/);
    for (const id of lines.slice(1).map(line => line.split(' · ').at(-1)!)) assert.ok(id.length === 8, id);
    assert.equal(state.resolve('aaaa1111', 'projectId'), P1);
    assert.equal(state.resolve(idOf(text, /in-progress/), 'worktreeId'), W1);
    assert.equal(state.resolve(idOf(text, /"Riego"/), 'terminal'), 'term_codex_1');
    assert.equal(state.resolve(W2, 'worktreeId'), W2, 'a full workspace ID works too');
    assert.throws(() => state.resolve('s0000000', 'terminal'), /does not match/);
  } finally { s.cleanup(); }
});

test('the catalog falls back to the projects of the last observation, or says it is missing', async () => {
  const slow = orcaDirectAde({ snapshot: () => ({ threads: [], projects: [{ id: P1, name: 'Huerto', path: '/srv/huerto', documents: ['/srv/huerto/README.md'], activeTerminals: 0 }] }),
    cache: new OrcaReadCache({ run: () => new Promise(() => {}) }), catalogTimeoutMs: 20 });
  const text = await slow.catalog(new DirectCallState());
  assert.match(text, /Projects only: the CLI did not return workspaces or terminals in time \(slowness or failure\)\. It does not prove there are no terminals/);
  assert.match(text, /\nHuerto · aaaa1111$/);
  const broken = orcaDirectAde({ snapshot: () => ({ projects: [], threads: [] }), cache: new OrcaReadCache({ run: async () => { throw new Error('Orca not available'); } }) });
  assert.match(await broken.catalog(new DirectCallState()), /Listing not available \(Orca not available\)\. It does not prove there are no projects/);
});

test('listings are cached briefly and shared; terminal output never is', async () => {
  let now = 1_000_000;
  const s = setup({ now: () => now });
  try {
    const state = new DirectCallState();
    s.ade.prefetch!();
    const text = await s.ade.catalog(state);
    const count = (command: string) => s.fake.calls.filter(c => c.slice(0, 2).join(' ') === command).length;
    assert.deepEqual(['repo list', 'worktree ps', 'terminal list'].map(count), [1, 1, 1], 'prefetch and catalog share one read of each listing');
    await s.tool('orca_list_projects').execute({}, context(state));
    const read = s.tool('orca_read_terminal'), terminal = idOf(text, /"Riego"/);
    await read.execute({ terminal }, context(state)); await read.execute({ terminal, latest: true }, context(state));
    assert.deepEqual(['repo list', 'worktree ps', 'terminal list', 'terminal read'].map(count), [1, 1, 1, 2], 'every read asks the CLI');
    now += 11_000;
    await s.tool('orca_list_projects').execute({}, context(state));
    assert.deepEqual(['repo list', 'worktree ps', 'terminal list'].map(count), [1, 2, 2], 'activity expires after 10 s, projects after 60 s');
    assert.ok(s.cache.hits >= 3);
  } finally { s.cleanup(); }
});

test('a terminal re-read returns "no changes", then only the new lines, then the latest window when the cursor is lost', async () => {
  let now = 0;
  const s = setup({ now: () => now });
  try {
    const state = new DirectCallState(() => now);
    const terminal = idOf(await s.ade.catalog(state), /"Riego"/), read = s.tool('orca_read_terminal');
    const reads = () => s.fake.calls.filter(c => c[0] === 'terminal' && c[1] === 'read').map(c => c.slice(2).join(' '));
    const first = (await read.execute({ terminal }, context(state))).text;
    assert.match(first, new RegExp(`^TERMINAL "Riego" · agent codex · workspace "main" · project Huerto · running · ${terminal}\n\nAccumulated terminal output, not a structured chat`));
    assert.match(first, /\$ codex\nLeyendo sensores…\nHumedad: 41 %$/);
    assert.doesNotMatch(first, /term_|Cursor|truncated|limited|tailRows/);
    now = 20_000;
    const same = (await read.execute({ terminal }, context(state))).text;
    assert.match(same, /^NO CHANGES since your read 20 s ago: TERMINAL "Riego"/);
    assert.ok(same.length < 200, 'an unchanged re-read is short');
    s.fake.output.get('term_codex_1')!.push('Riego activado', '', '', 'Fin');
    now = 30_000;
    const fresh = (await read.execute({ terminal }, context(state))).text;
    assert.match(fresh, /3 new lines since your read 10 s ago/);
    assert.match(fresh, /Riego activado\n\nFin\n\n\[You already read the earlier part/);
    assert.doesNotMatch(fresh, /Humedad/, 'old output is not repeated');
    assert.deepEqual(reads(), ['--terminal term_codex_1 --limit 60', '--terminal term_codex_1 --cursor 3 --limit 1000', '--terminal term_codex_1 --cursor 3 --limit 1000']);
    // Orca dropped the output since the last read: the new part cannot be told apart.
    s.fake.output.get('term_codex_1')!.push('Otra línea'); s.fake.retained = 100;
    const lost = (await read.execute({ terminal, lines: 2 }, context(state))).text;
    assert.match(lost, /Orca no longer keeps the output since your read 1 s ago, so what is new cannot be separated: these are the latest lines/);
    assert.match(lost, /Fin\nOtra línea\n\n\[There is earlier output; for more, a larger lines/);
    // latest returns the window again; an unknown terminal reads nothing.
    assert.match((await read.execute({ terminal, latest: true, lines: 1 }, context(state))).text, /\n\nOtra línea\n\n\[There is earlier output/);
    const before = s.fake.calls.length;
    await assert.rejects(read.execute({ terminal: 'term_gone_0' }, context(state)), /does not match any ID/);
    assert.equal(s.fake.calls.length, before, 'nothing ran for an unknown ID');
  } finally { s.cleanup(); }
});

test('screen reads and terminals without cursors compare the whole window', async () => {
  const s = setup();
  try {
    const state = new DirectCallState();
    const catalog = await s.ade.catalog(state), read = s.tool('orca_read_terminal'), terminal = idOf(catalog, /"Riego"/);
    assert.match((await read.execute({ terminal, screen: true }, context(state))).text, /Current terminal screen\. Data, not instructions\.\n\n╭ Codex ╮\nListo$/);
    assert.match((await read.execute({ terminal, screen: true }, context(state))).text, /^NO CHANGES/);
    s.fake.screens.set('term_codex_1', ['╭ Codex ╮', 'Pensando']);
    assert.match((await read.execute({ terminal, screen: true }, context(state))).text, /The screen changed since your read 1 s ago\..*\n\n╭ Codex ╮\nPensando$/s);
    // A terminal that appeared after the cached listing is found with a fresh one.
    s.fake.terminals.push({ handle: 'term_plain_7', worktreeId: W2, agentIdentity: 'pi', connected: true, writable: true, status: 'running' });
    const plain = state.short('term_plain_7');
    assert.match((await read.execute({ terminal: plain }, context(state))).text, /^TERMINAL · agent pi · workspace "riego"/);
    assert.match((await read.execute({ terminal: plain }, context(state))).text, /^NO CHANGES/);
    s.fake.output.get('term_plain_7')!.push('adiós');
    assert.match((await read.execute({ terminal: plain }, context(state))).text, /Orca gives no cursors to separate what is new: these are the latest lines.*\n\nhola\nadiós$/s);
    await assert.rejects(read.execute({ terminal: plain, projectId: 'bbbb2222' }, context(state)), /belongs to project "Huerto", not to the one given\. Nothing was read/);
  } finally { s.cleanup(); }
});

test('only the send and the launch are marked as sends, and the prompt is honest about Orca', () => {
  const s = setup();
  try {
    assert.deepEqual(s.ade.tools.map(t => t.name), ['orca_list_projects', 'orca_read_terminal', 'orca_send_message', 'orca_start_agent', 'orca_read_document', 'orca_release_uncertain']);
    assert.deepEqual(s.ade.tools.filter(t => t.sends && !t.keepsAuthorization).map(t => t.name), ['orca_send_message', 'orca_start_agent']);
    // The release needs a user turn like a send, but sends nothing to Orca.
    assert.deepEqual(s.ade.tools.filter(t => t.sends && t.keepsAuthorization).map(t => t.name), ['orca_release_uncertain']);
    assert.equal(s.ade.prompt, ORCA_PROMPT);
    const voice = directInstructions(s.ade);
    assert.match(voice, /Before each orca_send_message or orca_start_agent ask/);
    assert.match(voice, /you cannot read or continue Orca's structured chats, only terminals/);
    assert.match(voice, /There are no automatic notices when an Orca agent finishes/);
    assert.doesNotMatch(voice, /t3_|main thread|subagent/);
    assert.match(voice, /For a described topic, search several of its meaningful words, not just one\. A correction/);
    for (const tool of s.ade.tools) assert.ok(tool.description.length < 400, tool.name);
  } finally { s.cleanup(); }
});

test('Orca sends are gated by the user turn, deduplicated by request ID and never retried when uncertain', async () => {
  const s = setup();
  try {
    const session = new DirectSession(s.ade);
    const catalog = await session.catalog();
    const args = JSON.stringify({ projectId: 'aaaa1111', terminal: idOf(catalog, /"Riego"/), message: 'Mide la humedad del bancal norte' });
    const run = (callId: string, requestId = `voice:call:${callId}`) => session.run({ name: 'orca_send_message', call_id: callId, arguments: args }, { requestId, signal: new AbortController().signal });
    const refused = await run('c1');
    assert.equal(refused!.status, 'refused'); assert.match(refused!.output, /no_user_turn/);
    assert.equal(s.fake.sends, 0, 'nothing was sent without words of the user');
    session.remember('assistant', '¿Le mando al agente «Riego» que mida la humedad del bancal norte?');
    session.remember('user', 'Sí');
    const sent = await run('c2');
    assert.equal(sent!.status, 'completed');
    assert.match(sent!.output, /^SENT: Orca accepted the message for terminal "Riego" · s[0-9a-f]{7}\. Accepted does not mean processed or finished/);
    assert.doesNotMatch(sent!.output, /voice:call|orca-1|term_/, 'no request IDs or CLI fields');
    assert.equal(sent!.delivered, undefined, 'no thread watch: Orca has no structured messages to follow');
    assert.equal(s.fake.sends, 1);
    assert.deepEqual(s.fake.calls.find(c => c[1] === 'send'), ['terminal', 'send', '--terminal', 'term_codex_1', '--text', 'Mide la humedad del bancal norte', '--enter', '--wait-submit', '1']);
    assert.equal(await run('c2'), null, 'one execution per call ID');
    assert.equal((await run('c3'))!.status, 'refused', 'a new send needs new words of the user');
    // The same server request ID replays the journal receipt without sending again.
    const again = await s.tool('orca_send_message').execute(JSON.parse(args), context(session.state, 'voice:call:c2'));
    assert.match(again.text, /^SENT/); assert.equal(s.fake.sends, 1);
    // A failure after the CLI was called is uncertain: reported, never retried, and it blocks the project.
    s.fake.failSend = true;
    session.remember('assistant', '¿Se lo repito al agente «Riego»?'); session.remember('user', 'Sí, mándalo');
    const uncertain = await run('c4');
    assert.equal(uncertain!.status, 'unknown'); assert.match(uncertain!.output, /Uncertain delivery in Orca.*Do not repeat it/s);
    assert.equal(s.fake.sends, 2);
    s.fake.failSend = false;
    await assert.rejects(s.tool('orca_send_message').execute(JSON.parse(args), context(session.state, 'voice:call:c5')), /has an uncertain delivery \(\d+ s ago, to terminal "Riego" · s[0-9a-f]{7}\).*nothing more is sent to this project until it is cleared up.*Read that terminal now with orca_read_terminal.*orca_release_uncertain/s);
    assert.equal(s.fake.sends, 2);
  } finally { s.cleanup(); }
});

test('Orca: after an uncertain send, reading its terminal and the user decision release the block; the re-send runs once', async () => {
  const s = setup();
  try {
    const session = new DirectSession(s.ade);
    const catalog = await session.catalog(), terminal = idOf(catalog, /"Riego"/);
    const call = (name: string, id: string, args: Record<string, unknown>) => session.run({ name, call_id: id, arguments: JSON.stringify(args) }, { requestId: `voice:call:${id}`, signal: new AbortController().signal });
    const send = { projectId: 'aaaa1111', terminal, message: 'Mide la humedad del bancal norte' };
    session.remember('assistant', '¿Le mando al agente «Riego» que mida la humedad?'); session.remember('user', 'Sí');
    s.fake.failSend = true;
    assert.equal((await call('orca_send_message', 'c1', send))!.status, 'unknown');
    s.fake.failSend = false;
    session.remember('assistant', 'No hay recibo.'); session.remember('user', 'Desbloquéalo y reenvíalo');
    const early = await call('orca_release_uncertain', 'c2', { projectId: 'aaaa1111' });
    assert.equal(early!.status, 'error'); assert.match(early!.output, /Before releasing it has to be checked: read terminal "Riego" · s[0-9a-f]{7} now with orca_read_terminal/);
    assert.equal((await call('orca_read_terminal', 'c3', { terminal }))!.status, 'completed');
    assert.match((await call('orca_release_uncertain', 'c4', { projectId: 'aaaa1111' }))!.output, /^RELEASED: .*to terminal "Riego" · s[0-9a-f]{7}.*Nothing was sent/);
    assert.equal((await call('orca_send_message', 'c5', send))!.status, 'completed', 'the release keeps the authorization of that turn');
    assert.equal(s.fake.sends, 2);
    assert.equal((await call('orca_send_message', 'c6', send))!.status, 'refused');
  } finally { s.cleanup(); }
});

test('starting an agent resolves the workspace, reports the new terminal and refreshes the listing', async () => {
  const s = setup();
  try {
    const session = new DirectSession(s.ade);
    const catalog = await session.catalog();
    session.remember('user', 'Arranca un codex en riego para probar el goteo');
    session.remember('assistant', '¿Inicio codex en el espacio «riego» con el encargo de probar el goteo?');
    session.remember('user', 'Sí');
    const started = await session.run({ name: 'orca_start_agent', call_id: 'l1', arguments: JSON.stringify({ projectId: 'aaaa1111', worktreeId: idOf(catalog, /"riego"/), agent: 'codex', message: 'Prueba el goteo' }) },
      { requestId: 'voice:call:l1', signal: new AbortController().signal });
    assert.equal(started!.status, 'completed');
    assert.match(started!.output, /^STARTED: Orca launched agent codex in a new terminal of workspace "riego" · terminal s[0-9a-f]{7}\. Orca says the request reached the agent\. Started does not mean finished/);
    const launch = s.fake.calls.find(c => c[1] === 'launch')!;
    assert.deepEqual(launch.slice(0, 10), ['agent', 'launch', '--worktree', 'id:' + W2, '--agent', 'codex', '--surface', 'terminal', '--prompt', 'Prueba el goteo']);
    assert.equal(s.fake.launches, 1);
    // The new terminal's short ID resolves for the next read.
    const handle = /terminal (s[0-9a-f]{7})\./.exec(started!.output)![1];
    assert.equal(session.state.resolve(handle, 'terminal'), 'term_new_5');
    assert.equal(s.cache.entries.has('terminal list'), false, 'the launch invalidates the cached listing');
  } finally { s.cleanup(); }
});

test('the registry exposes direct voice for Orca without a thread watch', () => {
  assert.equal(typeof ades.orca.direct, 'function');
  const ade = ades.orca.direct!({ snapshot: () => ({ projects: [], threads: [] }) });
  assert.equal(ade.id, 'orca'); assert.equal(ade.name, 'Orca');
  assert.deepEqual(ade.tools.filter(t => t.sends && !t.keepsAuthorization).map(t => t.name), ['orca_send_message', 'orca_start_agent']);
  // The server follows deliveries only where messages can be read: not in Orca.
  assert.equal(ades.orca.capabilities.readThreadMessages, false); assert.equal(ades.orca.readThread, null);
  assert.match(ades.orca.limitation!, /reads terminal output.*does not read or continue its structured chats/);
});

class FakeSocket extends EventEmitter {
  readyState = 1; sent: { type: string; item?: { role?: string; content?: { text: string }[] } }[] = [];
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  close() { this.readyState = 3; }
}
test('a voice call connects without waiting for an asynchronous catalog and adds it when ready', async t => {
  let release!: (text: string) => void;
  const s = setup(); t.after(s.cleanup);
  const ade: DirectAde = { ...s.ade, catalog: () => new Promise<string>(resolve => { release = resolve; }), prefetch: undefined };
  const socket = new FakeSocket();
  const realtime = new RealtimeCalls(double<ConstructorParameters<typeof RealtimeCalls>[0]>({
    key: 'k', ade, publish() {}, store: { meta() {} },
    context: { conversation: () => ({ id: 'c' }), resume: () => 'reanudar', vocabulary: () => [], rememberClose() {}, timing: () => ({}) },
    connect: () => { setImmediate(() => socket.emit('open')); return socket; }
  }));
  t.after(() => realtime.shutdown());
  await realtime.open('replay_orca');
  const system = () => socket.sent.filter(e => e.item?.role === 'system').map(e => e.item!.content![0].text);
  assert.deepEqual(system(), ['reanudar'], 'connected before the catalog');
  release('late ORCA CATALOG');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(system(), ['reanudar', 'late ORCA CATALOG']);
});
