import type { Publish, LiveResponse } from '../shared/contracts.mjs';
import type { VoiceContext } from './types.mjs';
import type { DeliveredThread, DirectAde } from '../direct/contract.mjs';
import { StatusError } from '../shared/contracts.mjs';
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { noticeBody, noticeHeader, USER_QUIET_MS, type ThreadNotice } from '../conversation/thread-watch.mjs';
import { DirectSession, requestIdFor, toolFailure, type ToolRun } from '../direct/session.mjs';
import { callLanguage, directInstructions, languageReminder } from '../direct/prompt.mjs';
import { redact } from '../direct/text.mjs';
import { toolDetails } from '../conversation/tool-details.mjs';
import { voiceNoteText } from '../resources.mjs';
import { audioDiagnostics } from './diagnostics.mjs';
import { isHintEcho } from '../conversation/hint-echo.mjs';

// Gemini Live (BidiGenerateContent over WebSocket). Unlike OpenAI Realtime it
// has no WebRTC leg and no sideband: whoever holds the provider socket sees the
// tool calls. So the provider socket stays on this server and the browser's
// audio is relayed through it (a second WebSocket, /api/live/stream): the key
// never leaves the server, and the model's function calls run here, through
// the same DirectSession and send rule as Realtime. The voice model calls the
// ADE tools itself; nothing else sits between it and the tools.
// This engine knows no ADE: it runs whatever DirectAde it is given.

// Live models Settings offers. gemini-3.8-live calls functions synchronously
// when its declarations say BLOCKING; gemini-3.1-flash-live-preview is always
// synchronous. Both take 16 kHz PCM in and give 24 kHz PCM out.
export const GEMINI_MODELS = ['gemini-3.8-live', 'gemini-3.1-flash-live-preview'] as const;
export const isGeminiModel = (model: string) => model.startsWith('gemini-');
// Prebuilt voices of the Live native audio models (a short, varied subset).
export const GEMINI_VOICES = ['Kore', 'Puck', 'Charon', 'Aoede', 'Leda', 'Zephyr', 'Fenrir', 'Orus'] as const;
export const GEMINI_DEFAULTS = { voice: 'Kore' } as const;
export const GEMINI_ENDPOINT = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
// Audio formats on the browser leg: what the page sends and plays.
export const INPUT_RATE = 16_000, OUTPUT_RATE = 24_000;
// Waiting for a transcript lets a tool call see the words that authorize it.
const TRANSCRIPT_WAIT_MS = 2500;
// The provider ends a connection after about ten minutes and announces it
// with goAway; the session continues over a new one with its resumption handle.
const MAX_RESUMES = 12;
// Browser frames: at most one second of 16 kHz mono PCM each.
const MAX_FRAME = INPUT_RATE * 2;
// Pieces of the user's transcript closer than this belong to one utterance,
// whatever the model does in between: Gemini sends input transcription
// independently of the model's output, so a late piece of the same words must
// not become a new turn that authorizes another send.
const UTTERANCE_GAP_MS = 2000;
// Margin before goAway's deadline to resume or end the call.
const GOAWAY_MARGIN_MS = 1000;

export type Socket = { readyState: number; send(data: string | Buffer, options?: { binary?: boolean }): void; close(code?: number, reason?: string): void;
  on(event: string, fn: (...args: never[]) => void): unknown; once(event: string, fn: (...args: never[]) => void): unknown };
// The key goes in a header, never in the URL, so no log or error can quote it.
export const connectGemini = (key: string) => new WebSocket(GEMINI_ENDPOINT, { headers: { 'x-goog-api-key': key }, handshakeTimeout: 15_000, maxPayload: 4 * 1024 * 1024 }) as unknown as Socket;
// Function parameters take Gemini's OpenAPI subset of JSON Schema: a keyword
// outside it (additionalProperties) makes the provider refuse the whole setup.
// Other keywords are dropped; property names are kept as they are.
const SCHEMA_KEYWORDS = new Set(['type', 'format', 'title', 'description', 'nullable', 'enum', 'maxItems', 'minItems', 'properties', 'required', 'minProperties', 'maxProperties',
  'minLength', 'maxLength', 'pattern', 'example', 'anyOf', 'propertyOrdering', 'default', 'items', 'minimum', 'maximum']);
export function geminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(geminiSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!SCHEMA_KEYWORDS.has(key)) continue;
    if (key === 'properties' && value && typeof value === 'object') out[key] = Object.fromEntries(Object.entries(value).map(([name, property]) => [name, geminiSchema(property)]));
    else if (key === 'items' || key === 'anyOf') out[key] = geminiSchema(value);
    else out[key] = value;
  }
  return out;
}
interface FunctionCallPart { id?: string; name?: string; args?: Record<string, unknown> }
interface ServerMessage {
  setupComplete?: object;
  serverContent?: {
    modelTurn?: { parts?: { inlineData?: { data?: string; mimeType?: string }; text?: string; thought?: boolean }[] };
    inputTranscription?: { text?: string }; outputTranscription?: { text?: string };
    interrupted?: boolean; turnComplete?: boolean; generationComplete?: boolean; interactionStatus?: string;
  };
  toolCall?: { functionCalls?: FunctionCallPart[] };
  toolCallCancellation?: { ids?: string[] };
  goAway?: { timeLeft?: string };
  sessionResumptionUpdate?: { newHandle?: string; resumable?: boolean };
  voiceActivity?: { type?: string };
  usageMetadata?: Record<string, unknown>;
}
// A conversation item whose text streams in: the Message the send rule reads
// is updated as each piece arrives, and published when the item ends.
interface OpenItem { id: string; text: string; message: { text: string }; at: number; timer?: NodeJS.Timeout }
// The utterance a send used. Every transcript piece that arrives while it is
// held joins it, so a late piece of the same words is never a new turn. It is
// released only at a clear boundary: the model has answered the send and
// completed a turn, and the user has paused since; or the user starts speaking
// again (the provider interrupts the model).
interface Held {
  callId: string; message: { text: string }; base: string; late: string; lastAt: number;
  item?: OpenItem; timer?: NodeJS.Timeout;
  // responded: its result was written to the provider; spoke: the model said
  // something after that; completed: then it finished that turn.
  responded?: boolean; spoke?: boolean; completed?: boolean;
}
export interface GeminiCall {
  id: string; backend?: string; conversationId?: string; seen: number; closed: boolean; closing?: boolean;
  // ready: the current upstream confirmed its setup; audio and messages wait for it.
  upstream?: Socket; browser?: Socket; ready?: boolean; resumes: number; reconnecting?: boolean;
  // The latest resumption handle, and whether the provider said the session can
  // be resumed at this point (not while it runs function calls or generates).
  handle?: string; resumable?: boolean; goAway?: NodeJS.Timeout;
  // Function results by call ID: answered again if the provider repeats the ID.
  results: Map<string, { name?: string; output: string }>;
  // The connection that last asked for each call ID still running: its result
  // goes as a function response only to that connection, if still current.
  requested: Map<string, Socket | undefined>;
  direct?: DirectSession; items: number; user?: OpenItem; assistant?: OpenItem; held?: Held; order: Map<string, number>;
  greeted?: boolean; responding?: boolean; userSpeaking?: boolean; lastUserAt?: number;
  // The connection that cancelled each call ID: a cancellation counts only
  // while that connection is still the one waiting for the call.
  toolsPending: Set<string>; cancelled: Map<string, Socket | undefined>;
  // callId: the note carries the result of that function call.
  queue: { text: string; speak: boolean; reply?: boolean; callId?: string }[]; flushTimer?: NodeJS.Timeout;
  usage: Record<string, number>; diagnosticsAt?: number; setup: Record<string, unknown>;
  // The recognition hints the transcription was given (isHintEcho).
  hints: string[];
}
export interface GeminiSettings { model?: string; voice?: string }
export interface GeminiOptions {
  key?: string; ade: DirectAde; context: VoiceContext; publish: Publish; store: { meta(key: string, value?: unknown): unknown };
  settings?: GeminiSettings;
  // Opens the provider socket; tests pass a fake.
  connect?: (key: string) => Socket;
  // Tests shorten the pause that separates two utterances.
  utteranceGapMs?: number;
  delivered?: (thread: DeliveredThread, conversationId?: string) => void; read?: (threadId: string) => void;
}

export class GeminiCalls {
  readonly provider = 'gemini';
  key: string | undefined; ade: DirectAde; publish: Publish; store: GeminiOptions['store']; context: VoiceContext;
  model!: string; voice!: string;
  sessions = new Map<string, GeminiCall>(); creating = false; stopping = false; running = 0;
  connect: (key: string) => Socket; timer: NodeJS.Timeout; gap: number;
  delivered?: GeminiOptions['delivered']; read?: GeminiOptions['read'];
  constructor({ key, ade, publish, store, context, settings = {}, connect, delivered, read, utteranceGapMs = UTTERANCE_GAP_MS }: GeminiOptions) {
    this.key = key; this.ade = ade; this.publish = publish; this.store = store; this.context = context; this.gap = utteranceGapMs;
    this.delivered = delivered; this.read = read;
    this.apply(settings);
    this.connect = connect || connectGemini;
    this.timer = setInterval(() => {
      for (const [id, call] of this.sessions) if (Date.now() - call.seen > 45_000) this.close(id, `The connection with the phone was lost. Requests keep running in ${this.ade.name}.`);
    }, 10_000).unref();
  }
  apply(settings: GeminiSettings) {
    const model = settings.model && isGeminiModel(settings.model) ? settings.model : GEMINI_MODELS[0];
    this.model = model; this.voice = settings.voice || GEMINI_DEFAULTS.voice;
  }
  get busy() { return this.creating || this.sessions.size > 0; }
  get working() { return this.running > 0; }
  configure({ settings, key }: { settings?: GeminiSettings; key?: string | null }) {
    if (this.busy) throw new Error('End the call before changing the voice settings.');
    if (settings) this.apply(settings);
    if (key !== undefined) this.key = key || undefined;
  }
  // The setup message: instructions, the ADE's tools and audio in both
  // directions with transcripts. The language is not set: native audio models
  // follow the instructions and the user.
  setup(language?: ReturnType<typeof callLanguage>) {
    const blocking = this.model.startsWith('gemini-3.8');
    const vocabulary = this.hints(blocking);
    return {
      model: `models/${this.model}`,
      generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: this.voice } } } },
      systemInstruction: { parts: [{ text: directInstructions(this.ade, { callStart: this.context.timing?.(), capabilities: { backend: this.context.backend, capabilities: this.context.capabilities }, language }) }] },
      // BLOCKING: the model waits for each result before it speaks about it,
      // as with Realtime. 3.1 is synchronous already and takes no behavior.
      tools: [{ functionDeclarations: this.ade.tools.map(({ name, description, parameters }) => ({ name, description, parameters: geminiSchema(parameters), ...(blocking ? { behavior: 'BLOCKING' } : {}) })) }],
      inputAudioTranscription: blocking && vocabulary.length ? { customVocabulary: vocabulary } : {},
      outputAudioTranscription: {},
      // History and catalog go first as client content; they never trigger a reply.
      historyConfig: { initialHistoryInClientContent: true },
      contextWindowCompression: { slidingWindow: {} },
      sessionResumption: {}
    };
  }
  // The names given to transcription as custom vocabulary (3.8 only).
  hints(blocking = this.model.startsWith('gemini-3.8')) { return blocking ? this.context.vocabulary().slice(0, 100) : []; }
  // Creates the provider session and returns where the browser streams audio.
  // The call is ready for audio when this answers.
  async create({ languages = [], language }: { languages?: string[]; language?: string } = {}): Promise<LiveResponse> {
    if (!this.key) throw new StatusError(503, 'The Gemini key is missing on the server.');
    if (this.creating || this.sessions.size) throw new StatusError(409, 'There is already a call active or connecting.');
    if (this.stopping) throw new StatusError(503, 'The service is stopping.');
    const id = `gem_${randomUUID()}`, spoken = callLanguage(language, languages);
    // Built before the engine counts as busy: a failure here leaves nothing behind.
    const call: GeminiCall = { id, backend: this.context.snapshot?.backend, conversationId: this.context.conversation?.().id, seen: Date.now(), closed: false,
      resumes: 0, items: 0, order: new Map(), toolsPending: new Set(), cancelled: new Map(), results: new Map(), requested: new Map(), queue: [], usage: {}, setup: this.setup(spoken), hints: [] };
    call.hints = ((call.setup.inputAudioTranscription as { customVocabulary?: string[] }).customVocabulary) || [];
    this.creating = true;
    this.sessions.set(id, call);
    try {
      const direct = call.direct = new DirectSession(this.ade);
      try { this.ade.prefetch?.(); } catch { /* Only a later cache miss. */ }
      // The catalog is part of the initial history; an ADE answers it within seconds.
      const catalog = Promise.resolve(direct.catalog()).catch(() => '');
      await this.open(call);
      if (call.closed || this.stopping) throw new StatusError(503, 'The call ended while it was connecting.');
      const history = [this.context.resume({ languages, language }), await catalog].filter(Boolean);
      if (call.closed) throw new StatusError(503, 'The call ended while it was connecting.');
      this.send(call, { clientContent: { turns: history.map(text => ({ role: 'user', parts: [{ text: voiceNoteText('note', { text }) }] })), turnComplete: true } });
      this.publish('voice', { status: 'connected', id, provider: 'gemini', backend: call.backend, conversationId: call.conversationId, ...(spoken ? { language: spoken.tag, languageSource: spoken.source } : {}) });
      return { session: { id }, transport: { stream: `/api/live/stream?id=${encodeURIComponent(id)}` } };
    } catch (error) {
      if (!call.closed) { call.closing = true; this.finish(call); call.upstream?.close(); }
      this.sessions.delete(id);
      throw error;
    } finally { this.creating = false; }
  }
  // Opens a provider connection and sends the setup, resuming the session when
  // a handle is known. Resolves on setupComplete.
  open(call: GeminiCall) {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (message: string) => { if (!settled) { settled = true; reject(new StatusError(502, message)); } };
      // Nothing goes to a new socket until it confirms the setup.
      call.ready = false;
      const resuming = !!call.handle;
      const socket = call.upstream = this.connect(this.key!);
      const timeout = setTimeout(() => { fail('Gemini Live did not confirm the session.'); socket.close(); }, 20_000);
      timeout.unref?.();
      socket.once('open', () => {
        socket.send(JSON.stringify({ setup: { ...call.setup, ...(call.handle ? { sessionResumption: { handle: call.handle } } : {}) } }));
      });
      socket.on('error', () => fail('Gemini Live could not be connected.'));
      socket.on('message', (raw: Buffer) => {
        let message: ServerMessage;
        try { message = JSON.parse(raw.toString()); } catch { return; }
        if (message.setupComplete && !settled) {
          settled = true; clearTimeout(timeout);
          // The handle just used belongs to the old connection: this one must
          // report its own checkpoint (possibly in the next message) before it
          // can be resumed in turn.
          if (call.upstream === socket) { call.ready = true; if (resuming) call.resumable = false; }
          resolve(); return;
        }
        if (call.upstream !== socket) return;
        try { this.event(call, message); }
        catch { this.publish('notice', { text: 'A voice event could not be processed. No action will be repeated.' }); }
      });
      socket.on('close', (code: number, reason: Buffer) => {
        clearTimeout(timeout);
        // The provider explains a refused setup (model, key, field) in the close reason.
        fail(`Gemini Live closed the session (${code}${reason?.length ? `: ${redact(reason.toString()).slice(0, 300)}` : ''}, ${this.model}).`);
        if (call.upstream === socket) this.lost(call);
      });
    });
  }
  // Resuming restores the provider's state at its latest checkpoint; one taken
  // while it ran a function or generated would roll the conversation back, so
  // only a session the provider called resumable continues.
  canResume(call: GeminiCall) { return !!call.handle && !!call.resumable && call.resumes < MAX_RESUMES && !this.stopping; }
  // The provider connection ended: resume the session over a new one, or end the call.
  lost(call: GeminiCall, reason = 'The provider\'s connection closed.') {
    call.ready = false;
    if (call.closed || call.closing || call.reconnecting) return;
    if (this.canResume(call)) { void this.resume(call); return; }
    this.disconnect(call, reason);
  }
  // Ends a call the provider can no longer carry. ADE work already sent keeps running.
  disconnect(call: GeminiCall, reason: string) {
    if (call.closed) return;
    this.finish(call); this.sessions.delete(call.id);
    this.publish('voice', { status: 'disconnected', reason, id: call.id, provider: 'gemini', backend: call.backend, conversationId: call.conversationId });
    try { call.upstream?.close(1000); } catch { /* Already closed. */ }
    call.browser?.close(1000, 'provider_closed');
  }
  // goAway: the connection ends after timeLeft. Resume at the first resumable
  // checkpoint; with none by the deadline, end the call instead of resuming an
  // older state or starting a session without the conversation.
  goAway(call: GeminiCall, timeLeft?: string) {
    if (call.goAway || call.reconnecting) return;
    if (this.canResume(call)) { void this.resume(call); return; }
    const seconds = Number.parseFloat(timeLeft || '');
    const ms = Math.max(0, (Number.isFinite(seconds) ? seconds * 1000 : 5000) - GOAWAY_MARGIN_MS);
    call.goAway = setTimeout(() => {
      call.goAway = undefined;
      if (this.canResume(call)) void this.resume(call);
      else this.disconnect(call, 'The provider ended the session before it could be resumed.');
    }, ms);
    call.goAway.unref?.();
  }
  // Audio the page sends meanwhile is dropped; a failed attempt counts and
  // retries while resumptions are left.
  async resume(call: GeminiCall) {
    if (call.reconnecting || call.closed || call.closing) return;
    clearTimeout(call.goAway); call.goAway = undefined;
    call.reconnecting = true; call.resumes++;
    const previous = call.upstream;
    let resumed = false;
    try { await this.open(call); resumed = true; } catch { /* Retried or ended below. */ } finally { call.reconnecting = false; }
    if (previous && previous !== call.upstream) try { previous.close(); } catch { /* Already closed. */ }
    if (call.closed || call.closing) { call.upstream?.close(); return; }
    if (resumed) this.flush(call); else this.lost(call);
  }
  // The page's audio socket for a call this server created (see server.mts,
  // which checks authentication, origin and the call's owner first).
  attach(id: string, browser: Socket) {
    const call = this.sessions.get(id);
    if (!call || call.closed || call.browser) { browser.close(1008, 'no_call'); return false; }
    call.browser = browser; call.seen = Date.now();
    // A failure handling one frame drops that frame; it never reaches the process.
    browser.on('message', (data: Buffer, binary: boolean) => {
      try { this.fromBrowser(call, data, binary); } catch { /* Dropped. */ }
    });
    browser.on('close', () => { if (call.browser === browser && !call.closed) this.close(id, 'The connection with the phone was lost.'); });
    browser.on('error', () => {});
    this.toBrowser(call, { type: 'session.started', inputRate: INPUT_RATE, outputRate: OUTPUT_RATE });
    return true;
  }
  fromBrowser(call: GeminiCall, data: Buffer, binary: boolean) {
    if (call.closed) return;
    call.seen = Date.now();
    if (binary) {
      if (!call.ready || data.length > MAX_FRAME || data.length % 2) return;
      this.send(call, { realtimeInput: { audio: { data: data.toString('base64'), mimeType: `audio/pcm;rate=${INPUT_RATE}` } } });
      return;
    }
    let message: { type?: string };
    try { message = JSON.parse(data.toString()); } catch { return; }
    // Muting stops the audio: the provider flushes what it has cached.
    if (message?.type === 'audio.end') this.send(call, { realtimeInput: { audioStreamEnd: true } });
  }
  event(call: GeminiCall, message: ServerMessage) {
    if (call.closed) return;
    for (const [key, value] of Object.entries(message.usageMetadata || {})) if (typeof value === 'number') call.usage[key] = (call.usage[key] || 0) + value;
    if (message.voiceActivity?.type === 'ACTIVITY_START') { call.userSpeaking = true; call.greeted = true; this.release(call); }
    if (message.voiceActivity?.type === 'ACTIVITY_END') { call.userSpeaking = false; call.lastUserAt = Date.now(); this.later(call); }
    const update = message.sessionResumptionUpdate;
    if (update) {
      call.resumable = !!update.resumable && !!update.newHandle;
      if (call.resumable) call.handle = update.newHandle;
      // A goAway waiting for a checkpoint resumes at the first one.
      if (call.goAway && call.resumable) void this.resume(call);
    }
    if (message.goAway) this.goAway(call, message.goAway.timeLeft);
    const content = message.serverContent;
    if (content) {
      // The user speaking again ends the utterance a send used.
      if (content.interrupted) this.release(call);
      if (content.inputTranscription?.text) this.heard(call, content.inputTranscription.text);
      for (const part of content.modelTurn?.parts || []) {
        const audio = part.inlineData;
        if (audio?.data && audio.mimeType?.startsWith('audio/pcm')) {
          call.responding = true; call.greeted = true;
          if (call.held?.responded) call.held.spoke = true;
          this.toBrowser(call, Buffer.from(audio.data, 'base64'));
        }
      }
      if (content.outputTranscription?.text) {
        call.responding = true; call.greeted = true;
        if (call.held?.responded) call.held.spoke = true;
        this.said(call, content.outputTranscription.text);
      }
      if (content.interrupted) { this.toBrowser(call, { type: 'interrupted' }); this.end(call, 'assistant'); call.responding = false; }
      if (content.turnComplete) {
        this.end(call, 'assistant');
        // The model answered the send and finished that answer: a boundary, once the user pauses.
        if (call.held?.responded && call.held.spoke) { call.held.completed = true; this.releaseLater(call); }
        if (content.interactionStatus !== 'IN_PROGRESS') call.responding = false;
        this.toBrowser(call, { type: 'turn.done' });
        clearTimeout(call.flushTimer); call.flushTimer = undefined; this.later(call, this.replies(call) ? 50 : 300);
      }
    }
    if (message.toolCall?.functionCalls?.length) {
      // What was said so far precedes the call in the conversation.
      this.end(call, 'assistant');
      // A call ID never runs twice. One already answered gets the same result
      // again; one still running is answered, when it ends, to the connection
      // that asked last.
      // An ID repeated within the same message counts once.
      const functionCalls = message.toolCall.functionCalls.filter((fc, index, all) => fc.id && all.findIndex(other => other.id === fc.id) === index);
      const answered = functionCalls.filter(fc => call.results.has(fc.id!));
      if (answered.length) this.answer(call, answered.map(fc => ({ id: fc.id!, name: call.results.get(fc.id!)!.name, response: { output: call.results.get(fc.id!)!.output } })));
      for (const fc of functionCalls) if (call.requested.has(fc.id!)) call.requested.set(fc.id!, call.upstream);
      const calls = functionCalls.filter(fc => !call.results.has(fc.id!) && !call.requested.has(fc.id!) && !call.direct?.toolIds.has(fc.id!));
      for (const fc of calls) { call.toolsPending.add(fc.id!); call.requested.set(fc.id!, call.upstream); this.slot(call, `fn:${fc.id}`); }
      if (calls.length) void this.tools(call, calls);
    }
    for (const id of message.toolCallCancellation?.ids || []) call.cancelled.set(id, call.upstream);
  }
  // A piece of the user's transcript. The send rule reads it as it arrives:
  // a yes is a user turn as soon as its first words are transcribed. Pieces
  // join one utterance until a pause of the user, never because the model
  // spoke or finished in between; the utterance is published after that pause.
  heard(call: GeminiCall, text: string) {
    const now = Date.now();
    call.lastUserAt = now; call.greeted = true;
    if (call.assistant) this.end(call, 'assistant');
    const held = call.held;
    if (held) {
      held.lastAt = now;
      if (held.item && call.user === held.item) { held.item.text += text; held.item.message.text = held.item.text.trim(); held.item.at = now; }
      else { held.late += text; held.message.text = `${held.base} ${held.late.trim()}`.trim(); }
      if (held.completed) this.releaseLater(call);
      return;
    }
    if (call.user && now - call.user.at >= this.gap) this.end(call, 'user');
    if (!call.user) {
      const id = `u${++call.items}`;
      this.slot(call, id);
      call.user = { id, text: '', message: call.direct?.place(id, 'user') || { text: '' }, at: now };
    }
    const user = call.user;
    user.text += text; user.message.text = user.text.trim(); user.at = now;
    // A recital of the recognition hints is shown, never a user turn; it is
    // judged on the whole utterance so far, as its text grows.
    if (call.direct) {
      const echoes = call.direct.echoes as WeakSet<object>;
      if (isHintEcho(user.message.text, call.hints)) echoes.add(user.message); else echoes.delete(user.message);
    }
    clearTimeout(user.timer);
    user.timer = setTimeout(() => { if (call.user === user) this.end(call, 'user'); }, this.gap);
    user.timer.unref?.();
  }
  said(call: GeminiCall, text: string) {
    if (!call.assistant) {
      const id = `a${++call.items}`;
      this.slot(call, id);
      call.assistant = { id, text: '', message: call.direct?.place(id, 'assistant') || { text: '' }, at: Date.now() };
    }
    call.assistant.text += text; call.assistant.message.text = call.assistant.text.trim();
  }
  // Ends an open item: kept with its full text, or dropped when it has none.
  end(call: GeminiCall, role: 'user' | 'assistant') {
    const item = call[role];
    if (!item) return;
    call[role] = undefined; clearTimeout(item.timer);
    const text = item.text.trim();
    if (!text) { call.direct?.forget(item.id); return; }
    const echo = role === 'user' && isHintEcho(text, call.hints);
    call.direct?.fill(item.id, role, text, { echo });
    this.publish('transcript', { call: call.id, role, text, order: this.slot(call, item.id), item: item.id, backend: call.backend, conversationId: call.conversationId, ...(echo ? { echo: true } : {}) });
  }
  // A send is about to use the latest user utterance: hold it (see Held).
  hold(call: GeminiCall, callId: string) {
    const direct = call.direct;
    if (!direct || call.held) return;
    const item = call.user;
    const message = item?.message || direct.history.filter(m => m.role === 'user' && m.text).at(-1);
    if (!message) return;
    if (item) clearTimeout(item.timer);
    call.held = { callId, message, base: message.text, late: '', lastAt: item?.at || Date.now(), item };
  }
  releaseLater(call: GeminiCall) {
    const held = call.held;
    if (!held) return;
    clearTimeout(held.timer);
    held.timer = setTimeout(() => { if (call.held === held) this.release(call); }, Math.max(0, this.gap - (Date.now() - held.lastAt)));
    held.timer.unref?.();
  }
  release(call: GeminiCall) {
    const held = call.held;
    if (!held) return;
    call.held = undefined; clearTimeout(held.timer);
    if (held.item && call.user === held.item) { this.end(call, 'user'); return; }
    // Late words of an utterance already in the panel are shown on their own;
    // for the send rule they stay part of the utterance the send used.
    const late = held.late.trim();
    if (late) this.publish('transcript', { call: call.id, role: 'user', text: late, order: this.slot(call), item: `late:${held.callId}`, backend: call.backend, conversationId: call.conversationId });
  }
  slot(call: GeminiCall, key = `anon:${call.order.size}`) {
    let n = call.order.get(key);
    if (n === undefined) { n = call.order.size + 1; call.order.set(key, n); }
    return n;
  }
  // The functions of one tool call run together; the provider gets their
  // results in one response, as the synchronous models expect.
  async tools(call: GeminiCall, calls: FunctionCallPart[]) {
    const results = await Promise.all(calls.map(fc => this.tool(call, fc).catch(() => {
      const failure = toolFailure(this.ade, fc.name);
      return { callId: fc.id || '', name: fc.name || '', output: failure.output, status: failure.status } as Pick<ToolRun, 'callId' | 'name' | 'output' | 'status'>;
    })));
    const responses = [];
    for (const [index, run] of results.entries()) {
      const fc = calls[index];
      if (!fc.id) continue;
      call.toolsPending.delete(fc.id);
      // A renewed connection that did not ask for this call does not wait for it.
      const sendable = call.requested.get(fc.id) === call.upstream && this.sendable(call);
      const cancelled = this.isCancelled(call, fc.id);
      call.requested.delete(fc.id);
      // Abandoned before it started (cancelled, or the call ended): nothing ran,
      // and a repeat of the ID gets this outcome instead of waiting forever.
      if (!run) {
        const output = voiceNoteText('abandoned');
        call.results.set(fc.id, { name: fc.name, output });
        if (sendable && !cancelled) responses.push({ id: fc.id, name: fc.name, response: { output } });
        continue;
      }
      call.results.set(fc.id, { name: fc.name, output: run.output });
      // A send that ran, or may have, is told to the model even when its call
      // was dropped; reads are not.
      const tool = this.ade.tools.find(t => t.name === fc.name);
      const told = tool?.sends && (run.status === 'completed' || run.status === 'unknown');
      if (cancelled || !sendable) {
        if (told) this.system(call, voiceNoteText(cancelled ? 'cancelled' : 'reconnected', { tool: run.name, output: run.output }), true, true, fc.id);
        // Nothing reaches the model for this call: its utterance stays held until the user speaks again.
        continue;
      }
      responses.push({ id: fc.id, name: fc.name, response: { output: run.output } });
    }
    if (call.closed || call.closing) return;
    if (responses.length) this.answer(call, responses);
    this.flush(call);
  }
  // Writes function responses. A held utterance whose result is among them is
  // answered now, and a note still queued with the same result is dropped.
  answer(call: GeminiCall, responses: { id: string; name?: string; response: { output: string } }[]) {
    if (!this.sendable(call)) return;
    this.send(call, { toolResponse: { functionResponses: responses } });
    const ids = new Set(responses.map(response => response.id));
    call.queue = call.queue.filter(item => !item.callId || !ids.has(item.callId));
    if (call.held && ids.has(call.held.callId)) call.held.responded = true;
  }
  // Cancelled for the connection that is waiting for it now; a renewed
  // connection that asked for the call again still wants it.
  isCancelled(call: GeminiCall, id: string) {
    return call.cancelled.has(id) && call.cancelled.get(id) === call.requested.get(id);
  }
  async tool(call: GeminiCall, fc: FunctionCallPart) {
    const direct = call.direct;
    if (!direct || !fc.id) return null;
    this.running++;
    let run;
    const before = direct.submittedThrough;
    try {
      run = await direct.run({ name: fc.name, call_id: fc.id, arguments: JSON.stringify(fc.args ?? {}) }, {
        requestId: requestIdFor('voice', call.id, fc.id), signal: AbortSignal.timeout(90_000),
        // The transcript of a yes can arrive after the call it authorizes.
        // A call the provider cancelled meanwhile is abandoned: nothing is sent.
        beforeSend: async () => {
          const cancelled = () => this.isCancelled(call, fc.id!);
          for (let waited = 0; direct.sendRefusal() && waited < TRANSCRIPT_WAIT_MS && !call.closed && !cancelled(); waited += 100) await new Promise(resolve => setTimeout(resolve, 100));
          const go = !call.closed && !call.closing && !cancelled() && this.isCurrent(call);
          // The send uses the utterance now, before it runs: hold it from this moment.
          if (go && !direct.sendRefusal()) this.hold(call, fc.id!);
          return go;
        } });
    } finally {
      this.running--;
      // Nothing was used after all (refused, or failed before dispatch): no hold.
      // Only this execution owns its hold; a repeat of the ID never runs here.
      if (run && call.held?.callId === fc.id && direct.submittedThrough === before) this.release(call);
    }
    if (!run) return null;
    if (run.delivered) this.delivered?.(run.delivered, call.conversationId);
    if (run.read) this.read?.(run.read);
    this.publish('voice-tool', { id: call.id, callId: run.callId, name: run.name, ok: run.status === 'completed', status: run.status, order: this.slot(call, `fn:${run.callId}`), backend: call.backend, conversationId: call.conversationId,
      ...toolDetails({ args: run.args, result: run.output, ...(run.delivered ? { delivered: run.delivered } : {}) }, [this.key]) as Record<string, unknown> });
    return run;
  }
  // A note enters as client content. Silent notes wait for later input; a note
  // to speak completes the turn, which would cut the model off, so it waits for
  // the model to be idle and the user quiet.
  // reply: it answers what the user just asked, so it does not wait for a quiet moment.
  // callId: the note carries that function call's result.
  system(call: GeminiCall, text: string, speak = false, reply = false, callId?: string) {
    if (!speak) { this.send(call, { clientContent: { turns: [{ role: 'user', parts: [{ text: voiceNoteText('note', { text }) }] }], turnComplete: false } }); return; }
    call.queue.push({ text, speak, reply, callId }); this.flush(call);
  }
  idle(call: GeminiCall, reply = false) {
    return !call.toolsPending.size && !call.responding && !call.userSpeaking && (reply || Date.now() - (call.lastUserAt || 0) >= USER_QUIET_MS);
  }
  replies(call: GeminiCall) { return call.queue.every(item => !item.speak || item.reply); }
  flush(call: GeminiCall) {
    // Nothing leaves the queue unless it can be written now (a closing socket keeps it for the next one).
    if (call.closed || call.closing || !this.sendable(call) || !call.queue.length) return;
    const reply = this.replies(call);
    if (!this.idle(call, reply)) return this.later(call, reply ? 100 : 500);
    const items = call.queue.splice(0);
    const speak = items.some(item => item.speak);
    const texts = items.map(item => item.text).filter(Boolean);
    // Right after English data, so the reply keeps the user's language and accent.
    if (speak) texts.push(languageReminder());
    if (speak) call.responding = true;
    const written = this.sendable(call);
    this.send(call, { clientContent: { turns: texts.map(text => ({ role: 'user', parts: [{ text: voiceNoteText('note', { text }) }] })), turnComplete: speak } });
    // A held utterance counts as answered only once its result was written.
    if (written && call.held && items.some(item => item.callId === call.held!.callId)) call.held.responded = true;
  }
  later(call: GeminiCall, ms = 500) {
    if (call.flushTimer || !call.queue.length) return;
    call.flushTimer = setTimeout(() => { call.flushTimer = undefined; this.flush(call); }, ms);
    call.flushTimer.unref?.();
  }
  sendable(call: GeminiCall) {
    return call.upstream?.readyState === WebSocket.OPEN && !!call.ready && !call.closed && !call.closing && this.isCurrent(call);
  }
  send(call: GeminiCall, message: Record<string, unknown>) {
    if (this.sendable(call)) call.upstream!.send(JSON.stringify(message));
  }
  toBrowser(call: GeminiCall, data: Buffer | Record<string, unknown>) {
    if (call.browser?.readyState !== WebSocket.OPEN) return;
    if (Buffer.isBuffer(data)) call.browser.send(data, { binary: true });
    else call.browser.send(JSON.stringify(data));
  }
  // A conversation that cannot be read is not current: nothing is sent.
  isCurrent(call: GeminiCall) {
    try { return !call.conversationId || !this.context?.conversation || call.conversationId === this.context.conversation().id; }
    catch { return false; }
  }
  speakable(call: GeminiCall) {
    // A socket that is closing cannot take the notice: the watch keeps it for the next call.
    return !call.closed && !call.closing && !!call.greeted && this.sendable(call) && this.idle(call);
  }
  ready(id: string) {
    const call = this.sessions.get(id);
    if (!call || call.greeted || call.closed || call.closing) return;
    call.greeted = true;
    this.system(call, voiceNoteText('greeting'), true);
  }
  threadNotice(notice: ThreadNotice) {
    let sent = false;
    for (const call of this.sessions.values()) {
      if (notice.conversationId && call.conversationId && notice.conversationId !== call.conversationId) continue;
      if (!this.speakable(call)) continue;
      const body = noticeBody(notice, notice.kind === 'progress' ? 400 : 2000);
      this.system(call, noticeHeader(notice) + (body ? `\n${voiceNoteText('agentMessage', { body })}` : ''), !notice.quiet);
      sent = true;
    }
    return sent;
  }
  diagnostics(id: string, input: unknown, final = false) {
    const call = this.sessions.get(id);
    if (!call || call.closed || !this.isCurrent(call)) return;
    const now = Date.now();
    if (!final && call.diagnosticsAt != null && now - call.diagnosticsAt < 5000) return;
    const metrics = audioDiagnostics(input);
    if (!Object.keys(metrics).length) return;
    call.diagnosticsAt = now;
    this.publish('voice-diagnostic', { id, backend: call.backend, conversationId: call.conversationId, at: now, metrics });
  }
  heartbeat(id: string) { const call = this.sessions.get(id); if (call) call.seen = Date.now(); return !!call; }
  // Barge-in is the provider's VAD; the explicit interrupt only empties the
  // page's playback queue: Gemini Live has no request to cancel a response.
  interrupt(id: string) {
    const call = this.sessions.get(id); if (!call || call.closed) return;
    call.greeted = true; this.toBrowser(call, { type: 'interrupted' });
  }
  finish(call: GeminiCall) {
    // The call ends even if recording it fails: persistence here is best effort.
    try { this.release(call); this.end(call, 'user'); this.end(call, 'assistant'); this.context.rememberClose(); } catch { /* Kept as far as it got. */ }
    call.closed = true; call.queue = []; call.direct = undefined; call.ready = false;
    clearTimeout(call.flushTimer); clearTimeout(call.goAway);
    try { this.store.meta(`usage:${call.id}`, call.usage); } catch { /* Usage is diagnostic only. */ }
  }
  close(id: string, reason = 'the user hung up.') {
    const call = this.sessions.get(id);
    if (!call || call.closed) return;
    call.closing = true; this.finish(call); this.sessions.delete(id);
    this.publish('voice', { status: 'closed', id, reason, provider: 'gemini', backend: call.backend, conversationId: call.conversationId });
    try { call.upstream?.close(1000); } catch { /* Already closed. */ }
    try { call.browser?.close(1000, 'closed'); } catch { /* Already closed. */ }
  }
  shutdown() {
    this.stopping = true; clearInterval(this.timer);
    for (const id of [...this.sessions.keys()]) this.close(id);
  }
}
