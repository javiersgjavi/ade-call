import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { DirectResult, DirectTool, DirectToolContext } from '../src/direct/contract.mjs';
import { GeminiCalls, geminiSchema, isGeminiModel } from '../src/voice/gemini.mjs';
import { directInstructions } from '../src/direct/prompt.mjs';
import { StatusError } from '../src/shared/contracts.mjs';
import { pcmToFloat, streamUrl } from '../public/relayed-call.js';
import { double, fakeAde } from './fixtures.mjs';

// Gemini Live with an invented ADE and simulated sockets: nothing reaches
// Google. The provider socket answers the setup like the real one.
type Message = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
class Upstream extends EventEmitter {
  readyState = 0; sent: Message[] = [];
  // hold: the setup is confirmed only when the test calls confirm().
  constructor(readonly refuse?: string, readonly hold = false) { super(); setImmediate(() => { this.readyState = 1; this.emit('open'); }); }
  send(raw: string | Buffer) {
    const message = JSON.parse(String(raw)); this.sent.push(message);
    if (message.setup && !this.hold) setImmediate(() => this.refuse ? this.close(1007, this.refuse) : this.confirm());
  }
  confirm() { this.emit('message', Buffer.from(JSON.stringify({ setupComplete: {} }))); }
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
// The pause that separates two utterances is 200 ms here (2 s in production).
function fixture({ execute = async () => ({ text: 'ok' }), refuse, model }: { execute?: Execute; refuse?: string; model?: string } = {}) {
  const sockets: Upstream[] = [], keys: string[] = [];
  // Set by a test: later provider connections wait for confirm().
  const options = { hold: false };
  const published: { type: string; data: Record<string, unknown> }[] = [], runs: Record<string, unknown>[] = [];
  const tools: DirectTool[] = [
    { name: 'fake_send', description: 'Send', parameters: { type: 'object' }, sends: true, execute: async (params, context) => { runs.push(params); return execute(params, context); } },
    { name: 'fake_read', description: 'Read', parameters: { type: 'object' }, execute }];
  const ade = fakeAde(tools, 'fake CATALOG · p1');
  const gemini = new GeminiCalls(double<ConstructorParameters<typeof GeminiCalls>[0]>({
    key: 'test-gemini-key', ade, store: { meta() {} }, settings: { model, voice: 'Puck' }, publish: (type, data) => published.push({ type, data }),
    context: { conversation: () => ({ id: 'current' }), resume: () => 'Earlier history.', vocabulary: () => ['Faro'], rememberClose() {}, timing: () => ({}) },
    connect: (key: string) => { keys.push(key); const socket = new Upstream(refuse, options.hold); sockets.push(socket); return socket as never; },
    utteranceGapMs: 200
  }));
  const upstream = () => sockets.at(-1)!;
  const content = (serverContent: Message) => upstream().server({ serverContent });
  const browser = new Browser();
  return { gemini, ade, sockets, keys, published, runs, browser, upstream, content, options,
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
  assert.equal(setup.systemInstruction.parts[0].text, directInstructions(f.ade, { provider: 'gemini' }));
  assert.match(setup.systemInstruction.parts[0].text, /SENDING[\s\S]*\nSENDING STEPS[\s\S]*Never call fake_send in the same response as your proposal/, 'the send procedure as steps, after the shared rules');
  assert.doesNotMatch(directInstructions(f.ade), /SENDING STEPS/, 'Realtime keeps the shared prompt');
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
  assert.ok(isGeminiModel('gemini-3.8-live') && !isGeminiModel('gpt-realtime-2.1'));
});

test('the owner\'s custom instructions end the Gemini instructions, and configure() changes or clears them', async t => {
  const f = fixture(); t.after(() => f.close());
  f.gemini.configure({ instructions: 'Answer in one sentence.' });
  await f.start();
  const text = f.upstream().sent[0].setup.systemInstruction.parts[0].text;
  assert.equal(text, directInstructions(f.ade, { custom: 'Answer in one sentence.', provider: 'gemini' }));
  assert.match(text, /OWNER INSTRUCTIONS[\s\S]*Answer in one sentence\.$/);
  f.gemini.close(f.gemini.sessions.keys().next().value!);
  await wait();
  f.gemini.configure({ instructions: null });
  assert.equal(f.gemini.instructions, undefined);
});

test('a refused setup is a provider error with its reason, and leaves no call behind', async t => {
  const f = fixture({ refuse: 'API key not valid. AIzaSyFAKEFAKEFAKEFAKE' }); t.after(() => f.close());
  await assert.rejects(f.gemini.create(), (error: Error) => error instanceof StatusError && error.status === 502 && /API key not valid/.test(error.message) && !/AIzaSy/.test(error.message));
  assert.equal(f.gemini.busy, false); assert.equal(f.gemini.sessions.size, 0);
  const missing = fixture(); missing.gemini.configure({ key: null }); t.after(() => missing.close());
  await assert.rejects(missing.gemini.create(), (error: Error) => error instanceof StatusError && error.status === 503);
});

test('a failure while preparing a call leaves the engine free for the next one', async t => {
  const f = fixture(); t.after(() => f.close());
  const conversation = f.gemini.context.conversation!;
  f.gemini.context.conversation = () => { throw new Error('store unavailable'); };
  await assert.rejects(f.gemini.create(), /store unavailable/);
  assert.equal(f.gemini.busy, false); assert.equal(f.gemini.sessions.size, 0);
  f.gemini.context.conversation = conversation;
  await f.start();
  assert.equal(f.gemini.sessions.size, 1);
});

test('a conversation read that fails during a call drops the frame instead of throwing', async t => {
  const f = fixture(); t.after(() => f.close());
  await f.start();
  const sent = f.upstream().sent.length;
  f.gemini.context.conversation = () => { throw new Error('store unavailable'); };
  assert.doesNotThrow(() => f.browser.audio(Buffer.from([1, 0])));
  assert.equal(f.upstream().sent.length, sent, 'nothing forwarded');
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

test('transcripts stream into the conversation; an utterance is published after the user pauses, in conversation order', async t => {
  const f = fixture(); t.after(() => f.close());
  await f.start();
  f.heard(' Hola,'); f.heard(' ¿qué tal?'); f.said('Bien.'); f.said(' ¿Y tú?'); f.done();
  await wait(250);
  const transcripts = f.published.filter(e => e.type === 'transcript').map(e => [e.data.role, e.data.text, e.data.order]).sort((a, b) => Number(a[2]) - Number(b[2]));
  assert.deepEqual(transcripts, [['user', 'Hola, ¿qué tal?', 1], ['assistant', 'Bien. ¿Y tú?', 2]]);
});

test('a late piece of the same utterance, after the model spoke, does not authorize a second send', async t => {
  const f = fixture(); t.after(() => f.close());
  await f.start();
  f.heard('Yes,');
  f.call('fake_send', 'fc1');
  await wait();
  assert.equal(f.runs.length, 1);
  // Later than the pause that separates utterances: still the words the send used.
  f.said('Sending it.'); await wait(300); f.heard(' send it please.');
  f.call('fake_send', 'fc2');
  await wait(2800);
  assert.equal(f.runs.length, 1, 'the late words joined the utterance the first send used');
  assert.match(f.responses().at(-1)!.response.output, /NOT SENT \(no_user_turn\)/);
  // The model completes its turn after the result, the user pauses: a boundary.
  f.done(); await wait(250);
  assert.deepEqual(f.published.filter(e => e.type === 'transcript' && e.data.role === 'user').map(e => e.data.text), ['Yes, send it please.']);
  f.heard('And tell it to add docs.');
  f.call('fake_send', 'fc3');
  await wait();
  assert.equal(f.runs.length, 2);
});

test('a repeat of a call ID still running neither runs nor releases the utterance it used, and gets its result', async t => {
  let release!: () => void;
  const f = fixture({ execute: () => new Promise(resolve => { release = () => resolve({ text: 'delivered' }); }) }); t.after(() => f.close());
  await f.start();
  f.heard('Yes,');
  f.call('fake_send', 'fc1');
  await wait();
  // Renewed connection asks for fc1 again while it runs.
  f.upstream().server({ sessionResumptionUpdate: { resumable: true, newHandle: 'h' } });
  f.upstream().server({ goAway: { timeLeft: '5s' } });
  await wait();
  const next = f.sockets[1];
  next.server({ toolCall: { functionCalls: [{ id: 'fc1', name: 'fake_send', args: {} }] } });
  await wait();
  assert.equal(f.runs.length, 1);
  await wait(300); next.server({ serverContent: { inputTranscription: { text: ' send it please.' } } });
  release(); await wait();
  assert.deepEqual(next.sent.filter(m => m.toolResponse).flatMap(m => m.toolResponse.functionResponses), [{ id: 'fc1', name: 'fake_send', response: { output: 'delivered' } }], 'answered to the connection that asked');
  next.server({ toolCall: { functionCalls: [{ id: 'fc2', name: 'fake_send', args: {} }] } });
  await wait(2800);
  assert.equal(f.runs.length, 1, 'the late words are still the utterance fc1 used');
});

// Moves the call to a new provider connection; hold: that connection waits for confirm().
async function renew(f: ReturnType<typeof fixture>, hold = false) {
  f.options.hold = hold;
  f.upstream().server({ sessionResumptionUpdate: { resumable: true, newHandle: `h${f.sockets.length}` } });
  f.upstream().server({ goAway: { timeLeft: '5s' } });
  await wait();
  return f.upstream();
}

test('an ID repeated in one message runs once, and every later request for it gets the same result', async t => {
  const f = fixture({ execute: async () => ({ text: 'delivered' }) }); t.after(() => f.close());
  await f.start();
  f.heard('Yes.');
  f.upstream().server({ toolCall: { functionCalls: [{ id: 'fc1', name: 'fake_send', args: {} }, { id: 'fc1', name: 'fake_send', args: {} }] } });
  await wait();
  f.call('fake_send', 'fc1');
  await wait();
  assert.equal(f.runs.length, 1);
  assert.deepEqual(f.responses().map(r => r.response.output), ['delivered', 'delivered']);
});

test('a result note is kept while the provider socket is closing and reaches the renewed connection once', async t => {
  let release!: () => void;
  const f = fixture({ execute: () => new Promise(resolve => { release = () => resolve({ text: 'delivered' }); }) }); t.after(() => f.close());
  await f.start();
  f.heard('Yes.');
  f.call('fake_send', 'fc1');
  await wait();
  const old = f.upstream();
  old.server({ sessionResumptionUpdate: { resumable: true, newHandle: 'h1' } });
  old.server({ toolCallCancellation: { ids: ['fc1'] } });
  old.readyState = 2; // CLOSING: no close event yet.
  release(); await wait();
  assert.equal(old.sent.filter(m => m.clientContent?.turnComplete && /fake_send/.test(JSON.stringify(m))).length, 0, 'not written to a closing socket');
  old.close(1011); await wait(100);
  const notes = f.upstream().sent.filter(m => m.clientContent?.turnComplete && /fake_send/.test(JSON.stringify(m)));
  assert.notEqual(f.upstream(), old); assert.equal(notes.length, 1);
});

test('a call cancelled before it started answers a later request for its ID with that outcome, without running', async t => {
  const f = fixture(); t.after(() => f.close());
  await f.start();
  f.call('fake_send', 'fc1');
  await wait(100);
  f.upstream().server({ toolCallCancellation: { ids: ['fc1'] } });
  await wait(200);
  assert.deepEqual(f.responses(), [], 'the connection that cancelled it does not wait for it');
  const next = await renew(f);
  next.server({ toolCall: { functionCalls: [{ id: 'fc1', name: 'fake_send', args: {} }] } });
  await wait();
  const [response] = next.sent.filter(m => m.toolResponse).flatMap(m => m.toolResponse.functionResponses);
  assert.equal(response.id, 'fc1'); assert.match(response.response.output, /^NOT RUN/);
  assert.equal(f.runs.length, 0);
});

test('a renewed connection that asks again for a call the old one cancelled after dispatch gets its result', async t => {
  let release!: () => void;
  const f = fixture({ execute: () => new Promise(resolve => { release = () => resolve({ text: 'delivered' }); }) }); t.after(() => f.close());
  await f.start();
  f.heard('Yes.');
  f.call('fake_send', 'fc1');
  await wait();
  f.upstream().server({ toolCallCancellation: { ids: ['fc1'] } });
  const next = await renew(f);
  next.server({ toolCall: { functionCalls: [{ id: 'fc1', name: 'fake_send', args: {} }] } });
  release(); await wait(100);
  assert.deepEqual(next.sent.filter(m => m.toolResponse).flatMap(m => m.toolResponse.functionResponses), [{ id: 'fc1', name: 'fake_send', response: { output: 'delivered' } }]);
  assert.equal(next.sent.filter(m => m.clientContent?.turnComplete).length, 0, 'no note as well');
  assert.equal(f.runs.length, 1);
});

test('replaying a cached result answers the held utterance and drops its queued note', async t => {
  let release!: () => void;
  const f = fixture({ execute: () => new Promise(resolve => { release = () => resolve({ text: 'delivered' }); }) }); t.after(() => f.close());
  await f.start();
  f.heard('Yes.');
  f.call('fake_send', 'fc1');
  await wait();
  const next = await renew(f, true);
  release(); await wait();
  // In one read: setup confirmed, the model already speaking, and a request for fc1 again.
  next.confirm();
  next.server({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: Buffer.from([1, 1]).toString('base64') } }] } } });
  next.server({ toolCall: { functionCalls: [{ id: 'fc1', name: 'fake_send', args: {} }] } });
  await wait();
  assert.deepEqual(next.sent.filter(m => m.toolResponse).flatMap(m => m.toolResponse.functionResponses), [{ id: 'fc1', name: 'fake_send', response: { output: 'delivered' } }]);
  next.server({ serverContent: { outputTranscription: { text: 'Sent.' } } });
  next.server({ serverContent: { turnComplete: true } });
  await wait(300);
  assert.equal(next.sent.filter(m => m.clientContent?.turnComplete && /renewed/.test(JSON.stringify(m))).length, 0, 'the result is not announced twice');
  f.heard('Now tell it to add docs.');
  f.call('fake_send', 'fc2');
  await wait();
  assert.equal(f.runs.length, 2, 'the answered utterance was released: a new request authorizes');
});

test('a result note still queued does not let the end of other speech release the utterance', async t => {
  let release!: () => void;
  const f = fixture({ execute: () => new Promise(resolve => { release = () => resolve({ text: 'delivered' }); }) }); t.after(() => f.close());
  await f.start();
  f.heard('Yes.');
  f.call('fake_send', 'fc1');
  await wait();
  // The model is speaking when the provider cancels fc1 and the send then finishes.
  f.content({ modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: Buffer.from([1, 1]).toString('base64') } }] } });
  f.upstream().server({ toolCallCancellation: { ids: ['fc1'] } });
  release(); await wait();
  // That speech ends after the pause: the note goes out now, but the model has not answered it yet.
  await wait(300); f.done(); await wait(400);
  f.heard(' and the docs.');
  f.call('fake_send', 'fc2');
  await wait(2800);
  assert.equal(f.runs.length, 1);
});

test('a checkpoint in the same read as the renewed connection\'s setup is kept', async t => {
  const f = fixture(); t.after(() => f.close());
  const { session } = await f.start();
  f.options.hold = true;
  f.upstream().server({ sessionResumptionUpdate: { resumable: true, newHandle: 'h1' } });
  f.upstream().server({ goAway: { timeLeft: '5s' } });
  await wait();
  const next = f.sockets[1];
  next.confirm(); next.server({ sessionResumptionUpdate: { resumable: true, newHandle: 'h2' } });
  await wait();
  f.options.hold = false;
  next.close(1011);
  await wait();
  assert.equal(f.sockets.length, 3); assert.equal(f.sockets[2].sent[0].setup.sessionResumption.handle, 'h2');
  assert.ok(f.gemini.sessions.has(session.id));
});

test('a send the provider cancels while it waits for its transcript is never sent', async t => {
  const f = fixture(); t.after(() => f.close());
  await f.start();
  f.call('fake_send', 'fc1');
  await wait(200);
  f.upstream().server({ toolCallCancellation: { ids: ['fc1'] } });
  f.heard('Yes.');
  await wait(400);
  assert.equal(f.runs.length, 0);
  assert.deepEqual(f.responses(), []);
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
  f.upstream().server({ sessionResumptionUpdate: { resumable: true, newHandle: 'handle-0' } });
  // Not resumable now (a function call is running): goAway waits for the next checkpoint.
  f.upstream().server({ sessionResumptionUpdate: { resumable: false, newHandle: '' } });
  f.upstream().server({ goAway: { timeLeft: '5s' } });
  await wait();
  assert.equal(f.sockets.length, 1, 'no resume to an older state');
  f.upstream().server({ sessionResumptionUpdate: { resumable: true, newHandle: 'handle-1' } });
  await wait();
  assert.equal(f.sockets.length, 2);
  assert.equal(f.sockets[1].sent[0].setup.sessionResumption.handle, 'handle-1');
  assert.equal(f.sockets[0].readyState, 3, 'the old connection is closed');
  assert.ok(f.gemini.sessions.has(session.id));
  f.browser.audio(Buffer.from([1, 0]));
  assert.ok(f.sockets[1].sent.at(-1)!.realtimeInput, 'audio goes to the new connection');
  // The new connection reports its own checkpoint; a drop then resumes from it.
  f.sockets[1].server({ sessionResumptionUpdate: { resumable: true, newHandle: 'handle-2' } });
  f.sockets[1].close(1011);
  await wait();
  assert.equal(f.sockets.length, 3); assert.equal(f.sockets[2].sent[0].setup.sessionResumption.handle, 'handle-2');
  // A drop before the newest connection reported a checkpoint: no resume from an older one.
  f.sockets[2].close(1011);
  await wait();
  assert.equal(f.sockets.length, 3); assert.equal(f.gemini.sessions.has(session.id), false);
});

test('a connection lost while the session is not resumable ends the call; goAway with no checkpoint ends it at the deadline', async t => {
  const f = fixture(); t.after(() => f.close());
  const { session } = await f.start();
  f.upstream().server({ sessionResumptionUpdate: { resumable: false } });
  f.upstream().close(1011);
  await wait();
  assert.equal(f.sockets.length, 1); assert.equal(f.gemini.sessions.has(session.id), false);
  assert.equal(f.published.at(-1)!.data.status, 'disconnected'); assert.equal(f.browser.closed, 1000);
  const g = fixture(); t.after(() => g.close());
  const second = await g.start();
  g.upstream().server({ goAway: { timeLeft: '1.1s' } });
  await wait(300);
  assert.equal(g.gemini.sessions.has(second.session.id), false, 'no handle by the deadline: ended, not restarted empty');
  assert.match(String(g.published.at(-1)!.data.reason), /before it could be resumed/);
  assert.equal(g.sockets.length, 1);
});

test('no audio reaches a new connection before it confirms the setup', async t => {
  const f = fixture(); t.after(() => f.close());
  await f.start();
  f.options.hold = true;
  f.upstream().server({ sessionResumptionUpdate: { resumable: true, newHandle: 'h' } });
  f.upstream().server({ goAway: { timeLeft: '5s' } });
  await wait();
  const next = f.sockets[1];
  assert.equal(next.readyState, 1, 'open, setup pending');
  f.browser.audio(Buffer.from([1, 0]));
  assert.deepEqual(next.sent.map(m => Object.keys(m)[0]), ['setup']);
  next.confirm(); await wait();
  f.browser.audio(Buffer.from([1, 0]));
  assert.ok(next.sent.at(-1)!.realtimeInput);
});

for (const confirmFirst of [false, true]) test(`a send that finishes while the connection is renewed (${confirmFirst ? 'after' : 'before'} the new one confirms) runs once and its result still reaches the model`, async t => {
  let release!: () => void;
  const f = fixture({ execute: () => new Promise(resolve => { release = () => resolve({ text: 'delivered' }); }) }); t.after(() => f.close());
  await f.start();
  f.heard('Yes.');
  f.call('fake_send', 'fc1');
  await wait();
  f.options.hold = true;
  f.upstream().server({ sessionResumptionUpdate: { resumable: true, newHandle: 'h' } });
  f.upstream().server({ goAway: { timeLeft: '5s' } });
  await wait();
  const next = f.sockets[1];
  if (confirmFirst) { next.confirm(); await wait(); }
  release(); await wait();
  if (!confirmFirst) next.confirm();
  await wait(100);
  assert.equal(next.sent.filter(m => m.toolResponse).length, 0, 'the new session never asked for fc1');
  assert.equal(f.runs.length, 1);
  const note = next.sent.find(m => m.clientContent?.turnComplete);
  assert.match(note!.clientContent.turns[0].parts[0].text, /renewed while fake_send was running[\s\S]*delivered/);
  // The provider asks for the same call again: the same result, no second run.
  next.server({ toolCall: { functionCalls: [{ id: 'fc1', name: 'fake_send', args: {} }] } });
  await wait();
  assert.equal(f.runs.length, 1);
  assert.deepEqual(next.sent.filter(m => m.toolResponse).flatMap(m => m.toolResponse.functionResponses), [{ id: 'fc1', name: 'fake_send', response: { output: 'delivered' } }]);
});

test('a thread notice is not taken by a call whose provider socket is closing', async t => {
  const f = fixture(); t.after(() => f.close());
  const { session } = await f.start();
  f.gemini.ready(session.id); f.said('Hi.'); f.done(); await wait(2600);
  const notice = { kind: 'finished' as const, threadId: 't1', project: 'p', conversationId: 'current', title: 'T' };
  f.upstream().readyState = 2;
  assert.equal(f.gemini.threadNotice(notice), false, 'the watch keeps it');
  f.upstream().readyState = 1;
  assert.equal(f.gemini.threadNotice(notice), true);
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

test('a transcript that only recites the recognition hints is shown but is not a user turn', { timeout: 10_000 }, async t => {
  const f = fixture(); t.after(() => f.close());
  f.gemini.context.vocabulary = () => ['Faro', 'Codex', 'README', 'Claude'];
  await f.start();
  f.heard('Faro, Codex,'); f.heard(' README.');
  f.call('fake_send', 'call_echo');
  await wait(2800);
  assert.match(f.responses().find(r => r.id === 'call_echo').response.output, /no_user_turn/);
  assert.deepEqual(f.runs, [], 'nothing was sent');
  await wait(250);
  const echo = f.published.find(e => e.type === 'transcript' && e.data.role === 'user')!;
  assert.equal(echo.data.text, 'Faro, Codex, README.'); assert.equal(echo.data.echo, true);
  // Words of the user's own make it a turn as it grows.
  f.heard('Sí, mándalo a Faro.');
  f.call('fake_send', 'call_yes');
  await wait(100);
  assert.equal(f.runs.length, 1);
});

test('a recital of the hints that has not reached its third one does not authorize a send', { timeout: 10_000 }, async t => {
  const f = fixture(); t.after(() => f.close());
  f.gemini.context.vocabulary = () => ['Faro', 'Codex', 'README', 'Claude'];
  await f.start();
  f.heard('Faro, Codex,');
  f.call('fake_send', 'call_prefix');
  await wait(100);
  assert.deepEqual(f.runs, [], 'two hints of an open utterance are no turn yet');
  f.heard(' README.');
  await wait(2800);
  assert.match(f.responses().find(r => r.id === 'call_prefix').response.output, /no_user_turn/);
  assert.deepEqual(f.runs, [], 'nothing was sent');
  // Two names that end the utterance are the user's own words: a turn.
  f.heard('Faro, Codex.');
  f.call('fake_send', 'call_names');
  await wait(2800);
  assert.equal(f.runs.length, 1);
});

test('tool parameters keep only the schema keywords Gemini accepts', () => {
  assert.deepEqual(geminiSchema({ type: 'object', additionalProperties: false, required: ['q'], properties: { q: { type: 'string', minLength: 1, description: 'Query' }, additionalProperties: { type: 'array', items: { type: 'integer', minimum: 0, const: 1 }, maxItems: 2 } } }),
    { type: 'object', required: ['q'], properties: { q: { type: 'string', minLength: 1, description: 'Query' }, additionalProperties: { type: 'array', items: { type: 'integer', minimum: 0 }, maxItems: 2 } } });
});
