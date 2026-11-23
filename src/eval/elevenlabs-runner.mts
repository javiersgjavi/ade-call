import type { Scenario } from './scenario.mjs';
import { EventEmitter } from 'node:events';
import { ElevenLabsCalls, connectElevenLabs, INPUT_RATE, OUTPUT_RATE, type ElevenLabsCall, type ElevenLabsSettings } from '../voice/elevenlabs.mjs';
import type { Socket } from '../voice/gemini.mjs';
import { SimulatedT3 } from './world.mjs';
import { redactEvidence } from './redact.mjs';
import { finalKind } from '../conversation/thread-watch.mjs';
import { timeContext } from '../conversation/time-context.mjs';
import { requestIdFor } from '../direct/session.mjs';
import { BYTES_PER_MS, RATE } from './speech.mjs';
import { evalText } from './judge.mjs';
import { toInputRate } from './gemini-runner.mjs';
import { CHUNK_MS, scenarioAudio, simulatedVocabulary, sleep, speakableText, stereo, turnAt, type RunOptions, type RunRecord } from './runner.mjs';

// Runs one scenario as a closed-loop call against ElevenLabs Agents, as
// gemini-runner.mts does for Gemini Live: the production engine
// (ElevenLabsCalls: agent and tools, overrides, send rule, notes, notices)
// holds the provider socket, and the synthetic user is the page on the other
// side of its audio relay, streaming 16 kHz PCM in real time and playing the
// 24 kHz answer on one playhead. The record has the same shape, so checks,
// judges and reports read it unchanged.
//
// A response is one stretch of agent output: it starts with the first audio
// or text after the previous one ended, and ends at agent_response_complete,
// at an interruption, at a tool call (the answer after the result is a
// response of its own) or when the user's next transcript arrives. It belongs
// to the user turn of the latest transcribed user speech.

export interface ElevenLabsRunOptions extends Omit<RunOptions, 'settings' | 'connect'> {
  settings: ElevenLabsSettings;
  // The agent and tools the evaluations keep in the account (a JSON file's contents).
  agentState?: { get(): unknown; set(value: unknown): void };
  // Tests pass fakes for the REST API and the socket.
  api?: ConstructorParameters<typeof ElevenLabsCalls>[0]['api'];
  connect?: (url: string) => Socket;
}

class Page extends EventEmitter {
  readyState = 1; events: { type?: string }[] = [];
  send(data: string | Buffer, options?: { binary?: boolean }) { if (!options?.binary) try { this.events.push(JSON.parse(String(data))); } catch { /* Not an event. */ } }
  close() { this.readyState = 3; }
}
type ServerEvent = {
  type?: string; audio_event?: { audio_base_64?: string }; agent_response_event?: { agent_response?: string };
  agent_response_correction_event?: { corrected_agent_response?: string };
  client_tool_call?: { tool_call_id?: string }; user_transcription_event?: { user_transcript?: string };
};
type ClientMessage = {
  type?: string; text?: string; tool_call_id?: string; result?: string;
  conversation_config_override?: { agent?: { prompt?: { prompt?: string } }; asr?: { keywords?: string[] } };
};

export async function runElevenLabsScenario(scenario: Scenario, options: ElevenLabsRunOptions): Promise<RunRecord> {
  if (OUTPUT_RATE !== RATE || INPUT_RATE !== 16_000) throw new Error('The recording rate must be the provider\'s output rate, and the microphone 16 kHz.');
  const speakable = speakableText(scenario, options);
  const log = options.log || (() => {});
  const audio = await scenarioAudio(scenario, options);
  const sim = new SimulatedT3(scenario.world);
  const t0 = Date.now(), clock = () => Date.now() - t0;
  const record: RunRecord = { scenario: scenario.id, startedAt: new Date(t0).toISOString(), model: '', transcriptionModel: 'built-in', reasoning: '', eagerness: '', voice: '',
    durationMs: 0, turns: [], transcript: [], tools: [], sends: [], notices: [], bargeIns: 0, timeouts: [], providerErrors: [], usage: {} };
  let turn = 0, committed = 0;
  const turnStarts: number[] = [];
  const turnNow = () => turnStarts.filter(start => start <= clock()).length;
  const responseTurn = new Map<string, number>(), callTurn = new Map<string, number>(), callStart = new Map<string, number>(), requestTurn = new Map<string, number>();
  const calling = new Set<string>(), open = new Set<string>();
  const substantive = (id: string) => calling.has(id) || /[\p{L}\p{N}]/u.test(said.get(id) || '');
  const ownTurn = (responseId?: string) => responseId && responseTurn.has(responseId) ? responseTurn.get(responseId)! : committed;
  const voiceReads: { threadId: string; at: number }[] = [];
  const utteranceTurns: number[] = [];
  let fatal: string | null = null;
  let call: ElevenLabsCall | undefined;

  let noticesGiven = 0, covering: number[] = [];
  let quietLine: RunRecord['notices'][number] | null = null;
  const spokenLines: RunRecord['notices'][number][] = [];
  const coverage = new Map<string, number[]>(), callNotices = new Map<string, number[]>();
  const outputs = new Map<string, string>();
  function outgoing(data: string) {
    let message: ClientMessage;
    try { message = JSON.parse(data); } catch { return; }
    if (message.type === 'conversation_initiation_client_data') {
      const override = message.conversation_config_override;
      record.vocabulary = override?.asr?.keywords ?? [];
      const prompt = override?.agent?.prompt?.prompt || '', catalog = prompt.indexOf('T3 CATALOG ');
      if (catalog >= 0) record.initialCatalog ??= prompt.slice(catalog);
    }
    // A quiet notice is context; one to announce is a message that asks for a reply.
    if ((message.type === 'contextual_update' || message.type === 'user_message') && message.text?.includes('System notice:')) {
      const n = ++noticesGiven, line = quietLine ?? spokenLines.shift();
      if (line) Object.assign(line, { index: n, given: message.text, ms: clock() });
      if (message.type === 'user_message') covering = [...covering, n];
    }
    if (message.type === 'client_tool_result' && message.tool_call_id) {
      const id = message.tool_call_id, full = redactEvidence(String(message.result ?? ''), [options.key]);
      outputs.set(id, full);
      const line = record.tools.find(t => t.callId === id);
      if (line) line.result = full;
      if (callNotices.has(id)) { covering = [...covering, ...callNotices.get(id)!]; callNotices.delete(id); }
    }
  }

  const voiceTrack: { at: number; audio: Buffer; item: string; response: string }[] = [];
  const interrupted = new Map<string, { heardMs: number; totalMs: number }>();
  const cutResponses = new Set<string>(), said = new Map<string, string>();
  let playhead = 0, lastActivity = 0, current: string | null = null, responses = 0;
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
    const id = current = `er${++responses}`;
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
  function incoming(raw: Buffer) {
    let message: ServerEvent;
    try { message = JSON.parse(raw.toString()); } catch { return; }
    const now = clock();
    switch (message.type) {
      case 'tentative_user_transcript': committed = turnNow(); lastActivity = now; return;
      case 'user_transcript':
        // The user spoke: what the agent said before is over.
        end(now); committed = turnNow(); lastActivity = now;
        if (message.user_transcription_event?.user_transcript?.trim()) utteranceTurns.push(turnNow());
        return;
      case 'audio': {
        const data = message.audio_event?.audio_base_64;
        if (!data) return;
        const id = begin(), chunk = Buffer.from(data, 'base64');
        const at = Math.max(now, playhead);
        voiceTrack.push({ at, audio: chunk, item: id, response: id });
        playhead = at + chunk.length / BYTES_PER_MS; lastActivity = now;
        return;
      }
      case 'agent_response': {
        const id = begin(), text = (message.agent_response_event?.agent_response || '').replace(/\[[a-z][a-z ]{0,30}\]\s*/gi, '');
        said.set(id, `${said.get(id) || ''} ${text}`.trim()); lastActivity = now;
        return;
      }
      case 'agent_response_correction': {
        const text = message.agent_response_correction_event?.corrected_agent_response;
        const last = [...said.keys()].at(-1);
        if (text && last) { said.set(last, text); const line = record.transcript.find(l => l.response === last); if (line) line.text = text; }
        return;
      }
      case 'interruption': {
        const response = playhead > now ? cut(now) : null;
        if (response) { cutResponses.add(response); record.bargeIns++; }
        end(now); lastActivity = now;
        return;
      }
      case 'agent_response_complete': end(now); lastActivity = now; return;
      case 'client_tool_call': {
        const id = begin(), owner = ownTurn(id), callId = message.client_tool_call?.tool_call_id;
        calling.add(id);
        if (callId && !callTurn.has(callId)) {
          callTurn.set(callId, owner); callStart.set(callId, now);
          if (call) requestTurn.set(requestIdFor('voice', call.id, callId), owner);
          if (coverage.has(id)) callNotices.set(callId, coverage.get(id)!);
        }
        end(now); lastActivity = now;
        return;
      }
    }
  }

  const eleven: ElevenLabsCalls = new ElevenLabsCalls({
    key: options.key, ade: sim.ade, settings: options.settings, instructions: scenario.instructions, api: options.api, agentName: 'ADE Call (evaluations)',
    store: { meta(key: string, value?: unknown) { if (key !== 'elevenlabs:agent') return undefined; if (value === undefined) return options.agentState?.get(); options.agentState?.set(value); return undefined; } },
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
      if (type === 'transcript' && d.role === 'user' && typeof d.text === 'string') record.transcript.push({ ms: clock(), role: 'user', text: d.text, turn: utteranceTurns.shift() ?? turn });
      if (type === 'voice' && d.status === 'disconnected') fatal ??= `The provider closed the call before the scenario ended (${String(d.reason || '').slice(0, 120)}).`;
      if (type === 'notice') record.providerErrors.push({ code: String(d.text || '').startsWith('ElevenLabs reported') ? 'provider_error' : 'event_not_processed' });
    },
    connect: url => {
      const socket = (options.connect || connectElevenLabs)(url);
      socket.on('message', incoming as never);
      const send = socket.send.bind(socket);
      socket.send = (data: string | Buffer, sendOptions?: { binary?: boolean }) => { if (typeof data === 'string') outgoing(data); send(data, sendOptions); };
      return socket;
    }
  });
  let pumping = false, pump: Promise<void> = Promise.resolve();
  const cleanups: (() => void)[] = [];
  try {
    Object.assign(record, { model: `${eleven.model}:${eleven.llm}`, voice: eleven.voice });
    const undelivered: { notice: Parameters<ElevenLabsCalls['threadNotice']>[0]; line: RunRecord['notices'][number]; runId: string; endedAt: number; quiet?: boolean }[] = [];
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
        const given = eleven.threadNotice({ ...next.notice, ...(quiet ? { quiet: true } : {}) });
        quietLine = null;
        if (!given) { if (!quiet) spokenLines.pop(); break; }
        Object.assign(next.line, { delivered: true, ...(quiet ? { quiet: true } : {}) });
        undelivered.shift();
      }
    }, 250);
    cleanups.push(() => clearInterval(offer));

    const created = await eleven.create(scenario.language ? { language: scenario.language } : {});
    call = eleven.sessions.get(created.session.id);
    if (!call) throw new Error('The ElevenLabs call ended while it was connecting.');
    const live = call, page = new Page();
    if (!eleven.attach(live.id, page as never as Socket)) throw new Error('The ElevenLabs call did not take the audio relay.');
    const alive = () => { if (fatal) throw new Error(fatal); };

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
    const quiet = () => !live.responding && !live.toolsPending.size && !live.queue.length && !eleven.working && clock() >= playhead && clock() - lastActivity > 1200;
    const answered = (owner: number) => [...responseTurn].some(([id, turn]) => turn === owner && substantive(id));
    const settle = async (limit: number, done: () => boolean, noResponseMs = options.noResponseMs ?? 10_000) => {
      const from = clock(), until = from + limit;
      while (clock() < until) {
        alive();
        if (quiet() && (done() || clock() - from >= noResponseMs)) { if (current && clock() >= playhead) end(clock()); if (!open.size) return true; }
        await sleep(100);
      }
      return false;
    };
    const settleTurn = async (settling: number, limit: number, noResponseMs?: number) => {
      if (await settle(limit, () => answered(settling), noResponseMs)) return;
      record.timeouts.push(settling); log(`  ${settling ? `turn ${settling}` : 'greeting'}: the voice did not go quiet in time`);
    };

    await sleep(800);
    eleven.ready(live.id);
    await settleTurn(0, 20_000, 4000);
    const interruptions: { bargeIn: { overVoice: boolean; cut: boolean; preamble?: boolean }; response: string | null }[] = [];
    const finishCut = () => { for (const i of interruptions) { i.bargeIn.cut = !!i.response && cutResponses.has(i.response); if (i.response && calling.has(i.response)) i.bargeIn.preamble = true; } };
    for (const [i, t] of scenario.turns.entries()) {
      if (t.bargeInMs !== undefined && i > 0) {
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
    const played = (response: string) => voiceTrack.some(p => p.response === response && p.audio.length && p.at < clock());
    const announced = (notice: number) => [...coverage].some(([response, notices]) => notices.includes(notice) && played(response));
    const owed = () => record.notices.filter(n => n.delivered && !n.quiet);
    const allAnnounced = () => !undelivered.length && owed().every(n => n.index !== undefined && announced(n.index));
    if (record.notices.some(n => !n.superseded) && !(await settle(options.turnTimeoutMs ?? 90_000, allAnnounced, Infinity))) record.timeouts.push(-1);
    await sleep(1500);
    alive();
    end(clock());
    pumping = false; await pump;
    record.usage = {};
    eleven.close(live.id, 'end of the evaluation');
    record.durationMs = clock();
    finishCut();
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
    eleven.shutdown();
    sim.close();
  }
}
