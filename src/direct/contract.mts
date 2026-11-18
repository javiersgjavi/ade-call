import type { DirectCallState } from './state.mjs';
export { NotDispatchedError } from '../shared/contracts.mjs';

// The contract between an ADE and the direct-tool engine. The engine (voice
// over WebRTC) knows nothing of T3 or Orca: it
// shows the ADE's catalog, offers its tools, gates the sending ones and passes
// confirmed deliveries to the thread watch. See docs/adapters.md.

export interface DirectToolContext {
  // Server identity of this tool call ("voice:CALL:CALL_ID").
  // Sending tools must use it for deduplication; the model never sets it.
  requestId: string;
  signal: AbortSignal;
  // Per-call memory: short IDs and earlier reads.
  state: DirectCallState;
}
// A delivery the ADE accepted. Only these start a thread watch; an uncertain
// or rejected one must not.
// A queued delivery has no runId yet: `before` is what the ADE showed just
// before the send (number of runs, latest run), so the watch follows only a
// run that starts after it and never adopts the turn that was already active.
export interface RunBaseline { runs?: number; latestRunId?: string | null }
export interface DeliveredThread { threadId: string; runId: string | null; link: string | null; project: string; before?: RunBaseline }
export interface DirectResult {
  // Plain text for the model: a JSON envelope escapes every quote and line.
  text: string;
  delivered?: DeliveredThread;
  // The thread this call read: a later end-of-turn notice about it is quiet.
  read?: string;
}
export interface DirectTool {
  name: string; description: string; parameters: unknown;
  // A tool that changes the ADE (send, launch). The engine runs it only after a
  // new transcribed user turn since the previous send (it does not check that
  // the turn accepts a proposal: the model judges that), at most once per call
  // ID, and never retries it. A sending execute() throws
  // NotDispatchedError when nothing reached the ADE ("Nothing was
  // sent"); any other error is reported as an uncertain delivery.
  sends?: boolean;
  // A sending tool that changes only ADE Call's journal (releasing an
  // uncertain send) and sends nothing: it needs a user turn like a send but
  // does not use it up, so the send the user decided can follow in that turn.
  keepsAuthorization?: boolean;
  // Resolves short IDs and validates arguments without side effects; a throw
  // means nothing ran. For sends the engine calls it before using the user's
  // authorization, and passes its result to execute().
  prepare?(params: Record<string, unknown>, state: DirectCallState): Record<string, unknown>;
  execute(params: Record<string, unknown>, context: DirectToolContext): Promise<DirectResult>;
}
// ADE-specific parts of the instructions. The engine adds the voice or text
// rules, evidence and send policy around them.
export interface DirectPrompt {
  // PAPEL: who the model is for this ADE and which tools it has.
  role: string;
  // The noun of a send destination, as the user hears it: "thread", "terminal".
  target: string;
  // What the model reads to check it, with its article: "the thread", "its terminal".
  source?: string;
  // Where a send goes when the user names no destination.
  destination: string;
  // ADE meanings of states the model must not misread (e.g. completed).
  evidence: string;
  // What cannot be done from here (stop work, cancel) and what to say instead.
  limits: string;
  // How IDs appear in the catalog and tools and how to pass them.
  ids: string;
  // Optional: how to look for a destination the user describes (e.g. which threads first).
  search?: string;
}
export interface DirectAde {
  id: string; name: string;
  tools: DirectTool[];
  prompt: DirectPrompt;
  // Compact catalog shown at the start of a session. It registers its IDs in
  // state so tools can resolve the short forms it prints. An ADE without a
  // cheap local read may answer a promise; it must settle (never reject) in a
  // few seconds, and the session does not wait for it before connecting.
  catalog(state: DirectCallState): string | Promise<string>;
  // Optional background warm-up when a session opens; never adds tokens.
  prefetch?(): void;
}
