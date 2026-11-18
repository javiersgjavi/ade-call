import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import type { DirectResult, DirectTool, DirectToolContext } from '../src/direct/contract.mjs';
import { RealtimeCalls, transcriptionLanguage } from '../src/voice/realtime.mjs';
import { DirectSession } from '../src/direct/session.mjs';
import { NotDispatchedError } from '../src/direct/contract.mjs';
import { StatusError } from '../src/shared/contracts.mjs';
import { callLanguage, directInstructions } from '../src/direct/prompt.mjs';
import { compactCatalog } from '../src/direct/t3.mjs';
import { DirectCallState } from '../src/direct/state.mjs';
import { normalizeLiveEvent } from '../public/live-events.js';
import { double, fakeAde } from './fixtures.mjs';

type Sent = { type: string; item?: { type?: string; role?: string; call_id?: string; output?: string; content?: { text: string }[] } };
class FakeSocket extends EventEmitter {
  readyState = 1; sent: Sent[] = [];
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  close() { this.readyState = 3; }
}
type Execute = (params: Record<string, unknown>, context: DirectToolContext) => Promise<DirectResult>;
// The engine with an invented ADE: a sending tool and a reading tool.
function fixture(execute: Execute = async () => ({ text: 'ok' }), settings = {}) {
  const socket = new FakeSocket();
  const delivered: unknown[] = [], published: { type: string; data: Record<string, unknown> }[] = [], requests: { url: string; init: RequestInit }[] = [];
  const tools: DirectTool[] = [{ name: 'fake_send', description: 'Send', parameters: { type: 'object' }, sends: true, execute }, { name: 'fake_read', description: 'Read', parameters: { type: 'object' }, execute }];
  const ade = fakeAde(tools, 'fake CATALOG · p1');
  const realtime = new RealtimeCalls(double<ConstructorParameters<typeof RealtimeCalls>[0]>({
    key: 'test-key', ade, store: { meta() {} }, settings, publish: (type, data) => published.push({ type, data }),
    context: { conversation: () => ({ id: 'current' }), resume: (options?: { languages?: string[]; language?: string }) => options?.languages?.length ? `Earlier history (${options.languages.join(', ')}${options.language ? `; chosen ${options.language}` : ''}).` : 'Earlier history.', vocabulary: () => ['Faro'], rememberClose() {}, timing: () => ({}) },
    delivered: (thread: unknown) => delivered.push(thread),
    fetch: async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return { ok: true, status: 201, text: async () => 'v=answer', headers: new Headers({ location: '/v1/realtime/calls/rtc_test123' }) };
    },
    connect: () => { setImmediate(() => socket.emit('open')); return socket; }
  }));
  const emit = (event: Record<string, unknown>) => socket.emit('message', Buffer.from(JSON.stringify(event)));
  return { realtime, socket, ade, delivered, published, requests, emit, close() { realtime.shutdown(); },
    said: (transcript: string) => emit({ type: 'response.output_audio_transcript.done', item_id: 'a' + Math.random(), transcript }),
    heard: (transcript: string) => emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u' + Math.random(), transcript }),
    call: (name: string, id: string, args = '{}') => emit({ type: 'response.output_item.done', item: { type: 'function_call', name, call_id: id, arguments: args } }),
    outputs: () => socket.sent.filter(e => e.item?.type === 'function_call_output').map(e => e.item!.output!) };
}
const wait = (ms = 50) => new Promise(resolve => setTimeout(resolve, ms));

test('creates a WebRTC call with the ADE tools, its instructions and configurable turn taking', async t => {
  const f = fixture(undefined, { eagerness: 'medium', noiseReduction: 'far_field', reasoning: 'high', model: 'gpt-realtime-2' }); t.after(() => f.close());
  const result = await f.realtime.create('v=offer');
  assert.deepEqual(result, { session: { id: 'rtc_test123' }, transport: { sdp: 'v=answer' } });
  const form = f.requests[0].init.body as FormData;
  assert.equal(form.get('sdp'), 'v=offer');
  const session = JSON.parse(String(form.get('session')));
  assert.equal(session.model, 'gpt-realtime-2'); assert.deepEqual(session.output_modalities, ['audio']);
  assert.deepEqual(session.reasoning, { effort: 'high' });
  assert.deepEqual(session.audio.input.turn_detection, { type: 'semantic_vad', eagerness: 'medium', create_response: true, interrupt_response: true });
  assert.deepEqual(session.audio.input.noise_reduction, { type: 'far_field' });
  assert.equal(session.audio.input.transcription.language, undefined, 'without any language the provider detects it'); assert.equal(session.audio.input.transcription.prompt, 'Faro', 'only the names, no words around them');
  assert.deepEqual(session.tools.map((tool: { name: string }) => tool.name), ['fake_send', 'fake_read']);
  assert.ok(session.instructions.startsWith(directInstructions(f.ade)));
  assert.match(session.instructions, /Before each fake_send ask/);
  const system = f.socket.sent.filter(e => e.item?.role === 'system').map(e => e.item!.content![0].text);
  assert.deepEqual(system, ['Earlier history.', 'fake CATALOG · p1'], 'history and catalog are silent context, not user turns');
  assert.equal(f.published.find(e => e.type === 'voice')!.data.provider, 'realtime');
});

test('changed settings and key apply from the next call and are refused while one is active or connecting', async t => {
  const f = fixture(undefined, { model: 'gpt-realtime-2' }); t.after(() => f.close());
  f.realtime.configure({ settings: { model: 'gpt-realtime-2.1-mini', voice: 'cedar', reasoning: 'high', eagerness: 'auto', noiseReduction: 'off', transcriptionModel: 'gpt-4o-mini-transcribe' }, key: 'next-key' });
  assert.deepEqual(f.realtime.settings, { model: 'gpt-realtime-2.1-mini', voice: 'cedar', reasoning: 'high', eagerness: 'auto', noiseReduction: 'off', transcriptionModel: 'gpt-4o-mini-transcribe' });
  const created = f.realtime.create('v=offer');
  assert.equal(f.realtime.busy, true);
  assert.throws(() => f.realtime.configure({ settings: { reasoning: 'low' } }), /End the call/, 'not while connecting');
  await created;
  const session = JSON.parse(String((f.requests[0].init.body as FormData).get('session')));
  assert.equal(session.model, 'gpt-realtime-2.1-mini'); assert.deepEqual(session.reasoning, { effort: 'high' });
  assert.deepEqual(session.audio.output, { voice: 'cedar' }); assert.equal(session.audio.input.noise_reduction, null);
  assert.equal(session.audio.input.turn_detection.eagerness, 'auto'); assert.equal(session.audio.input.transcription.model, 'gpt-4o-mini-transcribe');
  assert.equal((f.requests[0].init.headers as Record<string, string>).Authorization, 'Bearer next-key');
  assert.throws(() => f.realtime.configure({ key: null }), /End the call/, 'not during a call');
  assert.equal(f.realtime.key, 'next-key');
  f.realtime.close('rtc_test123');
  f.realtime.configure({ key: null }); assert.equal(f.realtime.key, undefined);
  await assert.rejects(f.realtime.create('v=offer'), /OpenAI key is missing/);
  assert.throws(() => f.realtime.configure({ settings: { reasoning: 'extreme' } }), /Invalid OpenAI Realtime reasoning/);
  assert.equal(f.realtime.reasoning, 'high', 'an invalid value changes nothing');
});

test('without a configured model the voice uses gpt-realtime-2.1', async t => {
  const f = fixture(); t.after(() => f.close());
  await f.realtime.create('v=offer');
  assert.equal(JSON.parse(String((f.requests[0].init.body as FormData).get('session'))).model, 'gpt-realtime-2.1');
});

test('the browser\'s languages reach the resume context of the call', async t => {
  const f = fixture(); t.after(() => f.close());
  await f.realtime.create('v=offer', { languages: ['es-ES', 'en'], language: 'es' });
  assert.equal(JSON.parse(String((f.requests[0].init.body as FormData).get('session'))).audio.input.transcription.language, 'es', 'transcription is fixed to the chosen language');
  const system = f.socket.sent.filter(e => e.item?.role === 'system').map(e => e.item!.content![0].text);
  assert.equal(system[0], 'Earlier history (es-ES, en; chosen es).');
});

test('the instructions name the language the call starts in and its native accent, and the stored event keeps it', async t => {
  const sessionOf = (f: ReturnType<typeof fixture>) => JSON.parse(String((f.requests[0].init.body as FormData).get('session')));
  const connected = (f: ReturnType<typeof fixture>) => f.published.find(e => e.type === 'voice' && e.data.status === 'connected')!.data;
  // No choice in the settings: the browser's first preference, region included.
  const browser = fixture(); t.after(() => browser.close());
  await browser.realtime.create('v=offer', { languages: ['es-ES', 'en'] });
  assert.match(sessionOf(browser).instructions, /^LANGUAGE: The user's browser prefers Spanish: start in it, with a native Spanish \(Spain\) accent, unless their latest words in the history are in another language\. Speak each language with its native accent/);
  assert.equal(sessionOf(browser).audio.input.transcription.language, 'es');
  assert.equal(connected(browser).language, 'es-ES'); assert.equal(connected(browser).languageSource, 'browser');
  browser.realtime.close('rtc_test123');
  // A bare choice takes the region of the browser's matching preference.
  const chosen = fixture(); t.after(() => chosen.close());
  await chosen.realtime.create('v=offer', { languages: ['pt', 'pt-BR', 'en'], language: 'pt' });
  assert.match(sessionOf(chosen).instructions, /^LANGUAGE: The user chose Portuguese in the settings: speak it from your first word, with a native Portuguese \(Brazil\) accent\./);
  assert.equal(connected(chosen).language, 'pt-BR'); assert.equal(connected(chosen).languageSource, 'settings');
  chosen.realtime.close('rtc_test123');
  // Nothing known: no language is invented and the event says nothing.
  const none = fixture(); t.after(() => none.close());
  await none.realtime.create('v=offer');
  assert.match(sessionOf(none).instructions, /^LANGUAGE: Until the user speaks, use the language of their latest words in the history, or English if there are none\./);
  assert.equal(connected(none).language, undefined);
});

test('every response the server requests is preceded by the language and accent reminder', async t => {
  const f = fixture(async () => ({ text: 'THREAD in English' })); t.after(() => f.close());
  await f.realtime.open('replay_lang', { languages: ['de-DE'] });
  f.call('fake_read', 'r1'); await wait(700);
  const at = f.socket.sent.findIndex(e => e.type === 'response.create');
  assert.ok(at > 1, 'the tool output was spoken');
  assert.equal(f.socket.sent[at - 1].item?.role, 'system');
  assert.match(f.socket.sent[at - 1].item!.content![0].text, /^Keep speaking the user's current language with its native accent; the English of tool results and notices changes neither\.$/);
  assert.ok(f.socket.sent.findIndex(e => e.item?.type === 'function_call_output') < at - 1, 'after the English data');
});

test('defaults favour patience and reject unknown settings', t => {
  const f = fixture(); t.after(() => f.close());
  assert.equal(f.realtime.eagerness, 'low'); assert.equal(f.realtime.noiseReduction, 'near_field'); assert.equal(f.realtime.voice, 'marin'); assert.equal(f.realtime.reasoning, 'low');
  assert.throws(() => fixture(undefined, { eagerness: 'impatient' }), /eagerness/);
});

test('a send runs once per call ID, only after a new transcribed user turn, and feeds the thread watch', async t => {
  const runs: string[] = [];
  const f = fixture(async (_params, { requestId }) => { runs.push(requestId); return { text: 'SEND ACCEPTED', delivered: { threadId: 'th1', runId: null, link: null, project: 'Alfa' } }; });
  t.after(() => f.close());
  await f.realtime.open('replay_1');
  f.call('fake_send', 's1', '{"message":"hola"}'); await wait();
  assert.equal(runs.length, 0, 'no send without words of the user');
  assert.match(f.outputs()[0], /no_user_turn/);
  f.said('¿Le mando a Alfa «hola»?'); f.heard('Sí, mándaselo');
  f.call('fake_send', 's2'); f.call('fake_send', 's2'); await wait();
  assert.deepEqual(runs, ['voice:replay_1:s2']);
  assert.deepEqual(f.delivered, [{ threadId: 'th1', runId: null, link: null, project: 'Alfa' }]);
  f.call('fake_send', 's3'); await wait();
  assert.equal(runs.length, 1, 'a second send needs new words of the user');
});

test('a send waits for the transcript that authorizes it', async t => {
  let sends = 0;
  const f = fixture(async () => { sends++; return { text: 'SEND ACCEPTED' }; });
  t.after(() => f.close());
  await f.realtime.open('replay_w');
  f.said('¿Le mando a Faro que revise el riego?');
  f.emit({ type: 'input_audio_buffer.speech_started' }); f.emit({ type: 'input_audio_buffer.speech_stopped' });
  f.emit({ type: 'input_audio_buffer.committed', item_id: 'u1' });
  f.call('fake_send', 's1'); await wait(150);
  assert.equal(sends, 0, 'nothing runs before the user words arrive');
  f.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u1', transcript: 'Sí.' });
  await wait(150);
  assert.equal(sends, 1);
});

test('call events carry the position the provider gave each item, not the time they completed', async t => {
  const f = fixture();
  t.after(() => f.close());
  await f.realtime.open('replay_order');
  f.emit({ type: 'input_audio_buffer.committed', item_id: 'u1' });
  f.emit({ type: 'response.output_item.added', item: { type: 'function_call', call_id: 'r1' } });
  f.call('fake_read', 'r1');
  f.emit({ type: 'response.output_item.added', item: { type: 'message', id: 'a1' } });
  f.emit({ type: 'response.output_audio_transcript.done', item_id: 'a1', transcript: 'Lo he leído.' });
  await wait();
  // The user's words complete last, but were committed first.
  f.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u1', transcript: 'Lee el hilo.' });
  await wait();
  const order = (type: string, key: string, value: string) => f.published.find(p => p.type === type && p.data[key] === value)?.data.order;
  assert.deepEqual([order('transcript', 'text', 'Lee el hilo.'), order('voice-tool', 'callId', 'r1'), order('transcript', 'text', 'Lo he leído.')], [1, 2, 3]);
});

test('a failed send is reported as uncertain, never retried', async t => {
  let attempts = 0;
  const f = fixture(async () => { attempts++; throw new Error('timeout'); });
  t.after(() => f.close());
  await f.realtime.open('replay_2');
  f.said('¿Le mando a Alfa «hola»?'); f.heard('Envíaselo');
  f.call('fake_send', 's1'); await wait();
  assert.equal(attempts, 1);
  assert.match(f.outputs()[0], /^ERROR: timeout\nDelivery not confirmed.*Do not repeat it/s, 'plain text, not a JSON envelope');
  assert.equal(f.published.find(e => e.type === 'voice-tool')!.data.status, 'unknown');
});

test('reads need no confirmation and parallel tool calls are answered together: the voice speaks once', async t => {
  const resolvers: (() => void)[] = [];
  const f = fixture(() => new Promise(resolve => resolvers.push(() => resolve({ text: 'thread read' }))));
  t.after(() => f.close());
  await f.realtime.open('replay_3');
  f.call('fake_read', 'r1'); f.call('fake_read', 'r2'); await wait(10);
  resolvers[0](); await wait(700);
  assert.ok(!f.socket.sent.some(e => e.type === 'response.create'), 'no speech with a read still pending');
  resolvers[1](); await wait(700);
  assert.equal(f.socket.sent.filter(e => e.type === 'response.create').length, 1);
  assert.deepEqual(f.outputs(), ['thread read', 'thread read']);
});

test('a tool output is spoken as soon as the model is free, without the quiet window', async t => {
  const f = fixture(async () => ({ text: 'thread read' }));
  t.after(() => f.close());
  await f.realtime.open('replay_5');
  f.emit({ type: 'input_audio_buffer.speech_started' }); f.emit({ type: 'input_audio_buffer.speech_stopped' });
  f.emit({ type: 'response.created' });
  f.call('fake_read', 'r1'); await wait(20);
  f.emit({ type: 'response.done', response: { status: 'completed', usage: { total_tokens: 5 } } });
  await wait(150);
  assert.equal(f.socket.sent.at(-1)!.type, 'response.create', 'spoken well before the 2.5 s quiet window');
  assert.equal(f.realtime.sessions.get('replay_5')!.usage.total_tokens, 5);
});

test('unknown tools and invalid arguments run nothing', async t => {
  let runs = 0;
  const f = fixture(async () => { runs++; return { text: 'x' }; });
  t.after(() => f.close());
  await f.realtime.open('replay_7');
  f.call('bash', 'b1'); f.call('fake_read', 'r1', '{not json'); await wait();
  assert.equal(runs, 0);
  assert.equal(f.outputs().length, 2);
  assert.match(f.outputs()[0], /tool bash is not available\. Nothing was executed.*tools of this session/);
  assert.match(f.outputs()[1], /invalid arguments; nothing was executed.*Fix the JSON object/);
});

test('the explicit interrupt cancels speech; thread notices wait for a quiet user and quiet ones are not spoken', async t => {
  const f = fixture(); t.after(() => f.close());
  const call = await f.realtime.open('replay_8');
  f.emit({ type: 'response.created' });
  f.realtime.interrupt('replay_8');
  assert.deepEqual(f.socket.sent.slice(-2).map(e => e.type), ['response.cancel', 'output_audio_buffer.clear']);
  f.emit({ type: 'response.done', response: { status: 'cancelled' } });
  call.lastUserAt = Date.now();
  assert.equal(f.realtime.threadNotice({ kind: 'finished', threadId: 't', title: 'Riego', project: 'Faro', conversationId: 'current', text: 'Hecho.' }), false, 'the user just spoke');
  call.lastUserAt = Date.now() - 60_000;
  const before = f.socket.sent.length;
  assert.equal(f.realtime.threadNotice({ kind: 'finished', threadId: 't', title: 'Riego', project: 'Faro', conversationId: 'current', quiet: true }), true);
  await wait(20);
  assert.ok(!f.socket.sent.slice(before).some(e => e.type === 'response.create'), 'a quiet notice is context only');
  assert.equal(f.realtime.threadNotice({ kind: 'finished', threadId: 't', title: 'Riego', project: 'Faro', conversationId: 'other' }), false, 'another conversation');
  assert.equal(f.realtime.threadNotice({ kind: 'finished', threadId: 't', title: 'Riego', project: 'Faro', conversationId: 'current', text: 'Hecho.' }), true);
  await wait(20);
  assert.equal(f.socket.sent.at(-1)!.type, 'response.create');
});

test('page events from Realtime use one vocabulary', () => {
  assert.equal(normalizeLiveEvent({ type: 'conversation.item.input_audio_transcription.delta', delta: 'ho' }).type, 'session.input_transcript.delta');
  assert.equal(normalizeLiveEvent({ type: 'response.output_audio_transcript.delta' }).type, 'session.output_transcript.delta');
  assert.equal(normalizeLiveEvent({ type: 'session.output_audio.delta' }).type, 'session.output_audio.delta');
});

test('the voice engine is ADE-agnostic: no T3 or Orca code inside it', () => {
  for (const file of ['src/voice/realtime.mts', 'src/direct/session.mts', 'src/direct/prompt.mts', 'src/direct/contract.mts', 'src/direct/state.mts']) {
    const source = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /from '[^']*(?:adapters\/(?:t3|orca)|direct\/t3)[^']*'/, file);
    assert.doesNotMatch(source, /t3_send_message|t3_read_thread|orca_/, file);
  }
});

test('the T3 catalog lists the most recent activity first', () => {
  const state = new DirectCallState();
  const text = compactCatalog({ projects: [{ id: 'aaaaaaaa-0000-4000-8000-000000000001', name: 'Antiguo' }, { id: 'bbbbbbbb-0000-4000-8000-000000000002', name: 'Reciente' }],
    threads: [{ threadId: 'cccccccc-0000-4000-8000-000000000003', projectId: 'aaaaaaaa-0000-4000-8000-000000000001', title: 'Viejo', updatedAt: '2026-01-01T00:00:00Z' },
      { threadId: 'dddddddd-0000-4000-8000-000000000004', projectId: 'bbbbbbbb-0000-4000-8000-000000000002', title: 'Nuevo', updatedAt: '2026-06-01T00:00:00Z' }] }, state);
  assert.ok(text.indexOf('Reciente') < text.indexOf('Antiguo'));
});

test('a late transcript of the "yes" keeps its place before the reply: the confirmed send runs', async t => {
  let sends = 0;
  const f = fixture(async () => { sends++; return { text: 'SEND ACCEPTED' }; });
  t.after(() => f.close());
  await f.realtime.open('replay_late');
  f.emit({ type: 'input_audio_buffer.committed', item_id: 'u1' });
  f.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u1', transcript: 'Dile a Faro que revise el riego.' });
  f.emit({ type: 'response.output_item.added', item: { type: 'message', id: 'a1' } });
  f.emit({ type: 'response.output_audio_transcript.done', item_id: 'a1', transcript: '¿Le mando a Faro que revise el riego?' });
  f.emit({ type: 'input_audio_buffer.committed', item_id: 'u2' });
  f.emit({ type: 'response.output_item.added', item: { type: 'message', id: 'a2' } });
  f.emit({ type: 'response.output_audio_transcript.done', item_id: 'a2', transcript: 'Vale, lo mando.' });
  f.call('fake_send', 's1'); await wait(150);
  assert.equal(sends, 0, 'waits for the pending transcript');
  f.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u2', transcript: 'Sí.' });
  await wait(150);
  assert.equal(sends, 1);
  assert.deepEqual(f.realtime.sessions.get('replay_late')!.direct!.history.map(m => m.text),
    ['Dile a Faro que revise el riego.', '¿Le mando a Faro que revise el riego?', 'Sí.', 'Vale, lo mando.']);
});

test('a send accepted after the call closed still feeds the thread watch and is stored', async t => {
  let finish!: (r: DirectResult) => void;
  const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  t.after(() => f.close());
  await f.realtime.open('replay_gone');
  f.said('¿Le mando a Faro que revise el riego?'); f.heard('Sí.');
  f.call('fake_send', 's1'); await wait();
  f.realtime.close('replay_gone');
  finish({ text: 'SEND ACCEPTED', delivered: { threadId: 'th9', runId: 'run9', link: null, project: 'Faro' } });
  await wait();
  assert.deepEqual(f.delivered, [{ threadId: 'th9', runId: 'run9', link: null, project: 'Faro' }]);
  const stored = f.published.find(e => e.type === 'voice-tool')!.data;
  assert.equal(stored.status, 'completed'); assert.equal(stored.callId, 's1'); assert.equal(stored.result, 'SEND ACCEPTED');
  assert.deepEqual((stored.delivered as { threadId: string }).threadId, 'th9');
  assert.equal(f.outputs().length, 0, 'nothing is sent to a closed call');
});

test('a sideband that fails after the provider created the call hangs it up and leaves no session', async () => {
  const requests: string[] = [];
  const socket = new FakeSocket();
  const realtime = new RealtimeCalls(double<ConstructorParameters<typeof RealtimeCalls>[0]>({
    key: 'test-key', ade: fakeAde([], 'CATALOG'), store: { meta() {} }, publish: () => {},
    context: { conversation: () => ({ id: 'c' }), resume: () => '', vocabulary: () => [], rememberClose() {}, timing: () => ({}) },
    fetch: async (url: string) => { requests.push(url); return { ok: true, status: 201, text: async () => 'v=answer', headers: new Headers({ location: '/v1/realtime/calls/rtc_fail1' }) }; },
    connect: () => { setImmediate(() => { socket.emit('error'); socket.emit('close'); }); return socket; }
  }));
  try {
    await assert.rejects(realtime.create('v=offer'), /canal|control/);
    await wait();
    assert.equal(requests.filter(url => url.endsWith('/rtc_fail1/hangup')).length, 1, 'the created call is hung up, once');
    assert.equal(realtime.sessions.size, 0);
  } finally { realtime.shutdown(); }
});

// The engine with a scripted provider: fetch answers the creation with
// `created` and records every request; connect hands out `socket`.
function scripted(created: () => Promise<{ ok: boolean; status: number; text: () => Promise<string>; headers: Headers }>, socket?: FakeSocket) {
  const requests: string[] = [], published: { type: string; data: Record<string, unknown> }[] = [];
  let connects = 0;
  const realtime = new RealtimeCalls(double<ConstructorParameters<typeof RealtimeCalls>[0]>({
    key: 'test-key', ade: fakeAde([], 'CATALOG'), store: { meta() {} }, publish: (type, data) => published.push({ type, data }),
    context: { conversation: () => ({ id: 'c' }), resume: () => '', vocabulary: () => [], rememberClose() {}, timing: () => ({}) },
    fetch: async (url: string) => { requests.push(url); return url.endsWith('/hangup') ? { ok: true, status: 200, text: async () => '', headers: new Headers() } : created(); },
    connect: () => { connects++; return socket || new FakeSocket(); }
  }));
  return { realtime, requests, published, connects: () => connects, hangups: (id: string) => requests.filter(url => url.endsWith(`/${id}/hangup`)).length };
}
const createdCall = (id: string) => ({ ok: true, status: 201, text: async () => 'v=answer', headers: new Headers({ location: `/v1/realtime/calls/${id}` }) });

test('a call the provider creates after shutdown is hung up once and never opened', async () => {
  let respond!: () => void;
  const f = scripted(() => new Promise(resolve => { respond = () => resolve(createdCall('rtc_late')); }));
  const created = f.realtime.create('v=offer');
  await wait(5);
  f.realtime.shutdown();
  respond();
  await assert.rejects(created, (error: unknown) => error instanceof StatusError && error.status === 503 && /stopping/.test(error.message));
  await wait();
  assert.equal(f.hangups('rtc_late'), 1, 'exactly one hang-up');
  assert.equal(f.realtime.sessions.size, 0, 'no session');
  assert.equal(f.realtime.busy, false);
  assert.equal(f.connects(), 0, 'no sideband is opened');
  assert.equal(f.published.some(e => e.type === 'voice' && e.data.status === 'connected'), false, 'nothing is announced');
  await assert.rejects(f.realtime.create('v=offer'), /stopping/, 'no new call while stopping');
});

test('a call shutdown closes while its sideband connects is hung up once and not announced', async () => {
  const socket = new FakeSocket();
  const f = scripted(async () => createdCall('rtc_opening'), socket);
  const created = f.realtime.create('v=offer');
  await wait(5);
  assert.equal(f.connects(), 1);
  f.realtime.shutdown();
  socket.emit('open');
  await assert.rejects(created, /ended while it was connecting/);
  await wait();
  assert.equal(f.hangups('rtc_opening'), 1, 'exactly one hang-up');
  assert.equal(f.realtime.sessions.size, 0);
  assert.equal(f.published.some(e => e.type === 'voice' && e.data.status === 'connected'), false);
});

test('a created call whose answer is cut while it is read is hung up once', async () => {
  const f = scripted(async () => ({ ...createdCall('rtc_cut'), text: async () => { throw new TypeError('terminated'); } }));
  try {
    await assert.rejects(f.realtime.create('v=offer'), (error: unknown) => error instanceof StatusError && error.status === 502 && /terminated/.test(error.message));
    await wait();
    assert.equal(f.hangups('rtc_cut'), 1, 'the call the headers named is hung up, once');
    assert.equal(f.realtime.sessions.size, 0); assert.equal(f.connects(), 0);
  } finally { f.realtime.shutdown(); }
});

// A created call whose answer the provider holds back until release().
function heldAnswer(id: string) {
  let release!: () => void;
  const body = new Promise<string>(resolve => { release = () => resolve('v=answer'); });
  return { response: { ...createdCall(id), text: () => body }, release: () => release() };
}

test('a call whose headers arrive after shutdown is hung up at once, without waiting for its answer', { timeout: 5_000 }, async () => {
  let respond!: () => void;
  const held = heldAnswer('rtc_headers');
  const f = scripted(() => new Promise(resolve => { respond = () => resolve(held.response); }));
  const created = f.realtime.create('v=offer');
  await wait(5);
  const refused = assert.rejects(created, (error: unknown) => error instanceof StatusError && error.status === 503);
  f.realtime.shutdown();
  respond();
  await wait(5);
  assert.equal(f.hangups('rtc_headers'), 1, 'hung up before its answer is read');
  held.release();
  await refused;
  await wait();
  assert.equal(f.hangups('rtc_headers'), 1, 'no second hang-up once the answer comes');
  assert.equal(f.connects(), 0, 'no sideband');
  assert.equal(f.published.some(e => e.type === 'voice' && e.data.status === 'connected'), false, 'nothing is announced');
  assert.equal(f.realtime.sessions.size, 0); assert.equal(f.realtime.busy, false);
});

test('shutdown while the answer of a created call is read hangs it up at once, and only once', { timeout: 5_000 }, async () => {
  const held = heldAnswer('rtc_reading');
  const f = scripted(async () => held.response);
  const created = f.realtime.create('v=offer');
  await wait(5);
  assert.equal(f.hangups('rtc_reading'), 0);
  f.realtime.shutdown();
  assert.equal(f.hangups('rtc_reading'), 1, 'hung up by shutdown, before the answer');
  f.realtime.shutdown();
  held.release();
  await assert.rejects(created, (error: unknown) => error instanceof StatusError && error.status === 503 && /stopping/.test(error.message));
  await wait();
  assert.equal(f.hangups('rtc_reading'), 1, 'no second hang-up when the answer comes');
  assert.equal(f.connects(), 0, 'no sideband');
  assert.equal(f.published.some(e => e.type === 'voice' && e.data.status === 'connected'), false, 'nothing is announced');
  assert.equal(f.realtime.sessions.size, 0); assert.equal(f.realtime.busy, false);
});

test('losing the sideband ends the call on the server: the provider is asked to hang up and a running send still finishes', async t => {
  let finish!: (r: DirectResult) => void;
  const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  t.after(() => f.close());
  await f.realtime.create('v=offer');
  f.said('¿Le mando a Faro que revise el riego?'); f.heard('Sí.');
  f.call('fake_send', 's1'); await wait();
  f.socket.emit('close');
  await wait();
  const hangups = f.requests.filter(r => r.url.endsWith('/rtc_test123/hangup'));
  assert.equal(hangups.length, 1, 'the server hangs up the provider call once');
  assert.equal(hangups[0].init.method, 'POST');
  assert.equal(f.realtime.sessions.size, 0); assert.equal(f.realtime.busy, false);
  assert.equal(f.realtime.working, true, 'the send still running keeps the service from stopping at once');
  const ended = f.published.filter(e => e.type === 'voice' && e.data.id === 'rtc_test123' && e.data.status !== 'connected');
  assert.deepEqual(ended.map(e => e.data.status), ['disconnected']);
  finish({ text: 'SEND ACCEPTED', delivered: { threadId: 'th9', runId: 'run9', link: null, project: 'Faro' } });
  await wait();
  assert.equal(f.published.find(e => e.type === 'voice-tool')!.data.status, 'completed', 'hanging up does not cancel ADE work');
  assert.equal(f.realtime.working, false);
  assert.equal(f.delivered.length, 1);
  f.realtime.close('rtc_test123');
  assert.equal(f.requests.filter(r => r.url.endsWith('/hangup')).length, 1, 'a later close does nothing more');
});

test('call creation failures carry an HTTP status: 503 without a key, 502 when the provider fails, 409 with a call active', async () => {
  type Fetcher = ConstructorParameters<typeof RealtimeCalls>[0]['fetch'];
  const make = (fetcher: Fetcher, key = 'test-key') => new RealtimeCalls(double<ConstructorParameters<typeof RealtimeCalls>[0]>({
    key, ade: fakeAde([], 'CATALOG'), store: { meta() {} }, publish: () => {},
    context: { conversation: () => ({ id: 'c' }), resume: () => '', vocabulary: () => [], rememberClose() {}, timing: () => ({}) },
    fetch: fetcher, connect: () => { const socket = new FakeSocket(); setImmediate(() => socket.emit('open')); return socket; }
  }));
  const status = (expected: number, pattern: RegExp) => (error: unknown) => {
    assert.ok(error instanceof StatusError); assert.equal(error.status, expected); assert.match(error.message, pattern); return true;
  };
  const cases: [RealtimeCalls, number, RegExp][] = [
    [make(async () => { throw new Error('unused'); }, ''), 503, /OpenAI key/],
    [make(async () => { throw new TypeError('fetch failed'); }), 502, /fetch failed/],
    [make(async () => ({ ok: false, status: 500, text: async () => JSON.stringify({ error: { code: 'server_error', message: 'boom' } }), headers: new Headers() })), 502, /could not create the call \(500.*server_error: boom/],
    [make(async () => ({ ok: true, status: 201, text: async () => 'not sdp', headers: new Headers() })), 502, /incomplete call/]
  ];
  for (const [realtime, expected, pattern] of cases) {
    try { await assert.rejects(realtime.create('v=offer'), status(expected, pattern)); } finally { realtime.shutdown(); }
  }
  const busy = make(async () => ({ ok: true, status: 201, text: async () => 'v=answer', headers: new Headers({ location: '/v1/realtime/calls/rtc_busy' }) }));
  try {
    await busy.create('v=offer');
    await assert.rejects(busy.create('v=offer'), status(409, /already a call/));
  } finally { busy.shutdown(); }
});

test('a send that fails before dispatch is an error, says nothing was sent and keeps the yes', async () => {
  let attempts = 0;
  const tools: DirectTool[] = [{ name: 'fake_send', description: 'Send', parameters: { type: 'object' }, sends: true,
    prepare: (params, state) => ({ ...params, threadId: state.resolve(params.threadId, 'threadId') }),
    execute: async params => { attempts++; if (params.message === 'archivado') throw new NotDispatchedError('The thread is archived.'); return { text: 'SEND ACCEPTED' }; } }];
  const session = new DirectSession(fakeAde(tools));
  session.state.remember('0f0f0f0f-1111-4222-8333-444455556666');
  session.remember('assistant', '¿Le mando al hilo de Faro que revise el riego?'); session.remember('user', 'Sí.');
  const run = (id: string, args: Record<string, unknown>) => session.run({ name: 'fake_send', call_id: id, arguments: JSON.stringify(args) }, { requestId: 'r:' + id, signal: AbortSignal.timeout(1000) });
  const badId = await run('c1', { threadId: 'zz', message: 'revisa' });
  assert.equal(badId!.status, 'error'); assert.match(badId!.output, /too short[\s\S]*Nothing was sent in this attempt\./);
  assert.equal(attempts, 0, 'an unknown short ID runs nothing');
  const archived = await run('c2', { threadId: '0f0f0f0f', message: 'archivado' });
  assert.equal(archived!.status, 'error'); assert.doesNotMatch(archived!.output, /Entrega no confirmada/);
  const sent = await run('c3', { threadId: '0f0f0f0f', message: 'revisa' });
  assert.equal(sent!.status, 'completed', 'the yes was not used up by sends that never left');
  assert.equal((await run('c4', { threadId: '0f0f0f0f', message: 'revisa' }))!.status, 'refused', 'a delivered send uses it');
});

test('two function calls of a call get distinct request IDs; a failure outside the tool names it and keeps the send uncertain', async t => {
  const ids: string[] = [];
  const f = fixture(async (_params, { requestId }) => { ids.push(requestId); return { text: 'ok' }; }); t.after(() => f.close());
  await f.realtime.open('replay_ids');
  f.call('fake_read', 'call_a.b'); f.call('fake_read', 'call_ab'); f.call('fake_read', 'call_ab'); await wait();
  assert.equal(ids.length, 2); assert.equal(new Set(ids).size, 2);
  assert.equal(ids[1], 'voice:replay_ids:call_ab');
  // A failure after the tool ran (here, publishing its record) answers by tool kind.
  const realtime = f.realtime as unknown as { publish: (type: string) => void };
  const publish = realtime.publish;
  realtime.publish = type => { if (type === 'voice-tool') throw new Error('fallo interno'); };
  f.said('¿Le mando a Faro «hola»?'); f.heard('Sí');
  f.call('fake_send', 'call_s'); f.call('fake_read', 'call_r'); await wait();
  realtime.publish = publish;
  const sent = f.outputs().find(o => o.includes('fake_send'))!, read = f.outputs().find(o => o.includes('fake_read'))!;
  assert.equal(sent, 'ERROR: fake_send failed on the server without a confirmed result. The send may have happened: do not repeat it. Read the thread now to check whether it arrived and tell the user.');
  assert.match(read, /^ERROR: fake_read failed on the server\. Nothing was read; you may repeat the read once/);
});

test('transcription is fixed to the chosen language, else the browser\'s, as a two-letter code', () => {
  assert.equal(transcriptionLanguage('en', ['es-ES']), 'en');
  assert.equal(transcriptionLanguage(undefined, ['es-ES', 'en']), 'es');
  assert.equal(transcriptionLanguage(undefined, []), undefined);
  assert.equal(transcriptionLanguage(undefined, ['fil-PH']), undefined, 'three-letter codes are left to detection');
  assert.equal(transcriptionLanguage('es', ['es-MX']), 'es', 'the accent region does not reach transcription');
});

test('the call language: the settings choice, with the browser\'s region, else the browser\'s first preference', () => {
  assert.deepEqual(callLanguage('es', ['es', 'es-MX', 'en']), { tag: 'es-MX', source: 'settings' });
  assert.deepEqual(callLanguage('fr', ['es-ES']), { tag: 'fr', source: 'settings' }, 'another language keeps no foreign region');
  assert.deepEqual(callLanguage('en-GB', ['en-US']), { tag: 'en-GB', source: 'settings' });
  assert.deepEqual(callLanguage(undefined, ['ja-JP', 'en']), { tag: 'ja-JP', source: 'browser' });
  assert.equal(callLanguage(undefined, []), undefined);
});
