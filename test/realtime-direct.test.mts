import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Message, T3Response } from '../src/shared/contracts.mjs';
import { compactCatalog, t3DirectAde, t3DirectTools, T3_PROMPT } from '../src/direct/t3.mjs';
import { DirectCallState } from '../src/direct/state.mjs';
import { directInstructions } from '../src/direct/prompt.mjs';
import { RealtimeCalls } from '../src/voice/realtime.mjs';
import { double } from './fixtures.mjs';
import { t3FindThreads } from '../src/adapters/t3/client.mjs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Invented IDs: two threads share their first 8 characters.
const P1 = '11111111-aaaa-4aaa-8aaa-000000000001', P2 = '22222222-bbbb-4bbb-8bbb-000000000002';
const T1 = 'abcdef12-0000-4000-8000-000000000001', T2 = 'abcdef12-9999-4000-8000-000000000002', T3 = '33333333-cccc-4ccc-8ccc-000000000003';
const T4 = '44444444-dddd-4ddd-8ddd-000000000004';
const catalog = {
  projects: [{ id: P1, name: 'Huerto', documents: ['README.md'] }, { id: P2, name: 'Faro' }],
  threads: [
    { threadId: T1, projectId: P1, title: 'Riego por goteo', status: 'completed', updatedAt: '2026-11-10T09:30:00Z' },
    { threadId: T3, projectId: P1, title: 'Medir humedad', parentThreadId: T1, relationshipToParent: 'subagent', updatedAt: '2026-11-10T10:00:00Z' },
    { threadId: T2, projectId: P2, title: 'Lámpara nueva' }
  ]
};

test('short IDs resolve only to a single ID shown in the call', () => {
  const state = new DirectCallState();
  compactCatalog(catalog, state);
  assert.equal(state.resolve('11111111', 'projectId'), P1, 'unique prefix');
  assert.equal(state.resolve(' 33333333 ', 'threadId'), T3);
  assert.equal(state.resolve(T1.toUpperCase(), 'threadId'), T1, 'full ID, any case');
  assert.equal(state.resolve(T4, 'threadId'), T4, 'an unseen full ID still works');
  assert.throws(() => state.resolve('abcdef12', 'threadId'), /ambiguous: it matches abcdef12-0, abcdef12-9\. Nothing was executed/);
  assert.equal(state.resolve('abcdef12-9', 'threadId'), T2, 'the longer prefix shown for a clash resolves');
  assert.throws(() => state.resolve('99999999', 'threadId'), /does not match any ID.*Nothing was executed/);
  assert.throws(() => state.resolve('abc', 'threadId'), /too short/);
  assert.equal(state.shorten(`thread ${T4} · https://t3.example/threads/${T1}`), `thread 44444444 · https://t3.example/threads/${T1}`, 'IDs in links stay whole');
  // Non-UUID IDs share long prefixes: they get a hash alias resolved exactly.
  const long = 'thread:provider:agent:native-thread:provider-thread%3Aabc', other = long + 'd';
  const shown = state.shorten(`- "Sub" · id ${long} · parent ${other}`);
  const [, a, b] = /id (s[0-9a-f]{7}) · parent (s[0-9a-f]{7})$/.exec(shown)!;
  assert.notEqual(a, b);
  assert.equal(state.resolve(a, 'threadId'), long); assert.equal(state.resolve(b.toUpperCase(), 'threadId'), other);
  assert.equal(state.resolve(long, 'threadId'), long, 'the full long ID works too');
  assert.throws(() => state.resolve('s0000000', 'threadId'), /does not match/);
});

test('an ID a CLI would read as an option, or with spaces, never resolves', () => {
  const state = new DirectCallState();
  compactCatalog(catalog, state);
  for (const value of ['--base-dir=/tmp/elsewhere-xxxxxxxxxx', '-hxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', 'thread with spaces in its long name'])
    assert.throws(() => state.resolve(value, 'threadId'), /does not match any ID.*Nothing was executed/, value);
  assert.equal(state.resolve('thread:provider:agent:native-thread:x-yyyyyyyy', 'threadId'), 'thread:provider:agent:native-thread:x-yyyyyyyy', 'a long ID with inner dashes still works');
});

test('a long ID that embeds a UUID keeps its whole alias and is read in full', async () => {
  // T3 names Codex subagents after their provider thread: the UUID is inside the ID.
  const sub = 'thread:provider:codex:native-thread:01a1db48-da2c-7861-ba1d-6eddacf49742';
  const sibling = 'thread:provider:codex:native-thread:01a1db43-4110-7791-a984-4d9c5878dbde';
  const state = new DirectCallState();
  const shown = state.shorten(`- "/root/review" · id ${sub} · project ${P1} · parent ${T1} (subagent)\n- "/root/auth" · id ${sibling} · project ${P1}`);
  const [, a] = /id (s[0-9a-f]{7}) · project 11111111 · parent abcdef12 \(subagent\)/.exec(shown)!;
  const [, b] = /"\/root\/auth" · id (s[0-9a-f]{7}) · project 11111111$/m.exec(shown)!;
  assert.ok(!shown.includes('native-thread'), 'no truncated long ID is left in the text');
  assert.equal(state.resolve(a, 'threadId'), sub);
  assert.equal(state.resolve(b, 'threadId'), sibling);
  assert.ok(![...state.ids].some(id => id.startsWith('01a1db4')), 'the embedded UUID is not registered as an ID');
  const { read, calls } = readerWith({ ...thread([msg(1)]), thread: { ...thread([]).thread, threadId: sub } });
  await read.execute({ threadId: a }, { requestId: 'r1', signal: AbortSignal.timeout(1000), state });
  assert.deepEqual(calls[0], ['thread', 'show', sub, '--messages', '6']);
});

test('the compact catalog has one line per project and thread, without full IDs', () => {
  process.env.ADE_CALL_TIME_ZONE = 'UTC';
  const text = compactCatalog(catalog, new DirectCallState());
  const lines = text.split('\n');
  assert.match(lines[0], /^T3 CATALOG/);
  assert.deepEqual(lines.slice(1), [
    'Huerto · 11111111 · documents: README.md',
    '- "Riego por goteo" · completed · 2026-11-10 09:30 · abcdef12-0',
    '  ↳ "Medir humedad" · 2026-11-10 10:00 · 33333333',
    'Faro · 22222222',
    '- "Lámpara nueva" · abcdef12-9'
  ]);
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/.test(text), 'no full UUIDs');
});

function thread(messages: Message[], status = 'completed'): T3Response {
  return { thread: { threadId: T1, projectId: P1, title: 'Riego por goteo', status, updatedAt: '2026-11-10T09:30:00Z', link: 'https://t3.example/x',
    ...{ createdBy: 'user', providerInstanceId: 'agent', model: 'modelo', runtimeMode: 'full-access', runCount: 2, itemCount: 40, pendingRequestCount: 0 } }, messages };
}
const msg = (n: number, role = n % 2 ? 'user' : 'assistant'): Message => ({ role, runId: `run-${Math.ceil(n / 2)}`, text: `Mensaje ${n}` });
function readerWith(initial: T3Response) {
  const calls: string[][] = []; let current = initial;
  const tools = t3DirectTools({ run: async args => { calls.push(args); return { ...current, messages: (current.messages || []).slice(-Number(args[4])) }; } });
  return { read: tools.find(t => t.name === 't3_read_thread')!, calls, set: (r: T3Response) => { current = r; } };
}

test('the voice read drops technical metadata and returns the latest six messages', async () => {
  process.env.ADE_CALL_TIME_ZONE = 'UTC';
  const state = new DirectCallState(); compactCatalog(catalog, state);
  const data = thread(Array.from({ length: 10 }, (_, i) => msg(i + 1)));
  const { read, calls } = readerWith(data);
  const { text } = await read.execute({ threadId: 'abcdef12-0' }, { requestId: 'r1', signal: AbortSignal.timeout(1000), state });
  assert.deepEqual(calls[0], ['thread', 'show', T1, '--messages', '6']);
  assert.match(text, /^THREAD "Riego por goteo" · abcdef12-0 · project Huerto · 11111111 · completed \(end of turn, not finished work\) · updated 2026-11-10 09:30/);
  assert.ok(!/createdBy|providerInstanceId|runtimeMode|itemCount|runCount|https:/.test(text), 'no technical metadata');
  assert.ok(text.includes('Mensaje 5') && text.includes('Mensaje 10') && !text.includes('Mensaje 4'));
  assert.match(text, /\[For older messages: offset=6\.\]$/);
});

test('re-reads in the same call: unchanged says so; changed returns only new messages', async () => {
  let now = 1_000_000;
  const state = new DirectCallState(() => now); compactCatalog(catalog, state);
  const first = thread([msg(1), msg(2), msg(3), msg(4)], 'running');
  const { read, calls, set } = readerWith(first);
  await read.execute({ threadId: T1 }, { requestId: 'r1', signal: AbortSignal.timeout(1000), state });
  now += 42_000;
  const again = await read.execute({ threadId: T1, messages: 6 }, { requestId: 'r2', signal: AbortSignal.timeout(1000), state });
  assert.match(again.text, /^NO CHANGES since your read 42 s ago: THREAD "Riego por goteo".*you already have all its messages\.$/);
  assert.ok(!again.text.includes('Mensaje'), 'no content repeated');
  assert.ok(again.text.length < 300);
  set(thread([msg(1), msg(2), msg(3), msg(4), msg(5), msg(6)], 'completed'));
  now += 10_000;
  const changed = await read.execute({ threadId: 'abcdef12-0' }, { requestId: 'r3', signal: AbortSignal.timeout(1000), state });
  assert.deepEqual(calls.at(-1), ['thread', 'show', T1, '--messages', '30']);
  assert.match(changed.text, /Status before: running\. 2 new messages since your read 10 s ago/);
  assert.ok(changed.text.includes('Mensaje 5') && changed.text.includes('Mensaje 6') && !changed.text.includes('Mensaje 4'));
  // Explicit history still reads the content, and memory is per call.
  const older = await read.execute({ threadId: T1, offset: 4, messages: 3 }, { requestId: 'r4', signal: AbortSignal.timeout(1000), state });
  assert.ok(older.text.includes('Mensaje 1') && older.text.includes('Mensaje 2') && !older.text.includes('Mensaje 3'));
  assert.match(older.text, /\[Start of thread\.\]$/);
  const otherCall = await read.execute({ threadId: T1 }, { requestId: 'r5', signal: AbortSignal.timeout(1000), state: new DirectCallState() });
  assert.ok(otherCall.text.includes('Mensaje 6') && !otherCall.text.startsWith('NO CHANGES'));
});

test('asking an unchanged thread for more messages returns only the older ones not yet read', async () => {
  const state = new DirectCallState(); compactCatalog(catalog, state);
  const { read } = readerWith(thread(Array.from({ length: 20 }, (_, i) => msg(i + 1))));
  const first = await read.execute({ threadId: T1 }, { requestId: 'r1', signal: AbortSignal.timeout(1000), state });
  assert.ok(first.text.includes('Mensaje 15') && !first.text.includes('Mensaje 14'));
  const more = await read.execute({ threadId: T1, messages: 10 }, { requestId: 'r2', signal: AbortSignal.timeout(1000), state });
  assert.match(more.text, /No changes since your read \d+ s ago; you already have the 6 most recent\. Messages before the 6 most recent, in order \(4\)/);
  for (const n of [11, 12, 13, 14]) assert.match(more.text, new RegExp(`Mensaje ${n}\\b`));
  assert.ok(!/Mensaje (1[5-9]|20|10)\b/.test(more.text), 'nothing repeated, nothing beyond the request');
  const same = await read.execute({ threadId: T1, messages: 10 }, { requestId: 'r3', signal: AbortSignal.timeout(1000), state });
  assert.match(same.text, /^NO CHANGES .*you already have its 10 most recent messages\. For more history, offset=10\.$/);
});

test('a direct search names the parents of the subagents it left out by short IDs that resolve back', async () => {
  // A UUID parent and a long provider-named one: each alias must resolve to its own ID.
  const longParent = 'thread:provider:codex:native-thread:01a1db48-da2c-7861-ba1d-6eddacf49742';
  const parents = [{ threadId: longParent, title: 'Revisar sensores' }, { threadId: T1, title: 'Riego por goteo' }, { threadId: T4 }];
  const find = t3DirectTools({ findThreads: () => ({ threads: [], projectsMatchingName: [], searched: { field: 'thread_titles', projects: 1, catalogProjects: 1, subagents: false },
    subagentsMatching: { count: 4, parents } }) }).find(t => t.name === 't3_find_threads')!;
  const state = new DirectCallState(); compactCatalog(catalog, state);
  const { text } = await find.execute({ query: 'humedad' }, { requestId: 'r', signal: AbortSignal.timeout(1000), state });
  assert.match(text, /main threads only/);
  assert.match(text, /4 subagent threads also match and are not shown\. Search them with includeSubagents=true/);
  const shown = [...text.matchAll(/^- (?:"[^"]*" · )?parent (\S+)$/gm)].map(m => m[1]);
  assert.equal(shown.length, parents.length, text);
  assert.ok(!text.includes(T1) && !text.includes('native-thread'), 'parents by short ID');
  assert.deepEqual(shown.map(alias => state.resolve(alias, 'threadId')), parents.map(p => p.threadId));
});

test('a long ID followed by a comma, semicolon or full stop keeps its alias whole', () => {
  const long = 'thread:provider:codex:native-thread:01a1db43-4110-7791-a984-4d9c5878dbde', other = long.replace('dbde', 'dbdf');
  const state = new DirectCallState();
  const shown = state.shorten(`subagents of id ${long}, id ${other}; parent ${T1}, root ${long}.`);
  const [, a, b, c, d] = /^subagents of id (s[0-9a-f]{7}), id (s[0-9a-f]{7}); parent ([0-9a-f]{8}), root (s[0-9a-f]{7})\.$/.exec(shown)!;
  assert.equal(state.resolve(a, 'threadId'), long); assert.equal(state.resolve(b, 'threadId'), other);
  assert.equal(state.resolve(c, 'threadId'), T1); assert.equal(d, a);
  assert.ok(![...state.ids].some(id => /[,;.]$/.test(id)), 'no ID registered with its separator');
});

test('a direct search rejects a text "false" for its flags and searches nothing', async () => {
  let searched = 0;
  const find = t3DirectTools({ findThreads: params => { searched++; return t3FindThreads(params, join(tmpdir(), 'caller-no-base-' + process.pid)); } }).find(t => t.name === 't3_find_threads')!;
  const state = new DirectCallState(); compactCatalog(catalog, state);
  for (const field of ['includeSubagents', 'includeClosed'])
    await assert.rejects(find.execute({ query: 'humedad', [field]: 'false' }, { requestId: 'r', signal: AbortSignal.timeout(1000), state }),
      { message: `${field} must be the boolean true or false, not text or a number. Nothing was searched.` });
  assert.equal(searched, 2, 'the search itself rejected it, before reading any base');
  // The direct listing reuses the same tool: a text "false" lists nothing either.
  let listed = 0;
  const list = t3DirectTools({ overview: async () => { listed++; throw new Error('Unexpected listing'); } }).find(t => t.name === 't3_list_threads')!;
  await assert.rejects(list.execute({ includeSubagents: 'false' }, { requestId: 'r', signal: AbortSignal.timeout(1000), state }),
    { message: 'includeSubagents must be the boolean true or false, not text or a number. Nothing was listed.' });
  assert.equal(listed, 0);
});

test('direct sends resolve short IDs first; an ambiguous ID sends nothing', async () => {
  const dispatched: Record<string, unknown>[] = [];
  const coordinator = { async dispatch(params: Record<string, unknown>) { dispatched.push(params); return { status: 'delivered', delivery: 'started', threadId: params.threadId, project: params.project, projectId: params.projectId, requestId: params.requestId, link: null, runId: null }; }, close() {} };
  const send = t3DirectTools({ coordinatorFactory: () => coordinator as never }).find(t => t.name === 't3_send_message')!;
  const state = new DirectCallState(); compactCatalog(catalog, state);
  await assert.rejects(send.execute({ projectId: '11111111', project: 'Huerto', threadId: 'abcdef12', message: 'Revisa el goteo' }, { requestId: 'voice:c:1', signal: AbortSignal.timeout(1000), state }), /ambiguous/);
  assert.equal(dispatched.length, 0);
  const { text, delivered } = await send.execute({ projectId: '11111111', project: 'Huerto', threadId: 'abcdef12-0', message: 'Revisa el goteo' }, { requestId: 'voice:c:2', signal: AbortSignal.timeout(1000), state });
  assert.deepEqual(delivered, { threadId: T1, runId: null, link: null, project: 'Huerto' }, 'a confirmed delivery feeds the thread watch');
  assert.deepEqual(dispatched, [{ projectId: P1, project: 'Huerto', threadId: T1, message: 'Revisa el goteo', requestId: 'voice:c:2' }]);
  assert.match(text, /SEND ACCEPTED/); assert.ok(!text.includes(T1), 'receipt with short IDs');
});

test('T3 voice instructions keep every rule area and stay compact', () => {
  const ade = { name: 'T3', tools: t3DirectTools(), prompt: T3_PROMPT };
  const voice = directInstructions(ade);
  for (const area of ['LANGUAGE:', 'TIME:', 'Interruption policy:', 'Backchannel policy:', 'ROLE:', 'SPEECH:', 'TURNS:', 'NAMES:', 'ANSWERING:', 'EVIDENCE:', 'SENDING:', 'LIMITS:', 'IDS:', 'NOTICES:'])
    assert.ok(voice.includes(area), area);
  // The search guidance for described topics and main threads added about 260 (8427 → 8689).
  // Heard-to-the-end acceptance, lone words and project matching added about 210 (8682 → 8895).
  // Saying that the main thread is omitted threadId, never a listed thread, added about 60 (8930 → 8988).
  assert.ok(voice.length < 9000, `compact voice instructions (${voice.length} chars)`);
  assert.match(voice, /Before each t3_send_message propose it in one short, natural sentence/);
  assert.match(voice, /name the thread or project only if the user did not name it or to tell candidates apart/);
  // Only a yes to the voice's proposal authorizes (also one that cuts it off); lone words and wrong matches do not.
  assert.match(voice, /of your proposal authorizes a send/);
  assert.match(voice, /a lone word, number or name that accepts no proposal \(often a transcription artifact\)/);
  assert.match(voice, /A yes that cuts your proposal off accepts it if message and recipient are what the user asked for; otherwise ask/);
  assert.match(voice, /never pick one silently/);
  assert.match(voice, /never present another project or thread as the one asked for/);
  assert.match(voice, /completed means the agent finished its turn/);
  assert.match(voice, /Your tools are t3_find_threads, t3_list_threads, t3_read_thread, t3_read_document, t3_send_message and t3_release_uncertain\./);
  // Reading is always allowed: the model reads and validates before answering, and asks only for decisions.
  assert.match(voice, /When the turn asks about the projects, reading is always allowed: never ask "shall I read it\?", read it\. Before talking about status, progress, results or data, read the thread yourself and validate/);
  assert.match(voice, /Ask the user only for decisions: sends, choosing between candidates or missing data/);
  assert.match(voice, /After sending, if useful, read the thread to see that it arrived and report what you see\./);
  assert.match(voice, /Notes on what a status does not prove .* limit your claims; do not relay them as warnings\./);
  assert.match(voice, /On a confirmed send, confirm delivery \(or queuing\) briefly; do not imply the work is done/);
  assert.match(voice, /if there are none, omit the topic, including claims of "no warnings"/);
  assert.match(voice, /Voice doubt only on a failure, an uncertain result or the agent's own caveat/);
  assert.doesNotMatch(voice, /ofrece (?:leer|listar|buscar|comprobar)/);
  // A described topic: several of its words, recent main threads before old subagents.
  assert.match(voice, /For a described topic, search several of its meaningful words, not just one\. Unless they ask for a subagent, prefer recent main threads \(searches and listings leave subagents out by default\): one in the catalog or a listing that fits comes before old subagents\./);
});

test('T3 direct tools are compact and only the send changes T3', () => {
  const tools = t3DirectTools();
  assert.deepEqual(tools.map(t => t.name), ['t3_find_threads', 't3_list_threads', 't3_read_thread', 't3_send_message', 't3_read_document', 't3_release_uncertain']);
  assert.deepEqual(tools.filter(t => t.sends && !t.keepsAuthorization).map(t => t.name), ['t3_send_message']);
  assert.deepEqual(tools.filter(t => t.sends && t.keepsAuthorization).map(t => t.name), ['t3_release_uncertain'], 'the release needs a user turn and sends nothing');
  for (const tool of tools) assert.ok(tool.description.length < 400, tool.name);
});

class FakeSocket extends EventEmitter {
  readyState = 1; sent: { type: string; item?: { type?: string; role?: string; output?: string; content?: { text: string }[] } }[] = [];
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  close() { this.readyState = 3; }
}
test('a T3 call uses the compact catalog and per-call memory, and the read is plain text', async t => {
  const socket = new FakeSocket();
  const ade = t3DirectAde({ snapshot: () => ({ projects: [], threads: [] }), catalog: () => catalog });
  let seen: DirectCallState | undefined;
  ade.tools = [{ name: 't3_read_thread', description: 'Read', parameters: { type: 'object' }, async execute(_p, context) { seen = context.state; return { text: 'THREAD "Riego" \'quoted\'', read: T1 }; } }];
  ade.prefetch = undefined;
  const reads: string[] = [];
  const realtime = new RealtimeCalls(double<ConstructorParameters<typeof RealtimeCalls>[0]>({
    key: 'k', ade, publish() {}, store: { meta() {} }, read: id => reads.push(id),
    context: { conversation: () => ({ id: 'c' }), resume: () => '', vocabulary: () => [], rememberClose() {}, timing: () => ({}) },
    connect: () => { setImmediate(() => socket.emit('open')); return socket; }
  }));
  t.after(() => realtime.shutdown());
  assert.ok(realtime.session().instructions.startsWith(directInstructions(ade)));
  const call = await realtime.open('replay_d');
  const system = socket.sent.filter(e => e.item?.role === 'system').map(e => e.item!.content![0].text);
  assert.ok(system.some(text => text.startsWith('T3 CATALOG') && text.includes('abcdef12-0')));
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.output_item.done', item: { type: 'function_call', name: 't3_read_thread', call_id: 'r1', arguments: '{"threadId":"abcdef12-0"}' } })));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(seen, call.direct!.state, 'the tool receives this call\'s state');
  assert.equal(socket.sent.find(e => e.item?.type === 'function_call_output')!.item!.output, 'THREAD "Riego" \'quoted\'', 'plain text output, no JSON escaping');
  assert.deepEqual(reads, [T1], 'a read marks the thread as seen for the watch');
  realtime.close('replay_d');
  assert.equal(call.direct, undefined, 'memory is discarded with the call');
});

test('a messages=1 read of a clipped message keeps the memory of the fuller read', async () => {
  const state = new DirectCallState(); compactCatalog(catalog, state);
  const { read } = readerWith(thread(Array.from({ length: 20 }, (_, i) => msg(i + 1))));
  await read.execute({ threadId: T1 }, { requestId: 'r1', signal: AbortSignal.timeout(1000), state });
  const one = await read.execute({ threadId: T1, messages: 1 }, { requestId: 'r2', signal: AbortSignal.timeout(1000), state });
  assert.match(one.text, /Mensaje 20\b/);
  assert.equal(state.reads.get(T1)?.count, 6);
  const again = await read.execute({ threadId: T1 }, { requestId: 'r3', signal: AbortSignal.timeout(1000), state });
  assert.match(again.text, /^NO CHANGES .*you already have its 6 most recent messages/);
  assert.ok(!/Mensaje 1[5-9]\b/.test(again.text), 'nothing delivered again');
});
