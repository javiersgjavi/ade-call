import type { Scenario } from './scenario.mjs';
import { EventEmitter } from 'node:events';
import { GeminiCalls, connectGemini, INPUT_RATE, OUTPUT_RATE, type GeminiCall, type GeminiSettings, type Socket } from '../voice/gemini.mjs';
import { SimulatedT3 } from './world.mjs';
import { redactEvidence } from './redact.mjs';
import { finalKind } from '../conversation/thread-watch.mjs';
import { timeContext } from '../conversation/time-context.mjs';
import { requestIdFor } from '../direct/session.mjs';
import { BYTES_PER_MS, RATE } from './speech.mjs';
import { evalText } from './judge.mjs';
import { CHUNK_MS, scenarioAudio, simulatedVocabulary, sleep, speakableText, stereo, turnAt, type RunOptions, type RunRecord } from './runner.mjs';

// Runs one scenario as a closed-loop call against Gemini Live, as runner.mts
// does for GPT Realtime: the production engine (GeminiCalls: instructions,
// tools, send rule, notes, notices) holds the provider socket, and the
// synthetic user is the page on the other side of its audio relay, streaming
// 16 kHz PCM in real time and playing the 24 kHz answer on one playhead. The
// record has the same shape, so checks, judges and reports read it unchanged.
//
// Gemini Live has no response IDs and no speech events. A response here is
// one stretch of model output: it starts with the first audio or transcript
// after the previous one ended, and ends at turnComplete, at interrupted
// (the user spoke over it) or at a toolCall (the answer after the result is a
// response of its own, as with Realtime). It belongs to the user turn of the
// latest transcribed user speech, which is what the send rule reads.

export interface GeminiRunOptions extends Omit<RunOptions, 'settings' | 'connect'> {
  settings: GeminiSettings;
  // Opens the provider socket; tests pass a fake.
  connect?: (key: string) => Socket;
  // Tests shorten the pause that separates two utterances.
  utteranceGapMs?: number;
}

// 24 kHz speech to the 16 kHz the provider takes, by linear interpolation.
export function toInputRate(pcm: Buffer) {
  const samples = pcm.length >> 1, ratio = RATE / INPUT_RATE, n = Math.floor(samples / ratio), out = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const x = i * ratio, j = Math.floor(x), f = x - j;
    const a = pcm.readInt16LE(j * 2), b = pcm.readInt16LE(Math.min(j + 1, samples - 1) * 2);
    out.writeInt16LE(Math.round(a + (b - a) * f), i * 2);
  }
  return out;
}

// The page side of the relay: what the engine sends to the browser arrives
// here, and the microphone frames go to the engine as the browser's would.
class Page extends EventEmitter {
  readyState = 1; events: { type?: string }[] = [];
  send(data: string | Buffer, options?: { binary?: boolean }) { if (!options?.binary) try { this.events.push(JSON.parse(String(data))); } catch { /* Not an event. */ } }
  close() { this.readyState = 3; }
}

type ServerMessage = {
  serverContent?: { modelTurn?: { parts?: { inlineData?: { data?: string; mimeType?: string } }[] }; inputTranscription?: { text?: string }; outputTranscription?: { text?: string }; interrupted?: boolean; turnComplete?: boolean };
  toolCall?: { functionCalls?: { id?: string }[] }; voiceActivity?: { type?: string };
};
type ClientMessage = {
  setup?: { inputAudioTranscription?: { customVocabulary?: string[] } };
  clientContent?: { turns?: { parts?: { text?: string }[] }[]; turnComplete?: boolean };
  toolResponse?: { functionResponses?: { id?: string; response?: { output?: unknown } }[] };
};

export async function runGeminiScenario(scenario: Scenario, options: GeminiRunOptions): Promise<RunRecord> {
  if (OUTPUT_RATE !== RATE) throw new Error('The recording rate must be the provider\'s output rate.');
  const speakable = speakableText(scenario, options);
  const log = options.log || (() => {});
  const audio = await scenarioAudio(scenario, options);
  const sim = new SimulatedT3(scenario.world);
  const t0 = Date.now(), clock = () => Date.now() - t0;
  const record: RunRecord = { scenario: scenario.id, startedAt: new Date(t0).toISOString(), model: '', transcriptionModel: 'built-in', reasoning: '', eagerness: '', voice: '',
    durationMs: 0, turns: [], transcript: [], tools: [], sends: [], notices: [], bargeIns: 0, timeouts: [], providerErrors: [], usage: {} };
  // turn: the user turn being spoken (microphone). committed: the turn of the
  // latest user speech the provider transcribed.
  let turn = 0, committed = 0;
  const turnStarts: number[] = [];
  const turnNow = () => turnStarts.filter(start => start <= clock()).length;
  const responseTurn = new Map<string, number>(), callTurn = new Map<string, number>(), callStart = new Map<string, number>(), requestTurn = new Map<string, number>();
  const calling = new Set<string>(), open = new Set<string>();
  // An answer has words or calls a tool: a lone "..." or breath the model voices
  // while the user pauses neither answers the turn nor sets its latency.
  const substantive = (id: string) => calling.has(id) || /[\p{L}\p{N}]/u.test(said.get(id) || '');
  const ownTurn = (responseId?: string) => responseId && responseTurn.has(responseId) ? responseTurn.get(responseId)! : committed;
  const voiceReads: { threadId: string; at: number }[] = [];
  // The turn each utterance started in, in order, and of the latest piece
  // (late pieces of a held utterance are published on their own).
  const utteranceTurns: number[] = [];
  let lastPieceTurn = 0;
  let fatal: string | null = null;
  let call: GeminiCall | undefined;

  // Notices given to the voice (numbered from 1 in order), the ones whose
  // note asked for a reply and no response has taken yet, and the ones each
  // response covers. A covered response that calls a tool first passes them
  // to the answer after the tool's result.
  let noticesGiven = 0, waiting: number[] = [], covering: number[] = [];
  let quietLine: RunRecord['notices'][number] | null = null;
  const spokenLines: RunRecord['notices'][number][] = [];
  const coverage = new Map<string, number[]>(), callNotices = new Map<string, number[]>();
  const outputs = new Map<string, string>();
  function outgoing(data: string) {
    let message: ClientMessage;
    try { message = JSON.parse(data); } catch { return; }
    // What the transcriber was really given: the custom vocabulary, or none.
    if (message.setup) record.vocabulary = message.setup.inputAudioTranscription?.customVocabulary ?? [];
    const content = message.clientContent;
    for (const part of (content?.turns || []).flatMap(t => t.parts || [])) {
      const text = part.text || '';
      const catalog = text.indexOf('T3 CATALOG ');
      if (catalog >= 0) record.initialCatalog ??= text.slice(catalog);
      // A quiet notice asks for no announcement: it is numbered but never waited on.
      if (text.includes('System notice:')) {
        const n = ++noticesGiven, line = quietLine ?? spokenLines.shift();
        if (line) Object.assign(line, { index: n, given: text, ms: clock() });
        if (!quietLine) waiting.push(n);
      }
    }
    if (content?.turnComplete && waiting.length) { covering = [...covering, ...waiting]; waiting = []; }
    for (const response of message.toolResponse?.functionResponses || []) {
      const id = String(response.id), full = redactEvidence(String(response.response?.output ?? ''), [options.key]);
      outputs.set(id, full);
      const line = record.tools.find(t => t.callId === id);
      if (line) line.result = full;
      if (callNotices.has(id)) { covering = [...covering, ...callNotices.get(id)!]; callNotices.delete(id); }
    }
  }

  // Simulated playback on one playhead, as the page plays it.
  const voiceTrack: { at: number; audio: Buffer; item: string; response: string }[] = [];
  const interrupted = new Map<string, { heardMs: number; totalMs: number }>();
  const cutResponses = new Set<string>(), said = new Map<string, string>();
  let playhead = 0, lastActivity = 0, current: string | null = null, responses = 0;
  // Everything not yet played at `now` stops there; returns the response cut.
  const cut = (now: number) => {
    let heard: string | null = null;
    for (const part of voiceTrack) {
      const end = part.at + part.audio.length / BYTES_PER_MS;
      if (end <= now) continue;
      if (!heard) {
        heard = part.response;
        const own = voiceTrack.filter(p => p.item === part.item);
        interrupted.set(part.item, { heardMs: Math.round(own.reduce((sum, p) => sum + Math.min(Math.max(0, now - p.at), p.audio.length / BYTES_PER_MS), 0)), totalMs: Math.round(own.reduce((sum, p) => sum + p.audio.length / BYTES_PER_MS, 0)) });
      }
      part.audio = part.at >= now ? Buffer.alloc(0) : part.audio.subarray(0, Math.round((now - part.at) * BYTES_PER_MS) & ~1);
    }
    if (heard && playhead > now) playhead = Math.max(now, ...voiceTrack.filter(p => p.audio.length).map(p => p.at + p.audio.length / BYTES_PER_MS));
    return heard;
  };
  const begin = () => {
    if (current) return current;
    const id = current = `gr${++responses}`;
    responseTurn.set(id, committed); open.add(id);
    if (covering.length) { coverage.set(id, covering); covering = []; }
    return id;
  };
  const end = (now: number) => {
    const id = current;
    if (!id) return;
    current = null; open.delete(id);
    const text = said.get(id)?.trim();
    if (text) record.transcript.push({ ms: now, role: 'assistant', text, turn: ownTurn(id), item: id, response: id });
  };
  // Runs before the engine sees each message, so the response is known when
  // the engine acts on it.
  function incoming(raw: Buffer) {
    let message: ServerMessage;
    try { message = JSON.parse(raw.toString()); } catch { return; }
    const now = clock(), content = message.serverContent;
    const piece = content?.inputTranscription?.text;
    if (piece) {
      // A new utterance by the engine's own rule: no open one, or a pause, and no held one.
      if (call && !call.held && (!call.user || Date.now() - call.user.at >= gemini.gap)) utteranceTurns.push(turnNow());
      lastPieceTurn = turnNow();
    }
    if (piece || message.voiceActivity?.type === 'ACTIVITY_START') { committed = turnNow(); lastActivity = now; }
    for (const part of content?.modelTurn?.parts || []) {
      if (!part.inlineData?.data || !part.inlineData.mimeType?.startsWith('audio/pcm')) continue;
      const id = begin(), chunk = Buffer.from(part.inlineData.data, 'base64');
      // A chunk plays after what is queued, and never before it arrived.
      const at = Math.max(now, playhead);
      voiceTrack.push({ at, audio: chunk, item: id, response: id });
      playhead = at + chunk.length / BYTES_PER_MS; lastActivity = now;
    }
    if (content?.outputTranscription?.text) { const id = begin(); said.set(id, (said.get(id) || '') + content.outputTranscription.text); lastActivity = now; }
    // The user spoke over the voice: the page drops what it has not played.
    if (content?.interrupted) {
      const response = playhead > now ? cut(now) : null;
      if (response) { cutResponses.add(response); record.bargeIns++; }
      end(now); lastActivity = now;
    }
    if (content?.turnComplete) { end(now); lastActivity = now; }
    if (message.toolCall?.functionCalls?.length) {
      const id = begin(), owner = ownTurn(id);
      calling.add(id);
      for (const fc of message.toolCall.functionCalls) {
        // The engine runs a call ID once: a repeat keeps the first owner.
        if (!fc.id || callTurn.has(fc.id)) continue;
        callTurn.set(fc.id, owner); callStart.set(fc.id, now);
        if (call) requestTurn.set(requestIdFor('voice', call.id, fc.id), owner);
        if (coverage.has(id)) callNotices.set(fc.id, coverage.get(id)!);
      }
      end(now); lastActivity = now;
    }
  }

  const gemini: GeminiCalls = new GeminiCalls({
    key: options.key, ade: sim.ade, store: { meta() { return undefined; } }, settings: options.settings, instructions: scenario.instructions, utteranceGapMs: options.utteranceGapMs,
    read: threadId => voiceReads.push({ threadId, at: Date.now() }),
    context: { backend: 't3', capabilities: { listThreads: true, readThreadMessages: true, sendMessagesOnRequest: true },
      resume: () => scenario.history ? evalText('resume_with_history', { history: scenario.history }) : evalText('resume_without_history'),
      vocabulary: simulatedVocabulary(sim),
      timing: () => { const time = timeContext(); record.clock ??= { now: time.now, localNow: time.localNow, timeZone: time.timeZone }; return time; }, rememberClose() {}, conversation: () => ({ id: 'eval' }) },
    publish(type, data) {
      const d = data as Record<string, unknown>;
      if (type === 'voice-tool') {
        const callId = String(d.callId);
        record.tools.push({ ms: clock(), startedMs: callStart.get(callId), turn: callTurn.get(callId) ?? committed, name: String(d.name), status: String(d.status), args: d.args, resolvedArgs: sim.resolvedTargets.get(requestIdFor('voice', String(d.id), callId)), result: outputs.get(callId) ?? String(d.result ?? ''), callId });
      }
      if (type === 'transcript' && d.role === 'user' && typeof d.text === 'string') {
        const late = String(d.item || '').startsWith('late:');
        record.transcript.push({ ms: clock(), role: 'user', text: d.text, turn: (late ? lastPieceTurn : utteranceTurns.shift()) ?? turn });
      }
      // The provider could not carry the call (closed, refused a resumption).
      if (type === 'voice' && d.status === 'disconnected') fatal ??= `The provider closed the call before the scenario ended (${String(d.reason || '').slice(0, 120)}).`;
      if (type === 'notice') record.providerErrors.push({ code: 'event_not_processed' });
    },
    connect: key => {
      const socket = (options.connect || connectGemini)(key);
      socket.on('message', incoming as never);
      const send = socket.send.bind(socket);
      socket.send = (data: string | Buffer, sendOptions?: { binary?: boolean }) => { if (typeof data === 'string') outgoing(data); send(data, sendOptions); };
      return socket;
    }
  });
  let pumping = false, pump: Promise<void> = Promise.resolve();
  const cleanups: (() => void)[] = [];
  try {
    Object.assign(record, { model: gemini.model, voice: gemini.voice });
    // As the thread watch: a final notice the voice cannot take now is offered again until taken.
    const undelivered: { notice: Parameters<GeminiCalls['threadNotice']>[0]; line: RunRecord['notices'][number]; runId: string; endedAt: number; quiet?: boolean }[] = [];
    sim.onReply = reply => {
      const kind = finalKind(reply.status);
      const line: RunRecord['notices'][number] = { ms: clock(), arrivedMs: clock(), delivered: false, thread: reply.threadKey, text: reply.text, kind };
      record.notices.push(line);
      undelivered.push({ line, runId: reply.runId, endedAt: Date.now(), notice: { kind, threadId: reply.threadId, title: reply.title, project: reply.project, conversationId: 'eval', text: reply.text } });
    };
    const offer = setInterval(() => {
      while (undelivered.length) {
        const next = undelivered[0];
        if (sim.threads.get(next.notice.threadId)?.thread.latestRunId !== next.runId) { next.line.superseded = true; undelivered.shift(); continue; }
        const quiet = next.quiet ??= voiceReads.some(r => r.threadId === next.notice.threadId && r.at > next.endedAt);
        quietLine = quiet ? next.line : null;
        if (!quiet) spokenLines.push(next.line);
        const given = gemini.threadNotice({ ...next.notice, ...(quiet ? { quiet: true } : {}) });
        quietLine = null;
        if (!given) { if (!quiet) spokenLines.pop(); break; }
        Object.assign(next.line, { delivered: true, ...(quiet ? { quiet: true } : {}) });
        undelivered.shift();
      }
    }, 250);
    cleanups.push(() => clearInterval(offer));

    const created = await gemini.create(scenario.language ? { language: scenario.language } : {});
    call = gemini.sessions.get(created.session.id);
    if (!call) throw new Error('The Gemini call ended while it was connecting.');
    const live = call, page = new Page();
    if (!gemini.attach(live.id, page as never as Socket)) throw new Error('The Gemini call did not take the audio relay.');
    const alive = () => { if (fatal) throw new Error(fatal); };

    // The microphone: real-time 100 ms chunks of the next turn's audio or silence.
    const mic: Buffer[] = [];
    let queue = Buffer.alloc(0), micStart = 0;
    const firstSample: { run: (() => void) | null } = { run: null };
    pumping = true;
    pump = (async () => {
      const start = Date.now(); micStart = clock();
      for (let n = 0; pumping; n++) {
        const size = CHUNK_MS * BYTES_PER_MS;
        if (queue.length && firstSample.run) { const first = firstSample.run; firstSample.run = null; first(); }
        const chunk = queue.length ? queue.subarray(0, size) : Buffer.alloc(size);
        queue = queue.subarray(chunk.length);
        const full = chunk.length === size ? chunk : Buffer.concat([chunk, Buffer.alloc(size - chunk.length)]);
        mic.push(full);
        page.emit('message', toInputRate(full), true);
        const wait = start + (n + 1) * CHUNK_MS - Date.now();
        if (wait > 0) await sleep(wait);
      }
    })();
    const speak = async (pcm: Buffer, first?: () => void) => { firstSample.run = first ?? null; queue = Buffer.concat([queue, pcm]); while (queue.length && pumping) { alive(); await sleep(20); } };
    // Quiet: nothing pending in the engine, playback over, and no event for a moment.
    const quiet = () => !live.responding && !live.toolsPending.size && !live.queue.length && !gemini.working && clock() >= playhead && clock() - lastActivity > 1200;
    const answered = (owner: number) => [...responseTurn].some(([id, turn]) => turn === owner && substantive(id));
    const settle = async (limit: number, done: () => boolean, noResponseMs = options.noResponseMs ?? 10_000) => {
      const from = clock(), until = from + limit;
      while (clock() < until) {
        alive();
        if (quiet() && !open.size && (done() || clock() - from >= noResponseMs)) return true;
        await sleep(100);
      }
      return false;
    };
    const settleTurn = async (settling: number, limit: number, noResponseMs?: number) => {
      if (await settle(limit, () => answered(settling), noResponseMs)) return;
      record.timeouts.push(settling); log(`  ${settling ? `turn ${settling}` : 'greeting'}: the voice did not go quiet in time`);
    };

    await sleep(800);
    gemini.ready(live.id);
    await settleTurn(0, 20_000, 4000);
    const interruptions: { bargeIn: { overVoice: boolean; cut: boolean; preamble?: boolean }; response: string | null }[] = [];
    const finishCut = () => { for (const i of interruptions) { i.bargeIn.cut = !!i.response && cutResponses.has(i.response); if (i.response && calling.has(i.response)) i.bargeIn.preamble = true; } };
    for (const [i, t] of scenario.turns.entries()) {
      if (t.bargeInMs !== undefined && i > 0) {
        // Interrupt once bargeInMs of the answer to the previous turn has played, while it plays.
        const until = clock() + 60_000, answering = (p: { response: string }) => !coverage.has(p.response) && !calling.has(p.response) && ownTurn(p.response) === i;
        for (;;) {
          const now = clock(), own = voiceTrack.filter(p => p.audio.length && answering(p));
          const played = own.reduce((sum, p) => sum + Math.max(0, Math.min(now, p.at + p.audio.length / BYTES_PER_MS) - p.at), 0);
          const playing = own.some(p => p.at <= now && p.at + p.audio.length / BYTES_PER_MS > now);
          if ((played >= t.bargeInMs && playing) || now > until || (own.length && quiet() && !open.size)) break;
          await sleep(20);
        }
      } else if (t.continues) {
        await sleep(Math.max(0, record.turns[i - 1].endMs + (t.pauseMs ?? 800) - clock()));
      } else {
        if (i > 0) await settleTurn(i, options.turnTimeoutMs ?? 90_000);
        await sleep(t.pauseMs ?? 800);
      }
      finishCut();
      turn = i + 1;
      let overVoice = false;
      sim.startTurn(turn);
      let startMs = clock();
      const kind = t.say !== undefined ? 'say' : t.noise ? 'noise' : 'audio';
      log(`  turn ${turn}: ${kind}, ${Math.round(audio[i].length / BYTES_PER_MS)} ms`);
      let playing: string | null = null;
      await speak(audio[i], () => {
        startMs = clock(); turnStarts.push(startMs);
        playing = voiceTrack.find(p => p.audio.length && !coverage.has(p.response) && !calling.has(p.response) && ownTurn(p.response) === i && p.at <= startMs && p.at + p.audio.length / BYTES_PER_MS > startMs)?.response ?? null;
        overVoice = !!playing;
      });
      const bargeIn: { overVoice: boolean; cut: boolean; preamble?: boolean } | undefined = t.bargeInMs !== undefined ? { overVoice, cut: false } : undefined;
      if (bargeIn) interruptions.push({ bargeIn, response: playing });
      const endMs = startMs + audio[i].length / BYTES_PER_MS;
      record.turns.push({ index: turn, kind, ...(t.say !== undefined ? { text: t.say, words: speakable(t.say, t.voice || options.defaultVoice), voice: t.voice || options.defaultVoice } : t.transcript !== undefined ? { text: t.transcript } : {}), startMs, endMs: Math.round(endMs), ...(bargeIn ? { bargeIn } : {}) });
    }
    await settleTurn(scenario.turns.length, options.turnTimeoutMs ?? 90_000);
    finishCut();
    sim.startTurn(Number.MAX_SAFE_INTEGER);
    while (sim.timers.size && Date.now() < sim.lastDue + 5000) { alive(); await sleep(200); }
    if (sim.timers.size) record.timeouts.push(-1);
    // Every notice given to be announced must be heard in a response requested for it.
    const played = (response: string) => voiceTrack.some(p => p.response === response && p.audio.length && p.at < clock());
    const announced = (notice: number) => [...coverage].some(([response, notices]) => notices.includes(notice) && played(response));
    const owed = () => record.notices.filter(n => n.delivered && !n.quiet);
    const allAnnounced = () => !undelivered.length && owed().every(n => n.index !== undefined && announced(n.index));
    if (record.notices.some(n => !n.superseded) && !(await settle(options.turnTimeoutMs ?? 90_000, allAnnounced, Infinity))) record.timeouts.push(-1);
    await sleep(500);
    alive();
    // The last utterance is published after the user's pause.
    const transcriptionDeadline = clock() + (options.transcriptionTimeoutMs ?? 10_000);
    while (live.user && clock() < transcriptionDeadline) { alive(); await sleep(50); }
    alive();
    pumping = false; await pump;
    record.usage = { ...live.usage };
    gemini.close(live.id, 'end of the evaluation');
    record.durationMs = clock();
    finishCut();
    // Latency runs from the end of the turn's speech to the first sample of its answer that played.
    for (const t of record.turns) {
      const first = voiceTrack.filter(p => p.audio.length && p.at < record.durationMs && !coverage.has(p.response) && substantive(p.response) && ownTurn(p.response) === t.index).sort((a, b) => a.at - b.at)[0];
      t.firstAnswerMs = first ? Math.round(first.at) : null;
      t.latencyMs = first ? Math.round(first.at - t.endMs) : null;
    }
    for (const line of record.transcript) {
      const cutLine = line.item && interrupted.get(line.item); if (cutLine) line.cut = cutLine;
      if (line.role === 'assistant' && line.response && coverage.has(line.response)) line.notice = true;
      const own = line.role === 'assistant' && line.item ? voiceTrack.filter(p => p.item === line.item) : [];
      const first = own.find(p => p.audio.length && p.at < record.durationMs);
      if (first) line.ms = Math.round(first.at);
      else if (line.role === 'assistant' && line.item) line.unheard = true;
    }
    record.sends = sim.sends.map(s => ({ ms: s.at - t0, turn: requestTurn.get(s.requestId) ?? turnAt(record, s.at - t0), projectKey: s.projectKey, threadKey: s.threadKey, message: s.message, ...(s.uncertain ? { uncertain: true, arrival: s.arrival, projectId: s.projectId } : {}) }));
    record.audio = stereo(mic, micStart, voiceTrack, record.durationMs);
    return record;
  } finally {
    for (const cleanup of cleanups) cleanup();
    pumping = false; await pump.catch(() => {});
    gemini.shutdown();
    sim.close();
  }
}
