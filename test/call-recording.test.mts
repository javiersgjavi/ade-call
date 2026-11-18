import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { CallRecording } from '../public/call-recording.js';
import { LIBRARY_LIMIT, RECORDING_LIMIT, type RecordingEvent, type RecordingInfo } from '../public/recording-store.js';
import { double } from './fixtures.mjs';

function setup(t: TestContext) {
  let tracksStopped = 0, contextsClosed = 0;
  const connections: number[][] = [], starts: number[] = [];
  const node = () => ({ channelCount: 2, channelCountMode: 'max', connect(_target: unknown, ...ports: number[]) { connections.push(ports); }, disconnect() {} });
  class Audio {
    currentTime = 0; sampleRate = 48000; state = 'running';
    resume() { return Promise.resolve(); }
    close() { contextsClosed++; this.state = 'closed'; return Promise.resolve(); }
    createMediaStreamDestination() { return { ...node(), stream: { getTracks: () => [{ stop() { tracksStopped++; } }] } }; }
    createChannelMerger() { return node(); }
    createMediaStreamSource() { return node(); }
    createGain() { return node(); }
    createBuffer(_channels: number, samples: number, rate: number) { return { duration: samples / rate, getChannelData: () => new Float32Array(samples) }; }
    createBufferSource() { return { ...node(), start(time: number) { starts.push(time); }, stop() {} }; }
  }
  let recorder!: Recorder;
  class Recorder {
    static isTypeSupported(type: string) { return type.startsWith('audio/webm'); }
    mimeType = 'audio/webm;codecs=opus'; state = 'inactive'; ondataavailable?: (event: { data: Blob }) => void; onstop?: () => void;
    constructor() { recorder = this; }
    start() { this.state = 'recording'; }
    chunk(text: string) { this.ondataavailable?.({ data: new Blob([text]) }); }
    stop() { this.state = 'inactive'; queueMicrotask(() => { this.chunk('final'); this.onstop?.(); }); }
  }
  for (const [name, value] of Object.entries({ AudioContext: Audio, MediaRecorder: Recorder })) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); });
  }
  const saved: { info: RecordingInfo; events: RecordingEvent[]; audio: Blob; sequence: number }[] = [], warnings: string[] = [];
  const store = { list: async () => [] as RecordingInfo[], save: async (info: RecordingInfo, sequence: number, audio: Blob, events: RecordingEvent[]) => { saved.push({ info, sequence, audio, events }); } };
  const recording = new CallRecording(store, { provider: 'realtime', backend: 't3', conversationId: 'conversation' }, text => warnings.push(text));
  t.after(() => recording.stop());
  return { recording, store, saved, warnings, connections, starts, recorder: () => recorder, released: () => ({ tracksStopped, contextsClosed }), stream: double<MediaStream>({ getTracks() { assert.fail('must not stop call tracks'); } }) };
}

test('records both directions separately and commits final chunks and events before stop resolves', async t => {
  const p = setup(t); await p.recording.start(p.stream);
  p.recording.remoteStream(p.stream); p.recording.identify('call');
  p.recording.event('transcript', { text: 'test only', role: 'user' });
  p.recorder().chunk('one'); p.recorder().chunk('two');
  const first = p.recording.stop('user_hangup'); assert.equal(p.recording.stop(), first); await first;
  assert.equal(p.saved.at(-1)!.info.status, 'complete');
  assert.equal(p.saved.at(-1)!.info.callId, 'call');
  assert.equal(await new Blob(p.saved.map(item => item.audio)).text(), 'onetwofinal');
  assert.deepEqual(p.saved.map(item => item.sequence), [0, 1, 2, 3, 4]);
  assert.ok(p.connections.some(ports => ports.join() === '0,0'));
  assert.ok(p.connections.some(ports => ports.join() === '0,1'));
  const events = p.saved.flatMap(item => item.events);
  assert.ok(events.some(event => event.type === 'transcript'));
  assert.ok(events.every((event, i) => !i || event.ms >= events[i - 1].ms));
  p.recording.event('late'); assert.equal(events.at(-1)!.type, 'recording_stopped');
  assert.deepEqual(p.released(), { tracksStopped: 1, contextsClosed: 1 });
});

test('quota failure preserves committed chunks and releases only recording resources', async t => {
  const p = setup(t); await p.recording.start(p.stream); await new Promise(resolve => setImmediate(resolve));
  p.store.save = async () => { throw new Error('QuotaExceededError'); };
  p.recorder().chunk('fails'); await new Promise(resolve => setImmediate(resolve)); await p.recording.stop();
  assert.equal(p.saved.length, 1); assert.equal(p.saved[0].info.status, 'recording');
  assert.equal(p.recording.info.status, 'incomplete'); assert.ok(p.warnings.length);
  assert.deepEqual(p.released(), { tracksStopped: 1, contextsClosed: 1 });
});

test('full library refuses recording without acquiring audio resources', async t => {
  const p = setup(t); p.store.list = async () => [{ bytes: LIBRARY_LIMIT } as RecordingInfo];
  await p.recording.start(p.stream);
  assert.equal(p.saved.length, 0); assert.equal(p.recording.info.reason, 'start_failed');
  assert.deepEqual(p.released(), { tracksStopped: 0, contextsClosed: 0 });
});

test('recording size limit marks the archive incomplete and excludes excess chunks', async t => {
  const p = setup(t); await p.recording.start(p.stream);
  p.recorder().ondataavailable?.({ data: double<Blob>({ size: RECORDING_LIMIT + 1 }) });
  await p.recording.stop();
  assert.equal(p.saved.at(-1)!.info.reason, 'storage_limit');
  assert.equal(p.saved.at(-1)!.info.status, 'incomplete');
  assert.ok(p.saved.at(-1)!.info.bytes < RECORDING_LIMIT);
});

test('cancellation during storage initialization cannot start a recorder later', async t => {
  const p = setup(t); let resolve!: (items: RecordingInfo[]) => void;
  p.store.list = () => new Promise(done => { resolve = done; });
  const start = p.recording.start(p.stream); await p.recording.stop('disabled_by_user'); resolve([]); await start;
  assert.equal(p.saved.length, 0); assert.equal(p.recorder(), undefined);
});

test('event overflow stops once, persists the reason and does not recurse', async t => {
  const p = setup(t); await p.recording.start(p.stream);
  for (let i = 0; i < 2001; i++) p.recording.event('synthetic');
  await p.recording.stop();
  assert.equal(p.saved.at(-1)!.info.status, 'incomplete');
  assert.equal(p.saved.at(-1)!.info.reason, 'event_limit');
  assert.equal(p.saved.flatMap(part => part.events).filter(event => event.type === 'recording_stopped').length, 1);
});

test('only the final marker closes the server archive, after the final audio chunk', async t => {
  const p = setup(t); await p.recording.start(p.stream); await p.recording.stop();
  assert.ok(p.saved.slice(0, -1).every(part => part.info.status === 'recording'));
  assert.equal(p.saved.at(-1)!.audio.size, 0);
  assert.equal(p.saved.at(-1)!.info.status, 'complete');
});
