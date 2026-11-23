import type { Publish, LiveResponse } from '../shared/contracts.mjs';
import type { VoiceContext } from './types.mjs';
import type { DeliveredThread, DirectAde, DirectTool } from '../direct/contract.mjs';
import { StatusError } from '../shared/contracts.mjs';
import WebSocket from 'ws';
import { createHash, randomUUID } from 'node:crypto';
import { noticeBody, noticeHeader, USER_QUIET_MS, type ThreadNotice } from '../conversation/thread-watch.mjs';
import { DirectSession, requestIdFor, toolFailure } from '../direct/session.mjs';
import { callLanguage, directInstructions, languageReminder } from '../direct/prompt.mjs';
import { redact } from '../direct/text.mjs';
import { toolDetails } from '../conversation/tool-details.mjs';
import { voiceNoteText } from '../resources.mjs';
import { audioDiagnostics } from './diagnostics.mjs';
import { isHintEcho } from '../conversation/hint-echo.mjs';
import type { Socket } from './gemini.mjs';

// ElevenLabs Agents (Conversational AI over WebSocket). As with Gemini Live,
// whoever holds the provider socket sees the tool calls, so the socket stays on
// this server and the page's audio is relayed through /api/live/stream: the
// key never leaves the server, and every tool call runs here, through the same
// DirectSession and send rule. The tools are ElevenLabs "client" tools: the
// provider asks, this server runs them and answers, and the model waits for
// the result. ElevenLabs transcribes the user, runs the chosen LLM and speaks
// with its own voices; the LLM is chosen in Settings.
// This engine knows no ADE: it runs whatever DirectAde it is given.
//
// A conversation needs an agent in the owner's ElevenLabs account. The engine
// keeps one, named "ADE Call", with the ADE's tools attached, and creates or
// updates it (and the tools) through the API when they change; each call then
// sets its own instructions, LLM, language, voice and keywords as overrides.

export const ELEVENLABS_MODEL = 'elevenlabs-agents';
export const isElevenLabsModel = (model: string) => model.startsWith('elevenlabs');
// LLMs offered for the agent: models ElevenLabs runs with tool calling. Claude
// Haiku 5.5 is the default: in the evaluations it passed more scenarios than
// Gemini 3.8 Flash, with no unauthorized send, and answered about a second sooner.
// A value configured by hand stays offered.
export const ELEVENLABS_LLMS = ['claude-haiku-5-5', 'gemini-3.8-flash', 'claude-sonnet-5-5', 'gpt-6.2-sol', 'glm-52'] as const;
// Default voices of ElevenLabs (multilingual) by name; a hand-configured value
// that is not a name here is used as a voice ID.
export const ELEVENLABS_VOICES: Record<string, string> = {
  Sarah: 'EXAVITQu4vr4xnSDxMaL', Jessica: 'cgSgspJ2msm6clMCkdW9', Alice: 'Xb7hH8MSUJpSbSDYk0k2', Lily: 'pFZP5JQG7iQjIQuC4Bku',
  Eric: 'cjVigY5qzO86Huf0OWal', Brian: 'nPczCjzI2devNBz1zQrb', George: 'JBFqnCBsd6RMkjVDRZzb', Will: 'bIHbv24MWmeRgasZH58o'
};
export const ELEVENLABS_DEFAULTS = { llm: 'claude-haiku-5-5', voice: 'Sarah' } as const;
export const ELEVENLABS_API = 'https://api.elevenlabs.io';
// Audio formats on both legs: the page sends 16 kHz PCM and plays 24 kHz.
export const INPUT_RATE = 16_000, OUTPUT_RATE = 24_000;
// Browser frames: at most one second of 16 kHz mono PCM each.
const MAX_FRAME = INPUT_RATE * 2;
// ElevenLabs boosts at most 50 keywords per conversation.
const MAX_KEYWORDS = 50;
// A response ends at agent_response_complete; without it, the model counts as
// idle this long after its last audio (speech arrives sentence by sentence).
const RESPONSE_IDLE_MS = 8000;
// A message that asked for a reply and got no audio at all frees the queue after this.
const NO_REPLY_MS = 15_000;
// The provider events this server reads; others are not sent.
export const CLIENT_EVENTS = ['conversation_initiation_metadata', 'audio', 'interruption', 'user_transcript', 'tentative_user_transcript', 'agent_response',
  'agent_response_correction', 'agent_response_complete', 'client_tool_call', 'ping', 'vad_score', 'client_error'] as const;
// The meta key of the agent and tools this installation keeps in ElevenLabs.
const AGENT_META = 'elevenlabs:agent';

// Tool parameters in ElevenLabs' schema: objects, arrays and literals
// (string, integer, number, boolean), each literal with a description; enums
// only on strings. Other JSON Schema keywords are dropped; a union takes its
// first non-null type.
type Schema = { type?: string | string[]; description?: string; properties?: Record<string, Schema>; required?: string[]; items?: Schema; enum?: unknown[]; anyOf?: Schema[] };
const LITERALS = new Set(['string', 'integer', 'number', 'boolean']);
export function elevenlabsSchema(schema: unknown, name = 'value'): Record<string, unknown> {
  const s = (schema && typeof schema === 'object' ? schema : {}) as Schema;
  const types = [s.type, ...(s.anyOf || []).map(a => a.type)].flat().filter((t): t is string => typeof t === 'string' && t !== 'null');
  const branch = s.anyOf?.find(a => a.type && a.type !== 'null');
  const type = types[0] || (s.properties ? 'object' : 'string');
  const description = s.description || branch?.description || name;
  if (type === 'object') {
    const properties = s.properties || branch?.properties || {};
    return { type: 'object', description: s.description || '', properties: Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, elevenlabsSchema(value, key)])),
      required: (s.required || branch?.required || []).filter(key => key in properties) };
  }
  if (type === 'array') return { type: 'array', description, items: elevenlabsSchema(s.items || branch?.items || { type: 'string' }, name) };
  const literal = LITERALS.has(type) ? type : 'string';
  const values = s.enum || branch?.enum;
  return { type: literal, description, ...(literal === 'string' && Array.isArray(values) ? { enum: values.map(String) } : {}) };
}
export const toolConfig = (tool: Pick<DirectTool, 'name' | 'description' | 'parameters'>) => ({
  type: 'client', name: tool.name, description: tool.description, parameters: elevenlabsSchema(tool.parameters),
  // The model waits for each result before it speaks about it, as with Realtime.
  expects_response: true, response_timeout_secs: 120, execution_mode: 'immediate'
});
// The agent: no first message (the engine asks for the greeting), no built-in
// tools, the user never re-engaged or hung up on for silence, audio formats of
// the relay, plain speech (no expressive tags in the text), and the overrides
// each call sets.
export const agentSpec = (toolIds: string[], name = 'ADE Call') => ({
  name, tags: ['ade-call'],
  conversation_config: {
    agent: { first_message: '', language: 'en', prompt: { prompt: voiceNoteText('agentPrompt'), llm: ELEVENLABS_DEFAULTS.llm, tool_ids: toolIds, built_in_tools: {}, temperature: 0 } },
    asr: { user_input_audio_format: `pcm_${INPUT_RATE}` },
    tts: { agent_output_audio_format: `pcm_${OUTPUT_RATE}`, expressive_mode: false, voice_id: ELEVENLABS_VOICES[ELEVENLABS_DEFAULTS.voice] },
    turn: { turn_timeout: -1, silence_end_call_timeout: -1 },
    conversation: { max_duration_seconds: 3600, client_events: [...CLIENT_EVENTS] }
  },
  platform_settings: {
    auth: { enable_auth: true },
    overrides: { conversation_config_override: { agent: { language: true, prompt: { prompt: true, llm: true } }, tts: { voice_id: true }, asr: { keywords: true } } }
  }
});
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);

// The signed URL carries its own token; no header is needed.
export const connectElevenLabs = (url: string) => new WebSocket(url, { handshakeTimeout: 15_000, maxPayload: 4 * 1024 * 1024 }) as unknown as Socket;
export type Api = (path: string, init?: { method?: string; body?: unknown }) => Promise<{ status: number; json: unknown }>;
// The key goes in a header; no error quotes it.
// A failed request is reported without its cause, which can quote the key.
export const elevenlabsApi = (key: string): Api => async (path, init = {}) => {
  let response: Response;
  try {
    response = await fetch(ELEVENLABS_API + path, { method: init.method || 'GET', signal: AbortSignal.timeout(15_000),
      headers: { 'xi-api-key': key, ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: init.body !== undefined ? JSON.stringify(init.body) : undefined });
  } catch { throw new StatusError(502, 'ElevenLabs could not be reached.'); }
  const text = await response.text();
  const json = (() => { try { return text ? JSON.parse(text) as unknown : null; } catch { return text.slice(0, 300); } })();
  return { status: response.status, json };
};
// The provider's explanation of a refusal, without anything that looks like a secret.
function detail(json: unknown) {
  const d = (json as { detail?: unknown })?.detail ?? json;
  const message = typeof d === 'string' ? d : (d as { message?: unknown })?.message ?? JSON.stringify(d ?? '');
  return redact(String(message)).slice(0, 300);
}
// A refusal from the provider, with its status.
// agent: the refusal is of the agent (one that names its tools), not of a new tool.
class ProviderError extends StatusError { constructor(message: string, readonly provider: number, readonly agent = false) { super(502, message); } }
// The provider no longer has an agent or tool this installation kept.
const missing = (error: unknown) => error instanceof ProviderError && (error.provider === 404 || error.provider === 422 || (error.provider === 400 && error.agent));
// Stored in the server's meta: the agent and tools this installation created,
// for the account of the key that created them (a fingerprint, not the key).
interface AgentState { account: string; agentId?: string; hash?: string; tools: Record<string, { id: string; hash: string }> }

export interface ElevenLabsCall {
  id: string; backend?: string; conversationId?: string; providerConversation?: string; seen: number; closed: boolean; closing?: boolean;
  upstream?: Socket; browser?: Socket; ready?: boolean;
  // Function results by call ID: answered again if the provider repeats the ID.
  results: Map<string, { name?: string; output: string }>;
  direct?: DirectSession; items: number; order: Map<string, number>;
  // The assistant message of each provider response, and the latest one, to apply corrections.
  responses: Map<string, { item: string; message: { text: string } }>; lastResponse?: { item: string; message: { text: string } };
  greeted?: boolean; responding?: boolean; userSpeaking?: boolean; lastUserAt?: number; lastAudioAt?: number; idleTimer?: NodeJS.Timeout;
  toolsPending: Set<string>;
  queue: { text: string; speak: boolean; reply?: boolean }[]; flushTimer?: NodeJS.Timeout;
  // Notes sent as messages: one transcribed back is never a user turn.
  notes: Set<string>;
  diagnosticsAt?: number;
  // The recognition hints the transcription was given (isHintEcho).
  hints: string[];
}
export interface ElevenLabsSettings { llm?: string; voice?: string }
export interface ElevenLabsOptions {
  key?: string; ade: DirectAde; context: VoiceContext; publish: Publish; store: { meta(key: string, value?: unknown): unknown };
  settings?: ElevenLabsSettings;
  // The agent's name in the account (the evaluations keep their own).
  agentName?: string;

  // The owner's custom instructions (Settings), appended to the instructions when not blank.
  instructions?: string;
  // Tests pass fakes for the REST API and the conversation socket.
  api?: (key: string) => Api;
  connect?: (url: string) => Socket;
  delivered?: (thread: DeliveredThread, conversationId?: string) => void; read?: (threadId: string) => void;
}
interface ServerEvent {
  type?: string;
  conversation_initiation_metadata_event?: { conversation_id?: string };
  audio_event?: { audio_base_64?: string };
  user_transcription_event?: { user_transcript?: string };
  agent_response_event?: { agent_response?: string; response_id?: string };
  agent_response_correction_event?: { corrected_agent_response?: string; response_id?: string };
  client_tool_call?: { tool_name?: string; tool_call_id?: string; parameters?: Record<string, unknown> };
  ping_event?: { event_id?: number };
  vad_score_event?: { vad_score?: number };
  error_event?: { code?: number; error_name?: string; message?: string };
}
// Expressive audio tags ("[calm]") are for the speech, not the transcript.
const plain = (text: string) => text.replace(/\[[a-z][a-z ]{0,30}\]\s*/gi, '').replace(/\s{2,}/g, ' ').trim();

export class ElevenLabsCalls {
  readonly provider = 'elevenlabs';
  readonly model = ELEVENLABS_MODEL;
  key: string | undefined; ade: DirectAde; publish: Publish; store: ElevenLabsOptions['store']; context: VoiceContext;
  llm!: string; voice!: string;
  // The owner's custom instructions; changed by configure().
  instructions: string | undefined;
  sessions = new Map<string, ElevenLabsCall>(); creating = false; stopping = false; running = 0;
  api: (key: string) => Api; connect: (url: string) => Socket; timer: NodeJS.Timeout;
  // The agent state this process last confirmed with the provider.
  synced?: string; agentName?: string;
  delivered?: ElevenLabsOptions['delivered']; read?: ElevenLabsOptions['read'];
  constructor({ key, ade, publish, store, context, settings = {}, instructions, api, connect, delivered, read, agentName }: ElevenLabsOptions) {
    this.agentName = agentName;
    this.instructions = instructions; this.key = key; this.ade = ade; this.publish = publish; this.store = store; this.context = context;
    this.delivered = delivered; this.read = read;
    this.apply(settings);
    this.api = api || elevenlabsApi;
    this.connect = connect || connectElevenLabs;
    this.timer = setInterval(() => {
      // A call still connecting (creating the agent can take a while) has no page yet;
      // one whose page never attaches is closed 45 s after it connected.
      for (const [id, call] of this.sessions) if (!(this.creating && !call.ready) && Date.now() - call.seen > 45_000) this.close(id, `The connection with the phone was lost. Requests keep running in ${this.ade.name}.`);
    }, 10_000).unref();
  }
  apply(settings: ElevenLabsSettings) { this.llm = settings.llm || ELEVENLABS_DEFAULTS.llm; this.voice = settings.voice || ELEVENLABS_DEFAULTS.voice; }
  get busy() { return this.creating || this.sessions.size > 0; }
  get working() { return this.running > 0; }
  // instructions: null clears them; undefined keeps them.
  configure({ settings, key, instructions }: { settings?: ElevenLabsSettings; key?: string | null; instructions?: string | null }) {
    if (this.busy) throw new Error('End the call before changing the voice settings.');
    if (settings) this.apply(settings);
    if (instructions !== undefined) this.instructions = instructions || undefined;
    if (key !== undefined) { if ((key || undefined) !== this.key) this.synced = undefined; this.key = key || undefined; }
  }
  voiceId() { return ELEVENLABS_VOICES[this.voice] || this.voice; }
  hints() { return this.context.vocabulary().slice(0, MAX_KEYWORDS); }
  // Creates or updates the agent and its tools when they differ from what this
  // installation keeps; returns the agent ID.
  async ensureAgent(api: Api) {
    const account = digest(`elevenlabs:${this.key}`);
    let state = this.store.meta(AGENT_META) as AgentState | undefined;
    if (!state || state.account !== account) state = { account, tools: {} };
    const tools = this.ade.tools.map(tool => ({ tool, config: toolConfig(tool) })), replaced: string[] = [];
    for (const { tool, config } of tools) {
      const hash = digest(config), known = state.tools[tool.name];
      if (known?.hash === hash) continue;
      const created = await api('/v1/convai/tools', { method: 'POST', body: { tool_config: config } });
      const id = (created.json as { id?: string })?.id;
      if (created.status >= 300 || !id) throw new ProviderError(`ElevenLabs refused the tool ${tool.name} (${created.status}: ${detail(created.json)}).`, created.status);
      if (known) replaced.push(known.id);
      state.tools[tool.name] = { id, hash };
      this.store.meta(AGENT_META, state);
    }
    const spec = agentSpec(tools.map(({ tool }) => state.tools[tool.name].id), this.agentName), hash = digest(spec);
    if (state.agentId && state.hash === hash && this.synced === `${state.agentId}:${hash}`) return state.agentId;
    let updated = false;
    if (state.agentId) {
      const patched = await api(`/v1/convai/agents/${encodeURIComponent(state.agentId)}`, { method: 'PATCH', body: spec });
      if (patched.status < 300) updated = true;
      else if (patched.status !== 404) throw new ProviderError(`ElevenLabs refused the agent update (${patched.status}: ${detail(patched.json)}).`, patched.status, true);
    }
    if (!updated) {
      const created = await api('/v1/convai/agents/create', { method: 'POST', body: spec });
      const id = (created.json as { agent_id?: string })?.agent_id;
      if (created.status >= 300 || !id) throw new ProviderError(`ElevenLabs refused the agent (${created.status}: ${detail(created.json)}).`, created.status, true);
      state.agentId = id;
    }
    state.hash = hash; this.store.meta(AGENT_META, state);
    this.synced = `${state.agentId}:${hash}`;
    // Tools replaced by a new version are no longer attached: removed, best effort.
    for (const id of replaced) void api(`/v1/convai/tools/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
    return state.agentId!;
  }
  // A signed conversation URL for the agent. An agent deleted in the
  // dashboard is created again, and so are its tools if the provider says it
  // no longer has them; once.
  async signedUrl(api: Api) {
    const account = digest(`elevenlabs:${this.key}`);
    const forget = (tools: boolean) => {
      const state = this.store.meta(AGENT_META) as AgentState | undefined;
      this.synced = undefined;
      this.store.meta(AGENT_META, { account, tools: tools || state?.account !== account ? {} : state.tools });
    };
    let agentGone = false, toolsGone = false;
    for (;;) {
      let agentId: string;
      try { agentId = await this.ensureAgent(api); }
      // Only a missing tool or agent starts over; a busy or failing provider keeps the IDs.
      catch (error) { if (toolsGone || !missing(error)) throw error; toolsGone = true; forget(true); continue; }
      const signed = await api(`/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`);
      const url = (signed.json as { signed_url?: string })?.signed_url;
      if (signed.status < 300 && url) return url;
      if (signed.status === 404 && !agentGone) { agentGone = true; forget(false); continue; }
      throw new StatusError(502, `ElevenLabs could not start a conversation (${signed.status}: ${detail(signed.json)}).`);
    }
  }
  // The overrides of one call: its instructions (with the conversation so far
  // and the catalog as notes), LLM, language, voice and keywords.
  initiation(language: ReturnType<typeof callLanguage>, notes: string[], keywords: string[]) {
    const instructions = directInstructions(this.ade, { callStart: this.context.timing?.(), capabilities: { backend: this.context.backend, capabilities: this.context.capabilities }, language, custom: this.instructions, provider: 'elevenlabs' });
    const prompt = [instructions, ...notes.map(text => voiceNoteText('note', { text }))].join('\n\n');
    return { type: 'conversation_initiation_client_data', conversation_config_override: {
      agent: { prompt: { prompt, llm: this.llm }, ...(language ? { language: language.tag.split('-')[0].toLowerCase() } : {}) },
      tts: { voice_id: this.voiceId() }, ...(keywords.length ? { asr: { keywords } } : {})
    } };
  }
  // Creates the provider conversation and returns where the browser streams audio.
  async create({ languages = [], language }: { languages?: string[]; language?: string } = {}): Promise<LiveResponse> {
    if (!this.key) throw new StatusError(503, 'The ElevenLabs key is missing on the server.');
    if (this.creating || this.sessions.size) throw new StatusError(409, 'There is already a call active or connecting.');
    if (this.stopping) throw new StatusError(503, 'The service is stopping.');
    const id = `el_${randomUUID()}`, spoken = callLanguage(language, languages);
    const call: ElevenLabsCall = { id, backend: this.context.snapshot?.backend, conversationId: this.context.conversation?.().id, seen: Date.now(), closed: false,
      items: 0, order: new Map(), responses: new Map(), toolsPending: new Set(), results: new Map(), queue: [], notes: new Set(), hints: this.hints() };
    this.creating = true;
    this.sessions.set(id, call);
    try {
      const direct = call.direct = new DirectSession(this.ade);
      try { this.ade.prefetch?.(); } catch { /* Only a later cache miss. */ }
      const catalog = Promise.resolve(direct.catalog()).catch(() => '');
      const url = await this.signedUrl(this.api(this.key));
      if (call.closed || this.stopping) throw new StatusError(503, 'The call ended while it was connecting.');
      const notes = [this.context.resume({ languages, language }), await catalog].filter(Boolean);
      await this.open(call, url, this.initiation(spoken, notes, call.hints));
      if (call.closed || this.stopping) throw new StatusError(503, 'The call ended while it was connecting.');
      call.seen = Date.now();
      this.publish('voice', { status: 'connected', id, provider: 'elevenlabs', backend: call.backend, conversationId: call.conversationId, ...(spoken ? { language: spoken.tag, languageSource: spoken.source } : {}) });
      return { session: { id }, transport: { stream: `/api/live/stream?id=${encodeURIComponent(id)}` } };
    } catch (error) {
      if (!call.closed) { call.closing = true; this.finish(call); call.upstream?.close(); }
      this.sessions.delete(id);
      throw error;
    } finally { this.creating = false; }
  }
  // Opens the conversation socket and sends the overrides. Resolves when the
  // provider confirms the conversation.
  open(call: ElevenLabsCall, url: string, initiation: Record<string, unknown>) {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (message: string) => { if (!settled) { settled = true; reject(new StatusError(502, message)); } };
      // The signed URL carries a token: it is never logged or quoted, not even
      // in the error of a URL the socket cannot open.
      let socket: Socket;
      try { socket = call.upstream = this.connect(url); } catch { fail('ElevenLabs could not be connected.'); return; }
      const timeout = setTimeout(() => { fail('ElevenLabs did not confirm the conversation.'); socket.close(); }, 20_000);
      timeout.unref?.();
      socket.once('open', () => socket.send(JSON.stringify(initiation)));
      socket.on('error', () => fail('ElevenLabs could not be connected.'));
      socket.on('message', (raw: Buffer) => {
        let message: ServerEvent;
        try { message = JSON.parse(raw.toString()); } catch { return; }
        if (message.type === 'conversation_initiation_metadata' && !settled) {
          settled = true; clearTimeout(timeout);
          call.ready = true; call.providerConversation = message.conversation_initiation_metadata_event?.conversation_id;
          resolve(); return;
        }
        try { this.event(call, message); }
        catch { this.publish('notice', { text: 'A voice event could not be processed. No action will be repeated.' }); }
      });
      socket.on('close', (code: number, reason: Buffer) => {
        clearTimeout(timeout);
        // The provider explains a refused override (LLM, language, voice) in the close reason.
        const why = `${code}${reason?.length ? `: ${redact(reason.toString()).slice(0, 300)}` : ''}`;
        fail(`ElevenLabs closed the conversation (${why}, ${this.llm}).`);
        call.ready = false;
        if (!call.closed && !call.closing) this.disconnect(call, `The provider's connection closed (${why}).`);
      });
    });
  }
  // Ends a call the provider can no longer carry. ADE work already sent keeps running.
  disconnect(call: ElevenLabsCall, reason: string) {
    if (call.closed) return;
    this.finish(call); this.sessions.delete(call.id);
    this.publish('voice', { status: 'disconnected', reason, id: call.id, provider: 'elevenlabs', backend: call.backend, conversationId: call.conversationId });
    try { call.upstream?.close(1000); } catch { /* Already closed. */ }
    call.browser?.close(1000, 'provider_closed');
  }
  // The page's audio socket for a call this server created (see server.mts,
  // which checks authentication, origin and the call's owner first).
  attach(id: string, browser: Socket) {
    const call = this.sessions.get(id);
    if (!call || call.closed || call.browser) { browser.close(1008, 'no_call'); return false; }
    call.browser = browser; call.seen = Date.now();
    browser.on('message', (data: Buffer, binary: boolean) => {
      try { this.fromBrowser(call, data, binary); } catch { /* Dropped. */ }
    });
    browser.on('close', () => { if (call.browser === browser && !call.closed) this.close(id, 'The connection with the phone was lost.'); });
    browser.on('error', () => {});
    this.toBrowser(call, { type: 'session.started', inputRate: INPUT_RATE, outputRate: OUTPUT_RATE });
    return true;
  }
  // Microphone frames go up as they are; muting only stops them (the provider has no end of stream).
  fromBrowser(call: ElevenLabsCall, data: Buffer, binary: boolean) {
    if (call.closed) return;
    call.seen = Date.now();
    if (binary && call.ready && data.length <= MAX_FRAME && !(data.length % 2)) this.send(call, { user_audio_chunk: data.toString('base64') });
  }
  event(call: ElevenLabsCall, message: ServerEvent) {
    if (call.closed) return;
    switch (message.type) {
      case 'ping': this.send(call, { type: 'pong', event_id: message.ping_event?.event_id }); return;
      case 'audio': {
        const data = message.audio_event?.audio_base_64;
        if (!data) return;
        call.responding = true; call.greeted = true; call.lastAudioAt = Date.now();
        this.toBrowser(call, Buffer.from(data, 'base64'));
        // Without the end of the response, the model is idle a moment after its last audio.
        this.idleAfter(call, RESPONSE_IDLE_MS);
        return;
      }
      case 'agent_response': this.said(call, message.agent_response_event?.agent_response || '', message.agent_response_event?.response_id); return;
      case 'agent_response_correction': this.corrected(call, message.agent_response_correction_event?.corrected_agent_response || '', message.agent_response_correction_event?.response_id); return;
      case 'agent_response_complete': this.done(call); return;
      case 'interruption': call.responding = false; this.toBrowser(call, { type: 'interrupted' }); this.later(call); return;
      case 'tentative_user_transcript': call.userSpeaking = true; call.lastUserAt = Date.now(); call.greeted = true; return;
      case 'vad_score': {
        const score = message.vad_score_event?.vad_score ?? 0;
        if (score > 0.6) { call.userSpeaking = true; call.lastUserAt = Date.now(); } else if (score < 0.3 && call.userSpeaking) { call.userSpeaking = false; this.later(call); }
        return;
      }
      case 'user_transcript': this.heard(call, message.user_transcription_event?.user_transcript || ''); return;
      case 'client_tool_call': this.toolCall(call, message.client_tool_call || {}); return;
      case 'client_error': call.responding = false; this.later(call); this.publish('notice', { text: `ElevenLabs reported an error: ${redact(String(message.error_event?.message || message.error_event?.error_name || 'unknown')).slice(0, 200)}` }); return;
    }
  }
  idleAfter(call: ElevenLabsCall, ms: number) {
    clearTimeout(call.idleTimer);
    call.idleTimer = setTimeout(() => { if (call.responding && Date.now() - (call.lastAudioAt || 0) >= ms) this.done(call); }, ms);
    call.idleTimer.unref?.();
  }
  // The model finished a response: notes waiting for a quiet moment may go.
  done(call: ElevenLabsCall) {
    clearTimeout(call.idleTimer);
    if (!call.responding) return;
    call.responding = false;
    this.toBrowser(call, { type: 'turn.done' });
    clearTimeout(call.flushTimer); call.flushTimer = undefined; this.later(call, this.replies(call) ? 50 : 300);
  }
  // A user turn, transcribed once it ends: it is a turn for the send rule
  // unless it only recites the recognition hints.
  heard(call: ElevenLabsCall, raw: string) {
    const text = raw.trim();
    call.userSpeaking = false; call.lastUserAt = Date.now(); call.greeted = true;
    if (!text || call.notes.has(text)) return;
    const id = `u${++call.items}`, echo = isHintEcho(text, call.hints);
    call.direct?.fill(undefined, 'user', text, { echo });
    this.publish('transcript', { call: call.id, role: 'user', text, order: this.slot(call, id), item: id, backend: call.backend, conversationId: call.conversationId, ...(echo ? { echo: true } : {}) });
  }
  said(call: ElevenLabsCall, raw: string, responseId?: string) {
    const text = plain(raw);
    if (!text) return;
    call.greeted = true;
    const id = `a${++call.items}`, message = call.direct?.fill(undefined, 'assistant', text) || { text };
    call.lastResponse = { item: id, message };
    if (responseId) call.responses.set(responseId, call.lastResponse);
    this.publish('transcript', { call: call.id, role: 'assistant', text, order: this.slot(call, id), item: id, backend: call.backend, conversationId: call.conversationId });
  }
  // The user cut a response: the history keeps what was spoken.
  corrected(call: ElevenLabsCall, raw: string, responseId?: string) {
    // Without a response ID, the correction is of the latest response.
    const known = responseId ? call.responses.get(responseId) : call.lastResponse, text = plain(raw);
    if (!known || !text) return;
    known.message.text = text;
    this.publish('transcript', { call: call.id, role: 'assistant', text, order: this.slot(call, known.item), item: known.item, backend: call.backend, conversationId: call.conversationId, corrected: true });
  }
  slot(call: ElevenLabsCall, key = `anon:${call.order.size}`) {
    let n = call.order.get(key);
    if (n === undefined) { n = call.order.size + 1; call.order.set(key, n); }
    return n;
  }
  // A call ID never runs twice: one already answered gets the same result
  // again; one still running is answered when it ends.
  toolCall(call: ElevenLabsCall, request: NonNullable<ServerEvent['client_tool_call']>) {
    const id = request.tool_call_id;
    if (!id) return;
    const known = call.results.get(id);
    if (known) { this.result(call, id, known.output); return; }
    if (call.toolsPending.has(id)) return;
    call.toolsPending.add(id); this.slot(call, `fn:${id}`);
    // The conversation as it is now, before any await: words that arrive later
    // (even in the same tick) are a later turn and never authorize this call.
    const arrival = { at: call.direct?.turns().at(-1) };
    void this.tool(call, id, request.tool_name || '', request.parameters ?? {}, arrival).then(output => {
      call.toolsPending.delete(id);
      call.results.set(id, { name: request.tool_name, output });
      if (!call.closed && !call.closing) { this.result(call, id, output); this.flush(call); }
    });
  }
  result(call: ElevenLabsCall, id: string, output: string) { this.send(call, { type: 'client_tool_result', tool_call_id: id, result: output, is_error: false }); }
  async tool(call: ElevenLabsCall, callId: string, name: string, args: Record<string, unknown>, arrival?: { at: { role: string; text: string } | undefined }) {
    const direct = call.direct;
    if (!direct) return voiceNoteText('abandoned');
    this.running++;
    let run;
    try {
      run = await direct.run({ name, call_id: callId, arguments: JSON.stringify(args) }, {
        requestId: requestIdFor('voice', call.id, callId), signal: AbortSignal.timeout(90_000), arrival,
        // ElevenLabs sends a turn's transcript before the LLM answers it: speech
        // that arrives after the call is a later turn and never authorizes it.
        beforeSend: async () => {
          return !call.closed && !call.closing && this.isCurrent(call);
        } });
    } catch {
      return toolFailure(this.ade, name).output;
    } finally { this.running--; }
    if (!run) return voiceNoteText('abandoned');
    if (run.delivered) this.delivered?.(run.delivered, call.conversationId);
    if (run.read) this.read?.(run.read);
    this.publish('voice-tool', { id: call.id, callId: run.callId, name: run.name, ok: run.status === 'completed', status: run.status, order: this.slot(call, `fn:${run.callId}`), backend: call.backend, conversationId: call.conversationId,
      ...toolDetails({ args: run.args, result: run.output, ...(run.delivered ? { delivered: run.delivered } : {}) }, [this.key]) as Record<string, unknown> });
    return run.output;
  }
  // A silent note is context the model reads with the next turn; a note to
  // speak is a message that asks for a reply, sent when the model is idle and
  // the user quiet (reply: it answers what the user just asked, so it does not
  // wait for a quiet moment). Neither is a user turn for the send rule.
  system(call: ElevenLabsCall, text: string, speak = false, reply = false) {
    if (!speak) { this.send(call, { type: 'contextual_update', text: voiceNoteText('note', { text }) }); return; }
    call.queue.push({ text, speak, reply }); this.flush(call);
  }
  idle(call: ElevenLabsCall, reply = false) {
    return !call.toolsPending.size && !call.responding && !call.userSpeaking && (reply || Date.now() - (call.lastUserAt || 0) >= USER_QUIET_MS);
  }
  replies(call: ElevenLabsCall) { return call.queue.every(item => !item.speak || item.reply); }
  flush(call: ElevenLabsCall) {
    if (call.closed || call.closing || !this.sendable(call) || !call.queue.length) return;
    const reply = this.replies(call);
    if (!this.idle(call, reply)) return this.later(call, reply ? 100 : 500);
    const items = call.queue.splice(0);
    // Right after English data, so the reply keeps the user's language and accent.
    const text = [...items.map(item => voiceNoteText('note', { text: item.text })), languageReminder()].join('\n\n');
    call.responding = true; call.notes.add(text.trim()); call.lastAudioAt = Date.now();
    this.send(call, { type: 'user_message', text });
    // A message the provider never answers does not hold the queue forever.
    this.idleAfter(call, NO_REPLY_MS);
  }
  later(call: ElevenLabsCall, ms = 500) {
    if (call.flushTimer || !call.queue.length) return;
    call.flushTimer = setTimeout(() => { call.flushTimer = undefined; this.flush(call); }, ms);
    call.flushTimer.unref?.();
  }
  sendable(call: ElevenLabsCall) {
    return call.upstream?.readyState === WebSocket.OPEN && !!call.ready && !call.closed && !call.closing && this.isCurrent(call);
  }
  send(call: ElevenLabsCall, message: Record<string, unknown>) {
    if (this.sendable(call)) call.upstream!.send(JSON.stringify(message));
  }
  toBrowser(call: ElevenLabsCall, data: Buffer | Record<string, unknown>) {
    if (call.browser?.readyState !== WebSocket.OPEN) return;
    if (Buffer.isBuffer(data)) call.browser.send(data, { binary: true });
    else call.browser.send(JSON.stringify(data));
  }
  // A conversation that cannot be read is not current: nothing is sent.
  isCurrent(call: ElevenLabsCall) {
    try { return !call.conversationId || !this.context?.conversation || call.conversationId === this.context.conversation().id; }
    catch { return false; }
  }
  speakable(call: ElevenLabsCall) {
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
  // Barge-in is the provider's; the explicit interrupt only empties the page's playback queue.
  interrupt(id: string) {
    const call = this.sessions.get(id); if (!call || call.closed) return;
    call.greeted = true; this.toBrowser(call, { type: 'interrupted' });
  }
  finish(call: ElevenLabsCall) {
    try { this.context.rememberClose(); } catch { /* Kept as far as it got. */ }
    call.closed = true; call.queue = []; call.direct = undefined; call.ready = false;
    clearTimeout(call.flushTimer); clearTimeout(call.idleTimer);
    // The provider's conversation ID, to look up its cost in the ElevenLabs dashboard.
    try { if (call.providerConversation) this.store.meta(`usage:${call.id}`, { conversation: call.providerConversation, llm: this.llm }); } catch { /* Diagnostic only. */ }
  }
  close(id: string, reason = 'the user hung up.') {
    const call = this.sessions.get(id);
    if (!call || call.closed) return;
    call.closing = true; this.finish(call); this.sessions.delete(id);
    this.publish('voice', { status: 'closed', id, reason, provider: 'elevenlabs', backend: call.backend, conversationId: call.conversationId });
    try { call.upstream?.close(1000); } catch { /* Already closed. */ }
    try { call.browser?.close(1000, 'closed'); } catch { /* Already closed. */ }
  }
  shutdown() {
    this.stopping = true; clearInterval(this.timer);
    for (const id of [...this.sessions.keys()]) this.close(id);
  }
}
