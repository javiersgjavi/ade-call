import type { Publish, LiveResponse } from '../shared/contracts.mjs';
import type { VoiceContext } from './types.mjs';
import type { DeliveredThread, DirectAde } from '../direct/contract.mjs';
import type { Socket } from './gemini.mjs';
import { StatusError } from '../shared/contracts.mjs';
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { noticeBody, noticeHeader, type ThreadNotice } from '../conversation/thread-watch.mjs';
import { DirectSession, requestIdFor, toolFailure, type ToolRun } from '../direct/session.mjs';
import { callLanguage, directInstructions, type CallLanguage } from '../direct/prompt.mjs';
import { redact } from '../direct/text.mjs';
import { toolDetails } from '../conversation/tool-details.mjs';
import { lokutorText, voiceNoteText } from '../resources.mjs';
import { audioDiagnostics } from './diagnostics.mjs';

// Lokutor voice agents (wss://api.lokutor.com/ws/agent): one WebSocket that
// runs its own speech recognition, language model and speech synthesis. As
// with Gemini Live there is no WebRTC leg and no sideband: whoever holds the
// socket gets the tool calls, so this server holds it with the key, relays the
// page's audio (/api/live/stream) and runs every tool call through the same
// DirectSession and send rule. The provider calls the ADE tools itself.
// What differs: the protocol cannot add a message to the conversation. The
// instructions are the only channel, so the call start, the catalog, the
// greeting and every server note go into them (docs/lokutor.md).
// This engine knows no ADE: it runs whatever DirectAde it is given.

// Settings offers one entry; the model behind it is Lokutor's.
export const LOKUTOR_MODELS = ['lokutor'] as const;
export const isLokutorModel = (model: string) => model === 'lokutor';
// Voice slots: each language has its own native speaker in each slot, so one
// slot follows the call's language (GET https://api.lokutor.com/voices).
export const LOKUTOR_VOICES = ['F1', 'F2', 'F3', 'F4', 'F5', 'M1', 'M2', 'M3', 'M4', 'M5'] as const;
export const LOKUTOR_DEFAULTS = { voice: 'F1' } as const;
export const LOKUTOR_ENDPOINT = 'wss://api.lokutor.com/ws/agent';
// The languages Lokutor's recognition understands. A call in one of them is
// pinned to it (short replies such as "yes" are recognised reliably); in any
// other the provider follows the caller.
export const LOKUTOR_LANGUAGES = ['en', 'es', 'ca', 'gl', 'eu', 'pt', 'fr', 'it', 'de'] as const;
// The page sends 16 kHz PCM, as Lokutor takes it; Lokutor answers at the rate
// its server_rates message names (44.1 kHz today).
export const INPUT_RATE = 16_000;
const DEFAULT_OUTPUT_RATE = 44_100;
// Browser frames: at most one second each. Lokutor's clients send 20 ms frames.
const MAX_FRAME = INPUT_RATE * 2, PROVIDER_FRAME = INPUT_RATE * 2 / 50;
// Waiting for a transcript lets a tool call see the words that authorize it.
const TRANSCRIPT_WAIT_MS = 2500;
// Lokutor waits 10 s for a tool's result and then tells the model it failed.
// A tool still running at this point is answered that it continues; its
// result then reaches the model as a server note.
const TOOL_ANSWER_MS = 8000;
// Audio of the opening line waits until the page is ready to play it, bounded.
const MAX_HELD_BYTES = DEFAULT_OUTPUT_RATE * 2 * 30;
// The page usually reports ready at once; without it, audio flows anyway.
const READY_FALLBACK_MS = 1500;
// Muted: Lokutor's end of turn is measured on incoming audio, so silence keeps it going.
const SILENCE_FRAME_MS = 100;
// An answer is published once its audio has played, plus this margin.
const SPOKEN_MARGIN_MS = 800;
// Server notes kept in the instructions at once.
const MAX_NOTES = 6;
// Recognition vocabulary: Lokutor's limits.
const KEYTERMS = 100, KEYTERM_LENGTH = 40;
// The expression tags Lokutor's voices perform: not words of the transcript.
const TAGS = /\[(?:breath|laugh|sigh|happy|sad|angry|surprised|fearful|disgusted|excited|anxious)\]/gi;

// The key goes in a header, never in the URL, so no log or error can quote it.
// The URL carries only the recognition vocabulary: project and thread names.
export const connectLokutor = (key: string, keyterms: string[] = []) => new WebSocket(
  keyterms.length ? `${LOKUTOR_ENDPOINT}?${new URLSearchParams({ keyterms: keyterms.join(',') })}` : LOKUTOR_ENDPOINT,
  { headers: { 'X-API-Key': key }, handshakeTimeout: 15_000, maxPayload: 4 * 1024 * 1024 }) as unknown as Socket;

// The language a call is pinned to: its own when Lokutor recognises it, else
// '' (Lokutor follows the caller).
export function lokutorLanguage(language?: CallLanguage) {
  const primary = (language?.tag || '').split('-')[0].toLowerCase();
  return (LOKUTOR_LANGUAGES as readonly string[]).includes(primary) ? primary : '';
}
export const spokenText = (text: string) => text.replace(TAGS, ' ').replace(/\s+/g, ' ').trim();
// The text of a provider error: a structured object or a plain string.
function providerError(data: unknown) {
  if (typeof data === 'string') return data;
  if (!data || typeof data !== 'object') return '';
  const { code, message } = data as { code?: unknown; message?: unknown };
  return [code, message].filter((part): part is string => typeof part === 'string' && !!part).join(': ');
}
// A refused handshake ("Unexpected server response: 401") by its status.
function connectFailure(error: unknown) {
  const status = /Unexpected server response: (\d{3})/.exec(String((error as Error | null)?.message))?.[1];
  if (status === '401' || status === '403') return `Lokutor refused the API key (${status}).`;
  if (status === '402') return 'Lokutor cannot start a call: the account has no balance left (402).';
  if (status === '429') return 'Lokutor refused the call: too many calls at once on this account (429).';
  return `Lokutor could not be connected${status ? ` (${status})` : ''}.`;
}

interface ServerMessage {
  type?: string; data?: unknown; role?: string; partial?: boolean; generation?: number;
  previous?: unknown; full?: unknown; emitted?: boolean;
  name?: unknown; arguments?: unknown; call_id?: unknown; playback?: unknown;
}
// A conversation item: the Message the send rule reads is updated with it.
// voiced: audio has played since its text arrived.
interface Item { id: string; text: string; message: { text: string }; voiced?: boolean }
// A note in the instructions until a reply of a later generation has seen it.
interface Note { text: string; generation: number }
// A function call still running. spoke: the user started speaking after it
// arrived; missed: Lokutor has moved on to a new turn, so its result no
// longer reaches the model as a function result; answered: the provider has a
// result for it already (the interim "still running" one, when late).
interface Running { name: string; spoke?: boolean; missed?: boolean; answered?: boolean; late?: boolean }
export interface LokutorCall {
  id: string; backend?: string; conversationId?: string; seen: number; closed: boolean; closing?: boolean;
  // ready: Lokutor confirmed the configuration; live: the page plays audio.
  upstream?: Socket; browser?: Socket; ready?: boolean; live?: boolean; liveTimer?: NodeJS.Timeout;
  outputRate: number; held: Buffer[]; heldBytes: number;
  direct?: DirectSession; items: number; order: Map<string, number>;
  // The latest user utterance (a revision replaces its text) and the answer being spoken.
  user?: Item; assistant?: Item; assistantTimer?: NodeJS.Timeout; playEnd: number;
  // The newest reply's generation: older audio is dropped.
  generation: number; greeted?: boolean;
  // The instructions without the notes, and the notes.
  instructions: string; notes: Note[];
  running: Map<string, Running>; results: Map<string, string>;
  silence?: NodeJS.Timeout; diagnosticsAt?: number; revisions: number;
}
export interface LokutorSettings { voice?: string }
export interface LokutorOptions {
  key?: string; ade: DirectAde; context: VoiceContext; publish: Publish; store: { meta(key: string, value?: unknown): unknown };
  settings?: LokutorSettings;
  // The owner's custom instructions (Settings), appended to the instructions when not blank.
  instructions?: string;
  // Opens the provider socket; tests pass a fake.
  connect?: (key: string, keyterms: string[]) => Socket;
  // Tests shorten how long a tool runs before the provider is told it continues.
  toolAnswerMs?: number;
  delivered?: (thread: DeliveredThread, conversationId?: string) => void; read?: (threadId: string) => void;
}

export class LokutorCalls {
  readonly provider = 'lokutor';
  readonly model = LOKUTOR_MODELS[0];
  key: string | undefined; ade: DirectAde; publish: Publish; store: LokutorOptions['store']; context: VoiceContext;
  voice!: string;
  instructions: string | undefined;
  sessions = new Map<string, LokutorCall>(); creating = false; stopping = false; running = 0;
  connect: (key: string, keyterms: string[]) => Socket; timer: NodeJS.Timeout; toolAnswerMs: number;
  delivered?: LokutorOptions['delivered']; read?: LokutorOptions['read'];
  constructor({ key, ade, publish, store, context, settings = {}, instructions, connect, delivered, read, toolAnswerMs = TOOL_ANSWER_MS }: LokutorOptions) {
    this.instructions = instructions; this.key = key; this.ade = ade; this.publish = publish; this.store = store; this.context = context;
    this.delivered = delivered; this.read = read; this.toolAnswerMs = toolAnswerMs;
    this.apply(settings);
    this.connect = connect || connectLokutor;
    this.timer = setInterval(() => {
      for (const [id, call] of this.sessions) if (Date.now() - call.seen > 45_000) this.close(id, `The connection with the phone was lost. Requests keep running in ${this.ade.name}.`);
    }, 10_000).unref();
  }
  apply(settings: LokutorSettings) { this.voice = settings.voice || LOKUTOR_DEFAULTS.voice; }
  get busy() { return this.creating || this.sessions.size > 0; }
  get working() { return this.running > 0; }
  // instructions: null clears them; undefined keeps them.
  configure({ settings, key, instructions }: { settings?: LokutorSettings; key?: string | null; instructions?: string | null }) {
    if (this.busy) throw new Error('End the call before changing the voice settings.');
    if (settings) this.apply(settings);
    if (instructions !== undefined) this.instructions = instructions || undefined;
    if (key !== undefined) this.key = key || undefined;
  }
  // The names given to recognition as custom vocabulary, within Lokutor's limits.
  keyterms() { return this.context.vocabulary().filter(term => term && term.length <= KEYTERM_LENGTH && !term.includes(',')).slice(0, KEYTERMS); }
  // The ADE's tools as OpenAI function definitions, the shape Lokutor takes.
  tools() { return this.ade.tools.map(({ name, description, parameters }) => ({ type: 'function', function: { name, description, parameters } })); }
  // The voice instructions, then what other providers get as system messages:
  // the start of the call (history, greeting language) and the catalog.
  instructionsFor(language: CallLanguage | undefined, start: string, catalog: string) {
    const base = directInstructions(this.ade, { callStart: this.context.timing?.(), capabilities: { backend: this.context.backend, capabilities: this.context.capabilities }, language, custom: this.instructions, provider: 'lokutor' });
    return [base, lokutorText('session', { greeting: voiceNoteText('greeting') }), start && lokutorText('start', { text: start }), catalog && lokutorText('catalog', { text: catalog })].filter(Boolean).join('\n\n');
  }
  prompt(call: LokutorCall) {
    return call.notes.length ? `${call.instructions}\n\n${lokutorText('notes', { notes: call.notes.map(note => note.text).join('\n\n') })}` : call.instructions;
  }
  // Creates the provider session and returns where the browser streams audio.
  async create({ languages = [], language }: { languages?: string[]; language?: string } = {}): Promise<LiveResponse> {
    if (!this.key) throw new StatusError(503, 'The Lokutor key is missing on the server.');
    if (this.creating || this.sessions.size) throw new StatusError(409, 'There is already a call active or connecting.');
    if (this.stopping) throw new StatusError(503, 'The service is stopping.');
    const id = `lok_${randomUUID()}`, spoken = callLanguage(language, languages);
    // Built before the engine counts as busy: a failure here leaves nothing behind.
    const call: LokutorCall = { id, backend: this.context.snapshot?.backend, conversationId: this.context.conversation?.().id, seen: Date.now(), closed: false,
      outputRate: DEFAULT_OUTPUT_RATE, held: [], heldBytes: 0, items: 0, order: new Map(), playEnd: 0, generation: 0,
      instructions: '', notes: [], running: new Map(), results: new Map(), revisions: 0 };
    this.creating = true;
    this.sessions.set(id, call);
    try {
      const direct = call.direct = new DirectSession(this.ade);
      try { this.ade.prefetch?.(); } catch { /* Only a later cache miss. */ }
      // Lokutor speaks first as soon as its session is configured, and only the
      // instructions can carry the catalog: it is read before the session opens.
      const start = this.context.resume({ languages, language });
      const catalog = await Promise.resolve(direct.catalog()).catch(() => '');
      if (call.closed || this.stopping) throw new StatusError(503, 'The call ended while it was connecting.');
      call.instructions = this.instructionsFor(spoken, start, catalog);
      await this.open(call, lokutorLanguage(spoken));
      if (call.closed || this.stopping) throw new StatusError(503, 'The call ended while it was connecting.');
      this.publish('voice', { status: 'connected', id, provider: 'lokutor', backend: call.backend, conversationId: call.conversationId, ...(spoken ? { language: spoken.tag, languageSource: spoken.source } : {}) });
      return { session: { id }, transport: { stream: `/api/live/stream?id=${encodeURIComponent(id)}` } };
    } catch (error) {
      if (!call.closed) { call.closing = true; this.finish(call); try { call.upstream?.close(1000); } catch { /* Already closed. */ } }
      this.sessions.delete(id);
      throw error;
    } finally { this.creating = false; }
  }
  // Opens the provider socket and configures it. rates goes last: it tells
  // Lokutor the configuration is complete, and Lokutor then speaks first.
  // Resolves when Lokutor acknowledges it; an error frame before that refuses the call.
  open(call: LokutorCall, language: string) {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const socket = call.upstream = this.connect(this.key!, this.keyterms());
      const fail = (message: string) => {
        if (settled) return;
        settled = true; clearTimeout(timeout); reject(new StatusError(502, message));
        try { socket.close(1000); } catch { /* Already closed. */ }
      };
      const timeout = setTimeout(() => fail('Lokutor did not confirm the session.'), 20_000);
      timeout.unref?.();
      socket.once('open', () => {
        for (const message of [{ type: 'voice', data: this.voice }, { type: 'language', data: language }, { type: 'tools', data: this.tools() },
          { type: 'prompt', data: this.prompt(call) }, { type: 'rates', input: INPUT_RATE }]) socket.send(JSON.stringify(message));
      });
      socket.on('error', (error: Error) => fail(connectFailure(error)));
      socket.on('message', (raw: Buffer, binary: boolean) => {
        if (call.upstream !== socket || binary) return;
        let message: ServerMessage;
        try { message = JSON.parse(raw.toString()); } catch { return; }
        if (!message || typeof message !== 'object') return;
        if (!settled) {
          if (message.type === 'error') { fail(`Lokutor refused the session: ${redact(providerError(message.data)).slice(0, 300) || 'no reason given'}.`); return; }
          if (message.type === 'status' && message.data === 'rates_set') { settled = true; clearTimeout(timeout); call.ready = true; resolve(); return; }
        }
        try { this.event(call, message); }
        catch { this.publish('notice', { text: 'A voice event could not be processed. No action will be repeated.' }); }
      });
      socket.on('close', (code: number, reason: Buffer) => {
        const text = reason?.length ? `: ${redact(reason.toString()).slice(0, 200)}` : '';
        if (!settled) fail(`Lokutor closed the session (${code}${text}).`);
        else if (call.upstream === socket) this.disconnect(call, `Lokutor ended the call (${code}${text}). Requests keep running in ${this.ade.name}.`);
      });
    });
  }
  // Ends a call the provider no longer carries. ADE work already sent keeps running.
  disconnect(call: LokutorCall, reason: string) {
    if (call.closed || call.closing) return;
    this.finish(call); this.sessions.delete(call.id);
    this.publish('voice', { status: 'disconnected', reason, id: call.id, provider: 'lokutor', backend: call.backend, conversationId: call.conversationId });
    try { call.upstream?.close(1000); } catch { /* Already closed. */ }
    try { call.browser?.close(1000, 'provider_closed'); } catch { /* Already closed. */ }
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
    this.toBrowser(call, { type: 'session.started', inputRate: INPUT_RATE, outputRate: call.outputRate });
    call.liveTimer = setTimeout(() => this.ready(id), READY_FALLBACK_MS);
    call.liveTimer.unref?.();
    return true;
  }
  fromBrowser(call: LokutorCall, data: Buffer, binary: boolean) {
    if (call.closed) return;
    call.seen = Date.now();
    if (binary) {
      if (data.length > MAX_FRAME || data.length % 2) return;
      this.silence(call, false);
      this.audioUp(call, data);
      return;
    }
    let message: { type?: string };
    try { message = JSON.parse(data.toString()); } catch { return; }
    // Muted: the page stops its frames; silence lets Lokutor end the user's turn.
    if (message?.type === 'audio.end') this.silence(call, true);
  }
  audioUp(call: LokutorCall, pcm: Buffer) {
    if (!this.sendable(call)) return;
    for (let at = 0; at < pcm.length; at += PROVIDER_FRAME) call.upstream!.send(pcm.subarray(at, at + PROVIDER_FRAME), { binary: true });
  }
  silence(call: LokutorCall, on: boolean) {
    clearInterval(call.silence); call.silence = undefined;
    if (!on || call.closed) return;
    const frame = Buffer.alloc(INPUT_RATE * 2 * SILENCE_FRAME_MS / 1000);
    call.silence = setInterval(() => this.audioUp(call, frame), SILENCE_FRAME_MS);
    call.silence.unref?.();
  }
  event(call: LokutorCall, message: ServerMessage) {
    if (call.closed) return;
    const text = (value: unknown) => typeof value === 'string' ? value : '';
    switch (message.type) {
      case 'audio': this.audio(call, message); break;
      case 'status': this.status(call, message); break;
      case 'transcript':
        // Interim recognition is never a turn: only the final line counts.
        if (message.role === 'user') { if (!message.partial) this.heard(call, text(message.data)); }
        else if (message.role === 'agent') this.said(call, text(message.data));
        break;
      case 'transcript_revised': this.revised(call, text(message.data)); break;
      case 'transcript_truncated': this.truncated(call, text(message.data), text(message.full), message.emitted === true); break;
      // arguments is a JSON string; an object is taken as one.
      case 'tool_call': this.toolCall(call, text(message.call_id), text(message.name),
        message.arguments && typeof message.arguments === 'object' ? JSON.stringify(message.arguments) : text(message.arguments) || '{}'); break;
      case 'server_rates':
        if (typeof message.playback === 'number' && message.playback >= 8000 && message.playback <= 96_000) call.outputRate = message.playback;
        break;
      case 'error': {
        const error = providerError(message.data);
        if (error) this.publish('notice', { text: `Lokutor reported an error: ${redact(error).slice(0, 300)}` });
        break;
      }
    }
  }
  status(call: LokutorCall, message: ServerMessage) {
    // A newer reply starts (after a tool, the filler Lokutor spoke meanwhile
    // gives way to the answer): what the page still has queued is dropped,
    // as Lokutor's own clients do.
    if (message.data === 'thinking' && typeof message.generation === 'number' && message.generation > call.generation) {
      if (call.generation > 0) { this.toBrowser(call, { type: 'interrupted' }); call.held = []; call.heldBytes = 0; call.playEnd = 0; }
      // The words of the previous reply end with it. Lokutor sends the answer
      // after a tool call just before the generation that speaks it: words not
      // heard yet stay open for it.
      if (call.assistant?.voiced) this.endAssistant(call);
      call.generation = message.generation;
    }
    // The user started speaking: a tool still running may be overtaken by a new turn.
    if (message.data === 'listening') for (const running of call.running.values()) running.spoke = true;
    // The interruption is real: the page drops what it still has queued, and
    // Lokutor drops the turn, with any function call still running.
    if (message.data === 'interrupted') {
      this.toBrowser(call, { type: 'interrupted' });
      call.held = []; call.heldBytes = 0; call.playEnd = 0;
      for (const running of call.running.values()) running.missed = true;
    }
  }
  audio(call: LokutorCall, message: ServerMessage) {
    if (typeof message.data !== 'string') return;
    const generation = typeof message.generation === 'number' ? message.generation : call.generation;
    // A newer reply replaced it.
    if (generation < call.generation) return;
    call.generation = generation;
    const pcm = Buffer.from(message.data, 'base64');
    if (pcm.length < 2) return;
    if (!call.live) {
      if (call.heldBytes + pcm.length <= MAX_HELD_BYTES) { call.held.push(pcm); call.heldBytes += pcm.length; }
      if (call.assistant) call.assistant.voiced = true;
      return;
    }
    this.play(call, pcm);
  }
  play(call: LokutorCall, pcm: Buffer) {
    this.toBrowser(call, pcm);
    call.playEnd = Math.max(Date.now(), call.playEnd) + pcm.length / 2 / call.outputRate * 1000;
    if (call.assistant) { call.assistant.voiced = true; this.endLater(call); }
  }
  // The page is ready to play: the opening line held until now plays.
  ready(id: string) {
    const call = this.sessions.get(id);
    if (!call || call.closed || call.closing || call.live) return;
    clearTimeout(call.liveTimer);
    call.live = true; call.greeted = true;
    const held = call.held; call.held = []; call.heldBytes = 0;
    for (const pcm of held) this.play(call, pcm);
  }
  // The user's final transcript of a turn. Lokutor sends it before the
  // function calls of its answer, so a yes is a turn when they arrive.
  heard(call: LokutorCall, text: string) {
    const words = text.trim();
    if (!words) return;
    this.endAssistant(call);
    const id = `u${++call.items}`;
    this.slot(call, id);
    call.direct?.place(id, 'user');
    const message = call.direct?.fill(id, 'user', words) || { text: words };
    call.user = { id, text: words, message };
    this.publish('transcript', { call: call.id, role: 'user', text: words, order: this.slot(call, id), item: id, backend: call.backend, conversationId: call.conversationId });
    // Words that began after a function call arrived are a new turn: Lokutor answers them instead.
    for (const running of call.running.values()) if (running.spoke) running.missed = true;
  }
  // The user's paused sentence and its continuation, transcribed as one turn.
  // The same message grows: words a send already used never authorize another.
  // Lokutor withdraws the answer it had begun, and answers the whole sentence.
  revised(call: LokutorCall, text: string) {
    const words = text.trim(), user = call.user;
    if (!words) return;
    if (!user) { this.heard(call, words); return; }
    const begun = call.assistant;
    if (begun) {
      call.assistant = undefined; clearTimeout(call.assistantTimer);
      begun.message.text = ''; call.direct?.forget(begun.id);
    }
    for (const running of call.running.values()) running.missed = true;
    const shown = user.text;
    user.text = words; user.message.text = words;
    // The panel keeps the first half; the rest is its own line.
    const rest = words.startsWith(shown) ? words.slice(shown.length).trim() : words;
    if (rest) this.publish('transcript', { call: call.id, role: 'user', text: rest, order: this.slot(call), item: `${user.id}:r${++call.revisions}`, backend: call.backend, conversationId: call.conversationId });
  }
  // The agent's words. Lokutor sends a reply's text as soon as it is
  // written, before it plays; it is published once its audio has played (or
  // it is cut), so an interruption can still shorten it.
  said(call: LokutorCall, text: string) {
    const words = spokenText(text);
    if (!words) return;
    if (!call.assistant) {
      const id = `a${++call.items}`;
      this.slot(call, id);
      call.assistant = { id, text: '', message: call.direct?.place(id, 'assistant') || { text: '' } };
    }
    const item = call.assistant;
    item.text = item.text ? `${item.text} ${words}` : words; item.message.text = item.text;
    this.retire(call);
    this.endLater(call);
  }
  // The user cut the agent off: what they heard replaces what was written
  // (emitted), or is added as a line of its own.
  truncated(call: LokutorCall, heard: string, full: string, emitted: boolean) {
    const words = spokenText(heard), written = spokenText(full), item = call.assistant;
    if (!item) {
      if (!emitted && words) { this.said(call, words); this.endAssistant(call); }
      return;
    }
    item.text = emitted ? (written && item.text.includes(written) ? item.text.replace(written, words) : words).replace(/\s+/g, ' ').trim()
      : [item.text, words].filter(Boolean).join(' ');
    item.message.text = item.text;
    this.endAssistant(call);
  }
  endLater(call: LokutorCall) {
    const item = call.assistant;
    if (!item) return;
    clearTimeout(call.assistantTimer);
    call.assistantTimer = setTimeout(() => { if (call.assistant === item) this.endAssistant(call); }, Math.max(0, call.playEnd - Date.now()) + SPOKEN_MARGIN_MS);
    call.assistantTimer.unref?.();
  }
  // Ends the answer being spoken: kept with its text, or dropped when it has none.
  endAssistant(call: LokutorCall) {
    const item = call.assistant;
    if (!item) return;
    call.assistant = undefined; clearTimeout(call.assistantTimer);
    const text = item.text.trim();
    if (!text) { item.message.text = ''; call.direct?.forget(item.id); return; }
    call.direct?.fill(item.id, 'assistant', text);
    this.publish('transcript', { call: call.id, role: 'assistant', text, order: this.slot(call, item.id), item: item.id, backend: call.backend, conversationId: call.conversationId });
  }
  slot(call: LokutorCall, key = `anon:${call.order.size}`) {
    let n = call.order.get(key);
    if (n === undefined) { n = call.order.size + 1; call.order.set(key, n); }
    return n;
  }
  toolCall(call: LokutorCall, callId: string, name: string, args: string) {
    if (!callId) return;
    // What the voice said so far precedes the call.
    this.endAssistant(call);
    // A call ID never runs twice; one already answered gets the same result.
    const done = call.results.get(callId);
    if (done !== undefined) { this.submit(call, callId, done); return; }
    if (call.running.has(callId)) return;
    call.running.set(callId, { name });
    this.slot(call, `fn:${callId}`);
    void this.tool(call, callId, name, args);
  }
  async tool(call: LokutorCall, callId: string, name: string, args: string) {
    const direct = call.direct, running = call.running.get(callId);
    if (!direct || !running) return;
    const late = setTimeout(() => {
      if (running.answered || call.closed) return;
      running.answered = true; running.late = true;
      this.submit(call, callId, lokutorText('running', { tool: name }));
    }, this.toolAnswerMs);
    late.unref?.();
    this.running++;
    let run: ToolRun | null;
    try {
      run = await direct.run({ name, call_id: callId, arguments: args }, {
        requestId: requestIdFor('voice', call.id, callId), signal: AbortSignal.timeout(90_000),
        // The transcript of a yes may still be on its way. A send whose turn
        // Lokutor dropped meanwhile is abandoned: nothing is sent.
        beforeSend: async () => {
          for (let waited = 0; direct.sendRefusal() && waited < TRANSCRIPT_WAIT_MS && !call.closed && !running.missed; waited += 100) await new Promise(resolve => setTimeout(resolve, 100));
          return !call.closed && !call.closing && !running.missed && this.isCurrent(call);
        } });
    } catch {
      const failure = toolFailure(this.ade, name);
      run = { callId, name, args: null, status: failure.status, output: failure.output };
    } finally { this.running--; clearTimeout(late); }
    call.running.delete(callId);
    // Abandoned before it started: nothing ran, and a repeat of the ID gets this outcome.
    const output = run ? run.output : voiceNoteText('abandoned');
    call.results.set(callId, output);
    if (run) {
      if (run.delivered) this.delivered?.(run.delivered, call.conversationId);
      if (run.read) this.read?.(run.read);
      this.publish('voice-tool', { id: call.id, callId: run.callId, name: run.name, ok: run.status === 'completed', status: run.status, order: this.slot(call, `fn:${run.callId}`), backend: call.backend, conversationId: call.conversationId,
        ...toolDetails({ args: run.args, result: run.output, ...(run.delivered ? { delivered: run.delivered } : {}) }, [this.key]) as Record<string, unknown> });
    }
    if (call.closed || call.closing) return;
    // The model was told the tool continues: its result reaches it as a note.
    if (running.late) { this.note(call, lokutorText('late', { tool: name, output })); return; }
    running.answered = true;
    this.submit(call, callId, output);
    // Lokutor no longer waits for it: a send that ran, or may have, is told to
    // the model all the same; a read is not.
    const sends = this.ade.tools.find(t => t.name === name)?.sends;
    if (running.missed && sends && (run?.status === 'completed' || run?.status === 'unknown')) this.note(call, voiceNoteText('cancelled', { tool: name, output }));
  }
  submit(call: LokutorCall, callId: string, result: string) {
    // The provider reads the result as a string only.
    this.send(call, { type: 'tool_result', data: { call_id: callId, result } });
  }
  // A server note: Lokutor cannot add it to the conversation, so it goes into
  // the instructions, until a reply of a later generation has had it.
  note(call: LokutorCall, text: string) {
    // Progress notices of a long run pile up while nobody speaks: the newest few stay.
    call.notes = [...call.notes, { text, generation: call.generation }].slice(-MAX_NOTES);
    this.send(call, { type: 'prompt', data: this.prompt(call) });
  }
  retire(call: LokutorCall) {
    const kept = call.notes.filter(note => note.generation >= call.generation);
    if (kept.length === call.notes.length) return;
    call.notes = kept;
    this.send(call, { type: 'prompt', data: this.prompt(call) });
  }
  sendable(call: LokutorCall) {
    return call.upstream?.readyState === WebSocket.OPEN && !!call.ready && !call.closed && !call.closing && this.isCurrent(call);
  }
  send(call: LokutorCall, message: Record<string, unknown>) {
    if (this.sendable(call)) call.upstream!.send(JSON.stringify(message));
  }
  toBrowser(call: LokutorCall, data: Buffer | Record<string, unknown>) {
    if (call.browser?.readyState !== WebSocket.OPEN) return;
    if (Buffer.isBuffer(data)) call.browser.send(data, { binary: true });
    else call.browser.send(JSON.stringify(data));
  }
  // A conversation that cannot be read is not current: nothing is sent.
  isCurrent(call: LokutorCall) {
    try { return !call.conversationId || !this.context?.conversation || call.conversationId === this.context.conversation().id; }
    catch { return false; }
  }
  // Notices go into the instructions; the voice tells them in its next reply.
  // A thread the voice read since it finished has nothing new to tell.
  threadNotice(notice: ThreadNotice) {
    let sent = false;
    for (const call of this.sessions.values()) {
      if (notice.conversationId && call.conversationId && notice.conversationId !== call.conversationId) continue;
      if (call.closed || call.closing || !call.greeted || !this.sendable(call)) continue;
      if (!notice.quiet) {
        const body = noticeBody(notice, notice.kind === 'progress' ? 400 : 2000);
        this.note(call, noticeHeader(notice) + (body ? `\n${voiceNoteText('agentMessage', { body })}` : ''));
      }
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
  // Barge-in is Lokutor's own; the protocol has no request to cancel an
  // answer, so the explicit interrupt only empties the page's playback.
  interrupt(id: string) {
    const call = this.sessions.get(id); if (!call || call.closed) return;
    this.toBrowser(call, { type: 'interrupted' });
  }
  finish(call: LokutorCall) {
    // The call ends even if recording it fails: persistence here is best effort.
    try { this.endAssistant(call); this.context.rememberClose(); } catch { /* Kept as far as it got. */ }
    call.closed = true; call.direct = undefined; call.ready = false; call.held = []; call.notes = [];
    clearTimeout(call.liveTimer); clearTimeout(call.assistantTimer); clearInterval(call.silence);
  }
  close(id: string, reason = 'the user hung up.') {
    const call = this.sessions.get(id);
    if (!call || call.closed) return;
    call.closing = true; this.finish(call); this.sessions.delete(id);
    this.publish('voice', { status: 'closed', id, reason, provider: 'lokutor', backend: call.backend, conversationId: call.conversationId });
    try { call.upstream?.close(1000); } catch { /* Already closed. */ }
    try { call.browser?.close(1000, 'closed'); } catch { /* Already closed. */ }
  }
  shutdown() {
    this.stopping = true; clearInterval(this.timer);
    for (const id of [...this.sessions.keys()]) this.close(id);
  }
}
