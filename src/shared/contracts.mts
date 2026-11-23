export interface DiscoveryOptions { projects?: () => Project[]; onProgress?: (data: Overview) => void; signal?: AbortSignal }
export interface DiscoveryReader { catalog?: () => Project[] | Promise<Project[]>; overview(options?: DiscoveryOptions): Promise<Overview> }
export interface DiscoveryAdapter extends DiscoveryReader { id?: string; name: string; createDiscovery?: () => DiscoveryReader }
// Wire and persistence contracts. JSON enters at the CLI/HTTP/SQLite boundaries;
// consumers retain the existing runtime validation before authorizing actions.
export interface Project { id: string; name: string; path: string }
export interface ThreadReference { threadId: string; projectId: string; title: string; parentThreadId?: string; relationshipToParent?: string; state?: 'open' | 'settled' | 'archived'; updatedAt?: string }
export interface Thread {
  threadId: string; projectId: string; title?: string; id?: string; status?: string;
  link?: string; updatedAt?: string; archived?: boolean; archivedAt?: string; deletedAt?: string;
  parentThreadId?: string; rootThreadId?: string; relationshipToParent?: string; statusVerified?: boolean;
  activeRunId?: string | null; latestRunId?: string | null; runCount?: number;
}
export interface Workspace {
  id: string; projectId: string; name?: string; path?: string; status?: string;
  cardStatus?: string; activeTerminals?: number; updated?: string; link?: string; comment?: string;
}
// title may be the program's own, repainted by agents; paneTitle is the one set in Orca.
export interface Terminal { handle: string; title?: string; paneTitle?: string; worktreeId: string; agent?: string | null; status?: string; connected?: boolean; writable?: boolean; orphaned?: boolean }
export interface Warning { code: string; projectId?: string; threadId?: string; note?: string }
export interface Overview { backend?: string; projects: Project[]; threads: Thread[]; workspaces: Workspace[]; terminals: Terminal[]; discovery?: { complete: boolean; warnings?: Warning[] } }
export interface Message { role: string; text: string; start?: number; end?: number; runId?: string }
export interface T3Response { thread?: Partial<Thread>; messages?: Message[]; threadId?: string; link?: string; runId?: string; delivery?: 'started' | 'queued' | 'steered' | 'restarted' }
export interface Conversation { id: string; createdAt: string }
export interface CallHistory { id: string; conversationId: string; startedAt: string; endedAt: string | null; previousEndedAt?: string | null; status: string; reason?: string }
export interface StoredEvent<T = unknown> { id: number; type: string; data: T }
export type Capabilities = Partial<Record<'listThreads' | 'readThreadMessages' | 'sendMessagesOnRequest' | 'readTerminalOutput' | 'startAgent', boolean>>;
export interface ToolResult { content: { type: string; text: string }[]; details: Record<string, unknown> }
export interface ToolParameters { includeSubagents?: boolean; project: string; projectId: string; threadId: string; parentThreadId?: string; rootThreadId?: string; messages?: number; offset?: number; path: string; terminal: string; cursor?: number; limit?: number; message: string; worktreeId: string; agent: string; model?: string; effort?: string }
export interface ToolArguments {
  t3_find_threads: { query: string; projectId?: string; variants?: string[]; includeClosed?: boolean; includeSubagents?: boolean };
  t3_list_threads: Partial<Pick<ToolParameters, 'projectId' | 'parentThreadId' | 'rootThreadId' | 'includeSubagents'>>;
  t3_send_message: Pick<ToolParameters, 'projectId' | 'project' | 'message'> & { threadId?: string };
  t3_read_document: Pick<ToolParameters, 'projectId' | 'path' | 'offset'>;
  orca_read_document: ToolArguments['t3_read_document'];
  orca_list_projects: { projectId?: string; includeActivity?: boolean; query?: string; variants?: string[] };
  orca_read_terminal: Pick<ToolParameters, 'projectId' | 'terminal' | 'cursor' | 'limit'>;
  orca_send_message: Pick<ToolParameters, 'projectId' | 'terminal' | 'message'>;
  orca_start_agent: Pick<ToolParameters, 'projectId' | 'worktreeId' | 'agent' | 'message' | 'model' | 'effort'>;
}
// One ADE operation. requestId is the server's identity for this call: mutating
// tools use it for deduplication and receipts; the model never chooses it.
export type ToolDefinition<K extends keyof ToolArguments = keyof ToolArguments> = {
  [N in K]: { name: N; label: string; description: string; parameters: unknown; execute(requestId: string, params: ToolArguments[N], signal?: AbortSignal): Promise<ToolResult> }
}[K];
export interface Publication {
  backend?: string; conversationId?: string; status?: string; id?: string; reason?: string; at?: string | number;
  lifecycle?: CallHistory | null; role?: string; text?: string; output?: string | null; input?: string;
  [key: string]: unknown;
}
export type Publish = (type: string, data: Publication) => unknown;
// Events of the Realtime data channel that the page reads.
export interface LiveEvent { type: string; delta?: string; error?: { code?: string } }
// transport: the SDP answer of a WebRTC call (OpenAI Realtime), or the path of
// the server's audio socket for a relayed call (Gemini Live).
export type VoiceProvider = 'realtime' | 'gemini' | 'elevenlabs';
export interface LiveResponse { session: { id: string }; transport: { sdp?: string; stream?: string }; error?: { code?: string; message?: string } }
export interface OrcaResponse {
  repos?: { id: string; displayName: string; path: string }[];
  worktrees?: { worktreeId: string; repoId: string; displayName?: string; path?: string; status?: string; workspaceStatus?: string; comment?: string; liveTerminalCount?: number; lastActivityAt?: string }[];
  terminals?: (Omit<Terminal, 'agent'> & { agent?: string; agentIdentity?: string })[];
  send?: { accepted?: boolean; handle?: string; prompt?: { requestId?: string } };
  outcome?: { kind?: string; handle?: string }; worktreeId?: string; receipt?: unknown;
  [key: string]: unknown;
}
export type OrcaRun = (args: string[], options?: { timeout?: number; signal?: AbortSignal }) => Promise<OrcaResponse>;
export function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
// An error that knows its HTTP status: 400 for a bad request, 409 for a state
// conflict, 502 when a provider failed, 503 when the server is not configured.
// Any other error that reaches the HTTP handler is a 500.
export class StatusError extends Error {
  constructor(readonly status: number, message: string, options?: ErrorOptions) { super(message, options); }
}
export interface StatusResponse {
  runtime: string; availability?: { error?: string }; ades: { id: string; name: string; capabilities: Capabilities; direct: boolean }[];
  conversation: Conversation; lastCall?: CallHistory; limitation?: string;
  voiceReady: boolean; voiceModel: { provider: VoiceProvider; model: string; reasoning: string; eagerness: string; noiseReduction: string; voice: string };
  eventCursor: number; voiceActive: string[]; serviceBusy: boolean;
}
// GET/POST /api/settings/voice and POST /api/settings/key: the server-wide voice
// settings, the values each one accepts and whether a key exists (never the key).
// geminiVoice applies when the model is a Gemini Live model, elevenlabsVoice to an ElevenLabs
// Realtime one; the others, except model, to OpenAI Realtime.
export type VoiceSettingField = 'model' | 'voice' | 'reasoning' | 'eagerness' | 'noiseReduction' | 'transcriptionModel' | 'geminiVoice' | 'elevenlabsVoice';
export type KeyState = { set: boolean; source: 'config' | 'env' | null };
export interface VoiceSettingsResponse {
  settings: Record<VoiceSettingField, string>; options: Record<VoiceSettingField, string[]>;
  // key: the OpenAI key; geminiKey: the Gemini API key; elevenlabsKey: the ElevenLabs API key.
  // provider: the one the model in use needs.
  key: KeyState; geminiKey: KeyState; elevenlabsKey: KeyState; provider: VoiceProvider; busy: boolean;
  // The owner's custom instructions ('' when none) and their maximum length.
  instructions: string; instructionsMax: number;
}
// Stored events of a call, as src/voice/realtime.mts publishes them: what the
// user and the agent said, and each tool run with sanitized details.
// order: position of the item in its call (src/voice/realtime.mts slot()).
// item: the provider's conversation item the transcript belongs to.
export interface TranscriptData { call: string; role: 'user' | 'assistant'; text: string; order: number; backend: string; conversationId: string; at?: string; item?: string }
export interface VoiceToolData {
  order: number;
  id: string; callId: string; name: string; status: 'completed' | 'error' | 'refused' | 'unknown'; ok: boolean;
  args?: unknown; result?: unknown; delivered?: unknown; backend: string; conversationId: string;
}
export type CallEvent = { id: number; type: 'transcript'; data: TranscriptData } | { id: number; type: 'voice-tool'; data: VoiceToolData };
export interface CallsResponse { backend: string; conversationId: string; events: CallEvent[]; truncated: boolean }

export interface Tracked { threadId: string; project?: string; title?: string; role?: string; link?: string; status?: string; terminalStatus?: string; observation?: string; checkedAt?: string; note?: string }
export interface Snapshot { checkedAt: string | null; status: string; backend: string; projects: (Project & { documents: string[]; activeTerminals: number })[]; tracked: Tracked[]; discovery?: Overview['discovery']; workspaces?: (Partial<Workspace> & { lastActivity?: string })[]; capabilities?: Capabilities; threadCount?: number; threadsTruncated?: boolean; threads?: Thread[]; error?: string; failedAt?: string }

// Thrown by a sending operation when it failed before anything could reach
// the ADE (validation, unknown ID, target check, journal refusal). Any other
// error of a send is treated as possibly delivered: uncertain, never retried.
// This server process. A journal's pending row written by another one
// (stopped or crashed) is no longer in flight; one of this process may be.
export const PROCESS_ID: string = globalThis.crypto.randomUUID();
export class NotDispatchedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) { super(message, options); this.name = 'NotDispatchedError'; }
}
