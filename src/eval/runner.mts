import type { Scenario, Turn } from './scenario.mjs';
import type { Voice } from './speech.mjs';
import WebSocket from 'ws';
import { RealtimeCalls, type RealtimeSettings, type Socket } from '../voice/realtime.mjs';
import { SimulatedT3 } from './world.mjs';
import { redactEvidence } from './redact.mjs';
import { finalKind } from '../conversation/thread-watch.mjs';
import { t3OpenThreadIndex, t3Projects } from '../adapters/t3/client.mjs';
import { ProjectCatalog } from '../conversation/project-catalog.mjs';
import { timeContext } from '../conversation/time-context.mjs';
import { distinctiveWords, vocabularyHints } from '../conversation/context.mjs';
import { requestIdFor } from '../direct/session.mjs';
import { BYTES_PER_MS, RATE, Speech, audioFile, noise, phone, spokenWords } from './speech.mjs';
import { evalText } from './judge.mjs';
import { resolve, dirname } from 'node:path';

// Runs one scenario as a closed-loop call against GPT Realtime: the production
// voice engine (instructions, tools, send gate, notices) over a WebSocket, the
// simulated T3 underneath, and a synthetic user who speaks each turn once the
// voice has gone quiet (or interrupts it on purpose). Audio is streamed in
// real time, so turn taking behaves as in a call.

// cut: an answer the user interrupted, with how much of its audio was heard.
// unheard: an answer whose audio never played (cut or dropped before it sounded).
// The ms of a spoken answer is when its first sample played.
// notice: spoken by a response the engine requested to announce an agent reply, not an answer to the user.
export interface TranscriptLine { ms: number; role: 'user' | 'assistant'; text: string; turn: number; item?: string; cut?: { heardMs: number; totalMs: number }; unheard?: boolean; notice?: boolean; response?: string }
// startedMs: when the model asked for the call; ms: when its result came.
export interface ToolLine { ms: number; startedMs?: number; turn: number; name: string; status: string; args: unknown; resolvedArgs?: Record<string, unknown>; result: string; callId?: string }
export interface RunRecord {
  scenario: string; startedAt: string; model: string; transcriptionModel: string; reasoning: string; eagerness: string; voice: string;
  durationMs: number; turns: { index: number; kind: string; text?: string; words?: string; voice?: string; startMs: number; endMs: number; firstAnswerMs?: number | null; latencyMs?: number | null;
    // A scripted interruption: whether the voice was still playing when the user started, and whether its audio was cut.
    // preamble: the answer cut also called a tool ("let me look…"): it was not yet the proposal.
    bargeIn?: { overVoice: boolean; cut: boolean; preamble?: boolean } }[];
  transcript: TranscriptLine[]; tools: ToolLine[];
  // The recognition hints the call was given, and the clock it was given at the start.
  initialCatalog?: string;
  vocabulary?: string[]; clock?: { now?: string; localNow: string; timeZone: string };
  sends: { ms: number; turn: number; projectKey: string; threadKey: string | null; message: string; uncertain?: boolean; arrival?: 'confirmed' | 'unknown'; projectId?: string }[];
  // ms: when the voice was given the notice; arrivedMs: when the agent answered.
  // quiet: the voice had read the thread since it ended, so it was told not to announce it;
  // superseded: a newer send to the thread replaced it before it was given.
  // given: the system item the engine actually sent (header and bounded body), when it went out.
  notices: { ms: number; arrivedMs?: number; delivered?: boolean; quiet?: boolean; superseded?: boolean; index?: number; given?: string; thread: string; text: string; kind?: string }[];
  bargeIns: number; timeouts: number[]; providerErrors: { code?: string; message?: string }[];
  usage: Record<string, number>;
  audio?: Buffer;
}
export interface RunOptions {
  key: string; settings: RealtimeSettings; speech: Speech; voices: Record<string, Voice>; defaultVoice: string;
  // Longest wait for the voice to go quiet after a turn.
  turnTimeoutMs?: number; log?: (line: string) => void;
  // How long a turn that got no response at all (noise) is waited on.
  noResponseMs?: number;
  transcriptionTimeoutMs?: number;
  connect?: (model: string) => Socket;
}

const CHUNK_MS = 100;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function turnAudio(turn: Turn, scenario: Scenario, speech: Speech, voice: Voice, index: number) {
  if (turn.noise) return noise(turn.noise, turn.ms ?? 2500, index + 1);
  const audio = turn.say !== undefined ? await speech.say(turn.say, voice, scenario.language) : audioFile(resolve(dirname(scenario.file || '.'), turn.audio!));
  // The cache keeps clean speech; the line is applied per run.
  return scenario.channel === 'phone' ? phone(audio, index + 1) : audio;
}

export async function runScenario(scenario: Scenario, options: RunOptions): Promise<RunRecord> {
  // What the user said, for the judges: v3 audio tags are performance, other brackets are words.
  const speakable = (text: string, voice: string) => options.speech.path(text, options.voices[voice] || { id: '' }, scenario.language).model.startsWith('eleven_v3') ? spokenWords(text) : text;
  const log = options.log || (() => {});
  // Audio is prepared before the call: synthesis time is neither silence of
  // the user nor part of the recording.
  const audio: Buffer[] = [];
  for (const [i, t] of scenario.turns.entries()) audio.push(await turnAudio(t, scenario, options.speech, options.voices[t.voice || options.defaultVoice], i));
  // A turn without samples would leave no boundary for the turns after it: refused before the call.
  const empty = audio.findIndex(pcm => pcm.length < 2);
  if (empty >= 0) throw new Error(`turn ${empty + 1} has no audio samples; nothing was called.`);
  const sim = new SimulatedT3(scenario.world);
  const t0 = Date.now(), clock = () => Date.now() - t0;
  const record: RunRecord = { scenario: scenario.id, startedAt: new Date(t0).toISOString(), model: '', transcriptionModel: '', reasoning: '', eagerness: '', voice: '',
    durationMs: 0, turns: [], transcript: [], tools: [], sends: [], notices: [], bargeIns: 0, timeouts: [], providerErrors: [], usage: {} };
  // turn: the user turn being spoken (microphone). committed: the turn of the
  // latest user item the provider committed; a response, and every function
  // call in it, belongs to the turn committed when it was created, which is
  // the turn the send gate reads.
  let turn = 0, committed = 0;
  const itemTurn = new Map<string, number>(), responseTurn = new Map<string, number>(), callTurn = new Map<string, number>();
  // When each scripted turn's first sample went out (clock ms), and the turn
  // each user item's speech started in: a late commit keeps its own turn.
  const voiceReads: { threadId: string; at: number }[] = [];
  const requestTurn = new Map<string, number>(), calling = new Set<string>();
  const turnStarts: number[] = [], speechTurn = new Map<string, number>(), speechEndTurn = new Map<string, number>(), callStart = new Map<string, number>();
  // The provider's audio_start_ms counts from the first microphone sample; VAD
  // padding may start it a little before the words.
  const turnAtMic = (ms: number) => turnStarts.filter(start => start <= ms + 1000).length;
  const ownTurn = (responseId?: string) => responseId && responseTurn.has(responseId) ? responseTurn.get(responseId)! : committed;

  // The hints production gives speech recognition: project names and the distinctive
  // words of open main-thread titles (whole titles can be transcribed on noise).
  // Through the production catalog, with its count and size limits.
  const vocabulary = () => {
    const catalog = new ProjectCatalog('t3', () => t3Projects(sim.base), ids => t3OpenThreadIndex(ids, sim.base, { dated: true })).snapshot({ refresh: true });
    return vocabularyHints('t3', [...catalog.projects.map(p => p.name), ...catalog.threads.filter(t => t.relationshipToParent !== 'subagent').flatMap(t => distinctiveWords(t.title))]);
  };
  const realtime: RealtimeCalls = new RealtimeCalls({
    key: options.key, ade: sim.ade, store: { meta() { return undefined; } }, settings: options.settings,
    // The same signal the production thread watch gets: a read tool of the voice finished on this thread.
    read: threadId => voiceReads.push({ threadId, at: Date.now() }),
    context: { backend: 't3', capabilities: { listThreads: true, readThreadMessages: true, sendMessagesOnRequest: true },
      resume: () => scenario.history ? evalText('resume_with_history', { history: scenario.history }) : evalText('resume_without_history'),
      vocabulary, // The clock the voice is given, saved as given for the judges.
      timing: () => { const time = timeContext(); record.clock ??= { now: time.now, localNow: time.localNow, timeZone: time.timeZone }; return time; }, rememberClose() {}, conversation: () => ({ id: 'eval' }) },
    publish(type, data) {
      const d = data as Record<string, unknown>;
      if (type === 'voice-tool') {
        const callId = String(d.callId);
        // The published copy is shortened for the UI; the judge gets what the model got.
        record.tools.push({ ms: clock(), startedMs: callStart.get(callId), turn: callTurn.get(callId) ?? committed, name: String(d.name), status: String(d.status), args: d.args, resolvedArgs: sim.resolvedTargets.get(requestIdFor('voice', String(d.id), callId)), result: outputs.get(callId) ?? String(d.result ?? ''), callId });
      }
    },
    connect: () => {
      const socket = options.connect ? options.connect(realtime.model) : new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(realtime.model)}`, { headers: { Authorization: `Bearer ${options.key}` } }) as never as Socket;
      // What the engine sends tells which response announces a notice: the
      // first response.create after a system notice item.
      const send = socket.send.bind(socket);
      socket.send = (data: string) => send(outgoing(data));
      return socket;
    }
  });
  // Notices given to the voice (numbered from 1 in order) and the ones not
  // yet requested. The engine's response.create that follows them is tagged
  // with their numbers in the response's metadata, which the provider returns
  // on response.created: a response the provider starts on its own (the
  // user's turn) never takes them. A rejected request gives them back to the
  // next one. coverage: the notices each created response covers.
  // A spoken notice is queued by the engine and sent later, in order; a quiet one
  // is sent at once. Each notice line gets the number of its item when it goes out.
  let noticesGiven = 0, waiting: number[] = [];
  let quietLine: RunRecord['notices'][number] | null = null;
  const spokenLines: RunRecord['notices'][number][] = [];
  // A covered response may call a tool first (read the thread, then speak):
  // its notices pass to the request the engine makes after the tool's output.
  const tagged = new Map<string, number[]>(), coverage = new Map<string, number[]>(), callNotices = new Map<string, number[]>();
  const wait = (notices: number[]) => { waiting = [...new Set([...waiting, ...notices])].sort((a, b) => a - b); };
  // Each tool output exactly as the model received it, redacted like the diagnostics.
  const outputs = new Map<string, string>();
  function outgoing(data: string) {
    // What the transcriber was really given: the prompt of the session, or none.
    if (data.includes('"session.update"')) {
      const update = JSON.parse(data) as { type?: string; session?: { audio?: { input?: { transcription?: { prompt?: string } } } } };
      if (update.type === 'session.update') { const prompt = update.session?.audio?.input?.transcription?.prompt; record.vocabulary = prompt ? prompt.split(', ') : []; }
    }
    const event = JSON.parse(data) as { type?: string; event_id?: string; response?: { metadata?: Record<string, string> }; item?: { type?: string; call_id?: string; output?: unknown; role?: string; content?: { text?: string }[] } };
    if (event.type === 'conversation.item.create' && event.item?.role === 'system') {
      const text = event.item.content?.map(c => c.text || '').join('\n');
      if (text?.startsWith('T3 CATALOG ')) record.initialCatalog ??= text;
    }
    // A quiet notice asks for no announcement: it is numbered but never waited on.
    if (event.type === 'conversation.item.create' && event.item?.role === 'system' && event.item.content?.some(c => c.text?.startsWith('System notice:'))) {
      const n = ++noticesGiven, given = event.item.content?.map(c => c.text || '').join('\n') || '';
      const line = quietLine ?? spokenLines.shift();
      if (line) Object.assign(line, { index: n, given, ms: clock() });
      if (!quietLine) waiting.push(n);
    }
    if (event.type === 'conversation.item.create' && event.item?.type === 'function_call_output' && typeof event.item.output === 'string') {
      const callId = String(event.item.call_id), full = redactEvidence(String(event.item.output), [options.key]);
      outputs.set(callId, full);
      const line = record.tools.find(t => t.callId === callId);
      if (line) line.result = full;
    }
    if (event.type === 'conversation.item.create' && event.item?.type === 'function_call_output' && callNotices.has(String(event.item.call_id))) {
      wait(callNotices.get(String(event.item.call_id))!); callNotices.delete(String(event.item.call_id));
    }
    if (event.type !== 'response.create' || !waiting.length) return data;
    const notices = waiting; waiting = [];
    if (event.event_id) tagged.set(event.event_id, notices);
    return JSON.stringify({ ...event, response: { ...event.response, metadata: { ...event.response?.metadata, eval_notices: notices.join(',') } } });
  }
  let pumping = false, pump: Promise<void> = Promise.resolve();
  const cleanups: (() => void)[] = [];
  try {
    Object.assign(record, { model: realtime.model, transcriptionModel: realtime.transcriptionModel, reasoning: realtime.reasoning, eagerness: realtime.eagerness, voice: realtime.voice });
    // As the thread watch: a final notice the voice cannot take now (the
    // user is speaking, a response is running) is offered again until taken.
    const undelivered: { notice: Parameters<RealtimeCalls['threadNotice']>[0]; line: RunRecord['notices'][number]; runId: string; endedAt: number; quiet?: boolean }[] = [];
    sim.onReply = reply => {
      // The production mapping from the status the turn ended with to the notice.
      const kind = finalKind(reply.status);
      const line: RunRecord['notices'][number] = { ms: clock(), arrivedMs: clock(), delivered: false, thread: reply.threadKey, text: reply.text, kind };
      record.notices.push(line);
      undelivered.push({ line, runId: reply.runId, endedAt: Date.now(), notice: { kind, threadId: reply.threadId, title: reply.title, project: reply.project, conversationId: 'eval', text: reply.text } });
    };
    // The judge sees a notice where the voice got it, not where the agent answered.
    // As the thread watch: a newer send replaces a pending notice, and one the
    // voice has read since the thread ended is given quiet (not to be announced).
    const offer = setInterval(() => {
      while (undelivered.length) {
        const next = undelivered[0];
        if (sim.threads.get(next.notice.threadId)?.thread.latestRunId !== next.runId) { next.line.superseded = true; undelivered.shift(); continue; }
        // Decided when first offered and kept for the retries, as the watch keeps its final notice.
        const quiet = next.quiet ??= voiceReads.some(r => r.threadId === next.notice.threadId && r.at > next.endedAt);
        quietLine = quiet ? next.line : null;
        if (!quiet) spokenLines.push(next.line);
        const given = realtime.threadNotice({ ...next.notice, ...(quiet ? { quiet: true } : {}) });
        quietLine = null;
        if (!given) { if (!quiet) spokenLines.pop(); break; }
        Object.assign(next.line, { delivered: true, ...(quiet ? { quiet: true } : {}) });
        undelivered.shift();
      }
    }, 250);
    cleanups.push(() => clearInterval(offer));

    // Simulated playback on one playhead, as the browser would play it. Each
    // chunk keeps its item and response, so a cut finds what was playing even
    // when the response already ended.
    const voiceTrack: { at: number; audio: Buffer; item: string; response: string }[] = [];
    const itemStart = new Map<string, number>();
    // Items the user cut: how much was heard of how much was generated so far.
    const interrupted = new Map<string, { heardMs: number; totalMs: number }>();
    // Responses whose audio was cut: later chunks of theirs are not played.
    const dropped = new Set<string>();
    let playhead = 0;
    let lastActivity = 0;
    // Responses whose audio a user's speech cut.
    const cutResponses = new Set<string>();
    // Responses not finished yet, by ID: each belongs to a turn (responseTurn).
    const open = new Set<string>();
    // Why the run cannot be trusted: the provider closed the call, a response
    // failed, or the provider reported an error that is not routine.
    let fatal: string | null = null;
    // stopped: the first end of speech in each turn; itemStop: each user item's end,
    // so an answer is timed from the item it answers (a split utterance has two).
    const stopped = new Map<number, number>(), itemStop = new Map<string, number>(), responseItem = new Map<string, string>();
    let lastItem: string | null = null;
    // Everything not yet played at `now` stops there, including the end of the
    // chunk playing; only `responses` when given. Returns the item cut and how
    // much of it was heard.
    const cut = (now: number, responses?: Set<string>) => {
      let heard: { item: string; ms: number } | null = null;
      for (const part of voiceTrack) {
        if (responses && !responses.has(part.response)) continue;
        const end = part.at + part.audio.length / BYTES_PER_MS;
        if (end <= now) continue;
        // Heard: the audio of this item played before `now`, without the gaps.
        if (!heard) {
          const own = voiceTrack.filter(p => p.item === part.item);
          heard = { item: part.item, ms: own.reduce((sum, p) => sum + Math.min(Math.max(0, now - p.at), p.audio.length / BYTES_PER_MS), 0) };
          interrupted.set(part.item, { heardMs: Math.round(heard.ms), totalMs: Math.round(own.reduce((sum, p) => sum + p.audio.length / BYTES_PER_MS, 0)) });
        }
        dropped.add(part.response);
        part.audio = part.at >= now ? Buffer.alloc(0) : part.audio.subarray(0, Math.round((now - part.at) * BYTES_PER_MS) & ~1);
      }
      if (heard && playhead > now) playhead = Math.max(now, ...voiceTrack.filter(p => p.audio.length).map(p => p.at + p.audio.length / BYTES_PER_MS));
      return heard;
    };
    // Each truncation sent (event ID → response it cut), and the ones the provider refused.
    let truncationCount = 0;
    const truncations = new Map<string, string>(), refusedCuts = new Set<string>();
    // A cancellation that cut playback just before the user's speech was
    // detected: that speech is the interruption, and the item is truncated then.
    let cancelledCut: { heard: { item: string; ms: number }; at: number } | null = null;

    const call = await realtime.open('eval_' + t0, { update: true, ...(scenario.language ? { language: scenario.language } : {}) });
    const socket = call.socket as unknown as WebSocket;
    socket.on('message', raw => {
      const event = JSON.parse(raw.toString());
      const now = clock();
      switch (event.type) {
        case 'response.created':
          lastActivity = now;
          if (event.response?.id) {
            responseTurn.set(event.response.id, committed); open.add(event.response.id);
            if (lastItem) responseItem.set(event.response.id, lastItem);
            const notices = String(event.response.metadata?.eval_notices || '');
            if (notices) coverage.set(event.response.id, notices.split(',').map(Number));
          }
          break;
        case 'response.output_audio.delta': {
          if (dropped.has(event.response_id)) return;
          const chunk = Buffer.from(event.delta, 'base64');
          // A chunk plays after what is queued, and never before it arrived: a
          // stall of the provider is silence in the recording too.
          const at = Math.max(now, playhead);
          if (!itemStart.has(event.item_id)) itemStart.set(event.item_id, at);
          voiceTrack.push({ at, audio: chunk, item: event.item_id, response: event.response_id });
          playhead = at + chunk.length / BYTES_PER_MS; lastActivity = now;
          break;
        }
        case 'input_audio_buffer.speech_started': {
          // The turn the user's speech started in. The provider's audio_start_ms includes its VAD
          // padding, so it is bounded by when the event arrived (the speech had begun by then).
          if (event.item_id) {
            const arrived = turnStarts.filter(start => start <= now).length;
            speechTurn.set(event.item_id, typeof event.audio_start_ms === 'number' ? Math.min(arrived, Math.max(1, turnAtMic(micStart + event.audio_start_ms))) : arrived);
          }
          // The user speaks over the voice: what was not heard is cut and the
          // provider is told how much of the item the user heard.
          const recent = cancelledCut && now - cancelledCut.at < 1000 ? cancelledCut.heard : null;
          const heard = playhead > now ? cut(now) ?? recent : recent;
          cancelledCut = null;
          if (heard) {
            const response = voiceTrack.find(p => p.item === heard.item)?.response, eventId = `eval_truncate_${++truncationCount}`;
            if (response) { cutResponses.add(response); truncations.set(eventId, response); }
            socket.send(JSON.stringify({ event_id: eventId, type: 'conversation.item.truncate', item_id: heard.item, content_index: 0, audio_end_ms: Math.round(heard.ms) }));
            record.bargeIns++;
          }
          break;
        }
        case 'input_audio_buffer.speech_stopped':
          // The answer belongs to the last fragment the user's item covered (one item may span a hesitation).
          if (event.item_id && typeof event.audio_end_ms === 'number') speechEndTurn.set(event.item_id, turnStarts.filter(start => start <= micStart + event.audio_end_ms).length);
          // The end of speech on the microphone clock (the event may come later): latency is what the user waits.
          { const ended = (event.item_id && speechEndTurn.get(event.item_id)) || turn, at = typeof event.audio_end_ms === 'number' ? micStart + event.audio_end_ms : now;
            if (event.item_id) itemStop.set(event.item_id, at);
            if (ended && !stopped.has(ended)) stopped.set(ended, at); }
          lastActivity = now; break;
        case 'input_audio_buffer.committed': if (event.item_id) {
          // The transcript keeps the turn the speech started in; the response goes to the turn it ended in.
          itemTurn.set(event.item_id, speechTurn.get(event.item_id) ?? turn);
          committed = speechEndTurn.get(event.item_id) ?? speechTurn.get(event.item_id) ?? turn;
          lastItem = event.item_id;
        } break;
        case 'conversation.item.input_audio_transcription.failed': {
          // Production drops the user's item: the call is no longer the one the script describes.
          const code = String(event.error?.code || 'transcription_failed');
          record.providerErrors.push({ code, message: String(event.error?.message || '').slice(0, 300) });
          fatal ??= `Transcription of a user turn failed (${code.slice(0, 60)}).`;
          break;
        }
        case 'conversation.item.input_audio_transcription.completed':
          if (event.transcript?.trim()) record.transcript.push({ ms: now, role: 'user', text: event.transcript.trim(), turn: itemTurn.get(event.item_id) ?? turn });
          break;
        case 'response.output_item.done':
          if (event.item?.type === 'function_call' && event.item.call_id) {
            // The engine runs a call ID once: a repeat in a later response keeps the first owner.
            if (callTurn.has(event.item.call_id)) break;
            callTurn.set(event.item.call_id, ownTurn(event.response_id)); callStart.set(event.item.call_id, now);
            if (event.response_id) calling.add(event.response_id);
            // The engine's request ID for this call, as it builds it (long or odd IDs are hashed).
            requestTurn.set(requestIdFor('voice', call.id, event.item.call_id), ownTurn(event.response_id));
            if (coverage.has(event.response_id)) callNotices.set(event.item.call_id, coverage.get(event.response_id)!);
          }
          break;
        case 'response.output_audio_transcript.done':
          if (event.transcript?.trim()) record.transcript.push({ ms: now, role: 'assistant', text: event.transcript.trim(), turn: ownTurn(event.response_id), item: event.item_id, response: event.response_id });
          break;
        case 'response.done': {
          lastActivity = now;
          const id = event.response?.id, status = event.response?.status;
          if (id) open.delete(id);
          // A cancelled response stops where it is, whichever event came first.
          if (status === 'cancelled' && id) { const heard = cut(now, new Set([id])); if (heard) cancelledCut = { heard, at: now }; }
          // failed: no answer was produced, the run cannot be graded. incomplete
          // (a limit or a filter cut it): kept as a provider error of the run.
          if (status === 'failed' || status === 'incomplete') {
            const code = String(event.response?.status_details?.error?.code || event.response?.status_details?.reason || status);
            record.providerErrors.push({ code });
            if (status === 'failed') fatal ??= `A response of the provider failed (${code.slice(0, 60)}).`;
          }
          break;
        }
        case 'error': {
          const code = event.error?.code;
          // Routine: a response asked for while another runs (the engine
          // queues it), and our own truncations of audio already gone.
          if (['conversation_already_has_active_response', 'response_cancel_not_active'].includes(code)) {
            // The engine asks again later: the notices go with that request.
            const notices = tagged.get(String(event.error?.event_id || ''));
            if (code === 'conversation_already_has_active_response' && notices) { wait(notices); tagged.delete(String(event.error.event_id)); }
            break;
          }
          // A truncation the provider refused leaves the unheard words in the model's context:
          // the interruption it belonged to did not really happen.
          if (String(event.error?.event_id || '').startsWith('eval_truncate_')) {
            // Benign only when the item was already that short (everything after the cut was gone anyway).
            if (/already (?:shorter|truncated)|shorter than/i.test(String(event.error?.message || ''))) break;
            const response = truncations.get(String(event.error.event_id));
            if (response) refusedCuts.add(response);
            record.providerErrors.push({ code, message: String(event.error?.message || '').slice(0, 300) });
            break;
          }
          record.providerErrors.push({ code, message: String(event.error?.message || '').slice(0, 300) });
          fatal ??= `The provider reported an error (${String(code || 'no code').slice(0, 60)}).`;
        }
      }
    });

    socket.on('close', () => { if (pumping) fatal ??= 'The provider closed the call before the scenario ended.'; });
    const alive = () => { if (fatal) throw new Error(fatal); };

    // The microphone: real-time 100 ms chunks, the next turn's audio or silence.
    // micStart places its first sample on the call's clock.
    const mic: Buffer[] = [];
    let queue = Buffer.alloc(0), micStart = 0;
    // Called when the first sample of a turn leaves for the provider.
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
        realtime.heartbeat(call.id);
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: full.toString('base64') }));
        const wait = start + (n + 1) * CHUNK_MS - Date.now();
        if (wait > 0) await sleep(wait);
      }
    })();
    const speak = async (pcm: Buffer, first?: () => void) => { firstSample.run = first ?? null; queue = Buffer.concat([queue, pcm]); while (queue.length && pumping) { alive(); await sleep(20); } };
    // Quiet: nothing pending in the engine, playback over, and no event for a moment.
    const quiet = () => !call.responding && !call.toolsPending.size && !call.queue.length && !realtime.working && clock() >= playhead && clock() - lastActivity > 1200;
    // After a turn the provider may wait seconds before it closes the user's
    // turn (semantic VAD). The turn is answered once a response of its own
    // exists and no response at all is still open; a turn that got no
    // response (noise) settles after noResponseMs of quiet.
    const answered = (owner: number) => [...responseTurn.values()].includes(owner);
    const settle = async (limit: number, done: () => boolean, noResponseMs = options.noResponseMs ?? 10_000) => {
      const from = clock(), until = from + limit;
      while (clock() < until) {
        alive();
        if (quiet() && !open.size && (done() || clock() - from >= noResponseMs)) return true;
        await sleep(100);
      }
      return false;
    };
    // A timeout is recorded against the turn whose answer did not end (0: the greeting).
    const settleTurn = async (settling: number, limit: number, noResponseMs?: number) => {
      if (await settle(limit, () => answered(settling), noResponseMs)) return;
      record.timeouts.push(settling); log(`  ${settling ? `turn ${settling}` : 'greeting'}: the voice did not go quiet in time`);
    };

    await sleep(800);
    realtime.ready(call.id);
    await settleTurn(0, 20_000, 4000);
    // A scripted interruption is graded once its events have settled: the
    // provider may report the user's speech after the last microphone chunk.
    // The interruption must cut the answer it was scripted to interrupt.
    // Graded once the call is over: a refusal of the truncation can come late.
    const interruptions: { bargeIn: { overVoice: boolean; cut: boolean; preamble?: boolean }; response: string | null }[] = [];
    const finishCut = () => { for (const i of interruptions) { i.bargeIn.cut = !!i.response && cutResponses.has(i.response) && !refusedCuts.has(i.response); if (i.response && calling.has(i.response)) i.bargeIn.preamble = true; } };
    for (const [i, t] of scenario.turns.entries()) {
      if (t.bargeInMs !== undefined && i > 0) {
        // Interrupt once bargeInMs of the answer to the previous turn has played,
        // and while it is playing: a tool wait between a preamble and the answer
        // does not count. If the voice finishes first, the turn goes ahead (and
        // its interruption check fails: it was not exercised).
        const until = clock() + 60_000, answering = (p: { response: string }) => !coverage.has(p.response) && !calling.has(p.response) && ownTurn(p.response) === i;
        for (;;) {
          const now = clock(), own = voiceTrack.filter(p => p.audio.length && answering(p));
          const played = own.reduce((sum, p) => sum + Math.max(0, Math.min(now, p.at + p.audio.length / BYTES_PER_MS) - p.at), 0);
          const playing = own.some(p => p.at <= now && p.at + p.audio.length / BYTES_PER_MS > now);
          if ((played >= t.bargeInMs && playing) || now > until || (own.length && quiet() && !open.size)) break;
          await sleep(20);
        }
      } else if (t.continues) {
        // A hesitation: the clock runs from the end of the previous fragment.
        await sleep(Math.max(0, record.turns[i - 1].endMs + (t.pauseMs ?? 800) - clock()));
      } else {
        // The greeting (turn 0) was settled before the loop.
        if (i > 0) await settleTurn(i, options.turnTimeoutMs ?? 90_000);
        await sleep(t.pauseMs ?? 800);
      }
      finishCut();
      turn = i + 1;
      // Whether the answer was still playing is read when the user's first sample goes out, not when the turn is queued.
      let overVoice = false;
      sim.startTurn(turn);
      let startMs = clock();
      const kind = t.say !== undefined ? 'say' : t.noise ? 'noise' : 'audio';
      // Only the kind and length: the words may come from a private call.
      log(`  turn ${turn}: ${kind}, ${Math.round(audio[i].length / BYTES_PER_MS)} ms`);
      // The turn starts when its first sample goes out: the overlap and silence checks read that instant.
      // The answer an interruption cuts is the one playing when the user's first
      // sample goes out (a preamble, a tool wait and a later answer may share the turn).
      let playing: string | null = null;
      await speak(audio[i], () => {
        startMs = clock(); turnStarts.push(startMs);
        playing = voiceTrack.find(p => p.audio.length && !coverage.has(p.response) && !calling.has(p.response) && ownTurn(p.response) === i && p.at <= startMs && p.at + p.audio.length / BYTES_PER_MS > startMs)?.response ?? null;
        overVoice = !!playing;
      });
      const bargeIn: { overVoice: boolean; cut: boolean; preamble?: boolean } | undefined = t.bargeInMs !== undefined ? { overVoice, cut: false } : undefined;
      if (bargeIn) interruptions.push({ bargeIn, response: playing });
      // The fragment ends when its last sample does, on the microphone timeline.
      const endMs = startMs + audio[i].length / BYTES_PER_MS;
      record.turns.push({ index: turn, kind, ...(t.say !== undefined ? { text: t.say, words: speakable(t.say, t.voice || options.defaultVoice), voice: t.voice || options.defaultVoice } : t.transcript !== undefined ? { text: t.transcript } : {}), startMs, endMs: Math.round(endMs), ...(bargeIn ? { bargeIn } : {}) });
    }
    await settleTurn(scenario.turns.length, options.turnTimeoutMs ?? 90_000);
    finishCut();
    // A reply timed from a turn the script never reached starts now.
    sim.startTurn(Number.MAX_SAFE_INTEGER);
    // Replies of simulated agents still running arrive as notices, as in a
    // call: wait for each by its own delay. A reply or its announcement that
    // does not finish is a timeout (-1), not a quiet end.
    while (sim.timers.size && Date.now() < sim.lastDue + 5000) { alive(); await sleep(200); }
    if (sim.timers.size) record.timeouts.push(-1);
    // A notice is answered by a response created after it.
    // Every notice must be announced by a response requested for it, with
    // audio that was played (kept after any cut and already started): silence,
    // a tool-only response, an unrelated answer, audio still queued or cut
    // before it sounded do not count, and one notice never covers another.
    const played = (response: string) => voiceTrack.some(p => p.response === response && p.audio.length && p.at < clock());
    const announced = (notice: number) => [...coverage].some(([response, notices]) => notices.includes(notice) && played(response));
    // Every notice given to be announced must be heard; quiet and superseded ones are not owed.
    const owed = () => record.notices.filter(n => n.delivered && !n.quiet);
    const allAnnounced = () => !undelivered.length && owed().every(n => n.index !== undefined && announced(n.index));
    if (record.notices.some(n => !n.superseded) && !(await settle(options.turnTimeoutMs ?? 90_000, allAnnounced, Infinity))) record.timeouts.push(-1);
    await sleep(500);
    alive();

    // A spoken answer can finish before recognition does. Keep the last committed
    // items alive so a late transcription failure cannot become a passing run.
    const transcriptionDeadline = clock() + (options.transcriptionTimeoutMs ?? 10_000);
    while (call.pendingItems.size && clock() < transcriptionDeadline) { alive(); await sleep(50); }
    alive();
    if (call.pendingItems.size) throw new Error('Committed user transcription did not finish before the deadline.');
    pumping = false; await pump;
    record.usage = { ...call.usage };
    realtime.close(call.id, 'end of the evaluation');
    record.durationMs = clock();
    finishCut();
    // Latency runs to the first sample of the turn's answer that really played:
    // audio queued and then cut before it sounded does not count.
    for (const t of record.turns) {
      const first = voiceTrack.filter(p => p.audio.length && p.at < record.durationMs && !coverage.has(p.response) && ownTurn(p.response) === t.index).sort((a, b) => a.at - b.at)[0];
      const item = first ? responseItem.get(first.response) : undefined, end = (item ? itemStop.get(item) : undefined) ?? stopped.get(t.index);
      t.firstAnswerMs = first ? Math.round(first.at) : null;
      t.latencyMs = end != null && first ? Math.round(first.at - end) : null;
    }
    // Audio still generated after the cut was dropped, so the generated total
    // is what the item had when it was cut.
    for (const line of record.transcript) {
      const cut = line.item && interrupted.get(line.item); if (cut) line.cut = cut;
      // An announcement the engine asked for is not the answer to the user's turn.
      if (line.role === 'assistant' && line.response && coverage.has(line.response)) line.notice = true;
      // A spoken answer belongs where the user started hearing it, not where
      // its text arrived; one with audio of which nothing played was not heard.
      const own = line.role === 'assistant' && line.item ? voiceTrack.filter(p => p.item === line.item) : [];
      const first = own.find(p => p.audio.length && p.at < record.durationMs);
      if (first) line.ms = Math.round(first.at);
      // A transcript of audio of which no sample played (even if every delta was dropped) was not heard.
      else if (line.role === 'assistant' && line.item) line.unheard = true;
    }
    // A send belongs to the turn of the function call that made it; its
    // request ID ends with that call ID. Delivery time is kept apart.
    record.sends = sim.sends.map(s => ({ ms: s.at - t0, turn: requestTurn.get(s.requestId) ?? turnAt(record, s.at - t0), projectKey: s.projectKey, threadKey: s.threadKey, message: s.message, ...(s.uncertain ? { uncertain: true, arrival: s.arrival, projectId: s.projectId } : {}) }));
    record.audio = stereo(mic, micStart, voiceTrack, record.durationMs);
    return record;
  } finally {
    for (const cleanup of cleanups) cleanup();
    pumping = false; await pump.catch(() => {});
    realtime.shutdown();
    sim.close();
  }
}

// The user turn in progress at a moment of the call (0 before the first).
function turnAt(record: RunRecord, ms: number) {
  let current = 0;
  for (const t of record.turns) if (t.startMs <= ms) current = t.index;
  return current;
}

// Left: what the synthetic user said; right: what the voice said, as played.
function stereo(mic: Buffer[], micStart: number, voice: { at: number; audio: Buffer }[], durationMs: number) {
  const samples = Math.ceil(durationMs * RATE / 1000);
  const left = Buffer.concat([Buffer.alloc((Math.round(micStart * BYTES_PER_MS) & ~1)), ...mic]), right = Buffer.alloc(samples * 2);
  for (const part of voice) { const at = Math.round(part.at * BYTES_PER_MS) & ~1; if (at < right.length) part.audio.copy(right, at, 0, Math.min(part.audio.length, right.length - at)); }
  const out = Buffer.alloc(samples * 4);
  for (let i = 0; i < samples; i++) {
    if (i * 2 + 1 < left.length) out.writeInt16LE(left.readInt16LE(i * 2), i * 4);
    out.writeInt16LE(right.readInt16LE(i * 2), i * 4 + 2);
  }
  return out;
}
