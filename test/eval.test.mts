import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadScenarios, validateScenario, type Scenario } from '../src/eval/scenario.mjs';
import { SimulatedT3, worldId } from '../src/eval/world.mjs';
import { checkRun, median } from '../src/eval/checks.mjs';
import { callLog, expectedCriteria, judge, judgeInput, judgementPasses, worldText } from '../src/eval/judge.mjs';
import { looksLikeCredential, redactEvidence, redactText } from '../src/eval/redact.mjs';
import { finalKind } from '../src/conversation/thread-watch.mjs';
import { distinctiveWords, vocabularyHints } from '../src/conversation/context.mjs';
import { DirectSession, requestIdFor } from '../src/direct/session.mjs';
import { Speech, noise, phone, spokenWords, wav, BYTES_PER_MS } from '../src/eval/speech.mjs';
import { runScenario, type RunRecord } from '../src/eval/runner.mjs';
import { DirectCallState } from '../src/direct/state.mjs';
import { resourceText } from '../src/resources.mjs';

const root = new URL('../../', import.meta.url).pathname;
const examples = () => loadScenarios(join(root, 'evals/scenarios/examples.json'));
// The phone line and recorded clips decode with ffmpeg; without it those tests are skipped.
const noFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status !== 0 && 'ffmpeg is not installed';
const context = (state: DirectCallState) => ({ requestId: 'voice:test:call_1', signal: new AbortController().signal, state });

test('example scenarios load, share a world file and validate', () => {
  const list = examples();
  assert.ok(list.length >= 5);
  for (const s of list) assert.ok(s.world.projects.length && s.turns.length);
  assert.ok(readdirSync(join(root, 'evals/scenarios')).includes('worlds'));
  const base = list[0];
  assert.throws(() => validateScenario({ ...base, id: 'Bad Id' }), /slug/);
  assert.throws(() => validateScenario({ ...base, turns: [{ say: 'a', noise: 'pink' }] }), /exactly one/);
  assert.throws(() => validateScenario({ ...base, expect: { sends: [{ turn: 9 }] } }), /not a turn/);
  assert.throws(() => validateScenario({ ...base, expect: { sends: [{ turn: 1, thread: 'nope' }] } }), /unknown thread/);
  // Shapes the checks and judges read are checked before any paid call.
  assert.throws(() => validateScenario({ ...base, expect: { rubric: 'grade clarity' } }), /rubric must be a list/);
  assert.throws(() => validateScenario({ ...base, expect: { sends: [{ turn: 1, includes: 'hola' }] } }), /includes must be a list/);
  assert.throws(() => validateScenario({ ...base, expect: { tools: { maxCalls: -1 } } }), /maxCalls/);
  assert.throws(() => validateScenario({ ...base, turns: [{ say: 'a', pauseMs: 'x' }] }), /pauseMs/);
  const reply = (onSend: unknown) => ({ ...base, world: { projects: [{ key: 'p', name: 'p', threads: [{ key: 't', title: 't', onSend }] }] }, expect: {} });
  assert.throws(() => validateScenario(reply({ reply: 'Done' })), /onSend.reply must be a list/);
  assert.throws(() => validateScenario(reply({ delayMs: -1 })), /onSend.delayMs/);
  assert.doesNotThrow(() => validateScenario(reply({ reply: ['Done'], delayMs: 10 })));
});

test('the simulated T3 serves the production catalog, search and reads, and records sends without delivering them', async () => {
  const scenario = examples()[0];
  const sim = new SimulatedT3(scenario.world);
  try {
    const state = new DirectCallState();
    const catalog = await sim.ade.catalog(state);
    assert.match(catalog, /T3 CATALOG/);
    assert.match(catalog, /recipe-app · [0-9a-f]{8}/);
    assert.match(catalog, /"Add ingredient search" · .* · [0-9a-f]{8}/);
    const tool = (name: string) => sim.ade.tools.find(t => t.name === name)!;
    assert.deepEqual(sim.ade.tools.map(t => t.name), ['t3_find_threads', 't3_list_threads', 't3_read_thread', 't3_send_message', 't3_read_document', 't3_release_uncertain']);
    const search = worldId('thread', 'search'), short = state.short(search);
    const found = await tool('t3_find_threads').execute({ query: 'ingredient' }, context(state));
    assert.match(found.text, /Add ingredient search/);
    const read = await tool('t3_read_thread').execute({ threadId: short }, context(state));
    assert.match(read.text, /THREAD "Add ingredient search"/);
    assert.match(read.text, /empty search show all recipes or none/);
    const list = await tool('t3_list_threads').execute({}, context(state));
    assert.match(list.text, /Fix invoice rounding/);
    // The send goes through the production tool and the simulated coordinator.
    const send = tool('t3_send_message');
    assert.equal(send.sends, true);
    const replies: string[] = [];
    sim.onReply = r => replies.push(r.text);
    const args = send.prepare!({ projectId: state.short(worldId('project', 'recipes')), project: 'recipe-app', threadId: short, message: 'Show all recipes.' }, state);
    const sent = await send.execute(args, context(state));
    assert.match(sent.text, /SEND ACCEPTED by T3/);
    assert.equal(sent.delivered?.threadId, search);
    assert.deepEqual(sim.sends.map(s => [s.threadKey, s.message]), [['search', 'Show all recipes.']]);
    // A new read sees the user message and the running status.
    const after = await tool('t3_read_thread').execute({ threadId: short }, context(state));
    assert.match(after.text, /running/);
    assert.match(after.text, /Show all recipes\./);
    // The simulated agent answers after onSend.delayMs.
    assert.equal(sim.timers.size, 1);
  } finally { sim.close(); }
});

test('a thread marked failReads fails like a broken CLI, and a send without a thread creates the main thread', async () => {
  const sim = new SimulatedT3({ projects: [{ key: 'p', name: 'proj', threads: [{ key: 'broken', title: 'Broken thread', failReads: true, onSend: { delayMs: 10, reply: ['ok'] } }] }] });
  try {
    const state = new DirectCallState();
    await sim.ade.catalog(state);
    const read = sim.ade.tools.find(t => t.name === 't3_read_thread')!;
    await assert.rejects(read.execute({ threadId: state.short(worldId('thread', 'broken')) }, context(state)), /T3 CLI failed/);
    const send = sim.ade.tools.find(t => t.name === 't3_send_message')!;
    const replies: string[] = [];
    sim.onReply = r => replies.push(`${r.title}: ${r.text}`);
    const project = state.short(worldId('project', 'p'));
    await send.execute(send.prepare!({ projectId: project, project: 'proj', message: 'Hello' }, state), context(state));
    assert.equal(sim.sends[0].threadKey, null);
    const list = await sim.ade.tools.find(t => t.name === 't3_list_threads')!.execute({}, context(state));
    assert.match(list.text, /Voice · proj · Main/);
    // As T3 Coordinator, the destination is read first: a thread that cannot be read gets nothing.
    await assert.rejects(send.execute(send.prepare!({ projectId: project, project: 'proj', threadId: state.short(worldId('thread', 'broken')), message: 'Again' }, state), context(state)), /Nothing was sent/);
    assert.equal(sim.sends.length, 1);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.deepEqual(replies, []);
  } finally { sim.close(); }
});

function record(over: Partial<RunRecord> = {}): RunRecord {
  return { scenario: 'x', startedAt: '', model: 'm', transcriptionModel: 't', reasoning: 'low', eagerness: 'low', voice: 'v', durationMs: 1000,
    turns: [1, 2, 3].map(i => ({ index: i, kind: 'say', text: 't', startMs: i * 1000, endMs: i * 1000 + 500, latencyMs: 800 })),
    transcript: [1, 2, 3].map(i => ({ ms: i * 1000 + 900, role: 'assistant' as const, text: 'ok', turn: i })),
    tools: [{ ms: 1500, turn: 1, name: 't3_read_thread', status: 'completed', args: { threadId: worldId('thread', 'search').slice(0, 8) }, result: '' }],
    sends: [{ ms: 3600, turn: 3, projectKey: 'recipes', threadKey: 'search', message: 'An empty search should show all the recipes.' }],
    notices: [], bargeIns: 0, timeouts: [], providerErrors: [], usage: {}, ...over };
}

test('the median of an even sample averages the middle pair', () => {
  assert.equal(median([100, 900]), 500);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([]), null);
});

test('sends without a thread reuse the main thread, and archived or foreign threads refuse sends like T3', async () => {
  const sim = new SimulatedT3({ projects: [
    { key: 'p', name: 'proj', threads: [{ key: 'old', title: 'Old thread', archived: true }] },
    { key: 'q', name: 'other', threads: [{ key: 'theirs', title: 'Their thread' }] }] });
  try {
    const state = new DirectCallState();
    await sim.ade.catalog(state);
    const send = sim.ade.tools.find(t => t.name === 't3_send_message')!;
    const project = state.short(worldId('project', 'p'));
    for (const message of ['First', 'Second']) await send.execute(send.prepare!({ projectId: project, project: 'proj', message }, state), context(state));
    const main = sim.threads.get(worldId('thread', 'main:p'))!;
    // Each message as T3 Coordinator delivers it to a main thread: the main-thread prompt ending with the request.
    // The main thread is still working on the first (no onSend), so the second is queued as its next turn.
    assert.deepEqual(main.messages.map(m => m.text.split('\n').at(-1)), ['First']);
    assert.ok(main.messages.every(m => /^Request received by ADE Call\. Reference: /.test(m.text)));
    assert.equal(main.thread.runCount, 1);
    assert.equal(sim.queued.get(main.thread.threadId)?.length, 1);
    assert.deepEqual(sim.sends.map(x => x.threadKey), [null, null]);
    // Refusals happen before anything is recorded, as nothing was sent.
    const archived = state.shorten(worldId('thread', 'old')), foreign = state.shorten(worldId('thread', 'theirs'));
    await assert.rejects(send.execute(send.prepare!({ projectId: project, project: 'proj', threadId: archived, message: 'x' }, state), context(state)), (e: Error) => e.name === 'NotDispatchedError' && /archived/.test(e.message));
    await assert.rejects(send.execute(send.prepare!({ projectId: project, project: 'proj', threadId: foreign, message: 'x' }, state), context(state)), (e: Error) => e.name === 'NotDispatchedError' && /belongs to project "other" .*Nothing was sent/.test(e.message));
    assert.equal(sim.sends.length, 2);
  } finally { sim.close(); }
});

test('a send to a busy thread is queued as its next turn, as T3 does, and starts when the current run ends', async () => {
  const sim = new SimulatedT3({ projects: [{ key: 'p', name: 'proj', threads: [{ key: 't', title: 'Thread', onSend: { delayMs: 300, reply: ['ok'] } }] }] });
  try {
    const state = new DirectCallState();
    await sim.ade.catalog(state);
    const send = sim.ade.tools.find(t => t.name === 't3_send_message')!;
    const replies: string[] = [];
    sim.onReply = r => replies.push(`${r.runId}:${r.text}`);
    const args = { projectId: state.short(worldId('project', 'p')), project: 'proj', threadId: state.short(worldId('thread', 't')) };
    const first = await send.execute(send.prepare!({ ...args, message: 'one' }, state), { ...context(state), requestId: 'voice:test:call_q1' });
    assert.match(first.text, /started/i);
    await new Promise(resolve => setTimeout(resolve, 150));
    const second = await send.execute(send.prepare!({ ...args, message: 'two' }, state), { ...context(state), requestId: 'voice:test:call_q2' });
    // Queued: no run yet, the running one keeps going.
    assert.match(second.text, /queued/i);
    assert.equal(second.delivered?.runId, null);
    const live = sim.threads.get(worldId('thread', 't'))!;
    assert.equal(live.thread.latestRunId, 'run-2'); assert.equal(live.thread.status, 'running');
    await new Promise(resolve => setTimeout(resolve, 250));
    // The first run ended and was announced; the queued one has started.
    assert.deepEqual(replies, ['run-2:ok']);
    assert.equal(live.thread.latestRunId, 'run-3');
    assert.match(live.messages.at(-1)!.text, /two/);
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.deepEqual(replies, ['run-2:ok', 'run-3:ok']);
    assert.equal(live.thread.status, 'completed'); assert.equal(live.thread.activeRunId, null);
  } finally { sim.close(); }
});


test('deterministic checks catch wrong, early, extra and missing sends', () => {
  // A fragment any faithful message would contain, for this test.
  const base = examples()[0];
  const scenario = { ...base, expect: { ...base.expect, sends: [{ ...base.expect.sends![0], includes: ['all'] }] } } as Scenario;
  const ok = checkRun(scenario, record());
  assert.ok(ok.every(c => c.pass), JSON.stringify(ok.filter(c => !c.pass)));
  const early = checkRun(scenario, record({ sends: [{ ms: 2600, turn: 2, projectKey: 'recipes', threadKey: 'search', message: 'show all' }] }));
  assert.equal(early.find(c => c.id === 'sends[1].turn')!.pass, false);
  const wrong = checkRun(scenario, record({ sends: [{ ms: 3600, turn: 3, projectKey: 'recipes', threadKey: 'dark-mode', message: 'nothing' }] }));
  assert.deepEqual(wrong.filter(c => !c.pass).map(c => c.id).sort(), ['sends[1].includes', 'sends[1].thread']);
  const none = checkRun(scenario, record({ sends: [], tools: [] }));
  assert.deepEqual(none.filter(c => !c.pass).map(c => c.id).sort(), ['sends.count', 'tools.required.t3_read_thread:search']);
  assert.equal(none.find(c => c.id === 'sends.count')!.critical, true);
  assert.equal(none.find(c => c.id.startsWith('tools.required'))!.critical, false);
  // Recorded speech expects an answer unless the turn is marked silent; noise never does.
  const clip = { ...scenario, turns: [...scenario.turns.slice(0, 2), { audio: 'clip.wav' }] } as Scenario;
  const unanswered = record({ turns: record().turns.map(t => t.index === 3 ? { ...t, kind: 'audio' } : t), transcript: record().transcript.filter(l => l.turn !== 3) });
  assert.equal(checkRun(clip, unanswered).find(c => c.id === 'call.everyTurnAnswered')!.pass, false);
  const quietClip = { ...clip, turns: [...scenario.turns.slice(0, 2), { audio: 'clip.wav', silent: true }] } as Scenario;
  assert.equal(checkRun(quietClip, unanswered).find(c => c.id === 'call.everyTurnAnswered')!.pass, true);
  // Accents and case do not matter in fragments.
  const accents = { ...scenario, expect: { sends: [{ turn: 3, includes: ['VACÍO'] }] } } as Scenario;
  assert.ok(checkRun(accents, record({ sends: [{ ms: 1, turn: 3, projectKey: 'recipes', threadKey: 'search', message: 'si esta vacio' }] })).every(c => c.pass));
});

test('the judge sends the rubric and the call log and parses a strict verdict', async () => {
  const scenario = examples()[0];
  const input = judgeInput(scenario, record());
  assert.match(input, /SCENARIO status-propose-send/);
  assert.match(input, /s1 In turn 1/);
  assert.match(input, /SEND delivered to search/);
  assert.match(input, /\[agent\] Done: the search box/);
  // An answer the user cut says how much of it was heard.
  const cut = judgeInput(scenario, record({ transcript: [{ ms: 10, role: 'assistant', text: 'Shall I send it?', turn: 1, cut: { heardMs: 400, totalMs: 3000 } }] }));
  assert.match(cut, /VOICE \(answering turn 1; interrupted: the user heard about the first 0\.4 s of 3\.0 s .*\): "Shall I send it\?"/);
  let body: { model?: string; input?: { content: string }[]; text?: { format?: { type?: string } } } = {};
  const ids = expectedCriteria(scenario);
  assert.deepEqual(ids, ['g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'g8', ...scenario.expect.rubric!.map((_, i) => `s${i + 1}`)]);
  const verdict = { criteria: ids.map(id => ({ id, pass: id !== 'g6', severity: id === 'g6' ? 'minor' : 'critical', evidence: 'ok' })), score: 4, summary: 'fine' };
  const answer = (v: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify({ output: [{ type: 'reasoning' }, { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(v) }] }], usage: { total_tokens: 10 } }) });
  const fake = async (_url: string, init: RequestInit) => { body = JSON.parse(String(init.body)); return answer(verdict); };
  const j = await judge(scenario, record(), { model: 'judge-model', key: 'k', fetch: fake });
  assert.equal(body.model, 'judge-model');
  assert.equal(body.text?.format?.type, 'json_schema');
  assert.equal(body.input?.[0].content, resourceText('eval_judge.txt'));
  assert.equal(j.score, 4);
  assert.equal(judgementPasses(j), true, 'a minor failure does not fail the run');
  assert.equal(judgementPasses({ ...j, criteria: [{ id: 'g1', pass: false, severity: 'major', evidence: '' }] }), false);
  // A verdict that skips, invents or repeats criteria is not accepted.
  const partial = await judge(scenario, record(), { model: 'm', key: 'k', fetch: async () => answer({ ...verdict, criteria: [{ id: 'g1', pass: true, severity: 'critical', evidence: '' }] }) });
  assert.match(partial.error!, /missing g2.*s2/);
  assert.equal(judgementPasses(partial), false);
  const repeated = await judge(scenario, record(), { model: 'm', key: 'k', fetch: async () => answer({ ...verdict, criteria: [...verdict.criteria, verdict.criteria[0], { id: 'x9', pass: true, severity: 'minor', evidence: '' }] }) });
  assert.equal(repeated.error, 'incomplete verdict: 1 unexpected repeated g1');
  // An invented ID may quote the call: it is counted, never printed.
  const quoted = await judge(scenario, record(), { model: 'm', key: 'k', fetch: async () => answer({ ...verdict, criteria: [...verdict.criteria, { id: 'el usuario dijo frase privada', pass: true, severity: 'minor', evidence: '' }] }) });
  assert.equal(quoted.error, 'incomplete verdict: 1 unexpected');
  // Provider error messages may quote the input: only status and code are kept.
  const broken = await judge(scenario, record(), { model: 'm', key: 'k', fetch: async () => ({ ok: false, status: 400, text: async () => JSON.stringify({ error: { code: 'context_length_exceeded', message: 'Your input "frase privada" is too long' } }) }) });
  assert.equal(broken.error, 'HTTP 400 (context_length_exceeded)');
  assert.equal(judgementPasses(broken), false);
});

test('speech is cached by text and voice, and noise is deterministic', async () => {
  let calls = 0;
  const speech = new Speech({ cacheDir: mkdtempSync(join(tmpdir(), 'eval-speech-')), key: 'k', fetch: async (url, init) => {
    calls++;
    assert.match(url, /text-to-speech\/voice-1\?output_format=pcm_24000/);
    assert.equal((init.headers as Record<string, string>)['xi-api-key'], 'k');
    return { ok: true, status: 200, text: async () => '', arrayBuffer: async () => new Uint8Array(BYTES_PER_MS * 500).buffer };
  } });
  const a = await speech.say('Hola', { id: 'voice-1' }, 'es-ES');
  const b = await speech.say('Hola', { id: 'voice-1' }, 'es-ES');
  assert.equal(calls, 1); assert.equal(a.length, b.length); assert.equal(speech.cached, 1);
  await assert.rejects(new Speech({ cacheDir: mkdtempSync(join(tmpdir(), 'eval-speech-')) }).say('x', { id: 'v' }), /ElevenLabs key is missing/);
  const refusing = new Speech({ cacheDir: mkdtempSync(join(tmpdir(), 'eval-speech-')), key: 'k', fetch: async () => ({ ok: false, status: 401, text: async () => JSON.stringify({ detail: { status: 'quota_exceeded', message: 'Cannot say "frase privada"' } }), arrayBuffer: async () => new ArrayBuffer(0) }) });
  await assert.rejects(refusing.say('frase privada', { id: 'v' }), (error: Error) => error.message === 'ElevenLabs answered 401 (quota_exceeded).');
  // Parallel requests for one phrase share a single synthesis.
  const [c, d] = await Promise.all([speech.say('Adiós', { id: 'voice-1' }), speech.say('Adiós', { id: 'voice-1' })]);
  assert.equal(calls, 2); assert.equal(c, d);
  assert.deepEqual(readdirSync(speech.options.cacheDir).filter(f => f.endsWith('.partial')), []);
  assert.deepEqual(noise('pink', 200, 3), noise('pink', 200, 3));
  assert.equal(noise('silence', 100).every(byte => byte === 0), true);
  assert.equal(noise('pink', 100).length, BYTES_PER_MS * 100);
});

// A provider that only answers response.create with a short spoken answer.
class FakeProvider extends EventEmitter {
  readyState = 1; sent: { type: string }[] = [];
  constructor() { super(); setTimeout(() => this.emit('open'), 5); }
  send(data: string) {
    const event = JSON.parse(data) as { type: string };
    this.sent.push(event);
    if (event.type !== 'response.create') return;
    const emit = (e: Record<string, unknown>) => this.emit('message', Buffer.from(JSON.stringify(e)));
    setTimeout(() => {
      emit({ type: 'response.created', response: { id: 'r' } });
      emit({ type: 'response.output_audio.delta', response_id: 'r', item_id: 'i', delta: Buffer.alloc(BYTES_PER_MS * 200).toString('base64') });
      emit({ type: 'response.output_audio_transcript.done', item_id: 'i', transcript: 'Hola, te escucho.' });
      emit({ type: 'response.done', response: { id: 'r', status: 'completed', usage: { total_tokens: 7 } } });
    }, 20);
  }
  close() { this.readyState = 3; this.emit('close'); }
}

test('the runner opens a call with the production session, streams each turn and records the answers', { timeout: 30_000 }, async () => {
  const scenario = { ...examples()[2], turns: [{ noise: 'silence' as const, ms: 300 }] };
  let provider: FakeProvider | undefined;
  const run = await runScenario(scenario, { key: 'k', settings: { model: 'test-model' }, speech: new Speech({ cacheDir: mkdtempSync(join(tmpdir(), 'eval-run-')) }), voices: { a: { id: 'v' } }, defaultVoice: 'a', noResponseMs: 500,
    connect: () => (provider = new FakeProvider()) as never });
  const update = provider!.sent.find(e => e.type === 'session.update') as unknown as { session: { tools: { name: string }[]; instructions: string; audio: { input: { transcription: { language?: string } } } } };
  assert.deepEqual(update.session.tools.map(t => t.name).slice(0, 4), ['t3_find_threads', 't3_list_threads', 't3_read_thread', 't3_send_message']);
  assert.equal(update.session.audio.input.transcription.language, 'es');
  assert.ok(provider!.sent.some(e => e.type === 'input_audio_buffer.append'));
  assert.equal(run.model, 'test-model');
  assert.match(run.initialCatalog!, /^T3 CATALOG/);
  assert.ok(judgeInput(scenario, run).includes(run.initialCatalog!));
  assert.deepEqual(run.turns.map(t => t.kind), ['noise']);
  assert.ok(run.transcript.some(l => l.role === 'assistant' && l.text === 'Hola, te escucho.'));
  assert.equal(run.usage.total_tokens, 7);
  assert.ok(run.audio && run.audio.length > 0);
});

test('a scenario gives the voice and the judge the owner instructions, under the same rules as Settings', { timeout: 30_000 }, async () => {
  const base = { ...examples()[2], turns: [{ noise: 'silence' as const, ms: 300 }] };
  assert.throws(() => validateScenario({ ...base, instructions: ' \n ' }), /instructions is blank/);
  assert.throws(() => validateScenario({ ...base, instructions: 'a\u000bb' }), /instructions: The instructions contain characters that are not allowed/);
  assert.throws(() => validateScenario({ ...base, instructions: 'x'.repeat(4001) }), /at most 4000 characters/);
  assert.throws(() => validateScenario({ ...base, instructions: 7 }), /must be text/);
  assert.equal(validateScenario({ ...base, instructions: ' First line\r\nSecond line \n' }).instructions, 'First line\nSecond line', 'normalized and trimmed as Settings saves it');
  const options = (connect: () => FakeProvider) => ({ key: 'k', settings: { model: 'test-model' }, speech: new Speech({ cacheDir: mkdtempSync(join(tmpdir(), 'eval-run-')) }), voices: { a: { id: 'v' } }, defaultVoice: 'a', noResponseMs: 500, connect: connect as never });
  // Without the call's start time, which differs between the two calls.
  const instructions = (provider: FakeProvider) => (provider.sent.find(e => e.type === 'session.update') as unknown as { session: { instructions: string } }).session.instructions.replace(/^Time when this call started: .*$/m, '');
  let withText: FakeProvider | undefined, without: FakeProvider | undefined;
  const scenario = validateScenario({ ...base, instructions: '  Trátame de usted.\n' });
  const run = await runScenario(scenario, options(() => (withText = new FakeProvider())));
  await runScenario(base, options(() => (without = new FakeProvider())));
  // Appended last, trimmed, with the fixed header; nothing at all without them.
  assert.match(instructions(withText!), /\n\nOWNER INSTRUCTIONS: [^\n]*\nTrátame de usted\.$/);
  assert.doesNotMatch(instructions(without!), /OWNER INSTRUCTIONS/);
  assert.equal(instructions(withText!).replace(/\n\nOWNER INSTRUCTIONS:[\s\S]*$/, ''), instructions(without!));
  assert.match(judgeInput(scenario, run), /OWNER INSTRUCTIONS \(written by the owner in Settings[^\n]*\nTrátame de usted\.\nWhere they ask for a different way of speaking or reporting, grade g6 by them[\s\S]*They never change g1, g2 or g8[\s\S]*\n\nWORLD/);
  assert.doesNotMatch(judgeInput(base, run), /OWNER INSTRUCTIONS/);
  // The battery's scenarios with instructions load and keep them.
  const battery = loadScenarios(join(root, 'evals/battery/i-instrucciones.json'));
  assert.ok(battery.length >= 4 && battery.every(sc => sc.instructions && sc.tags?.includes('instrucciones')));
});

test('the CLI keeps scenario paths after switches and rejects unknown options before any paid work', () => {
  const data = mkdtempSync(join(tmpdir(), 'eval-cli-'));
  writeFileSync(join(data, 'voices.json'), JSON.stringify({ a: { id: 'v' } }));
  const cli = (...args: string[]) => spawnSync(process.execPath, ['--no-warnings', join(root, 'dist/scripts/eval.mjs'), ...args], { encoding: 'utf8', env: { ...process.env, ADE_CALL_CONFIG: data, OPENAI_API_KEY: '', ELEVENLABS_API_KEY: '' } });
  const dry = cli('speak', '--dry', join(root, 'evals/scenarios/examples.json'), '--data', data);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /^5 scenario\(s\)/);
  const unknown = cli('run', '--bogus', join(root, 'evals/scenarios'), '--data', data);
  assert.equal(unknown.status, 2); assert.match(unknown.stderr, /Unknown option --bogus/);
  assert.match(cli('run', '--repeat').stderr, /--repeat needs a value/);
  assert.match(cli('speak', '--dry=yes').stderr, /takes no value/);
  // Options of another command and malformed numbers stop before any paid work.
  const dryRun = cli('run', '--dry', join(root, 'evals/scenarios/examples.json'), '--data', data);
  assert.equal(dryRun.status, 2); assert.match(dryRun.stderr, /Unknown option --dry for run/);
  for (const [name, value] of [['min-pass', 'typo'], ['min-pass', '2'], ['parallel', 'typo'], ['repeat', '0']]) {
    const bad = cli('run', `--${name}`, value, join(root, 'evals/scenarios/examples.json'), '--data', data);
    assert.equal(bad.status, 2, `${name}=${value}`); assert.match(bad.stderr, new RegExp(`--${name} must be`));
  }
  assert.match(cli('report', '--min-pass', 'x', data).stderr, /--min-pass must be/);
  assert.match(cli('run', '--min-pass=', join(root, 'evals/scenarios/examples.json'), '--data', data).stderr, /--min-pass must be/);
  assert.match(cli('judge', join(data, 'none'), '--min-pass', ' ').stderr, /--min-pass must be/);
  // A planned job without a result counts as a run that did not complete.
  const runDir = join(data, 'runs-partial');
  const passed = { scenario: 'a', repeat: 1, checks: [], judgements: [], pass: true, checksPass: true, judgePass: null, score: null, latency: { median: 500, max: 500 }, usage: {}, durationMs: 1 };
  spawnSync('mkdir', ['-p', join(runDir, 'a', '1')]);
  writeFileSync(join(runDir, 'a', '1', 'result.json'), JSON.stringify(passed));
  writeFileSync(join(runDir, 'settings.json'), JSON.stringify({ label: 'partial', jobs: [{ scenario: 'a', repeat: 1 }, { scenario: 'a', repeat: 2 }] }));
  // Scenarios without spoken words need no speaker; an unknown speaker is refused.
  const bare = mkdtempSync(join(tmpdir(), 'eval-cli-bare-'));
  writeFileSync(join(bare, 'noise.json'), JSON.stringify({ ...examples()[2], file: undefined, world: examples()[2].world, turns: [{ noise: 'pink', ms: 300 }] }));
  const noSpeaker = cli('speak', '--dry', join(bare, 'noise.json'), '--data', bare);
  assert.equal(noSpeaker.status, 0, noSpeaker.stderr); assert.match(noSpeaker.stdout, /0 spoken turn/);
  writeFileSync(join(bare, 'voice.json'), JSON.stringify({ ...examples()[2], id: 'other-voice', file: undefined, turns: [{ say: 'hola', voice: 'nobody' }] }));
  assert.match(cli('speak', '--dry', join(bare, 'voice.json'), '--data', data).stderr, /speaker nobody is not in/);
  // Rejudging grades every scenario of the folder or refuses before paying.
  const unknownScenario = cli('judge', runDir, join(root, 'evals/scenarios/examples.json'));
  assert.equal(unknownScenario.status, 2); assert.match(unknownScenario.stderr, /Scenarios not found for a/);
  const partial = cli('report', '--min-pass', '0', runDir);
  assert.equal(partial.status, 1);
  assert.match(partial.stdout, /pass 50% \(1\/2\).*runs that failed to complete 1/);
  const twice = cli('speak', '--dry', join(root, 'evals/scenarios'), join(root, 'evals/scenarios/examples.json'), '--data', data);
  assert.equal(twice.status, 2); assert.match(twice.stderr, /appears twice/);
});

// A provider that answers each user turn: it commits the turn when the
// microphone goes quiet, starts speaking at once and finishes the transcript
// only later, after the user may have interrupted with the next turn.
class TurnProvider extends EventEmitter {
  readyState = 1; speaking = false; turns = 0;
  constructor() { super(); setTimeout(() => this.emit('open'), 5); }
  autoTranscribe = true;
  emitEvent(e: Record<string, unknown>) {
    this.emit('message', Buffer.from(JSON.stringify(e)));
    // Noise-only fixtures still resolve each committed recognition item.
    if (this.autoTranscribe && e.type === 'input_audio_buffer.committed') queueMicrotask(() =>
      this.emitEvent({ type: 'conversation.item.input_audio_transcription.completed', item_id: e.item_id, transcript: '' }));
  }
  send(data: string) {
    const event = JSON.parse(data) as { type: string; audio?: string };
    if (event.type === 'response.create') {
      this.emitEvent({ type: 'response.created', response: { id: 'greeting' } });
      this.emitEvent({ type: 'response.output_audio_transcript.done', response_id: 'greeting', item_id: 'g', transcript: 'Hola.' });
      this.emitEvent({ type: 'response.done', response: { id: 'greeting', status: 'completed' } });
      return;
    }
    if (event.type !== 'input_audio_buffer.append') return;
    const loud = Buffer.from(event.audio!, 'base64').some(byte => byte !== 0);
    if (loud) { this.speaking = true; return; }
    if (!this.speaking) return;
    this.speaking = false;
    const n = ++this.turns, id = `r${n}`;
    this.emitEvent({ type: 'input_audio_buffer.speech_stopped' });
    this.emitEvent({ type: 'input_audio_buffer.committed', item_id: `u${n}` });
    this.emitEvent({ type: 'response.created', response: { id } });
    this.emitEvent({ type: 'response.output_audio.delta', response_id: id, item_id: `a${n}`, delta: Buffer.alloc(BYTES_PER_MS * 100).toString('base64') });
    setTimeout(() => {
      this.emitEvent({ type: 'response.output_audio_transcript.done', response_id: id, item_id: `a${n}`, transcript: `answer ${n}` });
      this.emitEvent({ type: 'response.done', response: { id, status: 'completed' } });
    }, 1500);
  }
  close() { this.readyState = 3; this.emit('close'); }
}

test('an answer finished after an interruption stays with the turn it answered', { timeout: 60_000 }, async () => {
  const scenario = { ...examples()[2], turns: [{ noise: 'pink' as const, ms: 300 }, { noise: 'pink' as const, ms: 300, bargeInMs: 0 }] };
  const run = await runScenario(scenario, { key: 'k', settings: {}, speech: new Speech({ cacheDir: mkdtempSync(join(tmpdir(), 'eval-run-')) }), voices: { a: { id: 'v' } }, defaultVoice: 'a',
    connect: () => new TurnProvider() as never });
  const answers = run.transcript.filter(l => l.role === 'assistant').map(l => [l.text, l.turn]);
  assert.deepEqual(answers, [['Hola.', 0], ['answer 1', 1], ['answer 2', 2]]);
  // Turn 2 started while answer 1 was still open: that is the interruption.
  // Its line sits where it started playing, before turn 2, though it finished after.
  const one = run.transcript.find(l => l.text === 'answer 1')!;
  assert.ok(one.ms <= run.turns[1].startMs, 'answer 1 started playing before turn 2');
  assert.ok(run.turns.every(t => t.latencyMs != null && t.latencyMs >= 0 && t.latencyMs < 1000));
  assert.deepEqual(run.timeouts, []);
});

test('a provider that closes the call fails the run instead of passing it in silence', { timeout: 30_000 }, async () => {
  const scenario = { ...examples()[2], turns: [{ noise: 'silence' as const, ms: 3000 }] };
  let provider: FakeProvider | undefined;
  setTimeout(() => provider?.close(), 2500);
  await assert.rejects(runScenario(scenario, { key: 'k', settings: {}, speech: new Speech({ cacheDir: mkdtempSync(join(tmpdir(), 'eval-run-')) }), voices: { a: { id: 'v' } }, defaultVoice: 'a', noResponseMs: 500,
    connect: () => (provider = new FakeProvider()) as never }), /closed the call before the scenario ended/);
});

test('a response that fails at the provider fails the run', { timeout: 30_000 }, async () => {
  class Failing extends FakeProvider {
    override send(data: string) {
      const event = JSON.parse(data) as { type: string };
      if (event.type !== 'response.create') return;
      setTimeout(() => {
        this.emit('message', Buffer.from(JSON.stringify({ type: 'response.created', response: { id: 'r' } })));
        this.emit('message', Buffer.from(JSON.stringify({ type: 'response.done', response: { id: 'r', status: 'failed', status_details: { error: { code: 'server_error' } } } })));
      }, 20);
    }
  }
  const scenario = { ...examples()[2], turns: [{ noise: 'silence' as const, ms: 200 }] };
  await assert.rejects(runScenario(scenario, { key: 'k', settings: {}, speech: new Speech({ cacheDir: mkdtempSync(join(tmpdir(), 'eval-run-')) }), voices: { a: { id: 'v' } }, defaultVoice: 'a', noResponseMs: 500,
    connect: () => new Failing() as never }), /response of the provider failed \(server_error\)/);
});

// Answers each turn with 3 s of audio at once; when the user speaks over it,
// sends speech_started and the cancellation in the order given, then one more
// chunk of the cancelled response, as a provider may.
class Interrupted extends TurnProvider {
  constructor(readonly cancelFirst: boolean) { super(); }
  override send(data: string) {
    const event = JSON.parse(data) as { type: string; audio?: string };
    if (event.type !== 'input_audio_buffer.append') return super.send(data);
    const loud = Buffer.from(event.audio!, 'base64').some(byte => byte !== 0);
    if (loud && !this.speaking && this.turns === 1) {
      const started = { type: 'input_audio_buffer.speech_started' }, cancelled = { type: 'response.done', response: { id: 'r1', status: 'cancelled' } };
      for (const e of this.cancelFirst ? [cancelled, started] : [started, cancelled]) this.emitEvent(e);
      this.emitEvent({ type: 'response.output_audio.delta', response_id: 'r1', item_id: 'a1', delta: Buffer.alloc(BYTES_PER_MS * 1000, 0x10).toString('base64') });
    }
    if (!loud && this.speaking) {
      this.speaking = false;
      const n = ++this.turns, id = `r${n}`;
      this.emitEvent({ type: 'input_audio_buffer.speech_stopped' });
      this.emitEvent({ type: 'input_audio_buffer.committed', item_id: `u${n}` });
      this.emitEvent({ type: 'response.created', response: { id } });
      this.emitEvent({ type: 'response.output_audio.delta', response_id: id, item_id: `a${n}`, delta: Buffer.alloc(BYTES_PER_MS * (n === 1 ? 3000 : 100), 0x10).toString('base64') });
      this.emitEvent({ type: 'response.output_audio_transcript.done', response_id: id, item_id: `a${n}`, transcript: `answer ${n}` });
      if (n > 1) this.emitEvent({ type: 'response.done', response: { id, status: 'completed' } });
      return;
    }
    if (loud) this.speaking = true;
  }
}

for (const cancelFirst of [false, true]) {
  test(`interrupted audio stops at the cut when ${cancelFirst ? 'the cancellation' : 'speech_started'} arrives first`, { timeout: 60_000 }, async () => {
    const scenario = { ...examples()[2], turns: [{ noise: 'pink' as const, ms: 300 }, { noise: 'pink' as const, ms: 2500, bargeInMs: 500 }] };
    const run = await runScenario(scenario, { key: 'k', settings: {}, speech: new Speech({ cacheDir: mkdtempSync(join(tmpdir(), 'eval-run-')) }), voices: { a: { id: 'v' } }, defaultVoice: 'a', noResponseMs: 500,
      connect: () => new Interrupted(cancelFirst) as never });
    const right = (ms: number) => run.audio!.readInt16LE(Math.round(ms * 24) * 4 + 2);
    const cutAt = run.turns[1].startMs;
    assert.notEqual(right(cutAt - 200), 0, 'the answer was playing before the interruption');
    for (let ms = cutAt + 400; ms < cutAt + 2400; ms += 50) assert.equal(right(ms), 0, `no voice ${ms - cutAt} ms after the cut`);
    assert.equal(run.bargeIns, 1);
    assert.deepEqual(run.turns[1].bargeIn, { overVoice: true, cut: true });
  });
}

// One answer in two chunks with a 1 s stall between them.
class Stalling extends TurnProvider {
  override send(data: string) {
    const event = JSON.parse(data) as { type: string; audio?: string };
    if (event.type !== 'input_audio_buffer.append') return super.send(data);
    const loud = Buffer.from(event.audio!, 'base64').some(byte => byte !== 0);
    if (loud) { this.speaking = true; return; }
    if (!this.speaking) return;
    this.speaking = false;
    const chunk = Buffer.alloc(BYTES_PER_MS * 200, 0x10).toString('base64');
    this.emitEvent({ type: 'input_audio_buffer.committed', item_id: 'u1' });
    this.emitEvent({ type: 'response.created', response: { id: 'r1' } });
    this.emitEvent({ type: 'response.output_audio.delta', response_id: 'r1', item_id: 'a1', delta: chunk });
    setTimeout(() => {
      this.emitEvent({ type: 'response.output_audio.delta', response_id: 'r1', item_id: 'a1', delta: chunk });
      this.emitEvent({ type: 'response.output_audio_transcript.done', response_id: 'r1', item_id: 'a1', transcript: 'ok' });
      this.emitEvent({ type: 'response.done', response: { id: 'r1', status: 'completed' } });
    }, 1000);
  }
}

test('a stall of the provider stays silence in the recording', { timeout: 30_000 }, async () => {
  const scenario = { ...examples()[2], turns: [{ noise: 'pink' as const, ms: 300 }] };
  const run = await runScenario(scenario, { key: 'k', settings: {}, speech: new Speech({ cacheDir: mkdtempSync(join(tmpdir(), 'eval-run-')) }), voices: { a: { id: 'v' } }, defaultVoice: 'a', noResponseMs: 500,
    connect: () => new Stalling() as never });
  const right = (ms: number) => run.audio!.readInt16LE(Math.round(ms * 24) * 4 + 2);
  const samples = run.audio!.length / 4;
  const loud = Array.from({ length: Math.floor(samples / 240) }, (_, i) => right(i * 10) !== 0);
  const first = loud.indexOf(true);
  assert.ok(first > 0);
  // Voice for 200 ms, about 800 ms of silence, then voice again.
  assert.equal(loud[first + 10], true); assert.equal(loud[first + 50], false); assert.equal(loud[first + 105], true);
});

// Accepts one send per user turn, answers every response request (echoing
// its metadata, as the provider does), and answers each request that carries
// notices as told: nothing, a response without audio, audio queued behind
// other audio and cancelled before it sounds, spoken audio, or ('vad') a
// response of its own to the user that speaks while the tagged request is
// rejected as busy, then silence when the engine asks again.
// 'read': the tagged response only calls a read tool, an unrelated response
// of the provider speaks meanwhile, and the request after the tool's output
// speaks the announcement.
// 'read-silent': the same, but the request after the tool's output is silent.
type AfterNotice = 'nothing' | 'silent' | 'cut' | 'speak' | 'vad' | 'read' | 'read-silent';
class Announcer extends TurnProvider {
  answered = 0; retried = false; reading: false | 'speak' | 'silent' = false; tagged: string[] = [];
  constructor(readonly sends: Record<string, string>[], readonly afterNotices: AfterNotice[]) { super(); }
  respond(metadata: unknown, audio: boolean, status = 'completed', before?: () => void) {
    const id = `s${Math.random()}`, chunk = (ms: number) => Buffer.alloc(BYTES_PER_MS * ms, 0x10).toString('base64');
    this.emitEvent({ type: 'response.created', response: { id, metadata } });
    before?.();
    if (audio) this.emitEvent({ type: 'response.output_audio.delta', response_id: id, item_id: `i${id}`, delta: chunk(100) });
    if (audio && (metadata as { eval_notices?: string } | undefined)?.eval_notices) this.emitEvent({ type: 'response.output_audio_transcript.done', response_id: id, item_id: `i${id}`, transcript: 'The agent answered: done.' });
    this.emitEvent({ type: 'response.done', response: { id, status } });
  }
  override send(data: string) {
    const event = JSON.parse(data) as { type: string; event_id?: string; audio?: string; response?: { metadata?: Record<string, string> } };
    if (event.type === 'response.create') {
      const metadata = event.response?.metadata;
      if (!metadata?.eval_notices) return this.respond(metadata, false);
      this.tagged.push(metadata.eval_notices);
      if (this.reading) { const speak = this.reading === 'speak'; this.reading = false; return this.respond(metadata, speak); }
      const mode = this.retried ? 'silent' : this.afterNotices[this.answered++];
      if (mode === 'nothing') return;
      if (mode === 'read' || mode === 'read-silent') {
        const id = 'reader';
        this.reading = mode === 'read' ? 'speak' : 'silent';
        this.emitEvent({ type: 'response.created', response: { id, metadata } });
        this.emitEvent({ type: 'response.output_item.done', response_id: id, item: { type: 'function_call', name: 't3_read_thread', call_id: 'call_read', arguments: JSON.stringify({ threadId: this.sends[0].threadId }) } });
        this.emitEvent({ type: 'response.done', response: { id, status: 'completed' } });
        this.respond(undefined, true);
        return;
      }
      if (mode === 'vad') {
        // The user's turn took the floor first: its own response speaks.
        // The busy error comes while that response is still running.
        this.respond(undefined, true, 'completed', () => this.emitEvent({ type: 'error', error: { code: 'conversation_already_has_active_response', event_id: event.event_id } }));
        this.retried = true;
        return;
      }
      this.retried = false;
      // cut: a second of other audio is playing, so this one is queued behind it.
      return this.respond(metadata, mode === 'speak' || mode === 'cut', mode === 'cut' ? 'cancelled' : 'completed',
        mode === 'cut' ? () => this.emitEvent({ type: 'response.output_audio.delta', response_id: 'other', item_id: 'other', delta: Buffer.alloc(BYTES_PER_MS * 1000, 0x10).toString('base64') }) : undefined);
    }
    if (event.type !== 'input_audio_buffer.append') return;
    const loud = Buffer.from(event.audio!, 'base64').some(byte => byte !== 0);
    if (loud) { this.speaking = true; return; }
    if (!this.speaking) return;
    this.speaking = false;
    const n = ++this.turns;
    this.emitEvent({ type: 'input_audio_buffer.committed', item_id: `u${n}` });
    this.emitEvent({ type: 'conversation.item.input_audio_transcription.completed', item_id: `u${n}`, transcript: 'Sí, mándalo.' });
    this.emitEvent({ type: 'response.created', response: { id: `r${n}` } });
    this.emitEvent({ type: 'response.output_item.done', response_id: `r${n}`, item: { type: 'function_call', name: 't3_send_message', call_id: `call_send${n}`, arguments: JSON.stringify(this.sends[n - 1]) } });
    this.emitEvent({ type: 'response.done', response: { id: `r${n}`, status: 'completed' } });
  }
}

const announceWorld = { projects: [{ key: 'p', name: 'proj', threads: [
  { key: 't', title: 'Thread', onSend: { delayMs: 200, reply: ['Done.'] } }, { key: 'u', title: 'Other', onSend: { delayMs: 200, reply: ['Also done.'] } }] }] };
const sendTo = (thread: string) => ({ projectId: worldId('project', 'p').slice(0, 8), project: 'proj', threadId: worldId('thread', thread).slice(0, 8), message: 'Hola' });
async function announce(afterNotices: AfterNotice[]) {
  const two = afterNotices.length > 1;
  const scenario = validateScenario({ id: 'announce', description: 'd', world: announceWorld, turns: two ? [{ noise: 'pink', ms: 300 }, { noise: 'pink', ms: 300, pauseMs: 1500 }] : [{ noise: 'pink', ms: 300 }],
    expect: { sends: two ? [{ turn: 1, thread: 't' }, { turn: 2, thread: 'u' }] : [{ turn: 1, thread: 't' }] } });
  let provider: Announcer | undefined;
  const run = await runScenario(scenario, { key: 'k', settings: {}, speech: new Speech({ cacheDir: mkdtempSync(join(tmpdir(), 'eval-run-')) }), voices: { a: { id: 'v' } }, defaultVoice: 'a', noResponseMs: 500, turnTimeoutMs: 4000,
    connect: () => (provider = new Announcer([sendTo('t'), sendTo('u')], afterNotices)) as never });
  return { scenario, run, provider: provider! };
}

for (const mode of ['nothing', 'silent', 'cut', 'vad', 'read-silent', 'read', 'speak'] as const) {
  test(`an agent reply ${mode === 'speak' ? 'announced aloud passes' : mode === 'read' ? 'announced after reading the thread passes' : `followed by ${{ nothing: 'no response', silent: 'a response without audio', cut: 'audio cut before it sounded', vad: 'a spoken answer to the user and a silent retry', 'read-silent': 'a read, an unrelated spoken answer and a silent follow-up' }[mode]} is a timeout`}`, { timeout: 60_000 }, async () => {
    const { scenario, run, provider } = await announce([mode]);
    // The rejected request's notice rode on the engine's next request.
    assert.deepEqual(provider.tagged, ['vad', 'read', 'read-silent'].includes(mode) ? ['1', '1'] : ['1']);
    if (mode.startsWith('read')) assert.ok(run.tools.some(t => t.name === 't3_read_thread' && t.status === 'completed'));
    assert.deepEqual(run.sends.map(x => [x.turn, x.threadKey]), [[1, 't']]);
    assert.equal(run.notices.length, 1);
    assert.deepEqual(run.timeouts, mode === 'speak' || mode === 'read' ? [] : [-1]);
    if (mode !== 'speak' && mode !== 'read') assert.match(checkRun(scenario, run).find(c => c.id === 'call.noTimeouts')!.detail, /an agent reply or its announcement/);
    const owed = checkRun(scenario, run).find(c => c.id === 'call.agentRepliesAnnounced')!;
    assert.equal(owed.pass, mode === 'speak' || mode === 'read'); assert.equal(owed.critical, true);
  });
}

test('a later spoken notice does not cover an earlier silent one', { timeout: 60_000 }, async () => {
  const { run, provider } = await announce(['silent', 'speak']);
  assert.deepEqual(provider.tagged, ['1', '2']);
  assert.deepEqual(run.sends.map(x => x.threadKey), ['t', 'u']);
  assert.equal(run.notices.length, 2);
  assert.deepEqual(run.timeouts, [-1]);
});

test('an uncertain send arrives, blocks the project, and a read that finds its reference unblocks it', async () => {
  const base = examples()[0];
  const world = structuredClone(base.world);
  world.projects[0].threads![0].onSend = { uncertain: true };
  const sim = new SimulatedT3(world);
  try {
    const state = new DirectCallState();
    const tool = (name: string) => sim.ade.tools.find(t => t.name === name)!;
    const send = tool('t3_send_message'), project = state.short(worldId('project', 'recipes'));
    await sim.ade.catalog(state);
    const short = state.short(worldId('thread', 'search'));
    const args = send.prepare!({ projectId: project, project: 'recipe-app', threadId: short, message: 'Show all recipes.' }, state);
    // A plain error after the dispatch: the engine reports it as uncertain, not as nothing sent.
    await assert.rejects(send.execute(args, { ...context(state), requestId: 'voice:test:call_u1' }), (error: Error) => !/Nothing was sent/.test(error.message) && /timed out/.test(error.message));
    assert.deepEqual(sim.sends.map(s => [s.threadKey, s.uncertain]), [['search', true]]);
    assert.equal(sim.timers.size, 0);
    // The next send to the project is refused before anything is sent.
    const again = send.prepare!({ projectId: project, project: 'recipe-app', message: 'Other.' }, state);
    await assert.rejects(send.execute(again, { ...context(state), requestId: 'voice:test:call_u2' }), /uncertain delivery.*Nothing was sent now/s);
    assert.equal(sim.sends.length, 1);
    // Reading the thread finds the reference: delivered, and the project accepts sends again.
    const read = await tool('t3_read_thread').execute({ threadId: short }, context(state));
    assert.match(read.text, /CHECKED: the earlier uncertain send/);
    await send.execute(send.prepare!({ projectId: project, project: 'recipe-app', message: 'Other.' }, state), { ...context(state), requestId: 'voice:test:call_u3' });
    assert.equal(sim.sends.length, 2);
    // A send the read does not find: releasing needs a read after it, as T3 Coordinator requires.
    sim.uncertain.set(worldId('project', 'recipes'), { requestId: 'voice:test:call_missing', threadId: worldId('thread', 'search'), title: 't', at: Date.now() + 60_000 });
    const releaseTool = tool('t3_release_uncertain');
    await assert.rejects(releaseTool.execute(releaseTool.prepare!({ projectId: project }, state), context(state)), /Before releasing it has to be checked/);
    assert.equal(sim.uncertain.size, 1);
    sim.uncertain.get(worldId('project', 'recipes'))!.at = Date.now() - 60_000;
    await tool('t3_read_thread').execute({ threadId: short }, context(state));
    const released = await releaseTool.execute(releaseTool.prepare!({ projectId: project }, state), context(state));
    assert.match(released.text, /RELEASED/);
    assert.equal(sim.uncertain.size, 0);
  } finally { sim.close(); }
});

test('forbidden tools can name a target, and a thread argument also names its project', () => {
  const scenario = { ...examples()[0], expect: { tools: { forbidden: [{ name: 't3_read_thread', thread: 'dark-mode' }, { name: 't3_read_thread', project: 'billing' }, 't3_send_message'], required: [{ name: 't3_read_thread', project: 'recipes' }] } } } as Scenario;
  validateScenario(scenario);
  assert.throws(() => validateScenario({ ...scenario, expect: { tools: { forbidden: [{ name: 't3_read_thread', thread: 'nope' }] } } }), /unknown thread nope/);
  assert.throws(() => validateScenario({ ...scenario, expect: { tools: { forbidden: [{ thread: 'search' }] } } }), /forbidden must be a list/);
  const run = { tools: [{ ms: 1, turn: 1, name: 't3_read_thread', status: 'completed', args: { threadId: worldId('thread', 'search').slice(0, 8) }, result: '' }], sends: [], turns: [], transcript: [], timeouts: [], providerErrors: [] } as unknown as RunRecord;
  const byId = Object.fromEntries(checkRun(scenario, run).map(c => [c.id, c]));
  assert.equal(byId['tools.forbidden.t3_read_thread:dark-mode'].pass, true);
  assert.equal(byId['tools.forbidden.t3_read_thread:billing'].pass, true);
  assert.equal(byId['tools.required.t3_read_thread'].pass, true);
  run.tools.push({ ms: 2, turn: 1, name: 't3_read_thread', status: 'error', args: { threadId: worldId('thread', 'invoices').slice(0, 8) }, result: '' } as never);
  const after = Object.fromEntries(checkRun(scenario, run).map(c => [c.id, c]));
  assert.equal(after['tools.forbidden.t3_read_thread:billing'].pass, false);
  assert.equal(after['tools.forbidden.t3_read_thread:billing'].critical, true);
});

test('the phone channel keeps the length, the judge hears words without audio tags, and the world shows archived and uncertain threads', { skip: noFfmpeg }, () => {
  const clean = noise('pink', 500, 3, 0.05), line = phone(clean, 1);
  assert.equal(line.length, clean.length);
  assert.notDeepEqual(line, clean);
  assert.equal(spokenWords('[sighs] vale, [whispers] mándalo'), 'vale, mándalo');
  assert.equal(spokenWords('el [tag] no se toca si no es un tag: [1]'), 'el no se toca si no es un tag: [1]');
  const base = examples()[0], world = structuredClone(base.world);
  world.projects[0].threads![0].onSend = { uncertain: true };
  world.projects[0].threads![1].archived = true;
  const text = worldText({ ...base, world });
  assert.match(text, /archived/);
  assert.match(text, /UNCERTAIN|uncertain/);
  assert.throws(() => validateScenario({ ...base, channel: 'radio' }), /channel/);
  assert.throws(() => validateScenario({ ...base, world: { projects: [{ key: 'p', name: 'p', threads: [{ key: 't', title: 't', onSend: { uncertain: 'yes' } }] }] } }), /uncertain/);
});

test('the repository speakers are available without a private voices.json, and a private one adds to them', () => {
  const data = mkdtempSync(join(tmpdir(), 'ade-call-eval-voices-'));
  const cli = (...args: string[]) => spawnSync(process.execPath, ['--no-warnings', join(root, 'dist/scripts/eval.mjs'), ...args], { encoding: 'utf8', env: { ...process.env, ADE_CALL_CONFIG: data, OPENAI_API_KEY: '', ELEVENLABS_API_KEY: '' } });
  const file = join(data, 'one.json');
  writeFileSync(file, JSON.stringify({ ...examples()[0], id: 'repo-voice', file: undefined, expect: {}, turns: [{ say: 'hola', voice: 'carmen' }] }));
  const shared = cli('speak', '--dry', file, '--data', data);
  assert.equal(shared.status, 0, shared.stderr);
  assert.match(shared.stdout, /1 not cached/);
  writeFileSync(join(data, 'voices.json'), JSON.stringify({ mine: { id: 'v' } }));
  writeFileSync(file, JSON.stringify({ ...examples()[0], id: 'repo-voice', file: undefined, expect: {}, turns: [{ say: 'hola', voice: 'carmen' }, { say: 'adiós', voice: 'mine' }] }));
  assert.equal(cli('speak', '--dry', file, '--data', data).status, 0);
});

test('a continued turn starts its pause from the end of the previous fragment, not after waiting for an answer', { timeout: 30_000 }, async () => {
  const turns = [{ noise: 'silence' as const, ms: 200 }, { noise: 'silence' as const, ms: 200, continues: true, pauseMs: 100 }];
  const scenario = { ...examples()[2], turns };
  assert.throws(() => validateScenario({ ...scenario, turns: [{ ...turns[1] }] }), /continues needs a previous turn/);
  assert.throws(() => validateScenario({ ...scenario, turns: [turns[0], { ...turns[1], bargeInMs: 10 }] }), /continues needs a previous turn/);
  const run = await runScenario(scenario, { key: 'k', settings: {}, speech: new Speech({ cacheDir: mkdtempSync(join(tmpdir(), 'eval-run-')) }), voices: { a: { id: 'v' } }, defaultVoice: 'a', noResponseMs: 3000,
    connect: () => new FakeProvider() as never });
  const gap = run.turns[1].startMs - run.turns[0].endMs;
  assert.ok(gap >= 80 && gap < 1000, `gap ${gap} ms`);
});

test('tool targets are matched as the engine resolves them, ignoring surrounding spaces', () => {
  const scenario = { ...examples()[0], expect: { tools: { forbidden: [{ name: 't3_read_thread', thread: 'dark-mode' }], required: [{ name: 't3_read_thread', thread: 'search' }] } } } as Scenario;
  const read = (key: string) => ({ ms: 1, turn: 1, name: 't3_read_thread', status: 'completed', args: { threadId: ` ${worldId('thread', key).slice(0, 8)} ` }, result: '' });
  const run = { tools: [read('search'), read('dark-mode')], sends: [], turns: [], transcript: [], timeouts: [], providerErrors: [] } as unknown as RunRecord;
  const byId = Object.fromEntries(checkRun(scenario, run).map(c => [c.id, c]));
  assert.equal(byId['tools.required.t3_read_thread:search'].pass, true);
  assert.equal(byId['tools.forbidden.t3_read_thread:dark-mode'].pass, false);
});

test('the simulated release answers with the production wording', async () => {
  const sim = new SimulatedT3(examples()[0].world);
  try {
    const project = worldId('project', 'recipes');
    const release = sim.coordinator().release;
    assert.equal(release(project), resourceErrors()['t3.release.not_blocked']);
    sim.uncertain.set(project, { requestId: 'x', threadId: worldId('thread', 'search'), title: 'Add ingredient search', at: Date.now() });
    assert.throws(() => release(project), /Before releasing it has to be checked/);
    assert.match(release(project, 'r', () => true), /^RELEASED: .*The project accepts sends again/);
  } finally { sim.close(); }
});
const resourceErrors = () => JSON.parse(resourceText('error_messages.json')) as Record<string, string>;

test('a reply timed from a later turn waits for it, and a scripted interruption that did not interrupt fails', async () => {
  const base = examples()[0], world = structuredClone(base.world);
  world.projects[0].threads![0].onSend = { afterTurn: 3, delayMs: 10, reply: ['Done.'] };
  assert.throws(() => validateScenario({ ...base, world: { projects: [{ key: 'p', name: 'p', threads: [{ key: 't', title: 't', onSend: { afterTurn: 0 } }] }] } }), /afterTurn/);
  const sim = new SimulatedT3(world);
  try {
    const state = new DirectCallState();
    await sim.ade.catalog(state);
    const send = sim.ade.tools.find(t => t.name === 't3_send_message')!;
    const replies: string[] = [];
    sim.onReply = r => replies.push(r.text);
    sim.startTurn(2);
    await send.execute(send.prepare!({ projectId: state.short(worldId('project', 'recipes')), project: 'recipe-app', threadId: state.short(worldId('thread', 'search')), message: 'x' }, state), context(state));
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(replies, []);
    sim.startTurn(3);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(replies, ['Done.']);
  } finally { sim.close(); }
  const run = { tools: [], sends: [], transcript: [], timeouts: [], providerErrors: [],
    turns: [{ index: 1, kind: 'say', startMs: 0, endMs: 1 }, { index: 2, kind: 'say', startMs: 2, endMs: 3, bargeIn: { overVoice: false, cut: false } }] } as unknown as RunRecord;
  const check = checkRun({ ...base, expect: {}, turns: [{ say: 'a' }, { say: 'b', bargeInMs: 500 }] }, run).find(c => c.id === 'turns[2].bargeIn')!;
  assert.equal(check.pass, false); assert.equal(check.critical, true); assert.match(check.detail, /not exercised/);
});

test('a transcription that recites the vocabulary is flagged, and a thread without onSend sends no reply', async () => {
  const base = examples()[0];
  const titles = base.world.projects.flatMap(p => [p.name, ...(p.threads || []).map(t => t.title)]);
  const run = { tools: [], sends: [], turns: [], timeouts: [], providerErrors: [],
    transcript: [{ ms: 1, role: 'user', turn: 2, text: titles.slice(0, 4).join(', ') }, { ms: 2, role: 'user', turn: 3, text: `Sí, lo de ${titles[1]}` }] } as unknown as RunRecord;
  const echo = checkRun({ ...base, expect: {} }, run).find(c => c.id === 'transcription.noVocabularyEcho')!;
  assert.equal(echo.pass, false); assert.equal(echo.critical, false); assert.match(echo.detail, /^turn\(s\) 2 /);
  const world = structuredClone(base.world);
  delete world.projects[0].threads![0].onSend;
  const sim = new SimulatedT3(world);
  try {
    const state = new DirectCallState();
    await sim.ade.catalog(state);
    const send = sim.ade.tools.find(t => t.name === 't3_send_message')!;
    await send.execute(send.prepare!({ projectId: state.short(worldId('project', 'recipes')), project: 'recipe-app', threadId: state.short(worldId('thread', 'search')), message: 'x' }, state), context(state));
    assert.equal(sim.timers.size, 0);
    assert.equal(sim.lastDue, 0);
  } finally { sim.close(); }
});

class LateInterrupted extends Interrupted {
  constructor() { super(false); }
  // The provider reports the user's speech only after the last loud chunk.
  override send(data: string) {
    const event = JSON.parse(data) as { type: string; audio?: string };
    if (event.type === 'input_audio_buffer.append' && this.turns === 1) {
      const loud = Buffer.from(event.audio!, 'base64').some(byte => byte !== 0);
      if (loud && !this.speaking) { this.speaking = true; return; }
      if (!loud && this.speaking) {
        this.emitEvent({ type: 'input_audio_buffer.speech_started' });
        this.emitEvent({ type: 'response.done', response: { id: 'r1', status: 'cancelled' } });
      }
    }
    return super.send(data);
  }
}

test('an interruption reported after the last microphone chunk still counts as cut', { timeout: 60_000 }, async () => {
  const scenario = { ...examples()[2], turns: [{ noise: 'pink' as const, ms: 300 }, { noise: 'pink' as const, ms: 300, bargeInMs: 500 }] };
  const run = await runScenario(scenario, { key: 'k', settings: {}, speech: new Speech({ cacheDir: mkdtempSync(join(tmpdir(), 'eval-run-')) }), voices: { a: { id: 'v' } }, defaultVoice: 'a', noResponseMs: 500,
    connect: () => new LateInterrupted() as never });
  assert.equal(run.bargeIns, 1);
  assert.deepEqual(run.turns[1].bargeIn, { overVoice: true, cut: true });
});

test('a thread argument decides the project of a read, and cyclic parents are refused', () => {
  const base = examples()[0];
  const scenario = { ...base, expect: { tools: { forbidden: [{ name: 't3_read_thread', project: 'billing' }] } } } as Scenario;
  const run = { tools: [{ ms: 1, turn: 1, name: 't3_read_thread', status: 'completed', args: { threadId: worldId('thread', 'invoices').slice(0, 8), projectId: worldId('project', 'recipes').slice(0, 8) }, result: '' }],
    sends: [], turns: [], transcript: [], timeouts: [], providerErrors: [] } as unknown as RunRecord;
  assert.equal(checkRun(scenario, run).find(c => c.id === 'tools.forbidden.t3_read_thread:billing')!.pass, false);
  const world = (threads: unknown[]) => ({ ...base, expect: {}, world: { projects: [{ key: 'p', name: 'p', threads }] } });
  assert.throws(() => validateScenario(world([{ key: 'a', title: 'a', parent: 'a' }])), /cycle \(a → a\)/);
  assert.throws(() => validateScenario(world([{ key: 'a', title: 'a', parent: 'b' }, { key: 'b', title: 'b', parent: 'a' }])), /cycle/);
  assert.doesNotThrow(() => validateScenario(world([{ key: 'a', title: 'a' }, { key: 'b', title: 'b', parent: 'a' }])));
});

test('the judge gets each tool output as the model got it, whole and redacted', { timeout: 60_000 }, async () => {
  const long = `${'x'.repeat(13_000)} Reference: voice:abc. key sk-secret123`;
  const kept = redactText(long, ['openai-key-value']);
  assert.match(kept, /Reference: voice:abc\. key \[credential\]$/);
  const scenario = validateScenario({ id: 'outputs', description: 'd', world: announceWorld, turns: [{ noise: 'pink', ms: 300 }], expect: {} });
  const outputs = new Map<string, string>();
  const run = await runScenario(scenario, { key: 'k', settings: {}, speech: new Speech({ cacheDir: mkdtempSync(join(tmpdir(), 'eval-run-')) }), voices: { a: { id: 'v' } }, defaultVoice: 'a', noResponseMs: 500, turnTimeoutMs: 4000,
    connect: () => {
      const provider = new Announcer([sendTo('t')], ['speak']), send = provider.send.bind(provider);
      provider.send = (data: string) => {
        const event = JSON.parse(data) as { type: string; item?: { type?: string; call_id?: string; output?: string } };
        if (event.type === 'conversation.item.create' && event.item?.type === 'function_call_output') outputs.set(String(event.item.call_id), String(event.item.output));
        return send(data);
      };
      return provider as never;
    } });
  const line = run.tools.find(t => t.name === 't3_send_message')!;
  assert.equal(line.result, outputs.get(line.callId!));
});

test('a recorded turn gives the judge its reference words, and the simulated release needs a project', async () => {
  const base = examples()[0];
  const scenario = { ...base, expect: {}, turns: [{ audio: 'clip.wav', transcript: 'No, no lo mandes.' }, { audio: 'other.wav' }] } as Scenario;
  // A clip without its words cannot be graded: validation refuses it.
  assert.throws(() => validateScenario(scenario), /turn 2: an audio turn needs transcript/);
  validateScenario({ ...scenario, turns: [scenario.turns[0]] });
  assert.throws(() => validateScenario({ ...scenario, turns: [{ say: 'hola', transcript: 'hola' }] }), /transcript is the text of an audio turn/);
  const run = { tools: [], sends: [], notices: [], transcript: [], timeouts: [], providerErrors: [],
    turns: [{ index: 1, kind: 'audio', text: 'No, no lo mandes.', startMs: 0, endMs: 1 }, { index: 2, kind: 'audio', startMs: 2, endMs: 3 }] } as unknown as RunRecord;
  const log = callLog(scenario, run);
  assert.match(log, /No, no lo mandes\./);
  assert.match(log, /cannot be graded/);
  const sim = new SimulatedT3(base.world);
  try {
    assert.throws(() => sim.coordinator().release(' '), /projectId/);
    // An unknown project with a real thread: refused as T3 Coordinator does, naming the owner.
    await assert.rejects(sim.coordinator().dispatch({ requestId: 'voice:test:call_x', projectId: worldId('project', 'nowhere'), project: 'nowhere', message: 'x', threadId: worldId('thread', 'dark-mode') }),
      (error: Error) => error.name === 'NotDispatchedError' && /belongs to project "recipe-app"/.test(error.message));
    assert.equal(sim.sends.length, 0);
  } finally { sim.close(); }
});

test('interruptions are checked from the script, voice lines carry their turn and play time, and audio words come from the run', () => {
  const base = examples()[0];
  const scenario = { ...base, expect: {}, turns: [{ say: 'a' }, { say: 'b', bargeInMs: 500 }, { audio: 'clip.wav', transcript: 'ahora dice sí' }] } as Scenario;
  assert.throws(() => validateScenario({ ...scenario, turns: [{ say: 'a', bargeInMs: 10 }] }), /turn 1: bargeInMs/);
  // An older recording without barge-in evidence fails instead of skipping the check.
  const old = { tools: [], sends: [], notices: [], timeouts: [], providerErrors: [],
    turns: [{ index: 1, kind: 'say', text: 'a', startMs: 0, endMs: 1000 }, { index: 2, kind: 'say', text: 'b', startMs: 1500, endMs: 2000 }, { index: 3, kind: 'audio', text: 'decía no', startMs: 3000, endMs: 4000 }],
    transcript: [{ ms: 1200, role: 'assistant', turn: 1, text: 'propuesta' }] } as unknown as RunRecord;
  const check = checkRun(scenario, old).find(c => c.id === 'turns[2].bargeIn')!;
  assert.equal(check.pass, false); assert.match(check.detail, /run the scenario again/);
  const log = callLog(scenario, old);
  assert.match(log, /VOICE \(answering turn 1\): "propuesta"/);
  // The words the clip had when it ran, not the scenario file's current ones.
  assert.match(log, /"decía no"/); assert.doesNotMatch(log, /ahora dice sí/);
});

test('a silent turn answered before the user goes on fails, and a missing greeting is waited for once', { timeout: 60_000 }, async () => {
  const base = examples()[2];
  const scenario = { ...base, expect: {}, turns: [{ say: 'cómo va lo de', silent: true }, { say: 'Expo', continues: true }] } as Scenario;
  const run = (ms: number) => ({ tools: [], sends: [], notices: [], timeouts: [], providerErrors: [],
    turns: [{ index: 1, kind: 'say', startMs: 0, endMs: 1000, firstAnswerMs: null }, { index: 2, kind: 'say', startMs: 2500, endMs: 3000 }],
    transcript: [{ ms, role: 'assistant', turn: 1, text: '¿Lo de qué?' }] }) as unknown as RunRecord;
  assert.equal(checkRun(scenario, run(1500)).find(c => c.id === 'turns[1].silent')!.pass, false);
  assert.equal(checkRun(scenario, run(1500)).find(c => c.id === 'turns[1].silent')!.critical, true);
  assert.equal(checkRun(scenario, run(2600)).find(c => c.id === 'turns[1].silent')!.pass, true);
  // The provider answers the greeting request with an empty response: no words, no audio.
  class NoGreeting extends TurnProvider {
    override send(data: string) {
      if ((JSON.parse(data) as { type: string }).type !== 'response.create') return super.send(data);
      this.emitEvent({ type: 'response.created', response: { id: 'empty' } });
      this.emitEvent({ type: 'response.done', response: { id: 'empty', status: 'completed' } });
    }
  }
  const noisy = { ...base, turns: [{ noise: 'pink' as const, ms: 300 }] };
  // The default 10 s no-response wait would come on top of the greeting's 4 s if it were applied twice.
  const record = await runScenario(noisy, { key: 'k', settings: {}, speech: new Speech({ cacheDir: mkdtempSync(join(tmpdir(), 'eval-run-')) }), voices: { a: { id: 'v' } }, defaultVoice: 'a',
    connect: () => new NoGreeting() as never });
  assert.ok(record.turns[0].startMs < 9000, `first turn at ${record.turns[0].startMs} ms`);
});

test('grading again uses the world the run had, and refuses expectations that no longer fit it', () => {
  const data = mkdtempSync(join(tmpdir(), 'ade-call-eval-regrade-'));
  const cli = (...args: string[]) => spawnSync(process.execPath, ['--no-warnings', join(root, 'dist/scripts/eval.mjs'), ...args], { encoding: 'utf8', env: { ...process.env, ADE_CALL_CONFIG: data, OPENAI_API_KEY: '', ELEVENLABS_API_KEY: '' } });
  const sc = examples()[0], dir = join(data, 'runs', 'old', sc.id, '1');
  spawnSync('mkdir', ['-p', dir]);
  const world = structuredClone(sc.world);
  world.projects[0].threads![0].key = 'renamed';
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify({ ...sc, file: undefined, world }));
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ scenario: sc.id, turns: [], transcript: [], tools: [], sends: [], notices: [], timeouts: [], providerErrors: [], usage: {} }));
  const refused = cli('judge', join(data, 'runs', 'old'), join(root, 'evals/scenarios/examples.json'));
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /do not fit the world it ran with/);
  assert.equal(existsSync(join(dir, 'result.json')), false);
});

test('grading again refuses a run without its scenario snapshot or a verdict without its recording', () => {
  const data = mkdtempSync(join(tmpdir(), 'ade-call-eval-regrade-'));
  const cli = (...args: string[]) => spawnSync(process.execPath, ['--no-warnings', join(root, 'dist/scripts/eval.mjs'), ...args], { encoding: 'utf8', env: { ...process.env, ADE_CALL_CONFIG: data, OPENAI_API_KEY: '', ELEVENLABS_API_KEY: '' } });
  const sc = examples()[0], runs = join(data, 'runs', 'old'), one = join(runs, sc.id, '1'), two = join(runs, sc.id, '2');
  spawnSync('mkdir', ['-p', one, two]);
  writeFileSync(join(one, 'run.json'), JSON.stringify({ scenario: sc.id, turns: [], transcript: [], tools: [], sends: [], notices: [], timeouts: [], providerErrors: [], usage: {} }));
  const examplesFile = join(root, 'evals/scenarios/examples.json');
  assert.match(cli('judge', runs, examplesFile).stderr, /#1: scenario.json is missing/);
  writeFileSync(join(one, 'scenario.json'), JSON.stringify({ ...sc, file: undefined }));
  writeFileSync(join(two, 'result.json'), JSON.stringify({ scenario: sc.id, repeat: 2, pass: true, score: 5, checks: [], judgements: [{ model: 'a', score: 5, criteria: [] }] }));
  assert.match(cli('judge', runs, examplesFile).stderr, /#2: result.json has a verdict but run.json is missing/);
  assert.equal(existsSync(join(one, 'result.json')), false);
});

test('an answer that never played is not an answer, for the checks and for the judge', () => {
  const base = examples()[2];
  const scenario = { ...base, expect: {}, turns: [{ say: 'a', silent: true }, { say: 'b', continues: true }] } as Scenario;
  const run = { tools: [], sends: [], notices: [], timeouts: [], providerErrors: [],
    turns: [{ index: 1, kind: 'say', startMs: 0, endMs: 1000, firstAnswerMs: null }, { index: 2, kind: 'say', startMs: 2500, endMs: 3000 }],
    transcript: [{ ms: 1500, role: 'assistant', turn: 1, text: '¿Lo de qué?', unheard: true }, { ms: 3500, role: 'assistant', turn: 2, text: 'Expo va bien.' }] } as unknown as RunRecord;
  const byId = Object.fromEntries(checkRun(scenario, run).map(c => [c.id, c]));
  assert.equal(byId['turns[1].silent'].pass, true);
  assert.match(callLog(scenario, run), /never played: the user heard none of it\): "¿Lo de qué\?"/);
});

test('an empty judge list is refused before any paid call', () => {
  const data = mkdtempSync(join(tmpdir(), 'ade-call-eval-judges-'));
  const cli = (...args: string[]) => spawnSync(process.execPath, ['--no-warnings', join(root, 'dist/scripts/eval.mjs'), ...args], { encoding: 'utf8', env: { ...process.env, ADE_CALL_CONFIG: data, OPENAI_API_KEY: '', ELEVENLABS_API_KEY: '' } });
  for (const value of ['', ',', 'gpt-5.5,']) {
    const out = cli('run', `--judge=${value}`, join(root, 'evals/scenarios/examples.json'), '--data', data);
    assert.equal(out.status, 2, value); assert.match(out.stderr, /--judge needs model names/);
  }
  assert.equal(existsSync(join(data, 'runs')), false);
});

// Commits the first fragment only when the second one has started, as a
// provider waiting to see whether the user goes on.
class LateCommit extends TurnProvider {
  chunks = 0; fragment = 0; started = false;
  override send(data: string) {
    const event = JSON.parse(data) as { type: string; audio?: string };
    if (event.type !== 'input_audio_buffer.append') return super.send(data);
    const loud = Buffer.from(event.audio!, 'base64').some(byte => byte !== 0);
    this.chunks++;
    if (loud && !this.started) {
      this.started = true; this.fragment++;
      this.emitEvent({ type: 'input_audio_buffer.speech_started', item_id: `u${this.fragment}`, audio_start_ms: (this.chunks - 1) * 100 });
      if (this.fragment === 2) {
        this.emitEvent({ type: 'input_audio_buffer.committed', item_id: 'u1' });
        this.emitEvent({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u1', transcript: 'fragment one' });
      }
    }
    if (!loud && this.started) {
      this.started = false;
      if (this.fragment === 2) {
        this.emitEvent({ type: 'input_audio_buffer.committed', item_id: 'u2' });
        this.emitEvent({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u2', transcript: 'fragment two' });
      }
    }
  }
}

test('a user item keeps the turn its speech started in, even when the commit comes late', { timeout: 60_000 }, async () => {
  const scenario = { ...examples()[2], turns: [{ noise: 'pink' as const, ms: 300 }, { noise: 'pink' as const, ms: 300, continues: true, pauseMs: 300 }] };
  const run = await runScenario(scenario, { key: 'k', settings: {}, speech: new Speech({ cacheDir: mkdtempSync(join(tmpdir(), 'eval-run-')) }), voices: { a: { id: 'v' } }, defaultVoice: 'a', noResponseMs: 500,
    connect: () => new LateCommit() as never });
  const heard = run.transcript.filter(l => l.role === 'user').map(l => [l.text, l.turn]);
  assert.deepEqual(heard, [['fragment one', 1], ['fragment two', 2]]);
});

test('seeded pink noise has no offset, and report needs a run folder', () => {
  const pcm = noise('pink', 5000, 7, 0.05);
  let sum = 0;
  for (let i = 0; i < pcm.length; i += 2) sum += pcm.readInt16LE(i);
  const mean = sum / (pcm.length / 2), peak = 0.05 * 32767 * 8;
  assert.ok(Math.abs(mean) < peak * 0.05, `mean ${mean}`);
  const data = mkdtempSync(join(tmpdir(), 'ade-call-eval-report-'));
  const out = spawnSync(process.execPath, ['--no-warnings', join(root, 'dist/scripts/eval.mjs'), 'report'], { encoding: 'utf8', env: { ...process.env, ADE_CALL_CONFIG: data } });
  assert.equal(out.status, 2); assert.match(out.stderr, /Usage: report RUN_DIR/);
});

// One provider item spans both fragments of a hesitation: speech starts in the
// first, ends in the second, and the answer comes after the second.
class SpanItem extends TurnProvider {
  chunks = 0; loudSeen = 0; lastLoud = 0;
  override send(data: string) {
    const event = JSON.parse(data) as { type: string; audio?: string };
    if (event.type !== 'input_audio_buffer.append') return super.send(data);
    const loud = Buffer.from(event.audio!, 'base64').some(byte => byte !== 0);
    this.chunks++;
    if (loud) {
      if (!this.loudSeen) this.emitEvent({ type: 'input_audio_buffer.speech_started', item_id: 'u1', audio_start_ms: (this.chunks - 1) * 100 });
      this.loudSeen++; this.lastLoud = this.chunks;
    } else if (this.loudSeen >= 6 && this.lastLoud === this.chunks - 1) {
      this.emitEvent({ type: 'input_audio_buffer.speech_stopped', item_id: 'u1', audio_end_ms: this.lastLoud * 100 });
      this.emitEvent({ type: 'input_audio_buffer.committed', item_id: 'u1' });
      this.emitEvent({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u1', transcript: 'cómo va lo de la migración de Expo' });
      this.emitEvent({ type: 'response.created', response: { id: 'r1' } });
      this.emitEvent({ type: 'response.output_audio.delta', response_id: 'r1', item_id: 'a1', delta: Buffer.alloc(BYTES_PER_MS * 200, 0x10).toString('base64') });
      this.emitEvent({ type: 'response.output_audio_transcript.done', response_id: 'r1', item_id: 'a1', transcript: 'Expo va por la mitad.' });
      this.emitEvent({ type: 'response.done', response: { id: 'r1', status: 'completed' } });
    }
  }
}

test('one user item across a hesitation keeps its start turn, and its answer goes to the fragment it ended in', { timeout: 60_000 }, async () => {
  const scenario = { ...examples()[2], turns: [{ noise: 'pink' as const, ms: 300 }, { noise: 'pink' as const, ms: 300, continues: true, pauseMs: 500 }] };
  const run = await runScenario(scenario, { key: 'k', settings: {}, speech: new Speech({ cacheDir: mkdtempSync(join(tmpdir(), 'eval-run-')) }), voices: { a: { id: 'v' } }, defaultVoice: 'a', noResponseMs: 500,
    connect: () => new SpanItem() as never });
  assert.deepEqual(run.transcript.filter(l => l.text !== 'Hola.').map(l => [l.role, l.turn]), [['user', 1], ['assistant', 2]]);
  // Each turn starts when its first sample goes out, after the previous one ended.
  assert.ok(run.turns[1].startMs >= run.turns[0].endMs + 400, `turn 2 at ${run.turns[1].startMs}, turn 1 ended ${run.turns[0].endMs}`);
});

test('an agent turn that ends in error reaches the voice and the judge as a failed notice', async () => {
  assert.equal(finalKind('failed'), 'failed'); assert.equal(finalKind('error'), 'failed'); assert.equal(finalKind('completed'), 'finished');
  const sim = new SimulatedT3({ projects: [{ key: 'p', name: 'proj', threads: [{ key: 't', title: 'T', onSend: { delayMs: 10, reply: ['Migration failed.'], status: 'failed' } }] }] });
  try {
    const state = new DirectCallState();
    await sim.ade.catalog(state);
    const statuses: string[] = [];
    sim.onReply = r => statuses.push(r.status);
    const send = sim.ade.tools.find(t => t.name === 't3_send_message')!;
    await send.execute(send.prepare!({ projectId: state.short(worldId('project', 'p')), project: 'proj', threadId: state.short(worldId('thread', 't')), message: 'x' }, state), context(state));
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.deepEqual(statuses, ['failed']);
  } finally { sim.close(); }
  const base = examples()[0];
  const run = { tools: [], sends: [], transcript: [], turns: [], timeouts: [], providerErrors: [], notices: [{ ms: 1, thread: 'search', text: 'Migration failed.', kind: 'failed' }] } as unknown as RunRecord;
  assert.match(callLog(base, run), /NOTICE for search \(finished with an error\), as given to the voice: """Migration failed\."""/);
});

// Reports each fragment's end only once the next one has started.
class LateStop extends TurnProvider {
  chunks = 0; fragment = 0; started = false; endedAt = 0;
  answer(n: number) {
    this.emitEvent({ type: 'response.created', response: { id: `r${n}` } });
    this.emitEvent({ type: 'response.output_audio.delta', response_id: `r${n}`, item_id: `a${n}`, delta: Buffer.alloc(BYTES_PER_MS * 100, 0x10).toString('base64') });
    this.emitEvent({ type: 'response.output_audio_transcript.done', response_id: `r${n}`, item_id: `a${n}`, transcript: `answer ${n}` });
    this.emitEvent({ type: 'response.done', response: { id: `r${n}`, status: 'completed' } });
  }
  override send(data: string) {
    const event = JSON.parse(data) as { type: string; audio?: string };
    if (event.type !== 'input_audio_buffer.append') return super.send(data);
    const loud = Buffer.from(event.audio!, 'base64').some(byte => byte !== 0);
    this.chunks++;
    if (loud && !this.started) {
      this.started = true; this.fragment++;
      // The next fragment's start comes first, so the late answer is not cut by it.
      this.emitEvent({ type: 'input_audio_buffer.speech_started', item_id: `u${this.fragment}`, audio_start_ms: (this.chunks - 1) * 100 });
      if (this.fragment === 2) {
        this.emitEvent({ type: 'input_audio_buffer.speech_stopped', item_id: 'u1', audio_end_ms: this.endedAt });
        this.emitEvent({ type: 'input_audio_buffer.committed', item_id: 'u1' });
        this.answer(1);
      }
    }
    if (!loud && this.started) {
      this.started = false; this.endedAt = (this.chunks - 1) * 100;
      if (this.fragment === 2) {
        this.emitEvent({ type: 'input_audio_buffer.speech_stopped', item_id: 'u2', audio_end_ms: this.endedAt });
        this.emitEvent({ type: 'input_audio_buffer.committed', item_id: 'u2' });
        this.answer(2);
      }
    }
  }
}

test('a speech stop reported late still times the turn it ended, and a notice is logged when the voice gets it', { timeout: 60_000 }, async () => {
  const scenario = { ...examples()[2], turns: [{ noise: 'pink' as const, ms: 300 }, { noise: 'pink' as const, ms: 300, continues: true, pauseMs: 500 }] };
  const run = await runScenario(scenario, { key: 'k', settings: {}, speech: new Speech({ cacheDir: mkdtempSync(join(tmpdir(), 'eval-run-')) }), voices: { a: { id: 'v' } }, defaultVoice: 'a', noResponseMs: 500,
    connect: () => new LateStop() as never });
  assert.notEqual(run.turns[0].latencyMs, null);
  assert.notEqual(run.turns[1].latencyMs, null);
  const { run: announced } = await announce(['speak']);
  const notice = announced.notices[0];
  assert.equal(notice.delivered, true);
  assert.ok(notice.ms >= notice.arrivedMs!);
});

test('the final notice carries the last message, while reads show every message', async () => {
  const sim = new SimulatedT3({ projects: [{ key: 'p', name: 'proj', threads: [{ key: 't', title: 'T', onSend: { delayMs: 10, reply: ['Tentative: 3 tests fail.', 'Correction: all 12 tests pass.'] } }] }] });
  try {
    const state = new DirectCallState();
    await sim.ade.catalog(state);
    const texts: string[] = [];
    sim.onReply = r => texts.push(r.text);
    const send = sim.ade.tools.find(t => t.name === 't3_send_message')!;
    await send.execute(send.prepare!({ projectId: state.short(worldId('project', 'p')), project: 'proj', threadId: state.short(worldId('thread', 't')), message: 'x' }, state), context(state));
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.deepEqual(texts, ['Correction: all 12 tests pass.']);
    const read = await sim.ade.tools.find(t => t.name === 't3_read_thread')!.execute({ threadId: state.short(worldId('thread', 't')) }, context(state));
    assert.match(read.text, /Tentative: 3 tests fail\./);
  } finally { sim.close(); }
});

test('a reply with a working status is refused, and a partial verdict without its recording blocks grading again', () => {
  const base = examples()[0];
  const reply = (status: string) => ({ ...base, expect: {}, world: { projects: [{ key: 'p', name: 'p', threads: [{ key: 't', title: 't', onSend: { status } }] }] } });
  assert.throws(() => validateScenario(reply('running')), /working status/);
  assert.doesNotThrow(() => validateScenario(reply('failed')));
  const data = mkdtempSync(join(tmpdir(), 'ade-call-eval-partial-'));
  const cli = (...args: string[]) => spawnSync(process.execPath, ['--no-warnings', join(root, 'dist/scripts/eval.mjs'), ...args], { encoding: 'utf8', env: { ...process.env, ADE_CALL_CONFIG: data, OPENAI_API_KEY: '', ELEVENLABS_API_KEY: '' } });
  const dir = join(data, 'runs', 'x', base.id, '1');
  spawnSync('mkdir', ['-p', dir]);
  writeFileSync(join(dir, 'result.json'), JSON.stringify({ scenario: base.id, repeat: 1, error: 'judge b: timeout', pass: false, checks: [{ id: 'sends.count', pass: true, critical: true, detail: '' }], judgements: [{ model: 'a', score: 5, criteria: [] }, { model: 'b', error: 'timeout' }] }));
  assert.match(cli('judge', join(data, 'runs', 'x'), join(root, 'evals/scenarios/examples.json')).stderr, /has a verdict but run.json is missing/);
});

test('main: thread keys are reserved for the simulator, and latency counts from the end of speech on the microphone', { timeout: 60_000 }, async () => {
  const base = examples()[0];
  assert.throws(() => validateScenario({ ...base, expect: {}, world: { projects: [{ key: 'p', name: 'p', threads: [{ key: 'main:p', title: 't' }] }] } }), /reserved/);
  // LateStop reports each stop only when the next fragment starts: latency still runs from the real end.
  const scenario = { ...examples()[2], turns: [{ noise: 'pink' as const, ms: 300 }, { noise: 'pink' as const, ms: 300, continues: true, pauseMs: 800 }] };
  const run = await runScenario(scenario, { key: 'k', settings: {}, speech: new Speech({ cacheDir: mkdtempSync(join(tmpdir(), 'eval-run-')) }), voices: { a: { id: 'v' } }, defaultVoice: 'a', noResponseMs: 500,
    connect: () => new LateStop() as never });
  assert.ok(run.turns[0].latencyMs! >= 600, `turn 1 latency ${run.turns[0].latencyMs} ms`);
});

test('only gate refusals count as gate refusals, --tts-model overrides the speaker, and the judge gets the call start', () => {
  const base = examples()[0];
  const run = (result: string) => ({ tools: [{ ms: 1, turn: 1, name: 't3_send_message', status: 'refused', args: null, result }], sends: [], turns: [], transcript: [], timeouts: [], providerErrors: [], notices: [], startedAt: '2026-11-20T09:00:00.000Z' }) as unknown as RunRecord;
  assert.equal(checkRun({ ...base, expect: {} }, run('ERROR: invalid arguments; nothing was executed.')).some(c => c.id === 'sends.refusedByGate'), false);
  assert.equal(checkRun({ ...base, expect: {} }, run('NOT SENT (no_user_turn): there is no new request from the user.')).find(c => c.id === 'sends.refusedByGate')!.pass, false);
  const speech = new Speech({ cacheDir: mkdtempSync(join(tmpdir(), 'eval-speech-')), model: 'eleven_v3' });
  assert.equal(speech.path('hola', { id: 'v', model: 'eleven_multilingual_v2' }).model, 'eleven_v3');
  assert.match(judgeInput(base, run('x')), /CALL STARTED 2026-11-20T09:00:00\.000Z/);
});

test('an answer cut before it sounded leaves its turn without a latency', { timeout: 60_000 }, async () => {
  // LateStop variant: the late answer to fragment 1 arrives just before fragment 2's speech starts, which cuts it unheard.
  class CutLate extends LateStop {
    override send(data: string) {
      const event = JSON.parse(data) as { type: string; audio?: string };
      if (event.type === 'input_audio_buffer.append' && this.turns === 0 && !this.started && this.fragment === 1 && Buffer.from(event.audio!, 'base64').some(byte => byte !== 0)) {
        this.started = true; this.fragment = 2;
        this.emitEvent({ type: 'input_audio_buffer.speech_stopped', item_id: 'u1', audio_end_ms: this.endedAt });
        this.emitEvent({ type: 'input_audio_buffer.committed', item_id: 'u1' });
        // An announcement is playing, so the answer queues behind it and the cut drops all of it.
        this.emitEvent({ type: 'response.created', response: { id: 'n0', metadata: { eval_notices: '1' } } });
        this.emitEvent({ type: 'response.output_audio.delta', response_id: 'n0', item_id: 'an', delta: Buffer.alloc(BYTES_PER_MS * 1000, 0x10).toString('base64') });
        this.emitEvent({ type: 'response.done', response: { id: 'n0', status: 'completed' } });
        this.answer(1);
        this.emitEvent({ type: 'input_audio_buffer.speech_started', item_id: 'u2', audio_start_ms: this.chunks * 100 });
        this.chunks++;
        return;
      }
      return super.send(data);
    }
  }
  const scenario = { ...examples()[2], turns: [{ noise: 'pink' as const, ms: 300 }, { noise: 'pink' as const, ms: 300, continues: true, pauseMs: 500 }] };
  const run = await runScenario(scenario, { key: 'k', settings: {}, speech: new Speech({ cacheDir: mkdtempSync(join(tmpdir(), 'eval-run-')) }), voices: { a: { id: 'v' } }, defaultVoice: 'a', noResponseMs: 500,
    connect: () => new CutLate() as never });
  assert.equal(run.transcript.find(l => l.text === 'answer 1')?.unheard, true);
  assert.equal(run.turns[0].latencyMs, null);
});

test('a judge that fails during a regrade replaces nothing, and a complete regrade is published at once', () => {
  const data = mkdtempSync(join(tmpdir(), 'ade-call-eval-outage-'));
  const stub = join(data, 'stub.mjs');
  // No network: every judge request gets a rate limit.
  writeFileSync(stub, "globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: 'rate_limit_exceeded' } }), { status: 429 });\n");
  const cli = (...args: string[]) => spawnSync(process.execPath, ['--no-warnings', '--import', stub, join(root, 'dist/scripts/eval.mjs'), ...args], { encoding: 'utf8', env: { ...process.env, ADE_CALL_CONFIG: data, OPENAI_API_KEY: 'test-key', ELEVENLABS_API_KEY: '' } });
  const sc = examples()[2], runs = join(data, 'runs', 'old');
  const verdict = (repeat: number) => ({ scenario: sc.id, repeat, pass: true, score: 5, checks: [], judgements: [{ model: 'old', score: 5, criteria: [] }], checksPass: true, judgePass: true, latency: { median: 1, max: 1 }, usage: {}, durationMs: 1 });
  for (const repeat of [1, 2]) {
    const dir = join(runs, sc.id, String(repeat));
    spawnSync('mkdir', ['-p', dir]);
    writeFileSync(join(dir, 'run.json'), JSON.stringify({ scenario: sc.id, startedAt: '2026-11-20T09:00:00.000Z', turns: [], transcript: [], tools: [], sends: [], notices: [], timeouts: [], providerErrors: [], usage: {} }));
    writeFileSync(join(dir, 'scenario.json'), JSON.stringify({ ...sc, file: undefined }));
    writeFileSync(join(dir, 'result.json'), JSON.stringify(verdict(repeat)));
  }
  const out = cli('judge', runs, join(root, 'evals/scenarios/examples.json'), '--judge', 'new-judge');
  assert.equal(out.status, 2, out.stderr); assert.match(out.stderr, /Nothing was replaced/);
  assert.equal(existsSync(join(runs, 'grades.json')), false);
  for (const repeat of [1, 2]) assert.deepEqual(JSON.parse(readFileSync(join(runs, sc.id, String(repeat), 'result.json'), 'utf8')), verdict(repeat));
  assert.equal(readdirSync(runs).some(f => f.endsWith('.partial')), false);
  // A judge that answers: every verdict is published together in grades.json, which report reads.
  const ids = expectedCriteria(sc);
  const answer = { output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ criteria: ids.map(id => ({ id, pass: true, severity: 'minor', evidence: 'ok' })), score: 4, summary: 'fine' }) }] }], usage: { total_tokens: 1 } };
  writeFileSync(stub, `globalThis.fetch = async () => new Response(${JSON.stringify(JSON.stringify(answer))}, { status: 200 });\n`);
  const done = cli('judge', runs, join(root, 'evals/scenarios/examples.json'), '--judge', 'new-judge');
  assert.equal(done.status, 0, done.stderr + done.stdout);
  const { results: grades, judges } = JSON.parse(readFileSync(join(runs, 'grades.json'), 'utf8')) as { judges: string[]; results: { repeat: number; score: number; judgements: { model: string }[] }[] };
  assert.deepEqual(judges, ['new-judge']);
  assert.deepEqual(grades.map(g => [g.repeat, g.judgements[0].model, g.score]).sort(), [[1, 'new-judge', 4], [2, 'new-judge', 4]]);
  assert.match(cli('report', runs).stdout, /★4\.0/);
});

test('a required call can be required after the first send and be critical', () => {
  const base = examples()[0];
  const scenario = { ...base, expect: { tools: { required: [{ name: 't3_read_thread', thread: 'search', afterSend: true, critical: true }] } } } as Scenario;
  validateScenario(scenario);
  const read = (ms: number) => ({ ms, startedMs: ms, turn: 1, name: 't3_read_thread', status: 'completed', args: { threadId: worldId('thread', 'search').slice(0, 8) }, result: '' });
  const run = (ms: number) => ({ tools: [read(ms)], sends: [{ ms: 500, turn: 1, projectKey: 'recipes', threadKey: 'search', message: 'x' }], turns: [], transcript: [], timeouts: [], providerErrors: [], notices: [] }) as unknown as RunRecord;
  const before = checkRun(scenario, run(100)).find(c => c.id === 'tools.required.t3_read_thread:search')!;
  assert.equal(before.pass, false); assert.equal(before.critical, true); assert.match(before.detail, /after the first send/);
  assert.equal(checkRun(scenario, run(900)).find(c => c.id === 'tools.required.t3_read_thread:search')!.pass, true);
});

test('an announcement the engine asked for is not an answer to the user, and a vanished repeat blocks grading again', { timeout: 60_000 }, async () => {
  const { scenario, run } = await announce(['speak']);
  const line = run.transcript.find(l => l.text === 'The agent answered: done.')!;
  assert.equal(line.notice, true);
  assert.match(callLog(scenario, run), /VOICE \(announcing an agent reply, on its own, not answering a user turn\): "The agent answered: done\."/);
  // Only the announcement after the user's turn: that turn counts as unanswered.
  const spoken = { ...scenario, turns: [{ say: 'hola' }], expect: {} } as Scenario;
  const lone = { ...run, turns: [{ index: 1, kind: 'say', startMs: 0, endMs: 1 }], transcript: [{ ...line, turn: 1 }] } as RunRecord;
  assert.equal(checkRun(spoken, lone).find(c => c.id === 'call.everyTurnAnswered')!.pass, false);
  const murmur = { ...lone, transcript: [{ ...line, notice: undefined, text: '...', turn: 1 }] } as RunRecord;
  assert.equal(checkRun(spoken, murmur).find(c => c.id === 'call.everyTurnAnswered')!.pass, false, 'a lone "..." is no answer');
  const data = mkdtempSync(join(tmpdir(), 'ade-call-eval-vanished-'));
  const sc = examples()[2], runs = join(data, 'runs', 'old'), one = join(runs, sc.id, '1');
  spawnSync('mkdir', ['-p', one]);
  writeFileSync(join(one, 'run.json'), JSON.stringify({ scenario: sc.id, turns: [], transcript: [], tools: [], sends: [], notices: [], timeouts: [], providerErrors: [], usage: {} }));
  writeFileSync(join(one, 'scenario.json'), JSON.stringify({ ...sc, file: undefined }));
  writeFileSync(join(runs, 'grades.json'), JSON.stringify([{ scenario: sc.id, repeat: 1, score: 5, checks: [], judgements: [{ model: 'a', score: 5, criteria: [] }] }, { scenario: sc.id, repeat: 2, score: 5, checks: [], judgements: [{ model: 'a', score: 5, criteria: [] }] }]));
  const out = spawnSync(process.execPath, ['--no-warnings', join(root, 'dist/scripts/eval.mjs'), 'judge', runs, join(root, 'evals/scenarios/examples.json')], { encoding: 'utf8', env: { ...process.env, ADE_CALL_CONFIG: data, OPENAI_API_KEY: '' } });
  assert.match(out.stderr, /#2: result.json has a verdict but run.json is missing/);
});

test('a noise turn without samples is refused, and an announcement keeps its label when cut or unheard', () => {
  const base = examples()[2];
  assert.throws(() => validateScenario({ ...base, expect: {}, turns: [{ noise: 'silence', ms: 0 }, { noise: 'pink', ms: 300 }] }), /noise turn needs ms > 0/);
  const run = { tools: [], sends: [], notices: [], timeouts: [], providerErrors: [], turns: [{ index: 1, kind: 'noise', startMs: 0, endMs: 300 }],
    transcript: [{ ms: 500, role: 'assistant', turn: 1, text: 'El widget ya está.', notice: true, cut: { heardMs: 700, totalMs: 2000 } },
      { ms: 900, role: 'assistant', turn: 1, text: 'Orbital va bien.', notice: true, unheard: true }] } as unknown as RunRecord;
  const log = callLog({ ...base, expect: {} }, run);
  assert.match(log, /announcing an agent reply, on its own, not answering a user turn; interrupted: the user heard about the first 0\.7 s of 2\.0 s and nothing after\): "El widget ya está\."/);
  assert.match(log, /announcing an agent reply, on its own, not answering a user turn; generated but never played: the user heard none of it\): "Orbital va bien\."/);
  assert.doesNotMatch(log, /answering turn 1/);
});

// Answers turn 1 with an announcement first (as the engine's notice
// requests do) and the real answer queued behind it.
class NoticeFirst extends TurnProvider {
  override send(data: string) {
    const event = JSON.parse(data) as { type: string; audio?: string };
    if (event.type !== 'input_audio_buffer.append') return super.send(data);
    const loud = Buffer.from(event.audio!, 'base64').some(byte => byte !== 0);
    if (loud && !this.speaking) {
      this.speaking = true;
      if (this.turns === 1) this.emitEvent({ type: 'input_audio_buffer.speech_started', item_id: 'u2', audio_start_ms: 0 });
      return;
    }
    if (loud || !this.speaking) return;
    this.speaking = false;
    const n = ++this.turns, audio = (ms: number) => Buffer.alloc(BYTES_PER_MS * ms, 0x10).toString('base64');
    this.emitEvent({ type: 'input_audio_buffer.committed', item_id: `u${n}` });
    if (n === 1) {
      this.emitEvent({ type: 'response.created', response: { id: 'n1', metadata: { eval_notices: '1' } } });
      this.emitEvent({ type: 'response.output_audio.delta', response_id: 'n1', item_id: 'an', delta: audio(1500) });
      this.emitEvent({ type: 'response.done', response: { id: 'n1', status: 'completed' } });
    }
    this.emitEvent({ type: 'response.created', response: { id: `r${n}` } });
    this.emitEvent({ type: 'response.output_audio.delta', response_id: `r${n}`, item_id: `a${n}`, delta: audio(n === 1 ? 2000 : 100) });
    this.emitEvent({ type: 'response.output_audio_transcript.done', response_id: `r${n}`, item_id: `a${n}`, transcript: `answer ${n}` });
    this.emitEvent({ type: 'response.done', response: { id: `r${n}`, status: 'completed' } });
  }
}

test('a scripted interruption waits for the answer, not an announcement played before it, and must cut that answer', { timeout: 60_000 }, async () => {
  const scenario = { ...examples()[2], turns: [{ noise: 'pink' as const, ms: 300 }, { noise: 'pink' as const, ms: 300, bargeInMs: 300 }] };
  const run = await runScenario(scenario, { key: 'k', settings: {}, speech: new Speech({ cacheDir: mkdtempSync(join(tmpdir(), 'eval-run-')) }), voices: { a: { id: 'v' } }, defaultVoice: 'a', noResponseMs: 500,
    connect: () => new NoticeFirst() as never });
  // The announcement takes 1.5 s; the user starts 0.3 s into the answer after it.
  assert.ok(run.turns[1].startMs - run.turns[0].endMs >= 1500, `interrupted ${run.turns[1].startMs - run.turns[0].endMs} ms after turn 1`);
  assert.deepEqual(run.turns[1].bargeIn, { overVoice: true, cut: true });
});

test('an empty recorded turn is refused before the call, a check read must start after the send, and labels match what happened', { skip: noFfmpeg }, async () => {
  const base = examples()[2];
  const dir = mkdtempSync(join(tmpdir(), 'eval-empty-'));
  writeFileSync(join(dir, 'empty.wav'), wav(Buffer.alloc(0)));
  let connected = false;
  await assert.rejects(runScenario({ ...base, file: join(dir, 'x.json'), turns: [{ audio: 'empty.wav' }, { noise: 'pink', ms: 300 }] }, { key: 'k', settings: {}, speech: new Speech({ cacheDir: mkdtempSync(join(tmpdir(), 'eval-run-')) }), voices: {}, defaultVoice: '',
    connect: () => { connected = true; return new FakeProvider() as never; } }), /turn 1 has no audio samples/);
  assert.equal(connected, false);
  const scenario = { ...examples()[0], expect: { tools: { required: [{ name: 't3_read_thread', thread: 'search', afterSend: true, critical: true }] } } } as Scenario;
  const run = { tools: [{ ms: 900, startedMs: 400, turn: 1, name: 't3_read_thread', status: 'completed', args: { threadId: worldId('thread', 'search').slice(0, 8) }, result: '' }],
    sends: [{ ms: 500, turn: 1, projectKey: 'recipes', threadKey: null, message: 'x' }], turns: [], transcript: [], timeouts: [], providerErrors: [],
    notices: [{ ms: 1000, thread: 'search', text: 'ok', kind: 'finished', delivered: true, quiet: true }] } as unknown as RunRecord;
  // Started before the send, finished after it: it cannot have checked the send.
  assert.equal(checkRun(scenario, run).find(c => c.id === 'tools.required.t3_read_thread:search')!.pass, false);
  const log = callLog(scenario, run);
  assert.match(log, /SEND delivered to the project's main thread/);
  assert.match(log, /given quiet/);
});

test('a check read needs a recorded start, the judge sees the notice as given, and a running batch cannot be graded again', () => {
  const scenario = { ...examples()[0], expect: { tools: { required: [{ name: 't3_read_thread', thread: 'search', afterSend: true, critical: true }] } } } as Scenario;
  const run = { tools: [{ ms: 900, turn: 1, name: 't3_read_thread', status: 'completed', args: { threadId: worldId('thread', 'search').slice(0, 8) }, result: '' }],
    sends: [{ ms: 500, turn: 1, projectKey: 'recipes', threadKey: 'search', message: 'x' }], turns: [], transcript: [], timeouts: [], providerErrors: [],
    notices: [{ ms: 1000, thread: 'search', text: 'full reply with a decisive last line', given: 'System notice: the agent finished.\nAgent message: full reply…', kind: 'finished', delivered: true }] } as unknown as RunRecord;
  const check = checkRun(scenario, run).find(c => c.id === 'tools.required.t3_read_thread:search')!;
  assert.equal(check.pass, false); assert.match(check.detail, /no start times: run it again/);
  const log = callLog(scenario, run);
  assert.match(log, /as given to the voice: """System notice: the agent finished\.\nAgent message: full reply…"""/);
  assert.doesNotMatch(log, /decisive last line/);
  const data = mkdtempSync(join(tmpdir(), 'ade-call-eval-running-'));
  const sc = examples()[2], runs = join(data, 'runs', 'live'), one = join(runs, sc.id, '1');
  spawnSync('mkdir', ['-p', one]);
  writeFileSync(join(runs, 'settings.json'), JSON.stringify({ label: 'live', jobs: [{ scenario: sc.id, repeat: 1 }, { scenario: sc.id, repeat: 2 }] }));
  writeFileSync(join(one, 'run.json'), JSON.stringify({ scenario: sc.id, turns: [], transcript: [], tools: [], sends: [], notices: [], timeouts: [], providerErrors: [], usage: {} }));
  writeFileSync(join(one, 'scenario.json'), JSON.stringify({ ...sc, file: undefined }));
  writeFileSync(join(one, 'result.json'), JSON.stringify({ scenario: sc.id, repeat: 1, pass: true, score: 5, checks: [], judgements: [{ model: 'a', score: 5, criteria: [] }] }));
  const out = spawnSync(process.execPath, ['--no-warnings', join(root, 'dist/scripts/eval.mjs'), 'judge', runs, join(root, 'evals/scenarios/examples.json')], { encoding: 'utf8', env: { ...process.env, ADE_CALL_CONFIG: data, OPENAI_API_KEY: '' } });
  assert.match(out.stderr, /#2 has no result yet/);
  assert.equal(existsSync(join(runs, 'grades.json')), false);
});

test('the judge log puts a tool request where it was made, and a missing result.json blocks grading again even after a regrade', () => {
  const base = examples()[0];
  const run = { tools: [{ ms: 5000, startedMs: 1000, callId: 'call_9', turn: 1, name: 't3_send_message', status: 'completed', args: { message: 'x' }, result: 'SEND ACCEPTED' }],
    sends: [], notices: [], timeouts: [], providerErrors: [], transcript: [{ ms: 3000, role: 'user', turn: 2, text: 'sí' }], turns: [] } as unknown as RunRecord;
  const log = callLog({ ...base, expect: {} }, run).split('\n');
  const request = log.findIndex(l => /TOOL REQUEST t3_send_message \(call call_9\)/.test(l)), yes = log.findIndex(l => /USER heard \(turn 2\)/.test(l)), outcome = log.findIndex(l => /TOOL RESULT t3_send_message \(call call_9\) \[completed\]/.test(l));
  assert.ok(request >= 0 && request < yes && yes < outcome, log.join('\n'));
  const data = mkdtempSync(join(tmpdir(), 'ade-call-eval-gone-'));
  const sc = examples()[2], runs = join(data, 'runs', 'x'), one = join(runs, sc.id, '1');
  spawnSync('mkdir', ['-p', one]);
  writeFileSync(join(runs, 'settings.json'), JSON.stringify({ label: 'x', jobs: [{ scenario: sc.id, repeat: 1 }] }));
  writeFileSync(join(one, 'run.json'), JSON.stringify({ scenario: sc.id, turns: [], transcript: [], tools: [], sends: [], notices: [], timeouts: [], providerErrors: [], usage: {} }));
  writeFileSync(join(one, 'scenario.json'), JSON.stringify({ ...sc, file: undefined }));
  writeFileSync(join(runs, 'grades.json'), JSON.stringify([{ scenario: sc.id, repeat: 1, pass: true, checksPass: true, judgePass: true, score: 5, checks: [], judgements: [{ model: 'a', score: 5, criteria: [] }], latency: { median: 1, max: 1 }, usage: {}, durationMs: 1 }]));
  const env = { ...process.env, ADE_CALL_CONFIG: data, OPENAI_API_KEY: '' };
  const out = spawnSync(process.execPath, ['--no-warnings', join(root, 'dist/scripts/eval.mjs'), 'judge', runs, join(root, 'evals/scenarios/examples.json')], { encoding: 'utf8', env });
  assert.match(out.stderr, /#1 has no result yet/);
  const report = spawnSync(process.execPath, ['--no-warnings', join(root, 'dist/scripts/eval.mjs'), 'report', runs], { encoding: 'utf8', env });
  assert.match(report.stdout, /<run>\/grades\.json \(by scenario and repeat\)/);
});

test('a latency budget the scenario sets is binding, and extract never overwrites a draft', () => {
  const scenario = { ...examples()[0], expect: { maxMedianLatencyMs: 2500 } } as Scenario;
  const run = { tools: [], sends: [], notices: [], timeouts: [], providerErrors: [], transcript: [{ ms: 9000, role: 'assistant', turn: 1, text: 'Sí, está terminado.' }],
    turns: [{ index: 1, kind: 'say', startMs: 0, endMs: 1000, latencyMs: 8000 }] } as unknown as RunRecord;
  const check = checkRun(scenario, run).find(c => c.id === 'latency.median')!;
  assert.equal(check.pass, false); assert.equal(check.critical, true);
  const data = mkdtempSync(join(tmpdir(), 'ade-call-eval-extract-'));
  const db = new DatabaseSync(join(data, 'caller.sqlite'));
  db.exec('CREATE TABLE events(id INTEGER PRIMARY KEY, type TEXT, payload TEXT, created INTEGER)');
  db.prepare('INSERT INTO events(type, payload, created) VALUES(?,?,?)').run('transcript', JSON.stringify({ call: 'call-abcdef12', role: 'user', text: 'hola' }), Date.parse('2026-11-01'));
  db.close();
  const extract = () => spawnSync(process.execPath, ['--no-warnings', join(root, 'dist/scripts/eval.mjs'), 'extract', '--db', join(data, 'caller.sqlite'), '--out', join(data, 'drafts')], { encoding: 'utf8', env: { ...process.env, ADE_CALL_CONFIG: data } });
  assert.equal(extract().status, 0);
  const [file] = readdirSync(join(data, 'drafts'));
  writeFileSync(join(data, 'drafts', file), '{"edited": true}');
  assert.match(extract().stdout, /1 already there and left as they were/);
  assert.equal(readFileSync(join(data, 'drafts', file), 'utf8'), '{"edited": true}');
});

test('an expected language reaches the judge, and tool deadlines must be turns of the script', () => {
  const base = examples()[0];
  const run = { tools: [], sends: [], notices: [], timeouts: [], providerErrors: [], transcript: [], turns: [] } as unknown as RunRecord;
  assert.match(judgeInput({ ...base, expect: { language: 'English' } }, run), /EXPECTED LANGUAGE: every answer of the voice after the first user turn is in English/);
  assert.notEqual(judgeInput({ ...base, expect: { language: 'English' } }, run), judgeInput({ ...base, expect: { language: 'Spanish' } }, run));
  assert.doesNotMatch(judgeInput({ ...base, expect: {} }, run), /EXPECTED LANGUAGE/);
  for (const byTurn of [0, base.turns.length + 1]) assert.throws(() => validateScenario({ ...base, expect: { tools: { required: [{ name: 't3_read_thread', byTurn }] } } }), /is not a turn of the script/);
});

test('the simulator refuses the arguments production refuses, main threads count for their project, and an empty noise kind is refused', async () => {
  const base = examples()[0];
  const sim = new SimulatedT3(base.world);
  try {
    const state = new DirectCallState();
    await sim.ade.catalog(state);
    const send = sim.ade.tools.find(t => t.name === 't3_send_message')!;
    const project = state.short(worldId('project', 'recipes'));
    for (const bad of [{ message: ' ' }, { project: ' ', message: 'x' }])
      await assert.rejects(send.execute(send.prepare!({ projectId: project, project: 'recipe-app', ...bad }, state), context(state)), (e: Error) => e.name === 'NotDispatchedError');
    assert.equal(sim.sends.length, 0);
  } finally { sim.close(); }
  const scenario = { ...base, expect: { tools: { forbidden: [{ name: 't3_read_thread', project: 'recipes' }] } } } as Scenario;
  const run = { tools: [{ ms: 1, turn: 1, name: 't3_read_thread', status: 'completed', args: { threadId: worldId('thread', 'main:recipes').slice(0, 8) }, result: '' }],
    sends: [], turns: [], transcript: [], timeouts: [], providerErrors: [], notices: [] } as unknown as RunRecord;
  assert.equal(checkRun(scenario, run).find(c => c.id === 'tools.forbidden.t3_read_thread:recipes')!.pass, false);
  assert.throws(() => validateScenario({ ...base, expect: {}, turns: [{ noise: '' }] }), /noise is pink or silence/);
});

test('expected destinations must belong together, a read shows an archived thread as archived, and report takes the median over answers', async () => {
  const base = examples()[0];
  assert.throws(() => validateScenario({ ...base, expect: { sends: [{ turn: 3, project: 'billing', thread: 'search' }] } }), /thread search is not in project billing/);
  assert.throws(() => validateScenario({ ...base, expect: { tools: { required: [{ name: 't3_read_thread', project: 'billing', thread: 'search' }] } } }), /thread search is not in project billing/);
  const world = structuredClone(base.world);
  world.projects[0].threads![0].archived = true;
  const sim = new SimulatedT3(world);
  try {
    const state = new DirectCallState();
    await sim.ade.catalog(state);
    const read = await sim.ade.tools.find(t => t.name === 't3_read_thread')!.execute({ threadId: state.short(worldId('thread', 'search')) }, context(state));
    assert.match(read.text, /archived/);
  } finally { sim.close(); }
  const data = mkdtempSync(join(tmpdir(), 'ade-call-eval-latency-'));
  const runs = join(data, 'runs', 'lat');
  const result = (repeat: number, values: number[]) => ({ scenario: 's', repeat, pass: true, checksPass: true, judgePass: null, score: null, checks: [], judgements: [], latency: { median: median(values), max: Math.max(...values), values }, usage: {}, durationMs: 1 });
  for (const [repeat, values] of [[1, [100]], [2, [900, 900, 900]]] as const) {
    spawnSync('mkdir', ['-p', join(runs, 's', String(repeat))]);
    writeFileSync(join(runs, 's', String(repeat), 'result.json'), JSON.stringify(result(repeat, [...values])));
  }
  const out = spawnSync(process.execPath, ['--no-warnings', join(root, 'dist/scripts/eval.mjs'), 'report', runs], { encoding: 'utf8', env: { ...process.env, ADE_CALL_CONFIG: data } });
  assert.match(out.stdout, /median latency 900 ms/);
});

// One scripted turn the provider splits into two speech items; the answer comes after the second.
class SplitStops extends TurnProvider {
  chunks = 0; items = 0; loud = false;
  override send(data: string) {
    const event = JSON.parse(data) as { type: string; audio?: string };
    if (event.type !== 'input_audio_buffer.append') return super.send(data);
    const loud = Buffer.from(event.audio!, 'base64').some(byte => byte !== 0);
    this.chunks++;
    if (loud && !this.loud) { this.loud = true; this.items++; this.emitEvent({ type: 'input_audio_buffer.speech_started', item_id: `u${this.items}`, audio_start_ms: (this.chunks - 1) * 100 }); }
    if (!loud && this.loud) {
      this.loud = false;
      this.emitEvent({ type: 'input_audio_buffer.speech_stopped', item_id: `u${this.items}`, audio_end_ms: (this.chunks - 1) * 100 });
      this.emitEvent({ type: 'input_audio_buffer.committed', item_id: `u${this.items}` });
      if (this.items === 2) {
        this.emitEvent({ type: 'response.created', response: { id: 'r1' } });
        this.emitEvent({ type: 'response.output_audio.delta', response_id: 'r1', item_id: 'a1', delta: Buffer.alloc(BYTES_PER_MS * 100, 0x10).toString('base64') });
        this.emitEvent({ type: 'response.output_audio_transcript.done', response_id: 'r1', item_id: 'a1', transcript: 'answer' });
        this.emitEvent({ type: 'response.done', response: { id: 'r1', status: 'completed' } });
      }
    }
  }
}

test('an answer is timed from the speech item it answers, drafts never run, and a reply timed past the script is refused', { timeout: 60_000, skip: noFfmpeg }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'eval-split-'));
  writeFileSync(join(dir, 'split.wav'), wav(Buffer.concat([noise('pink', 300, 1, 0.05), noise('silence', 1500), noise('pink', 300, 2, 0.05)])));
  const scenario = { ...examples()[2], file: join(dir, 'x.json'), turns: [{ audio: 'split.wav' }] };
  const run = await runScenario(scenario, { key: 'k', settings: {}, speech: new Speech({ cacheDir: mkdtempSync(join(tmpdir(), 'eval-run-')) }), voices: {}, defaultVoice: '', noResponseMs: 500,
    connect: () => new SplitStops() as never });
  // From the end of the second item, not from the first stop 1.8 s earlier.
  assert.ok(run.turns[0].latencyMs! < 1000, `latency ${run.turns[0].latencyMs} ms`);
  const base = examples()[0];
  assert.throws(() => validateScenario({ ...base, draft: true }), /is a draft/);
  const world = structuredClone(base.world);
  world.projects[0].threads![0].onSend = { afterTurn: base.turns.length + 1, reply: ['x'] };
  assert.throws(() => validateScenario({ ...base, world }), /past the last turn/);
});

test('two processes share one synthesis per line, and a release is checked by its project', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'eval-speech-shared-'));
  let calls = 0;
  const fetch = async () => { calls++; await new Promise(resolve => setTimeout(resolve, 300)); return { ok: true, status: 200, text: async () => '', arrayBuffer: async () => new Uint8Array(BYTES_PER_MS * 200).fill(7).buffer }; };
  // Two Speech instances stand for two processes on one cache.
  const [a, b] = await Promise.all([new Speech({ cacheDir, key: 'k', fetch }).say('hola', { id: 'v' }), new Speech({ cacheDir, key: 'k', fetch }).say('hola', { id: 'v' })]);
  assert.equal(calls, 1); assert.deepEqual(a, b);
  assert.deepEqual(readdirSync(cacheDir).filter(f => f.endsWith('.lock')), []);
  const base = examples()[0];
  const scenario = { ...base, expect: { tools: { forbidden: [{ name: 't3_release_uncertain', project: 'recipes' }] } } } as Scenario;
  const run = { tools: [{ ms: 1, turn: 1, name: 't3_release_uncertain', status: 'completed', args: { projectId: worldId('project', 'recipes').slice(0, 8), threadId: worldId('thread', 'invoices').slice(0, 8) }, result: '' }],
    sends: [], turns: [], transcript: [], timeouts: [], providerErrors: [], notices: [] } as unknown as RunRecord;
  assert.equal(checkRun(scenario, run).find(c => c.id === 'tools.forbidden.t3_release_uncertain:recipes')!.pass, false);
});

test('a truncation the provider refuses fails the interruption', { timeout: 60_000 }, async () => {
  class RefusesTruncate extends Interrupted {
    constructor() { super(false); }
    override send(data: string) {
      const event = JSON.parse(data) as { type: string; event_id?: string };
      if (event.type === 'conversation.item.truncate') return this.emitEvent({ type: 'error', error: { code: 'invalid_value', event_id: event.event_id, message: 'item not found' } });
      return super.send(data);
    }
  }
  const scenario = { ...examples()[2], turns: [{ noise: 'pink' as const, ms: 300 }, { noise: 'pink' as const, ms: 2500, bargeInMs: 500 }] };
  const run = await runScenario(scenario, { key: 'k', settings: {}, speech: new Speech({ cacheDir: mkdtempSync(join(tmpdir(), 'eval-run-')) }), voices: { a: { id: 'v' } }, defaultVoice: 'a', noResponseMs: 500,
    connect: () => new RefusesTruncate() as never });
  assert.deepEqual(run.turns[1].bargeIn, { overVoice: true, cut: false });
  assert.ok(run.providerErrors.some(e => e.code === 'invalid_value'));
});

test('a late truncation refusal still fails the interruption, and tool rules may name a created main thread', { timeout: 60_000 }, async () => {
  class LateRefusal extends Interrupted {
    constructor() { super(false); }
    override send(data: string) {
      const event = JSON.parse(data) as { type: string; event_id?: string };
      if (event.type === 'conversation.item.truncate') { setTimeout(() => this.emitEvent({ type: 'error', error: { code: 'invalid_value', event_id: event.event_id, message: 'item not found' } }), 1500); return; }
      return super.send(data);
    }
  }
  const scenario = { ...examples()[2], turns: [{ noise: 'pink' as const, ms: 300 }, { noise: 'pink' as const, ms: 300, bargeInMs: 500 }, { noise: 'pink' as const, ms: 300, continues: true, pauseMs: 100 }] };
  const run = await runScenario(scenario, { key: 'k', settings: {}, speech: new Speech({ cacheDir: mkdtempSync(join(tmpdir(), 'eval-run-')) }), voices: { a: { id: 'v' } }, defaultVoice: 'a', noResponseMs: 500,
    connect: () => new LateRefusal() as never });
  assert.deepEqual(run.turns[1].bargeIn, { overVoice: true, cut: false });
  const base = examples()[0];
  assert.doesNotThrow(() => validateScenario({ ...base, expect: { tools: { required: [{ name: 't3_read_thread', thread: 'main:recipes', project: 'recipes' }] } } }));
  assert.throws(() => validateScenario({ ...base, expect: { tools: { required: [{ name: 't3_read_thread', thread: 'main:recipes', project: 'billing' }] } } }), /not in project billing/);
});

// Answers turn 1 with a short preamble, then (after a tool wait) the real answer.
class Preamble extends TurnProvider {
  override send(data: string) {
    const event = JSON.parse(data) as { type: string; audio?: string };
    if (event.type !== 'input_audio_buffer.append') return super.send(data);
    const loud = Buffer.from(event.audio!, 'base64').some(byte => byte !== 0);
    if (loud && !this.speaking) { this.speaking = true; if (this.turns === 1) this.emitEvent({ type: 'input_audio_buffer.speech_started', item_id: 'u2', audio_start_ms: 0 }); return; }
    if (loud || !this.speaking) return;
    this.speaking = false;
    const n = ++this.turns, audio = (ms: number) => Buffer.alloc(BYTES_PER_MS * ms, 0x10).toString('base64');
    const respond = (id: string, ms: number) => {
      this.emitEvent({ type: 'response.created', response: { id } });
      this.emitEvent({ type: 'response.output_audio.delta', response_id: id, item_id: `i${id}`, delta: audio(ms) });
      this.emitEvent({ type: 'response.done', response: { id, status: 'completed' } });
    };
    this.emitEvent({ type: 'input_audio_buffer.committed', item_id: `u${n}` });
    if (n === 1) { respond('pre', 300); setTimeout(() => respond('answer', 2000), 800); } else respond(`r${n}`, 100);
  }
}

test('an interruption binds to the answer playing when the user starts, and the simulator stays off the real installation', { timeout: 60_000 }, async () => {
  const scenario = { ...examples()[2], turns: [{ noise: 'pink' as const, ms: 300 }, { noise: 'pink' as const, ms: 300, bargeInMs: 1500 }] };
  const run = await runScenario(scenario, { key: 'k', settings: {}, speech: new Speech({ cacheDir: mkdtempSync(join(tmpdir(), 'eval-run-')) }), voices: { a: { id: 'v' } }, defaultVoice: 'a', noResponseMs: 500,
    connect: () => new Preamble() as never });
  assert.deepEqual(run.turns[1].bargeIn, { overVoice: true, cut: true });
  // Documents: the simulated world has none, and nothing reaches the real T3.
  const base = examples()[0], world = structuredClone(base.world);
  world.projects[0].threads![1].archived = true;
  world.projects[0].threads![0].onSend = { uncertain: true };
  const sim = new SimulatedT3(world);
  try {
    const state = new DirectCallState();
    await sim.ade.catalog(state);
    const doc = sim.ade.tools.find(t => t.name === 't3_read_document')!;
    await assert.rejects(doc.execute({ projectId: state.short(worldId('project', 'recipes')), path: 'README.md' }, context(state)));
    assert.deepEqual(sim.cliCalls, []);
    // An uncertain send blocks the project before the destination is looked at, as T3 Coordinator.
    const send = sim.ade.tools.find(t => t.name === 't3_send_message')!, project = state.short(worldId('project', 'recipes'));
    await assert.rejects(send.execute(send.prepare!({ projectId: project, project: 'recipe-app', threadId: state.short(worldId('thread', 'search')), message: 'x' }, state), { ...context(state), requestId: 'voice:test:call_b1' }));
    await assert.rejects(send.execute(send.prepare!({ projectId: project, project: 'recipe-app', threadId: state.short(worldId('thread', 'dark-mode')), message: 'y' }, state), { ...context(state), requestId: 'voice:test:call_b2' }), /uncertain delivery/);
  } finally { sim.close(); }
});


test('an interruption counts only played answer audio, waiting through a tool gap', { timeout: 60_000 }, async () => {
  // Preamble 300 ms, a gap until about 0.9 s, then the answer: the 500 ms offset is reached inside the answer, after the gap.
  const scenario = { ...examples()[2], turns: [{ noise: 'pink' as const, ms: 300 }, { noise: 'pink' as const, ms: 300, bargeInMs: 500 }] };
  const run = await runScenario(scenario, { key: 'k', settings: {}, speech: new Speech({ cacheDir: mkdtempSync(join(tmpdir(), 'eval-run-')) }), voices: { a: { id: 'v' } }, defaultVoice: 'a', noResponseMs: 500,
    connect: () => new Preamble() as never });
  assert.deepEqual(run.turns[1].bargeIn, { overVoice: true, cut: true });
  assert.ok(run.turns[1].startMs - run.turns[0].endMs >= 900, `interrupted ${run.turns[1].startMs - run.turns[0].endMs} ms after turn 1`);
});

test('dead synthesis locks are passed over without removing a live one, and the line is fetched once', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'eval-speech-gen-'));
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
  const file = new Speech({ cacheDir }).path('hola', { id: 'v' }).file;
  writeFileSync(`${file}.lock.0`, dead);
  let calls = 0;
  const fetch = async () => { calls++; await new Promise(resolve => setTimeout(resolve, 300)); return { ok: true, status: 200, text: async () => '', arrayBuffer: async () => new Uint8Array(BYTES_PER_MS * 200).fill(7).buffer }; };
  const results = await Promise.all([1, 2, 3].map(() => new Speech({ cacheDir, key: 'k', fetch }).say('hola', { id: 'v' })));
  assert.equal(calls, 1);
  assert.ok(results.every(r => r.equals(results[0])));
  assert.deepEqual(readdirSync(cacheDir).filter(f => /lock|\.pid$/.test(f)), []);
});

test('selectors and Realtime settings are checked before anything is paid', () => {
  const data = mkdtempSync(join(tmpdir(), 'ade-call-eval-select-'));
  const cli = (...args: string[]) => spawnSync(process.execPath, ['--no-warnings', join(root, 'dist/scripts/eval.mjs'), ...args], { encoding: 'utf8', env: { ...process.env, ADE_CALL_CONFIG: data, OPENAI_API_KEY: '', ELEVENLABS_API_KEY: '' } });
  const file = join(root, 'evals/scenarios/examples.json');
  for (const [args, message] of [[['--only='], /--only needs scenario IDs/], [['--only', 'status-propose-send,nope'], /no scenario nope/], [['--tag='], /--tag needs a tag/], [['--eagerness', 'hgh'], /Invalid OpenAI Realtime eagerness value: hgh/]] as const) {
    const out = cli('run', ...args, file, '--data', data);
    assert.equal(out.status, 2, out.stderr); assert.match(out.stderr, message);
  }
  assert.equal(existsSync(join(data, 'runs')), false);
  assert.equal(existsSync(join(data, 'audio-cache')), false);
});

test('a failed synthesis keeps dead generations, so a late waiter cannot double the request', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'eval-speech-fail-'));
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
  const file = new Speech({ cacheDir }).path('hola', { id: 'v' }).file;
  writeFileSync(`${file}.lock.0`, dead);
  const failing = async () => ({ ok: false, status: 500, text: async () => '{}', arrayBuffer: async () => new ArrayBuffer(0) });
  await assert.rejects(new Speech({ cacheDir, key: 'k', fetch: failing }).say('hola', { id: 'v' }), /ElevenLabs answered 500/);
  // The dead generation 0 stays: the next claimant moves past it instead of reusing it.
  assert.ok(existsSync(`${file}.lock.0`));
  assert.ok(!existsSync(`${file}.lock.1`));
});

test('a send is attributed to its turn by the full request ID, hints match production, and extract keeps the provider order', () => {
  // The engine hashes long call IDs: the recorded turn must still be found.
  const long = 'call_' + 'x'.repeat(80);
  assert.match(requestIdFor('voice', 'eval_1', long), /^voice:eval_1:h:[0-9a-f]{40}$/);
  const hints = vocabularyHints('t3', ['recipe-app', ...distinctiveWords('Add ingredient search')]);
  assert.ok(!hints.includes('Add ingredient search'));
  const data = mkdtempSync(join(tmpdir(), 'ade-call-eval-order-'));
  const db = new DatabaseSync(join(data, 'caller.sqlite'));
  db.exec('CREATE TABLE events(id INTEGER PRIMARY KEY, type TEXT, payload TEXT, created INTEGER)');
  const add = (order: number, text: string) => db.prepare('INSERT INTO events(type, payload, created) VALUES(?,?,?)').run('transcript', JSON.stringify({ call: 'call-1234abcd', role: 'user', text, order }), Date.parse('2026-11-01'));
  add(2, 'segundo'); add(1, 'primero');
  db.close();
  const out = spawnSync(process.execPath, ['--no-warnings', join(root, 'dist/scripts/eval.mjs'), 'extract', '--db', join(data, 'caller.sqlite'), '--out', join(data, 'drafts')], { encoding: 'utf8', env: { ...process.env, ADE_CALL_CONFIG: data } });
  assert.equal(out.status, 0, out.stderr);
  const [draft] = readdirSync(join(data, 'drafts'));
  assert.deepEqual((JSON.parse(readFileSync(join(data, 'drafts', draft), 'utf8')) as { turns: { say: string }[] }).turns.map(t => t.say), ['primero', 'segundo']);
});

test('the judge gets the local clock the voice had', () => {
  const run = { tools: [], sends: [], notices: [], timeouts: [], providerErrors: [], transcript: [], turns: [], startedAt: '2026-11-20T23:30:00.000Z', clock: { localNow: '2026-11-21 00:30', timeZone: 'Europe/Madrid' } } as unknown as RunRecord;
  assert.match(judgeInput({ ...examples()[0], expect: {} }, run), /CALL STARTED 2026-11-21 00:30 local time in Europe\/Madrid \(2026-11-20T23:30:00\.000Z UTC\)/);
});

test('world names must be text, a zero tool budget is binding, and the effort of the judges is checked first', () => {
  const base = examples()[0];
  assert.throws(() => validateScenario({ ...base, expect: {}, world: { projects: [{ key: 'p', name: { en: 'Example' } }] } }), /key and name as text/);
  assert.throws(() => validateScenario({ ...base, expect: {}, world: { projects: [{ key: 'p', name: 'p', threads: [{ key: 't', title: 7 }] }] } }), /key and title as text/);
  const scenario = { ...base, expect: { tools: { maxCalls: 0 } } } as Scenario;
  const run = { tools: [{ ms: 1, turn: 1, name: 't3_list_threads', status: 'completed', args: {}, result: '' }], sends: [], turns: [], transcript: [], timeouts: [], providerErrors: [], notices: [] } as unknown as RunRecord;
  const budget = checkRun(scenario, run).find(c => c.id === 'tools.maxCalls')!;
  assert.equal(budget.pass, false); assert.equal(budget.critical, true);
  assert.equal(checkRun({ ...base, expect: { tools: { maxCalls: 6 } } } as Scenario, run).find(c => c.id === 'tools.maxCalls')!.critical, false);
  const data = mkdtempSync(join(tmpdir(), 'ade-call-eval-effort-'));
  const out = spawnSync(process.execPath, ['--no-warnings', join(root, 'dist/scripts/eval.mjs'), 'run', '--judge-reasoning=', join(root, 'evals/scenarios/examples.json'), '--data', data], { encoding: 'utf8', env: { ...process.env, ADE_CALL_CONFIG: data, OPENAI_API_KEY: '', ELEVENLABS_API_KEY: '' } });
  assert.equal(out.status, 2); assert.match(out.stderr, /--judge-reasoning is one of/);
  assert.equal(existsSync(join(data, 'runs')), false);
});

test('the run records the transcription prompt the call was really given', { timeout: 30_000 }, async () => {
  const scenario = { ...examples()[0], turns: [{ noise: 'silence' as const, ms: 300 }] };
  const run = await runScenario(scenario, { key: 'k', settings: { transcriptionModel: 'gpt-4o-transcribe' }, speech: new Speech({ cacheDir: mkdtempSync(join(tmpdir(), 'eval-run-')) }), voices: {}, defaultVoice: '', noResponseMs: 500,
    connect: () => new FakeProvider() as never });
  assert.ok(run.vocabulary!.includes('recipe-app'));
  assert.ok(!run.vocabulary!.includes('Add ingredient search'));
  const other = await runScenario(scenario, { key: 'k', settings: { transcriptionModel: 'whisper-1' }, speech: new Speech({ cacheDir: mkdtempSync(join(tmpdir(), 'eval-run-')) }), voices: {}, defaultVoice: '', noResponseMs: 500,
    connect: () => new FakeProvider() as never });
  assert.deepEqual(other.vocabulary, []);
});

test('credentials never reach a judge, a judged unauthorized send is a critical failure, and statuses reach the catalog', async () => {
  const base = examples()[0], world = structuredClone(base.world);
  world.projects[0].threads![0].messages!.push({ role: 'assistant', text: 'deploy with api_key=sk-live-123456789 please' });
  let body = '';
  const fake = async (_url: string, init: RequestInit) => { body = String(init.body); return { ok: true, status: 200, text: async () => JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ criteria: expectedCriteria(base).map(id => ({ id, pass: true, severity: 'minor', evidence: 'ok' })), score: 5, summary: 'x' }) }] }] }) }; };
  const run = { tools: [], sends: [], notices: [], timeouts: [], providerErrors: [], transcript: [], turns: [] } as unknown as RunRecord;
  await judge({ ...base, world }, run, { model: 'm', key: 'k', fetch: fake });
  assert.doesNotMatch(body, /sk-live-123456789/);
  const sim = new SimulatedT3(base.world);
  try { assert.match(await sim.ade.catalog(new DirectCallState()), /running/); } finally { sim.close(); }
});

test('a regrade keeps the panel and effort of the folder, and a judged unauthorized send fails the gate whatever its severity', () => {
  const data = mkdtempSync(join(tmpdir(), 'ade-call-eval-panel-'));
  const sc = examples()[2], runs = join(data, 'runs', 'p'), one = join(runs, sc.id, '1'), log = join(data, 'requests.log');
  const ids = expectedCriteria(sc);
  const answer = { output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ criteria: ids.map(id => ({ id, pass: id !== 'g1', severity: 'minor', evidence: 'sent without a proposal' })), score: 4, summary: 'x' }) }] }] };
  const stub = join(data, 'stub.mjs');
  writeFileSync(stub, `import { appendFileSync } from 'node:fs';\nglobalThis.fetch = async (_url, init) => { const b = JSON.parse(init.body); appendFileSync(${JSON.stringify(log)}, b.model + ' ' + (b.reasoning?.effort || '') + '\\n'); return new Response(${JSON.stringify(JSON.stringify(answer))}, { status: 200 }); };\n`);
  spawnSync('mkdir', ['-p', one]);
  writeFileSync(join(runs, 'settings.json'), JSON.stringify({ label: 'p', jobs: [{ scenario: sc.id, repeat: 1 }], judges: ['judge-a', 'judge-b'], judgeReasoning: 'high' }));
  writeFileSync(join(one, 'run.json'), JSON.stringify({ scenario: sc.id, turns: [], transcript: [], tools: [], sends: [], notices: [], timeouts: [], providerErrors: [], usage: {} }));
  writeFileSync(join(one, 'scenario.json'), JSON.stringify({ ...sc, file: undefined }));
  writeFileSync(join(one, 'result.json'), JSON.stringify({ scenario: sc.id, repeat: 1, pass: true, checksPass: true, judgePass: true, score: 5, checks: [], judgements: [], latency: { median: null, max: null }, usage: {}, durationMs: 1 }));
  const env = { ...process.env, ADE_CALL_CONFIG: data, OPENAI_API_KEY: 'test-key', ELEVENLABS_API_KEY: '' };
  const out = spawnSync(process.execPath, ['--no-warnings', '--import', stub, join(root, 'dist/scripts/eval.mjs'), 'judge', runs, join(root, 'evals/scenarios/examples.json'), '--min-pass', '0'], { encoding: 'utf8', env });
  assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n').sort(), ['judge-a high', 'judge-b high']);
  // g1 failed as "minor": still a critical failure, and the command fails even with --min-pass 0.
  assert.equal(out.status, 1, out.stdout + out.stderr);
  const [graded] = (JSON.parse(readFileSync(join(runs, 'grades.json'), 'utf8')) as { results: { pass: boolean; checks: { id: string; critical: boolean }[] }[] }).results;
  assert.equal(graded.pass, false); assert.ok(graded.checks.some(c => c.id === 'judge.authorization' && c.critical));
  const typo = spawnSync(process.execPath, ['--no-warnings', join(root, 'dist/scripts/eval.mjs'), 'run', '--no-judge', '--judge-reasoning=hihg', join(root, 'evals/scenarios/examples.json'), '--data', data], { encoding: 'utf8', env });
  assert.equal(typo.status, 2); assert.match(typo.stderr, /--judge-reasoning is one of/);
});

test('authorization headers and padded criterion IDs cannot get past the judge, and literal brackets reach it', async () => {
  assert.doesNotMatch(redactText('Authorization: Basic dXNlcjpwYXNzd29yZA=='), /dXNlcjpwYXNzd29yZA/);
  const base = examples()[0], ids = expectedCriteria(base);
  const fake = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ criteria: ids.map(id => ({ id: id === 'g1' ? ' g1 ' : id, pass: id !== 'g1', severity: 'minor', evidence: 'x' })), score: 4, summary: 'x' }) }] }] }) });
  const run = { tools: [], sends: [], notices: [], timeouts: [], providerErrors: [], transcript: [], turns: [{ index: 1, kind: 'say', text: 'put [skip ci] in it', words: 'put [skip ci] in it', startMs: 0, endMs: 1 }] } as unknown as RunRecord;
  const verdict = await judge(base, run, { model: 'm', key: 'k', fetch: fake });
  assert.ok(verdict.criteria.some(c => c.id === 'g1' && !c.pass));
  assert.match(callLog(base, run), /put \[skip ci\] in it/);
});

test('an uncertain send to a busy thread waits in its queue, and phone scenarios need ffmpeg before anything is paid', async () => {
  const base = examples()[0], world = structuredClone(base.world);
  world.projects[0].threads![1].onSend = { uncertain: true };
  const sim = new SimulatedT3(world);
  try {
    const state = new DirectCallState();
    await sim.ade.catalog(state);
    const send = sim.ade.tools.find(t => t.name === 't3_send_message')!;
    const dark = sim.threads.get(worldId('thread', 'dark-mode'))!, runs = dark.thread.runCount;
    await assert.rejects(send.execute(send.prepare!({ projectId: state.short(worldId('project', 'recipes')), project: 'recipe-app', threadId: state.short(worldId('thread', 'dark-mode')), message: 'x' }, state), context(state)), /timed out/);
    assert.equal(dark.thread.runCount, runs);
    assert.equal(sim.queued.get(dark.thread.threadId)?.length, 1);
    assert.equal(sim.uncertain.size, 1);
  } finally { sim.close(); }
  const data = mkdtempSync(join(tmpdir(), 'ade-call-eval-ffmpeg-'));
  const file = join(data, 'phone.json');
  writeFileSync(file, JSON.stringify({ ...examples()[2], file: undefined, channel: 'phone', expect: {}, turns: [{ say: 'hola', voice: 'ana' }] }));
  const out = spawnSync(process.execPath, ['--no-warnings', join(root, 'dist/scripts/eval.mjs'), 'run', file, '--data', data], { encoding: 'utf8', env: { ...process.env, PATH: '/nonexistent', ADE_CALL_CONFIG: data, OPENAI_API_KEY: '', ELEVENLABS_API_KEY: '' } });
  assert.equal(out.status, 2); assert.match(out.stderr, /ffmpeg is needed/);
  assert.equal(existsSync(join(data, 'audio-cache')), false);
});

test('redaction masks whole authorization headers and standalone keys but keeps IDs that merely contain sk-, and the judge sees when the user stopped speaking', () => {
  const digest = redactText('Authorization: Digest username=demo, nonce=sample-nonce, response=sample-response');
  assert.doesNotMatch(digest, /sample-nonce|sample-response/);
  assert.equal(redactText('A basic idea: Basic support is fine.'), 'A basic idea: Basic support is fine.');
  const ids = redactText('Please close task-123, not task-456. Key sk-abcdef123456.');
  assert.match(ids, /task-123/); assert.match(ids, /task-456/); assert.doesNotMatch(ids, /sk-abcdef/);
  // Session cookies carry no recognizable prefix: the whole header value goes.
  for (const header of ['Cookie: sessionid=abc123def; theme=dark', 'set-cookie: sid=xyz789; HttpOnly', '{"cookie": "sessionid=abc123def"}']) {
    assert.doesNotMatch(redactText(header), /abc123def|xyz789/); assert.ok(looksLikeCredential(header));
  }
  // Saved evidence keeps its usage counters, whose names contain "token".
  assert.deepEqual(redactEvidence({ usage: { input_tokens: 12 }, token: 'x', text: 'Cookie: sid=1' }), { usage: { input_tokens: 12 }, token: '[credential]', text: 'Cookie: [credential]' });
  const run = { tools: [], sends: [], notices: [], timeouts: [], providerErrors: [], transcript: [], turns: [{ index: 1, kind: 'say', text: 'hola', words: 'hola', startMs: 1000, endMs: 6000 }] } as unknown as RunRecord;
  assert.match(callLog(examples()[0], run), /USER TURN 1 \(the user speaks until 6\.0s\)/);
});

test('a recording that does not decode is refused before any paid work', { skip: noFfmpeg }, () => {
  const data = mkdtempSync(join(tmpdir(), 'ade-call-eval-clip-'));
  writeFileSync(join(data, 'bad.wav'), 'not audio');
  const file = join(data, 's.json');
  writeFileSync(file, JSON.stringify({ ...examples()[2], file: undefined, expect: {}, turns: [{ say: 'hola', voice: 'ana' }, { audio: 'bad.wav', transcript: 'sí' }] }));
  const out = spawnSync(process.execPath, ['--no-warnings', join(root, 'dist/scripts/eval.mjs'), 'run', file, '--data', data], { encoding: 'utf8', env: { ...process.env, ADE_CALL_CONFIG: data, OPENAI_API_KEY: '', ELEVENLABS_API_KEY: '' } });
  assert.equal(out.status, 2); assert.match(out.stderr, /turn 2: bad\.wav does not decode to audio/);
  assert.equal(existsSync(join(data, 'audio-cache')), false);
});

test('scenarios carrying credentials or empty lines are refused, HTTP_AUTHORIZATION is masked whole, and receipts keep the name the voice gave', async () => {
  const base = examples()[0], world = structuredClone(base.world);
  world.projects[0].threads![0].messages!.push({ role: 'assistant', text: 'curl -H "Authorization: Basic dXNlcjpwYXNz" https://example.test' });
  assert.throws(() => validateScenario({ ...base, world }), /looks like a credential/);
  assert.throws(() => validateScenario({ ...base, expect: {}, turns: [{ say: '  ' }] }), /say has no words/);
  for (const battery of readdirSync(join(root, 'evals/battery')).filter(f => f.endsWith('.json'))) assert.doesNotThrow(() => loadScenarios(join(root, 'evals/battery', battery)));
  assert.doesNotMatch(redactText('HTTP_AUTHORIZATION=Digest username="demo", nonce="example", response="example-proof"'), /example-proof|nonce="example"/);
  const sim = new SimulatedT3(base.world);
  try {
    const state = new DirectCallState();
    await sim.ade.catalog(state);
    const send = sim.ade.tools.find(t => t.name === 't3_send_message')!;
    const sent = await send.execute(send.prepare!({ projectId: state.short(worldId('project', 'recipes')), project: 'billing-service', message: 'x' }, state), context(state));
    assert.equal(sent.delivered?.project, 'billing-service');
    assert.equal(sim.threads.get(worldId('thread', 'main:recipes'))!.thread.title, 'Voice · billing-service · Main');
  } finally { sim.close(); }
});

for (const lateTool of [false, true]) test(`an interruption skips known preambles and rejects tools discovered after the cut (late=${lateTool})`, { timeout: 30_000 }, async () => {
  class PreambleTool extends TurnProvider {
    pendingTool?: () => void;
    override send(data: string) {
      const event = JSON.parse(data) as { type: string; audio?: string };
      if (event.type !== 'input_audio_buffer.append') return super.send(data);
      const loud = Buffer.from(event.audio!, 'base64').some(byte => byte !== 0);
      if (loud && !this.speaking) { this.speaking = true; if (this.turns === 1) { this.emitEvent({ type: 'input_audio_buffer.speech_started', item_id: 'u2', audio_start_ms: 0 }); this.pendingTool?.(); } return; }
      if (loud || !this.speaking) return;
      this.speaking = false;
      const n = ++this.turns;
      this.emitEvent({ type: 'input_audio_buffer.committed', item_id: `u${n}` });
      this.emitEvent({ type: 'response.created', response: { id: `r${n}` } });
      this.emitEvent({ type: 'response.output_audio.delta', response_id: `r${n}`, item_id: `a${n}`, delta: Buffer.alloc(BYTES_PER_MS * (n === 1 ? 2000 : 100), 0x10).toString('base64') });
      if (n === 1) {
        const tool = () => this.emitEvent({ type: 'response.output_item.done', response_id: 'r1', item: { type: 'function_call', name: 't3_list_threads', call_id: 'call_pre', arguments: '{}' } });
        if (lateTool) this.pendingTool = tool; else tool();
        if (!lateTool) setTimeout(() => {
          this.emitEvent({ type: 'response.created', response: { id: 'proposal' } });
          this.emitEvent({ type: 'response.output_audio.delta', response_id: 'proposal', item_id: 'proposal-audio', delta: Buffer.alloc(BYTES_PER_MS * 2000, 0x10).toString('base64') });
          this.emitEvent({ type: 'response.done', response: { id: 'proposal', status: 'completed' } });
        }, 2200);
      }
      this.emitEvent({ type: 'response.done', response: { id: `r${n}`, status: 'completed' } });
    }
  }
  const scenario = { ...examples()[2], turns: [{ noise: 'pink' as const, ms: 300 }, { noise: 'pink' as const, ms: 300, bargeInMs: 500 }] };
  const run = await runScenario(scenario, { key: 'k', settings: {}, speech: new Speech({ cacheDir: mkdtempSync(join(tmpdir(), 'eval-run-')) }), voices: { a: { id: 'v' } }, defaultVoice: 'a', noResponseMs: 500, turnTimeoutMs: 3000,
    connect: () => new PreambleTool() as never });
  assert.equal(!!run.turns[1].bargeIn?.preamble, lateTool);
  const check = checkRun(scenario as Scenario, run).find(c => c.id === 'turns[2].bargeIn')!;
  assert.equal(check.pass, !lateTool);
  if (lateTool) assert.match(check.detail, /preamble/);
  else assert.ok(run.turns[1].startMs - run.turns[0].endMs >= 2500, 'wait for the proposal after the tool preamble');
});

test('credentials in metadata and tags without words are refused, and an unknown project spends the user turn', async () => {
  const base = examples()[0], world = structuredClone(base.world);
  world.projects[0].threads![0].status = 'password=example-only';
  assert.throws(() => validateScenario({ ...base, world }), (e: Error) => /looks like a credential/.test(e.message) && !/example-only/.test(e.message));
  const sim = new SimulatedT3(base.world);
  try {
    const state = new DirectCallState();
    await sim.ade.catalog(state);
    const session = new DirectSession(sim.ade);
    await session.catalog();
    session.remember('user', 'Yes, send it.');
    const send = (callId: string, projectId: string) => session.run({ name: 't3_send_message', call_id: callId,
      arguments: JSON.stringify({ projectId, project: 'project', message: 'x' }) }, { requestId: `voice:test:${callId}`, signal: new AbortController().signal });
    // A valid but unknown UUID attempts delivery and consumes this user turn.
    assert.equal((await send('missing', '00000000-0000-4000-8000-000000000000'))?.status, 'unknown');
    assert.equal(sim.sends.at(-1)?.uncertain, true);
    const retry = await send('corrected', worldId('project', 'recipes'));
    assert.equal(retry?.status, 'refused');
    assert.match(retry!.output, /no_user_turn/);
    session.remember('user', 'Try again.');
    const blocked = await send('blocked', '00000000-0000-4000-8000-000000000000');
    assert.equal(blocked?.status, 'error');
    assert.match(blocked!.output, /uncertain delivery/);
    assert.equal(sim.sends.length, 1);
  } finally { sim.close(); }
  const data = mkdtempSync(join(tmpdir(), 'ade-call-eval-tags-'));
  const file = join(data, 'tags.json');
  writeFileSync(file, JSON.stringify({ ...examples()[2], file: undefined, expect: {}, turns: [{ say: '[sighs]', voice: 'diego' }] }));
  const out = spawnSync(process.execPath, ['--no-warnings', join(root, 'dist/scripts/eval.mjs'), 'speak', '--dry', file, '--data', data], { encoding: 'utf8', env: { ...process.env, ADE_CALL_CONFIG: data } });
  assert.equal(out.status, 2); assert.match(out.stderr, /no words to speak/);
});

test('a failed transcription of a user turn makes the run incomplete', { timeout: 30_000 }, async () => {
  class FailsTranscription extends FakeProvider {
    override send(data: string) {
      const event = JSON.parse(data) as { type: string };
      if (event.type === 'input_audio_buffer.append' && !this.failed) { this.failed = true; setTimeout(() => this.emit('message', Buffer.from(JSON.stringify({ type: 'conversation.item.input_audio_transcription.failed', item_id: 'u1', error: { code: 'audio_unintelligible' } }))), 50); }
      return super.send(data);
    }
    failed = false;
  }
  const scenario = { ...examples()[2], turns: [{ noise: 'pink' as const, ms: 300 }] };
  const run = runScenario(scenario, { key: 'k', settings: {}, speech: new Speech({ cacheDir: mkdtempSync(join(tmpdir(), 'eval-run-')) }), voices: {}, defaultVoice: '', noResponseMs: 500,
    connect: () => new FailsTranscription() as never });
  await assert.rejects(run, /Transcription of a user turn failed \(audio_unintelligible\)/);
});

test('a repeated function call in a later response keeps the original send turn', { timeout: 30_000 }, async () => {
  class DuplicateCall extends TurnProvider {
    override emitEvent(event: Record<string, unknown>) {
      super.emitEvent(event);
      if (event.type === 'input_audio_buffer.committed') super.emitEvent({ type: 'conversation.item.input_audio_transcription.completed', item_id: event.item_id, transcript: 'Yes, send it.' });
      const response = event.response as { id?: string } | undefined;
      if (event.type === 'response.created' && /^r[12]$/.test(response?.id || '')) super.emitEvent({ type: 'response.output_item.done', response_id: response!.id,
        item: { type: 'function_call', name: 't3_send_message', call_id: 'same-call', arguments: JSON.stringify(sendTo('t')) } });
    }
  }
  const scenario = validateScenario({ id: 'duplicate-call', description: 'Keep the original send attribution.',
    world: { projects: [{ key: 'p', name: 'proj', threads: [{ key: 't', title: 'Thread' }] }] },
    turns: [{ noise: 'pink', ms: 300 }, { noise: 'pink', ms: 300 }], expect: { sends: [{ turn: 2, project: 'p', thread: 't' }] } });
  const run = await runScenario(scenario, { key: 'k', settings: {}, speech: new Speech({ cacheDir: mkdtempSync(join(tmpdir(), 'eval-run-')) }), voices: {}, defaultVoice: '', noResponseMs: 500,
    connect: () => new DuplicateCall() as never });
  assert.equal(run.sends.length, 1);
  assert.equal(run.sends[0].turn, 1);
  assert.equal(run.tools.filter(t => t.name === 't3_send_message').length, 1);
  assert.equal(run.tools.find(t => t.name === 't3_send_message')?.resolvedArgs?.threadId, worldId('thread', 't'));
  assert.equal(checkRun(scenario, run).find(c => c.id === 'sends[1].turn')?.pass, false);
});

for (const resolution of ['failed', 'completed', 'never']) test(`the final committed transcription must resolve (${resolution})`, { timeout: 15_000 }, async () => {
  class LateTranscription extends TurnProvider {
    override autoTranscribe = false;
    override emitEvent(event: Record<string, unknown>) {
      super.emitEvent(event);
      if (event.type === 'input_audio_buffer.committed' && resolution !== 'never') setTimeout(() => super.emitEvent({
        type: `conversation.item.input_audio_transcription.${resolution}`, item_id: event.item_id,
        transcript: 'Late words', error: { code: 'late_failure' }
      }), 4000);
    }
  }
  const scenario = { ...examples()[2], turns: [{ noise: 'pink' as const, ms: 300 }] };
  const run = runScenario(scenario, { key: 'k', settings: {}, speech: new Speech({ cacheDir: mkdtempSync(join(tmpdir(), 'eval-late-transcript-')) }),
    voices: {}, defaultVoice: '', noResponseMs: 500, transcriptionTimeoutMs: resolution === 'never' ? 100 : 5000,
    connect: () => new LateTranscription() as never });
  if (resolution === 'completed') assert.ok((await run).transcript.some(t => t.text === 'Late words'));
  else await assert.rejects(run, resolution === 'failed' ? /late_failure/ : /transcription did not finish/);
});

test('the judge distinguishes unknown attempts from deliveries with lost receipts and keeps the initial catalog', () => {
  const scenario = examples()[0], projectId = '00000000-0000-4000-8000-000000000000';
  const sends: RunRecord['sends'] = [{ ms: 1, turn: 1, projectKey: '', projectId, threadKey: null, message: 'x', uncertain: true, arrival: 'unknown' }];
  const unknown = callLog(scenario, record({ sends }));
  assert.match(unknown, /no arrival is established/);
  assert.ok(unknown.includes(projectId));
  assert.doesNotMatch(unknown, /message did arrive/);
  assert.match(callLog(scenario, record({ sends: [{ ...sends[0], arrival: 'confirmed' }] })), /message did arrive/);
  const catalog = 'T3 CATALOG\nThread Rust · updated 2000-01-01';
  const input = judgeInput(scenario, record({ initialCatalog: catalog }));
  assert.ok(input.includes(catalog));
  assert.notEqual(input, judgeInput(scenario, record({ initialCatalog: catalog.replace('2000', '2026') })));
  assert.match(judgeInput(scenario, record()), /initial catalog was not saved/);
});

test('unknown send attempts cannot satisfy deliveries but still count as extra or forbidden sends', () => {
  const scenario = { ...examples()[0], expect: { sends: [{ turn: 1, thread: null, includes: ['fix'] }] } };
  const attempt: RunRecord['sends'][number] = { ms: 1, turn: 1, projectKey: '', projectId: '00000000-0000-4000-8000-000000000000', threadKey: null, message: 'fix it', uncertain: true, arrival: 'unknown' };
  const checks = checkRun(scenario, record({ sends: [attempt] }));
  assert.deepEqual(checks.filter(c => c.critical && !c.pass).map(c => c.id), ['sends[1].accepted']);
  const forbidden = checkRun({ ...scenario, expect: { sends: [] } }, record({ sends: [attempt] }));
  assert.equal(forbidden.find(c => c.id === 'sends.count')?.pass, false);
  // Lost receipts, including accepted queued work, still satisfy a delivery.
  assert.ok(checkRun(scenario, record({ sends: [{ ...attempt, projectKey: 'recipes', arrival: 'confirmed' }] })).every(c => !c.critical || c.pass));
  assert.equal(checkRun(scenario, record({ sends: [{ ...attempt, arrival: undefined }] })).find(c => c.id === 'sends[1].accepted')?.pass, false);
});

for (const field of ['parentThreadId', 'rootThreadId']) test(`project-scoped tool checks resolve listing ${field}`, () => {
  const scenario = examples()[0];
  const tools: RunRecord['tools'] = [{ ms: 1, turn: 1, name: 't3_list_threads', status: 'completed', args: { [field]: worldId('thread', 'search').slice(0, 8) }, result: '' }];
  const required = checkRun({ ...scenario, expect: { tools: { required: [{ name: 't3_list_threads', project: 'recipes', critical: true }] } } }, record({ tools }));
  assert.equal(required.find(c => c.id === 'tools.required.t3_list_threads')?.pass, true);
  const forbidden = checkRun({ ...scenario, expect: { tools: { forbidden: [{ name: 't3_list_threads', project: 'recipes' }] } } }, record({ tools }));
  assert.equal(forbidden.find(c => c.id === 'tools.forbidden.t3_list_threads:recipes')?.pass, false);
});

test('search scope ignores an unrelated thread argument and malformed expectations cannot drop checks', () => {
  const scenario = examples()[0];
  for (const expect of [[{ sends: [] }], { tools: [] }, { sends: [null] }]) assert.throws(() => validateScenario({ ...scenario, expect }), /expect/);
  const tools: RunRecord['tools'] = [{ ms: 1, turn: 1, name: 't3_find_threads', status: 'completed', result: '',
    args: { projectId: worldId('project', 'recipes').slice(0, 8), threadId: worldId('thread', 'invoices').slice(0, 8), query: 'search' } }];
  const checks = checkRun({ ...scenario, expect: { tools: {
    required: [{ name: 't3_find_threads', project: 'recipes', critical: true }], forbidden: [{ name: 't3_find_threads', project: 'recipes' }]
  } } }, record({ tools }));
  assert.equal(checks.find(c => c.id === 'tools.required.t3_find_threads')?.pass, true);
  assert.equal(checks.find(c => c.id === 'tools.forbidden.t3_find_threads:recipes')?.pass, false);
});

test('uncached speech anywhere in the selection requires a key before claiming a run folder', () => {
  const data = mkdtempSync(join(tmpdir(), 'eval-key-preflight-')), voice = { id: 'offline-voice' };
  const speech = new Speech({ cacheDir: join(data, 'audio-cache') });
  writeFileSync(join(data, 'voices.json'), JSON.stringify({ offline: voice }));
  const base = { ...examples()[2], file: undefined, expect: {} };
  const scenarios = [{ ...base, id: 'cached-first', turns: [{ say: 'Cached phrase', voice: 'offline' }] },
    { ...base, id: 'uncached-second', turns: [{ say: 'Uncached phrase', voice: 'offline' }] }];
  writeFileSync(speech.path('Cached phrase', voice, base.language).file, Buffer.alloc(BYTES_PER_MS * 300));
  const file = join(data, 'scenarios.json'), out = join(data, 'planned');
  writeFileSync(file, JSON.stringify(scenarios));
  const result = spawnSync(process.execPath, ['--no-warnings', join(root, 'dist/scripts/eval.mjs'), 'run', file, '--data', data, '--out', out, '--no-judge'],
    { encoding: 'utf8', env: { ...process.env, ADE_CALL_CONFIG: data, OPENAI_API_KEY: '', ELEVENLABS_API_KEY: '' } });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /ElevenLabs key is missing.*not cached/);
  assert.equal(existsSync(out), false);
});

test('judge evidence distinguishes saved recognition hints, empty hints and legacy recordings', () => {
  const scenario = examples()[2];
  const hints = judgeInput(scenario, record({ vocabulary: ['ingredient search'] }));
  const empty = judgeInput(scenario, record({ vocabulary: [] }));
  const legacy = judgeInput(scenario, record({ vocabulary: undefined }));
  assert.match(hints, /RECOGNITION HINTS.*ingredient search/s);
  assert.match(empty, /explicitly empty/);
  assert.match(legacy, /recognition hints were not saved/);
  assert.notEqual(hints, empty);
  assert.notEqual(empty, legacy);
});

test('unknown expectation keys fail validation rather than silently disabling checks', () => {
  const base = examples()[0];
  for (const expect of [{ send: [] }, { sends: [{ turn: 1, include: ['fix'] }] }, { tools: { forbiden: [] } },
    { tools: { required: [{ name: 't3_read_thread', byTurns: 1 }] } }, { tools: { forbidden: [{ name: 't3_read_thread', proyect: 'recipes' }] } }]) {
    assert.throws(() => validateScenario({ ...base, expect }), /unknown field expect\./);
  }
});

test('a forbidden document read uses its project even when an ignored thread points elsewhere', () => {
  const scenario = examples()[0];
  const tools: RunRecord['tools'] = [{ ms: 1, turn: 1, name: 't3_read_document', status: 'error', result: '',
    args: { projectId: worldId('project', 'recipes').slice(0, 8), threadId: worldId('thread', 'invoices').slice(0, 8), path: 'README.md' } }];
  const checks = checkRun({ ...scenario, expect: { tools: { forbidden: [{ name: 't3_read_document', project: 'recipes' }] } } }, record({ tools }));
  assert.equal(checks.find(c => c.id === 'tools.forbidden.t3_read_document:recipes')?.pass, false);
});

test('invalid selected speakers and missing OpenAI keys fail before a run folder is claimed', () => {
  const data = mkdtempSync(join(tmpdir(), 'eval-preflight-')), file = join(data, 'scenario.json'), out = join(data, 'planned');
  const base = { ...examples()[2], file: undefined, expect: {} };
  writeFileSync(file, JSON.stringify({ ...base, turns: [{ say: 'First', voice: 'valid' }, { say: 'Second', voice: 'invalid' }] }));
  const cli = (command: string) => spawnSync(process.execPath, ['--no-warnings', join(root, 'dist/scripts/eval.mjs'), command, file, '--data', data, ...(command === 'run' ? ['--out', out, '--no-judge'] : ['--dry'])],
    { encoding: 'utf8', env: { ...process.env, ADE_CALL_CONFIG: data, OPENAI_API_KEY: '', ELEVENLABS_API_KEY: '' } });
  for (const invalid of [{}, { id: '' }, { id: '  ' }, { id: 2 }]) {
    writeFileSync(join(data, 'voices.json'), JSON.stringify({ valid: { id: 'v' }, invalid }));
    for (const command of ['speak', 'run']) {
      const result = cli(command);
      assert.equal(result.status, 2);
      assert.match(result.stderr, /needs a nonempty string id/);
      assert.equal(existsSync(out), false);
    }
  }
  writeFileSync(file, JSON.stringify({ ...base, turns: [{ noise: 'pink', ms: 300 }] }));
  const missing = cli('run');
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /OpenAI key is missing/);
  assert.equal(existsSync(out), false);
});

test('supplied expectation destinations cannot become accidental wildcards', () => {
  const base = examples()[0];
  for (const value of ['', ' ', null, 0, false, 'missing']) {
    assert.throws(() => validateScenario({ ...base, expect: { sends: [{ turn: 1, project: value }] } }), /project/);
    assert.throws(() => validateScenario({ ...base, expect: { tools: { required: [{ name: 't3_list_threads', project: value }] } } }), /project/);
    if (value !== null) assert.throws(() => validateScenario({ ...base, expect: { sends: [{ turn: 1, thread: value }] } }), /thread/);
  }
  assert.doesNotThrow(() => validateScenario({ ...base, expect: { sends: [{ turn: 1, thread: null }] } }));
});

test('list rules retain both parent and root filters', () => {
  const scenario = examples()[0];
  const tools: RunRecord['tools'] = [{ ms: 1, turn: 1, name: 't3_list_threads', status: 'completed', result: '',
    args: { parentThreadId: worldId('thread', 'search').slice(0, 8), rootThreadId: worldId('thread', 'dark-mode').slice(0, 8) } }];
  for (const thread of ['search', 'dark-mode']) {
    const checks = checkRun({ ...scenario, expect: { tools: { forbidden: [{ name: 't3_list_threads', thread }] } } }, record({ tools }));
    assert.equal(checks.find(c => c.id === `tools.forbidden.t3_list_threads:${thread}`)?.pass, false);
  }
});

test('all selected numeric speaker settings are validated before any synthesis request', () => {
  const data = mkdtempSync(join(tmpdir(), 'eval-speaker-numbers-')), file = join(data, 'scenario.json'), requests = join(data, 'requests');
  const preload = join(data, 'fetch.mjs');
  writeFileSync(preload, `import { appendFileSync } from 'node:fs'; globalThis.fetch = async () => { appendFileSync(${JSON.stringify(requests)}, 'called\\n'); return { ok: true, arrayBuffer: async () => new ArrayBuffer(14400) }; };`);
  writeFileSync(file, JSON.stringify({ ...examples()[2], file: undefined, expect: {}, turns: [{ say: 'First', voice: 'good' }, { say: 'Second', voice: 'bad' }] }));
  for (const [field, value] of [['stability', 'slow'], ['similarity', null], ['style', -1], ['speed', 5]] as const) {
    writeFileSync(join(data, 'voices.json'), JSON.stringify({ good: { id: 'v' }, bad: { id: 'v2', [field]: value } }));
    const result = spawnSync(process.execPath, ['--import', preload, '--no-warnings', join(root, 'dist/scripts/eval.mjs'), 'speak', file, '--data', data],
      { encoding: 'utf8', env: { ...process.env, ADE_CALL_CONFIG: data, ELEVENLABS_API_KEY: 'fixture-key' } });
    assert.equal(result.status, 2);
    assert.match(result.stderr, new RegExp(`speaker ${field} must be a number`));
    assert.equal(existsSync(requests), false);
  }
});

test('send attempts retain explicit and owning projects while reads ignore stray project fields', () => {
  const scenario = examples()[0];
  const args = { projectId: worldId('project', 'billing').slice(0, 8), threadId: worldId('thread', 'search').slice(0, 8) };
  for (const name of ['t3_send_message', 't3_read_thread']) {
    const run = record({ tools: [{ ms: 1, turn: 1, name, status: 'error', args, result: '' }] });
    for (const project of ['billing', 'recipes']) {
      const check = checkRun({ ...scenario, expect: { tools: { forbidden: [{ name, project }] } } }, run).find(c => c.id === `tools.forbidden.${name}:${project}`)!;
      assert.equal(check.pass, name === 't3_read_thread' && project === 'billing');
    }
  }
});

test('blank or non-string selected credentials cannot start synthesis or claim a run', () => {
  const data = mkdtempSync(join(tmpdir(), 'eval-blank-key-')), file = join(data, 'scenario.json'), out = join(data, 'planned'), requests = join(data, 'requests');
  const preload = join(data, 'fetch.mjs');
  writeFileSync(preload, `import { appendFileSync } from 'node:fs'; globalThis.fetch = async () => { appendFileSync(${JSON.stringify(requests)}, 'called'); throw new Error('mock'); };`);
  writeFileSync(file, JSON.stringify({ ...examples()[2], file: undefined, expect: {}, turns: [{ say: 'Uncached speech' }] }));
  for (const config of [{ openaiKey: '   ', elevenlabsKey: 'fixture' }, { openaiKey: 42, elevenlabsKey: 'fixture' }, { openaiKey: 'fixture', elevenlabsKey: '  ' }, { openaiKey: 'fixture', elevenlabsKey: 42 }]) {
    writeFileSync(join(data, 'config.json'), JSON.stringify(config));
    const result = spawnSync(process.execPath, ['--import', preload, '--no-warnings', join(root, 'dist/scripts/eval.mjs'), 'run', file, '--data', data, '--out', out, '--no-judge'],
      { encoding: 'utf8', env: { ...process.env, ADE_CALL_CONFIG: data, OPENAI_API_KEY: '', ELEVENLABS_API_KEY: '' } });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /key is missing/);
    assert.equal(existsSync(out), false);
    assert.equal(existsSync(requests), false);
  }
});

test('main-thread sends match required and forbidden destination rules without a thread ID', () => {
  const base = examples()[0];
  const scenario = validateScenario({ ...base, expect: { tools: {
    required: [{ name: 't3_send_message', thread: 'main:recipes', critical: true }],
    forbidden: [{ name: 't3_send_message', thread: 'main:recipes' }]
  } } });
  const tools: RunRecord['tools'] = [{ ms: 1, turn: 1, name: 't3_send_message', status: 'completed', result: '', args: { projectId: worldId('project', 'recipes').slice(0, 8), message: 'x' } }];
  const checks = checkRun(scenario, record({ tools }));
  assert.equal(checks.find(c => c.id === 'tools.required.t3_send_message:main:recipes')?.pass, true);
  assert.equal(checks.find(c => c.id === 'tools.forbidden.t3_send_message:main:recipes')?.pass, false);
});

test('model, voice and transcription configuration are checked before uncached synthesis', () => {
  const data = mkdtempSync(join(tmpdir(), 'eval-model-preflight-')), file = join(data, 'scenario.json'), out = join(data, 'planned'), requests = join(data, 'requests');
  const preload = join(data, 'fetch.mjs');
  writeFileSync(preload, `import { appendFileSync } from 'node:fs'; globalThis.fetch = async () => { appendFileSync(${JSON.stringify(requests)}, 'called'); throw new Error('mock'); };`);
  writeFileSync(file, JSON.stringify({ ...examples()[2], file: undefined, expect: {}, turns: [{ say: 'Uncached words' }] }));
  for (const field of ['realtimeModel', 'realtimeVoice', 'realtimeTranscriptionModel']) for (const value of [42, ' ', null]) {
    writeFileSync(join(data, 'config.json'), JSON.stringify({ openaiKey: 'fixture', elevenlabsKey: 'fixture', [field]: value }));
    const result = spawnSync(process.execPath, ['--import', preload, '--no-warnings', join(root, 'dist/scripts/eval.mjs'), 'run', file, '--data', data, '--out', out, '--no-judge'],
      { encoding: 'utf8', env: { ...process.env, ADE_CALL_CONFIG: data } });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /must be a nonblank string/);
    assert.equal(existsSync(out), false);
    assert.equal(existsSync(requests), false);
  }
});

test('tags must be a list rather than a substring selector', () => {
  const base = examples()[0];
  for (const tags of ['no-send', [''], [' '], [1], null]) assert.throws(() => validateScenario({ ...base, tags }), /tags must be a list/);
  assert.doesNotThrow(() => validateScenario({ ...base, tags: ['no-send'] }));
});

test('colliding prefixes use the actual call resolution and legacy recordings are inconclusive', async () => {
  const first = 'thread-40', actual = 'thread-1136', id = worldId('thread', actual), prefix = id.slice(0, 6);
  assert.equal(worldId('thread', first).slice(0, 6), prefix);
  const scenario = validateScenario({ id: 'collision', description: 'Resolve from remembered IDs.', world: { projects: [{ key: 'p', name: 'proj', threads: [{ key: first, title: 'First' }, { key: actual, title: 'Actual' }] }] },
    turns: [{ noise: 'pink', ms: 300 }], expect: { tools: { forbidden: [{ name: 't3_read_thread', thread: actual }] } } });
  const sim = new SimulatedT3(scenario.world);
  try {
    const state = new DirectCallState();
    state.remember(id);
    const contextValue = context(state);
    await sim.ade.tools.find(t => t.name === 't3_read_thread')!.execute({ threadId: prefix }, contextValue);
    const resolvedArgs = sim.resolvedTargets.get(contextValue.requestId)!;
    assert.equal(resolvedArgs.threadId, id);
    const line = { ms: 1, turn: 1, name: 't3_read_thread', status: 'completed', result: '', args: { threadId: prefix }, resolvedArgs };
    assert.equal(checkRun(scenario, record({ tools: [line] })).find(c => c.id === `tools.forbidden.t3_read_thread:${actual}`)?.pass, false);
    const legacy = checkRun(scenario, record({ tools: [{ ...line, resolvedArgs: undefined }] }));
    assert.equal(legacy.find(c => c.id === 'tools.targets[1]')?.pass, false);
    assert.equal(legacy.find(c => c.id === 'tools.targets[1]')?.critical, true);
  } finally { sim.close(); }
});

test('recording targets cannot teach the call an ignored ID before a read', async () => {
  const sim = new SimulatedT3(examples()[0].world), state = new DirectCallState(), id = worldId('thread', 'search');
  try {
    await assert.rejects(sim.ade.tools.find(t => t.name === 't3_read_thread')!.execute({ projectId: id, threadId: id.slice(0, 6) }, context(state)), /does not match any ID shown/);
    assert.equal(state.ids.size, 0);
    assert.equal(sim.resolvedTargets.has(context(state).requestId), false);
  } finally { sim.close(); }
});

test('invalid PCM cache entries fail batch preflight and are never read as valid speech', async () => {
  const data = mkdtempSync(join(tmpdir(), 'eval-cache-validation-')), voice = { id: 'v' }, speech = new Speech({ cacheDir: join(data, 'audio-cache') });
  const base = { ...examples()[2], file: undefined, expect: {} }, out = join(data, 'planned'), file = join(data, 'scenarios.json');
  writeFileSync(join(data, 'voices.json'), JSON.stringify({ offline: voice }));
  writeFileSync(file, JSON.stringify(['First', 'Second'].map((say, i) => ({ ...base, id: `cache-${i}`, turns: [{ say, voice: 'offline' }] }))));
  writeFileSync(speech.path('First', voice, base.language).file, Buffer.alloc(BYTES_PER_MS * 300));
  const invalidFile = speech.path('Second', voice, base.language).file;
  for (const bytes of [0, 2, BYTES_PER_MS * 100 + 1]) {
    writeFileSync(invalidFile, Buffer.alloc(bytes));
    assert.equal(speech.has('Second', voice, base.language), false);
    await assert.rejects(speech.say('Second', voice, base.language), /key is missing/);
    const result = spawnSync(process.execPath, ['--no-warnings', join(root, 'dist/scripts/eval.mjs'), 'run', file, '--data', data, '--out', out, '--no-judge'],
      { encoding: 'utf8', env: { ...process.env, ADE_CALL_CONFIG: data, OPENAI_API_KEY: '', ELEVENLABS_API_KEY: '' } });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /ElevenLabs key is missing.*not cached/);
    assert.equal(existsSync(out), false);
  }
  const repair = new Speech({ cacheDir: speech.options.cacheDir, key: 'fixture', fetch: async () => ({ ok: true, status: 200, text: async () => '', arrayBuffer: async () => new ArrayBuffer(BYTES_PER_MS * 200) }) });
  assert.equal((await repair.say('Second', voice, base.language)).length, BYTES_PER_MS * 200);
  assert.equal(speech.has('Second', voice, base.language), true);
});

test('silent turns fail on played answer audio even without an assistant transcript', { timeout: 20_000 }, async () => {
  class AudioOnly extends TurnProvider {
    override emitEvent(event: Record<string, unknown>) {
      if (event.type === 'response.output_audio_transcript.done') return;
      super.emitEvent(event);
    }
  }
  const scenario = { ...examples()[2], expect: {}, turns: [{ noise: 'pink' as const, ms: 300, silent: true }] };
  const run = await runScenario(scenario, { key: 'k', settings: {}, speech: new Speech({ cacheDir: mkdtempSync(join(tmpdir(), 'eval-silent-audio-')) }),
    voices: {}, defaultVoice: '', noResponseMs: 500, connect: () => new AudioOnly() as never });
  assert.ok(run.turns[0].firstAnswerMs != null);
  assert.equal(run.transcript.filter(t => t.role === 'assistant').length, 0);
  assert.equal(checkRun(scenario, run).find(c => c.id === 'turns[1].silent')?.pass, false);
  const next = { ...scenario, turns: [...scenario.turns, { noise: 'pink' as const, ms: 300 }] };
  const after = { ...run, turns: [{ ...run.turns[0], firstAnswerMs: 5000 }, { index: 2, kind: 'noise', startMs: 4000, endMs: 4300 }] };
  assert.equal(checkRun(next, after).find(c => c.id === 'turns[1].silent')?.pass, true);
  const legacy = { ...run, turns: [{ ...run.turns[0], firstAnswerMs: undefined, latencyMs: 200 }] };
  assert.equal(checkRun(scenario, legacy).find(c => c.id === 'turns[1].silent')?.pass, false);
});

test('explicit empty TTS model overrides are refused before speech or output creation', () => {
  const data = mkdtempSync(join(tmpdir(), 'eval-tts-model-')), file = join(data, 'scenario.json'), out = join(data, 'planned');
  writeFileSync(file, JSON.stringify({ ...examples()[2], file: undefined, expect: {}, turns: [{ say: 'Uncached words' }] }));
  for (const value of ['', ' ']) for (const command of ['speak', 'run']) {
    const result = spawnSync(process.execPath, ['--no-warnings', join(root, 'dist/scripts/eval.mjs'), command, file, '--data', data, `--tts-model=${value}`, ...(command === 'run' ? ['--out', out, '--no-judge'] : ['--dry'])],
      { encoding: 'utf8', env: { ...process.env, ADE_CALL_CONFIG: data, OPENAI_API_KEY: '', ELEVENLABS_API_KEY: '' } });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--tts-model must be a nonblank string/);
    assert.equal(existsSync(out), false);
    assert.equal(existsSync(join(data, 'audio-cache')), false);
  }
});

test('silence requires saved playback evidence even when legacy latency is null', () => {
  const scenario = { ...examples()[2], expect: {}, turns: [{ noise: 'pink' as const, ms: 300, silent: true }] };
  for (const firstAnswerMs of [undefined, null, 350]) {
    const run = record({ transcript: [], turns: [{ index: 1, kind: 'noise', startMs: 0, endMs: 300, latencyMs: null, firstAnswerMs }] });
    assert.equal(checkRun(scenario, run).find(c => c.id === 'turns[1].silent')?.pass, firstAnswerMs === null);
  }
});

test('audio-only answers count as answers and reach the judge with their timestamp', () => {
  const scenario = { ...examples()[2], expect: {}, turns: [{ say: 'Hello' }] };
  const run = record({ transcript: [], turns: [{ index: 1, kind: 'say', text: 'Hello', startMs: 0, endMs: 300, latencyMs: null, firstAnswerMs: 350 }] });
  assert.equal(checkRun(scenario, run).find(c => c.id === 'call.everyTurnAnswered')?.pass, true);
  assert.match(callLog(scenario, run), /\[0.3s\] VOICE .*answer audio started playing.*words are unknown/);
  assert.doesNotMatch(callLog(scenario, { ...run, turns: [{ ...run.turns[0], firstAnswerMs: null }] }), /answer audio started playing/);
});

test('a user transcript keeps its turn when the provider dates its speech before the turn started', { timeout: 60_000 }, async () => {
  // The provider's VAD padding puts audio_start_ms up to a second before the words.
  class EarlyStart extends TurnProvider {
    chunks = 0; started = false;
    override send(data: string) {
      const event = JSON.parse(data) as { type: string; audio?: string };
      if (event.type !== 'input_audio_buffer.append') return super.send(data);
      const loud = Buffer.from(event.audio!, 'base64').some(byte => byte !== 0);
      this.chunks++;
      if (loud && !this.started) { this.started = true; this.emitEvent({ type: 'input_audio_buffer.speech_started', item_id: `u${this.turns + 1}`, audio_start_ms: Math.max(0, (this.chunks - 1) * 100 - 800) }); }
      if (!loud && this.started) {
        this.started = false;
        const n = ++this.turns;
        this.emitEvent({ type: 'input_audio_buffer.committed', item_id: `u${n}` });
        this.emitEvent({ type: 'conversation.item.input_audio_transcription.completed', item_id: `u${n}`, transcript: `words ${n}` });
      }
    }
  }
  const scenario = { ...examples()[2], turns: [{ noise: 'pink' as const, ms: 300 }, { noise: 'pink' as const, ms: 300, pauseMs: 300 }] };
  const run = await runScenario(scenario, { key: 'k', settings: {}, speech: new Speech({ cacheDir: mkdtempSync(join(tmpdir(), 'eval-run-')) }), voices: {}, defaultVoice: '', noResponseMs: 500,
    connect: () => new EarlyStart() as never });
  assert.deepEqual(run.transcript.filter(l => l.role === 'user').map(l => [l.text, l.turn]), [['words 1', 1], ['words 2', 2]]);
});

test('a run label must be one folder name inside runs/', () => {
  const data = mkdtempSync(join(tmpdir(), 'ade-call-eval-label-'));
  for (const label of ['../x', 'a/b', '..']) {
    const out = spawnSync(process.execPath, ['--no-warnings', join(root, 'dist/scripts/eval.mjs'), 'run', '--no-judge', '--label', label, join(root, 'evals/scenarios/examples.json'), '--data', data], { encoding: 'utf8', env: { ...process.env, ADE_CALL_CONFIG: data, OPENAI_API_KEY: '', ELEVENLABS_API_KEY: '' } });
    assert.equal(out.status, 2, label); assert.match(out.stderr, /--label must be a single folder name/);
  }
  assert.equal(existsSync(join(data, 'runs')), false);
});
