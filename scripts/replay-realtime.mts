// Replays the microphone channel of a recorded call against GPT Realtime, in
// real time, and reports turn taking and tool use.
//
//   node dist/scripts/replay-realtime.mjs RECORDING_DIR OUT_DIR [--eagerness low] [--tail MS] [--no-prefetch]
//
// The replay is open loop: the user's words were spoken to another voice, so
// they do not react to this one. It runs real T3 reads (read-only CLI) and
// simulates every send: nothing is delivered to T3.
// Output contains transcripts: keep OUT_DIR private and out of commits.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import WebSocket from 'ws';
import { RealtimeCalls } from '../src/voice/realtime.mjs';
import { t3DirectAde } from '../src/direct/t3.mjs';
import { T3ReadCache } from '../src/adapters/t3/read-cache.mjs';
import { t3Projects, t3Overview } from '../src/adapters/t3/client.mjs';
import { ProjectContext } from '../src/conversation/context.mjs';

const [recording, out, ...rest] = process.argv.slice(2);
if (!recording || !out || out.startsWith('--')) {
  console.error('Usage: node dist/scripts/replay-realtime.mjs RECORDING_DIR OUT_DIR [--eagerness low] [--tail MS] [--no-prefetch]');
  process.exit(1);
}
const mode = 'direct';
const flag = (name: string) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
const configPath = join(process.env.ADE_CALL_CONFIG || join(homedir(), '.config/ade-call'), 'config.json');
const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, string>;
const key = config.openaiKey || process.env.OPENAI_API_KEY;
if (!key) throw new Error('openaiKey is missing.');
mkdirSync(out, { recursive: true, mode: 0o700 }); chmodSync(out, 0o700);

const RATE = 24_000, BYTES_PER_MS = RATE * 2 / 1000, CHUNK_MS = 100;
// Left channel is the microphone; right is what the user heard.
const mic = execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-i', join(recording, 'audio.webm'), '-af', 'pan=mono|c0=c0', '-ar', String(RATE), '-ac', '1', '-f', 's16le', '-'], { maxBuffer: 1 << 30 });
const durationMs = Math.floor(mic.length / BYTES_PER_MS);

const sends: unknown[] = [];
const fakeCoordinator = {
  async dispatch(params: { requestId: string; projectId: string; project: string; message: string; threadId?: string }) {
    sends.push({ at: clock(), ...params });
    return { requestId: params.requestId, projectId: params.projectId, project: params.project, threadId: params.threadId || 'simulated-thread', link: null, runId: null, status: 'delivered', delivery: 'started' as const };
  },
  close() {}
};
const projects = t3Projects();
// The same observation and compact catalog as production: main-thread statuses
// from read-only CLI lists, documents per project, short IDs resolved per call.
const observation = new ProjectContext({ state: join(out, 'no-state'), store: {} as never, publish() {}, readOverview: () => t3Overview({ includeSubagents: false }), readThread: null });
await observation.read();
const readCache = new T3ReadCache();
const ade = t3DirectAde({ snapshot: () => observation.snapshot, cache: readCache, tools: { coordinatorFactory: () => fakeCoordinator as never } });
if (rest.includes('--no-prefetch')) ade.prefetch = undefined;

let t0 = 0;
const clock = () => t0 ? Date.now() - t0 : 0;
const log: Record<string, unknown>[] = [];
const note = (type: string, data: Record<string, unknown> = {}) => log.push({ ms: clock(), type, ...data });

const realtime: RealtimeCalls = new RealtimeCalls({
  key, ade, store: { meta() { return undefined; } },
  settings: { model: config.realtimeModel, voice: config.realtimeVoice, reasoning: config.realtimeReasoning, eagerness: flag('--eagerness') || config.realtimeEagerness, noiseReduction: config.realtimeNoiseReduction, transcriptionModel: config.realtimeTranscriptionModel },
  context: { backend: 't3', capabilities: { listThreads: true, readThreadMessages: true, sendMessagesOnRequest: true },
    resume: () => 'There is no relevant historical conversation for this call.',
    vocabulary: () => projects.map(p => p.name), timing: () => ({ now: new Date().toISOString() }), rememberClose() {}, conversation: () => ({ id: 'replay' }) },
  publish(type, data) { if (type !== 'transcript') note(type, data); },
  connect: () => new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(realtime.model)}`, { headers: { Authorization: `Bearer ${key}` } }) as never
});
// Wrap the ADE's tool execution to log reads and their timing.
for (const tool of ade.tools) {
  const execute = tool.execute.bind(tool);
  tool.execute = async (params, context) => {
    note('tool_start', { name: tool.name, params });
    const result = await execute(params, context);
    note('tool_result', { name: tool.name, text: result.text.slice(0, 1500) });
    return result;
  };
}

// Simulated playback: deltas are queued on one playhead; user speech during
// playback stops it and truncates the item, as a browser client would.
const speech = Buffer.alloc(mic.length + 120 * RATE * 2);
let playhead = 0, playing: { item: string; start: number; written: number } | null = null;
const segments: { start: number; end: number; item: string; cut?: boolean }[] = [];
const userSegments: { start: number; end?: number }[] = [];
const transcripts: { ms: number; role: string; text: string }[] = [];
let dropResponse: string | null = null;

const call = await realtime.open('replay_' + Date.now(), { update: true });
const socket = call.socket as unknown as WebSocket;
socket.on('message', raw => {
  const event = JSON.parse(raw.toString());
  const now = clock();
  if (event.type === 'response.output_audio.delta') {
    if (event.response_id === dropResponse) return;
    const audio = Buffer.from(event.delta, 'base64');
    if (!playing || playing.item !== event.item_id) {
      const start = Math.max(now, playhead);
      playing = { item: event.item_id, start, written: 0 };
      segments.push({ start, end: start, item: event.item_id });
    }
    const at = Math.round((playing.start + playing.written / BYTES_PER_MS) * BYTES_PER_MS) & ~1;
    audio.copy(speech, at); playing.written += audio.length;
    playhead = playing.start + playing.written / BYTES_PER_MS; segments.at(-1)!.end = playhead;
  }
  if (event.type === 'input_audio_buffer.speech_started') {
    userSegments.push({ start: event.audio_start_ms });
    if (playing && playhead > now) {
      const played = Math.max(0, now - playing.start);
      socket.send(JSON.stringify({ type: 'conversation.item.truncate', item_id: playing.item, content_index: 0, audio_end_ms: Math.round(played) }));
      speech.fill(0, Math.round(now * BYTES_PER_MS) & ~1, Math.round(playhead * BYTES_PER_MS) & ~1);
      segments.at(-1)!.end = now; segments.at(-1)!.cut = true; playhead = now; playing = null;
      note('barge_in', { playedMs: Math.round(played) });
    }
  }
  if (event.type === 'response.created') dropResponse = null;
  if (event.type === 'response.done' && event.response?.status === 'cancelled') { dropResponse = event.response.id; playing = null; }
  if (event.type === 'input_audio_buffer.speech_stopped' && userSegments.length) userSegments.at(-1)!.end = event.audio_end_ms;
  if (event.type === 'conversation.item.input_audio_transcription.completed') transcripts.push({ ms: now, role: 'user', text: event.transcript });
  if (event.type === 'response.output_audio_transcript.done') transcripts.push({ ms: segments.find(s => s.item === event.item_id)?.start ?? now, role: 'voice', text: event.transcript });
  if (event.type === 'response.output_item.done' && event.item?.type === 'function_call') note('function_call', { name: event.item.name, arguments: event.item.arguments });
  if (event.type === 'error') note('provider_error', { code: event.error?.code, message: event.error?.message });
});
await new Promise(resolve => setTimeout(resolve, 1500));
realtime.ready(call.id);

// Stream the microphone in real time with drift correction.
t0 = Date.now();
for (let sent = 0; sent < mic.length; sent += CHUNK_MS * BYTES_PER_MS) {
  realtime.heartbeat(call.id);
  socket.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: mic.subarray(sent, sent + CHUNK_MS * BYTES_PER_MS).toString('base64') }));
  const wait = t0 + (sent / BYTES_PER_MS) + CHUNK_MS - Date.now();
  if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
}
// Silence after the recording lets pending results arrive.
const silence = Buffer.alloc(CHUNK_MS * BYTES_PER_MS);
const tail = Number(flag('--tail') || 30_000);
for (let i = 0; i < tail / CHUNK_MS; i++) { realtime.heartbeat(call.id); socket.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: silence.toString('base64') })); await new Promise(resolve => setTimeout(resolve, CHUNK_MS)); }
const usage = call.usage;
realtime.close(call.id, 'end of the replay'); realtime.shutdown();

const end = durationMs + tail;
const stereo = Buffer.alloc(Math.ceil(end * BYTES_PER_MS) * 2);
for (let i = 0; i < stereo.length / 4; i++) {
  if (i * 2 + 1 < mic.length) stereo.writeInt16LE(mic.readInt16LE(i * 2), i * 4);
  if (i * 2 + 1 < speech.length) stereo.writeInt16LE(speech.readInt16LE(i * 2), i * 4 + 2);
}
const header = Buffer.alloc(44);
header.write('RIFF', 0); header.writeUInt32LE(36 + stereo.length, 4); header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22); header.writeUInt32LE(RATE, 24); header.writeUInt32LE(RATE * 4, 28);
header.writeUInt16LE(4, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(stereo.length, 40);
writeFileSync(join(out, `replay-${mode}.wav`), Buffer.concat([header, stereo]), { mode: 0o600 });

// Talk-over: voice audio starting while the user is mid-utterance.
const inside = (ms: number) => userSegments.some(u => ms > u.start + 200 && ms < (u.end ?? Infinity));
const overlapMs = segments.reduce((sum, s) => sum + userSegments.reduce((acc, u) => acc + Math.max(0, Math.min(s.end, u.end ?? s.end) - Math.max(s.start, u.start)), 0), 0);
const latencies = userSegments.filter(u => u.end != null).map(u => segments.find(s => s.start >= u.end!)?.start).map((start, i) => start == null ? null : start - userSegments.filter(u => u.end != null)[i].end!).filter((v): v is number => v != null && v < 15_000);
const report = {
  mode, model: realtime.model, eagerness: realtime.eagerness, noiseReduction: realtime.noiseReduction, durationMs, usage,
  metrics: {
    userTurns: userSegments.length, voiceSegments: segments.length, bargeIns: log.filter(e => e.type === 'barge_in').length,
    voiceStartsWhileUserSpeaks: segments.filter(s => inside(s.start)).length, overlapMs: Math.round(overlapMs),
    medianResponseLatencyMs: latencies.length ? latencies.toSorted((a, b) => a - b)[Math.floor(latencies.length / 2)] : null,
    toolCalls: log.filter(e => e.type === 'function_call').length, simulatedSends: sends.length
  },
  transcripts: transcripts.toSorted((a, b) => a.ms - b.ms), segments, userSegments, events: log, sends
};
writeFileSync(join(out, `replay-${mode}.json`), JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ ...report.metrics, cacheHits: readCache.hits, cacheMisses: readCache.misses }));
process.exit(0);
