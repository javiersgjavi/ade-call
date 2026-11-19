import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { DirectResult, DirectTool, DirectToolContext } from '../src/direct/contract.mjs';
import { GeminiCalls, isGeminiModel } from '../src/voice/gemini.mjs';
import { directInstructions } from '../src/direct/prompt.mjs';
import { StatusError } from '../src/shared/contracts.mjs';
import { pcmToFloat, streamUrl } from '../public/relayed-call.js';
import { double, fakeAde } from './fixtures.mjs';

// Gemini Live with an invented ADE and simulated sockets: nothing reaches
// Google. The provider socket answers the setup like the real one.
type Message = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
class Upstream extends EventEmitter {
  readyState = 0; sent: Message[] = [];
  constructor(readonly refuse?: string) { super(); setImmediate(() => { this.readyState = 1; this.emit('open'); }); }
  send(raw: string | Buffer) {
    const message = JSON.parse(String(raw)); this.sent.push(message);
    if (message.setup) setImmediate(() => this.refuse ? this.close(1007, this.refuse) : this.emit('message', Buffer.from(JSON.stringify({ setupComplete: {} }))));
  }
  close(code = 1000, reason = '') { if (this.readyState === 3) return; this.readyState = 3; this.emit('close', code, Buffer.from(reason)); }
  server(message: Message) { this.emit('message', Buffer.from(JSON.stringify(message))); }
}
class Browser extends EventEmitter {
  readyState = 1; frames: Buffer[] = []; events: Message[] = []; closed?: number;
  send(data: string | Buffer) { if (Buffer.isBuffer(data)) this.frames.push(data); else this.events.push(JSON.parse(data)); }
  close(code = 1000) { this.readyState = 3; this.closed = code; }
  audio(bytes: Buffer) { this.emit('message', bytes, true); }
  text(message: Message) { this.emit('message', Buffer.from(JSON.stringify(message)), false); }
}
type Execute = (params: Record<string, unknown>, context: DirectToolContext) => Promise<DirectResult>;
function fixture({ execute = async () => ({ text: 'ok' }), refuse, model }: { execute?: Execute; refuse?: string; model?: string } = {}) {
  const sockets: Upstream[] = [], keys: string[] = [];
  const published: { type: string; data: Record<string, unknown> }[] = [], runs: Record<string, unknown>[] = [];
  const tools: DirectTool[] = [
    { name: 'fake_send', description: 'Send', parameters: { type: 'object' }, sends: true, execute: async (params, context) => { runs.push(params); return execute(params, context); } },
    { name: 'fake_read', description: 'Read', parameters: { type: 'object' }, execute }];
  const ade = fakeAde(tools, 'fake CATALOG · p1');
  const gemini = new GeminiCalls(double<ConstructorParameters<typeof GeminiCalls>[0]>({
    key: 'test-gemini-key', ade, store: { meta() {} }, settings: { model, voice: 'Puck' }, publish: (type, data) => published.push({ type, data }),
    context: { conversation: () => ({ id: 'current' }), resume: () => 'Earlier history.', vocabulary: () => ['Faro'], rememberClose() {}, timing: () => ({}) },
    connect: (key: string) => { keys.push(key); const socket = new Upstream(refuse); sockets.push(socket); return socket as never; }
  }));
  const upstream = () => sockets.at(-1)!;
  const content = (serverContent: Message) => upstream().server({ serverContent });
  const browser = new Browser();
  return { gemini, ade, sockets, keys, published, runs, browser, upstream, content,
    heard: (text: string) => content({ inputTranscription: { text } }),
    said: (text: string) => content({ outputTranscription: { text } }),
    done: () => content({ turnComplete: true }),
    call: (name: string, id: string, args = {}) => upstream().server({ toolCall: { functionCalls: [{ id, name, args }] } }),
    responses: () => upstream().sent.filter(m => m.toolResponse).flatMap(m => m.toolResponse.functionResponses),
    async start() { const result = await gemini.create(); gemini.attach(result.session.id, browser as never); return result; },
    close() { gemini.shutdown(); } };
}
const wait = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));

test('creates a Gemini Live session with the ADE tools, its instructions, transcripts and the history first', async t => {
  const f = fixture(); t.after(() => f.close());
  const result = await f.start();
  assert.match(result.session.id, /^gem_/);
  assert.equal(result.transport.stream, `/api/live/stream?id=${encodeURIComponent(result.session.id)}`);
  assert.equal(result.transport.sdp, undefined, 'no WebRTC leg');
  assert.deepEqual(f.keys, ['test-gemini-key'], 'the server holds the key');
  const { setup } = f.upstream().sent[0];
  assert.equal(setup.model, 'models/gemini-3.8-live');
  assert.deepEqual(setup.generationConfig.responseModalities, ['AUDIO']);
  assert.equal(setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Puck');
  assert.equal(setup.systemInstruction.parts[0].text, directInstructions(f.ade));
  assert.deepEqual(setup.tools[0].functionDeclarations.map((d: Message) => [d.name, d.behavior]), [['fake_send', 'BLOCKING'], ['fake_read', 'BLOCKING']], 'the voice model calls the ADE tools itself, synchronously');
  assert.deepEqual(setup.inputAudioTranscription, { customVocabulary: ['Faro'] }); assert.deepEqual(setup.outputAudioTranscription, {});
  assert.deepEqual(setup.historyConfig, { initialHistoryInClientContent: true });
  assert.ok(setup.contextWindowCompression && setup.sessionResumption, 'long calls survive the provider\'s connection limits');
  const history = f.upstream().sent[1].clientContent;
  assert.equal(history.turnComplete, true);
  assert.deepEqual(history.turns.map((turn: Message) => turn.parts[0].text.split('\n').at(-1)), ['Earlier history.', 'fake CATALOG · p1']);
  assert.match(history.turns[0].parts[0].text, /never authorize a send/, 'notes are marked as not the user\'s words');
  assert.equal(f.published.find(e => e.type === 'voice')!.data.provider, 'gemini');
  assert.equal(f.browser.events[0].type, 'session.started');
  assert.equal(f.gemini.busy, true);
});

test('gemini-3.1-flash-live-preview declares tools without a behavior: it is always synchronous', async t => {
  const f = fixture({ model: 'gemini-3.1-flash-live-preview' }); t.after(() => f.close());
  await f.start();
  const { setup } = f.upstream().sent[0];
  assert.equal(setup.model, 'models/gemini-3.1-flash-live-preview');
  assert.equal(setup.tools[0].functionDeclarations[0].behavior, undefined);
  assert.ok(isGeminiModel('gemini-3.8-live') && !isGeminiModel('gpt-realtime-2.1'));
});

test('a refused setup is a provider error with its reason, and leaves no call behind', async t => {
  const f = fixture({ refuse: 'API key not valid. AIzaSyFAKEFAKEFAKEFAKE' }); t.after(() => f.close());
  await assert.rejects(f.gemini.create(), (error: Error) => error instanceof StatusError && error.status === 502 && /API key not valid/.test(error.message) && !/AIzaSy/.test(error.message));
  assert.equal(f.gemini.busy, false); assert.equal(f.gemini.sessions.size, 0);
  const missing = fixture(); missing.gemini.configure({ key: null }); t.after(() => missing.close());
  await assert.rejects(missing.gemini.create(), (error: Error) => error instanceof StatusError && error.status === 503);
});

test('audio is relayed both ways and an interruption empties the page\'s playback', async t => {
  const f = fixture(); t.after(() => f.close());
  await f.start();
  const pcm = Buffer.from([1, 0, 2, 0, 3, 0, 4, 0]);
  f.browser.audio(pcm);
  assert.deepEqual(f.upstream().sent.at(-1), { realtimeInput: { audio: { data: pcm.toString('base64'), mimeType: 'audio/pcm;rate=16000' } } });
  f.browser.audio(Buffer.from([1, 2, 3]));
  assert.equal(f.upstream().sent.at(-1)!.realtimeInput.audio.data, pcm.toString('base64'), 'an odd frame is not PCM16 and is dropped');
  f.browser.text({ type: 'audio.end' });
  assert.deepEqual(f.upstream().sent.at(-1), { realtimeInput: { audioStreamEnd: true } }, 'muting flushes the provider');
  f.content({ modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: Buffer.from([9, 9]).toString('base64') } }] } });
  assert.deepEqual(f.browser.frames, [Buffer.from([9, 9])]);
  f.content({ interrupted: true });
  assert.equal(f.browser.events.at(-1)!.type, 'interrupted');
  assert.deepEqual([...pcmToFloat(new Int16Array([-32768, 16384]).buffer)], [-1, 0.5]);
  assert.equal(streamUrl('/api/live/stream?id=gem_1', 'orca', { protocol: 'https:', host: 'ade.example' }), 'wss://ade.example/api/live/stream?id=gem_1&backend=orca');
});

test('transcripts stream into the conversation and are published in order when each turn ends', async t => {
  const f = fixture(); t.after(() => f.close());
  await f.start();
  f.heard(' Hola,'); f.heard(' ¿qué tal?'); f.said('Bien.'); f.said(' ¿Y tú?'); f.done();
  const transcripts = f.published.filter(e => e.type === 'transcript').map(e => [e.data.role, e.data.text, e.data.order]);
  assert.deepEqual(transcripts, [['user', 'Hola, ¿qué tal?', 1], ['assistant', 'Bien. ¿Y tú?', 2]]);
});

test('the send rule: a send runs only after new words of the user, once per call ID, and the result goes back to the model', async t => {
  const f = fixture(); t.after(() => f.close());
  await f.start();
  f.said('Shall I tell the thread to add tests?'); f.done();
  f.heard('Yes, do it.');
  f.call('fake_send', 'fc1', { threadId: 't1' });
  f.call('fake_send', 'fc1', { threadId: 't1' });
  await wait();
  assert.deepEqual(f.runs, [{ threadId: 't1' }], 'executed once');
  assert.deepEqual(f.responses(), [{ id: 'fc1', name: 'fake_send', response: { output: 'ok' } }]);
  const tool = f.published.find(e => e.type === 'voice-tool')!.data;
  assert.equal(tool.status, 'completed'); assert.equal(tool.name, 'fake_send');
  // A second send off the same yes is refused after waiting for a transcript.
  f.call('fake_send', 'fc2');
  await wait(2800);
  assert.equal(f.runs.length, 1);
  assert.match(f.responses().at(-1)!.response.output, /NOT SENT \(no_user_turn\)/);
});

test('a yes transcribed just after the function call still authorizes it', async t => {
  const f = fixture(); t.after(() => f.close());
  await f.start();
  f.call('fake_send', 'fc1');
  await wait(300);
  assert.equal(f.runs.length, 0, 'waiting for the transcript');
  f.heard('Sí.');
  await wait(300);
  assert.equal(f.runs.length, 1);
});

test('a cancelled send that already ran is told to the model, not answered as a function response', async t => {
  let release!: () => void;
  const f = fixture({ execute: () => new Promise(resolve => { release = () => resolve({ text: 'delivered' }); }) }); t.after(() => f.close());
  await f.start();
  f.heard('Yes.');
  f.call('fake_send', 'fc1');
  await wait();
  f.upstream().server({ toolCallCancellation: { ids: ['fc1'] } });
  release(); await wait(); f.done(); await wait(80);
  assert.deepEqual(f.responses(), []);
  const note = f.upstream().sent.filter(m => m.clientContent?.turnComplete).at(-1)!;
  assert.match(note.clientContent.turns[0].parts[0].text, /fake_send was running and the call was cancelled[\s\S]*delivered/);
});

test('goAway resumes the same session on a new connection with the last handle', async t => {
  const f = fixture(); t.after(() => f.close());
  const { session } = await f.start();
  f.upstream().server({ sessionResumptionUpdate: { resumable: true, newHandle: 'handle-1' } });
  f.upstream().server({ goAway: { timeLeft: '5s' } });
  await wait();
  assert.equal(f.sockets.length, 2);
  assert.equal(f.sockets[1].sent[0].setup.sessionResumption.handle, 'handle-1');
  assert.equal(f.sockets[0].readyState, 3, 'the old connection is closed');
  assert.ok(f.gemini.sessions.has(session.id));
  f.browser.audio(Buffer.from([1, 0]));
  assert.ok(f.sockets[1].sent.at(-1)!.realtimeInput, 'audio goes to the new connection');
  // A connection lost without goAway resumes too while a handle is known.
  f.sockets[1].emit('close', 1011, Buffer.from(''));
  await wait();
  assert.equal(f.sockets.length, 3, 'a handle is kept, so it resumes again');
});

test('hanging up closes both sockets and the heartbeat keeps the call alive', async t => {
  const f = fixture(); t.after(() => f.close());
  const { session } = await f.start();
  assert.equal(f.gemini.heartbeat(session.id), true);
  f.gemini.close(session.id);
  assert.equal(f.upstream().readyState, 3); assert.equal(f.browser.closed, 1000);
  assert.equal(f.published.at(-1)!.data.status, 'closed');
  assert.equal(f.gemini.busy, false); assert.equal(f.gemini.heartbeat(session.id), false);
  assert.equal(f.gemini.attach(session.id, new Browser() as never), false, 'no socket attaches to an ended call');
});
