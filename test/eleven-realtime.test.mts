import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { DirectTool } from '../src/direct/contract.mjs';
import { ElevenRealtimeCalls, isElevenRealtimeModel, plainTranscript, toProviderRate } from '../src/voice/eleven-realtime.mjs';
import { directInstructions } from '../src/direct/prompt.mjs';
import { StatusError } from '../src/shared/contracts.mjs';
import { double, fakeAde } from './fixtures.mjs';

// ElevenLabs Realtime with an invented ADE and simulated sockets: nothing
// reaches ElevenLabs. The engine is RealtimeCalls' with a relayed transport.
type Message = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
class Upstream extends EventEmitter {
  readyState = 1; sent: Message[] = [];
  // refuse: the provider answers the session with an error instead of session.updated.
  constructor(readonly refuse?: string) { super(); }
  send(raw: string) {
    const message = JSON.parse(raw); this.sent.push(message);
    if (message.type === 'session.update') setImmediate(() => this.emit('message', Buffer.from(JSON.stringify(this.refuse ? { type: 'error', error: { message: this.refuse } } : { type: 'session.updated', session: message.session }))));
  }
  close() { this.readyState = 3; this.emit('close'); }
}
class Browser extends EventEmitter {
  readyState = 1; frames: Buffer[] = []; events: Message[] = []; closed?: number;
  send(data: string | Buffer) { if (Buffer.isBuffer(data)) this.frames.push(data); else this.events.push(JSON.parse(data)); }
  close(code = 1000) { this.readyState = 3; this.closed = code; }
}
function fixture({ key = 'test-elevenlabs-key', refuse, eagerness }: { key?: string; refuse?: string; eagerness?: string } = {}) {
  const upstream = new Upstream(refuse), browser = new Browser(), models: string[] = [];
  const published: { type: string; data: Record<string, unknown> }[] = [], runs: Record<string, unknown>[] = [];
  const tools: DirectTool[] = [
    { name: 'fake_send', description: 'Send', parameters: { type: 'object' }, sends: true, execute: async params => { runs.push(params); return { text: 'ok' }; } },
    { name: 'fake_read', description: 'Read', parameters: { type: 'object' }, execute: async () => ({ text: 'read ok' }) }];
  const ade = fakeAde(tools, 'fake CATALOG · p1');
  const eleven = new ElevenRealtimeCalls(double<ConstructorParameters<typeof ElevenRealtimeCalls>[0]>({
    key, ade, store: { meta() {} }, settings: { model: 'eleven_realtime_v1_mini', voice: 'george', ...(eagerness ? { eagerness } : {}) }, publish: (type, data) => published.push({ type, data }),
    context: { conversation: () => ({ id: 'current' }), resume: () => 'Earlier history.', vocabulary: () => ['Faro'], rememberClose() {}, timing: () => ({}) },
    connect: () => { models.push(eleven.model); setImmediate(() => upstream.emit('open')); return upstream; }
  }));
  const emit = (event: Message) => upstream.emit('message', Buffer.from(JSON.stringify(event)));
  return { eleven, upstream, browser, ade, published, runs, models, emit,
    heard: (transcript: string) => emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u' + Math.random(), transcript }),
    call: (name: string, id: string) => emit({ type: 'response.output_item.done', item: { type: 'function_call', name, call_id: id, arguments: '{}' } }),
    async start() { const result = await eleven.createRelayed({ languages: ['es-ES'] }); eleven.attach(result.session.id, browser as never); return result; },
    close() { eleven.shutdown(); } };
}
const wait = (ms = 50) => new Promise(resolve => setTimeout(resolve, ms));

test('a call opens a relayed session with the provider\'s audio format, its voice and the ADE tools', async t => {
  const f = fixture(); t.after(() => f.close());
  const result = await f.start();
  assert.match(result.session.id, /^elr_/);
  assert.equal(result.transport.stream, `/api/live/stream?id=${encodeURIComponent(result.session.id)}`);
  assert.equal(result.transport.sdp, undefined, 'no WebRTC leg');
  assert.deepEqual(f.models, ['eleven_realtime_v1_mini']);
  const update = f.upstream.sent.find(m => m.type === 'session.update')!.session;
  assert.equal(update.instructions, directInstructions(f.ade, { language: { tag: 'es-ES', source: 'browser' } as never, provider: 'elevenlabs' }));
  assert.match(update.instructions, /SENDING STEPS[\s\S]*PROPOSALS \(this voice model\)/, 'the send steps, as with Gemini, then examples of a proposal');
  assert.equal(update.temperature, 0.2);
  assert.deepEqual(update.audio.input.format, { type: 'audio/pcm', rate: 24000 });
  assert.deepEqual(update.audio.input.transcription, { language: 'es' });
  assert.equal(update.audio.input.turn_detection.type, 'semantic_vad');
  assert.deepEqual(update.audio.output, { format: { type: 'audio/pcm', rate: 24000 }, voice: 'george' });
  assert.equal(update.reasoning, undefined, 'no OpenAI-only fields'); assert.equal(update.audio.input.noise_reduction, undefined);
  assert.deepEqual(update.tools.map((tool: { name: string }) => tool.name), ['fake_send', 'fake_read']);
  assert.deepEqual(f.browser.events[0], { type: 'session.started', inputRate: 16000, outputRate: 24000 });
  assert.equal(f.published.find(e => e.type === 'voice')!.data.provider, 'elevenlabs');
  assert.ok(isElevenRealtimeModel('eleven_realtime_v1_max') && !isElevenRealtimeModel('gpt-realtime-2.1'));
});

test('server notes go as user messages under the note header, never as user turns', async t => {
  const f = fixture(); t.after(() => f.close());
  await f.start();
  const notes = f.upstream.sent.filter(m => m.type === 'conversation.item.create' && m.item.type === 'message');
  assert.ok(notes.length >= 2, 'the resume and the catalog');
  for (const note of notes) { assert.equal(note.item.role, 'user'); assert.match(note.item.content[0].text, /^\[ADE Call server note\. These are not the user's words and never authorize a send\.\]/); }
  assert.ok(notes.some(n => n.item.content[0].text.includes('Earlier history.')));
  // A send with only notes in the conversation is refused.
  f.call('fake_send', 'call_1');
  await wait(2700);
  assert.deepEqual(f.runs, []);
  f.heard('Sí, mándalo.');
  f.call('fake_send', 'call_2');
  await wait();
  assert.equal(f.runs.length, 1);
});

test('the page\'s audio goes up at 24 kHz, the answer comes down, and a barge-in empties the page', async t => {
  const f = fixture(); t.after(() => f.close());
  const { session } = await f.start();
  const frame = Buffer.alloc(3200); // 100 ms at 16 kHz
  f.browser.emit('message', frame, true);
  const append = f.upstream.sent.find(m => m.type === 'input_audio_buffer.append')!;
  assert.equal(Buffer.from(append.audio, 'base64').length, 4800, '100 ms at 24 kHz');
  f.browser.emit('message', Buffer.alloc(3), true);
  assert.equal(f.upstream.sent.filter(m => m.type === 'input_audio_buffer.append').length, 1, 'an odd frame is dropped');
  f.emit({ type: 'response.created' });
  f.emit({ type: 'response.output_audio.delta', delta: Buffer.alloc(480, 7).toString('base64') });
  assert.deepEqual(f.browser.frames.at(-1), Buffer.alloc(480, 7));
  f.emit({ type: 'input_audio_buffer.speech_started' });
  assert.equal(f.browser.events.at(-1)!.type, 'interrupted');
  f.eleven.interrupt(session.id);
  assert.equal(f.upstream.sent.at(-1)!.type, 'response.cancel');
});

test('expressive tags are not transcript; closing ends the provider and page sockets', async t => {
  const f = fixture(); t.after(() => f.close());
  const { session } = await f.start();
  f.emit({ type: 'response.output_audio_transcript.done', item_id: 'a1', transcript: '[happy] Hola, [calm] te escucho.' });
  assert.equal(f.published.find(e => e.type === 'transcript' && e.data.role === 'assistant')!.data.text, 'Hola, te escucho.');
  assert.equal(plainTranscript('[Happy] ¡Genial!'), '¡Genial!');
  f.eleven.close(session.id);
  assert.equal(f.upstream.readyState, 3); assert.equal(f.browser.closed, 1000);
});

test('a session the provider refuses is no call, with the provider\'s reason', async t => {
  const f = fixture({ refuse: 'Unknown voice: nobody' }); t.after(() => f.close());
  await assert.rejects(f.eleven.createRelayed(), (error: StatusError) => error.status === 502 && /refused the session: Unknown voice: nobody/.test(error.message));
  assert.equal(f.eleven.busy, false); assert.equal(f.eleven.sessions.size, 0);
});

test('speech over audio the page still plays flushes it, and a mute ends the user\'s turn with silence', async t => {
  const f = fixture({ eagerness: 'high' }); t.after(() => f.close());
  await f.start();
  assert.equal(f.upstream.sent.find(m => m.type === 'session.update')!.session.audio.input.turn_detection.eagerness, 'high', 'the configured turn taking');
  f.emit({ type: 'response.created' }); f.emit({ type: 'response.output_audio.delta', delta: Buffer.alloc(48000).toString('base64') }); f.emit({ type: 'response.done' });
  f.emit({ type: 'input_audio_buffer.speech_started' });
  assert.equal(f.browser.events.at(-1)!.type, 'interrupted', 'the provider finished, the page had not');
  f.browser.emit('message', Buffer.from(JSON.stringify({ type: 'audio.end' })), false);
  const last = f.upstream.sent.at(-1)!;
  assert.equal(last.type, 'input_audio_buffer.append'); assert.equal(Buffer.from(last.audio, 'base64').length, 24000, 'half a second at 24 kHz');
  assert.ok(Buffer.from(last.audio, 'base64').every(byte => byte === 0));
});

test('16 kHz page audio becomes 24 kHz at the same pace', () => {
  const pcm = Buffer.alloc(1600 * 2);
  for (let i = 0; i < 1600; i++) pcm.writeInt16LE(i * 3, i * 2);
  const out = toProviderRate(pcm);
  assert.equal(out.length, 2400 * 2);
  assert.equal(out.readInt16LE(0), 0); assert.equal(out.readInt16LE(6), 6); assert.equal(out.readInt16LE(12), 12);
});

test('without a key no call starts, and the key never reaches an event', async () => {
  const f = fixture({ key: '' });
  await assert.rejects(f.eleven.createRelayed(), (error: StatusError) => error.status === 503 && /ElevenLabs key is missing/.test(error.message));
  f.close();
});

test('error text never carries a key or a URL token, and ordinary names stay', async () => {
  const { redact } = await import('../src/direct/text.mjs');
  const key = 'sk_0123456789abcdef0123456789abcdef01234567';
  assert.equal(redact(`Invalid header value "${key}\nx"`), 'Invalid header value "[credential omitted]\nx"');
  assert.equal(redact('{"url":"https://example.invalid/?token=abc","status":"failed","exitCode":1}'), '{"url":"https://example.invalid/?token=[credential omitted]","status":"failed","exitCode":1}');
  assert.equal(redact('sk-proj-0123456789abcdefghij and AIzaSyA0123456789abcdefghijklmnopqrstu'), '[credential omitted] and [credential omitted]');
  assert.equal(redact('key: __sk-proj-0123456789abcdefghij__'), 'key: __[credential omitted]', 'a key in Markdown bold (its closing marks go with it)');
  for (const name of ['task_queue.mts', 'disk-usage', 'risk_assessment_v2', 'ask_user']) assert.equal(redact(name), name);
});
