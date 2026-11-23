import type { Message } from '../shared/contracts.mjs';
import { createHash } from 'node:crypto';
import { NotDispatchedError, type DeliveredThread, type DirectAde } from './contract.mjs';
import { DirectCallState } from './state.mjs';
import { userTurnSince } from '../conversation/intent.mjs';
import { boundedResult } from '../voice/result-parts.mjs';
import { redact } from './text.mjs';

export interface FunctionCall { name?: string; call_id?: string; arguments?: string }
export interface ToolRun {
  // refused: nothing ran. unknown: a send failed after it may have happened.
  callId: string; name: string; args: Record<string, unknown> | null; status: 'completed' | 'error' | 'refused' | 'unknown'; output: string;
  delivered?: DeliveredThread; read?: string;
}

// The server identity of one function call ("voice:CALL:CALL_ID"), the key
// of a send in the ADE's journal. Distinct
// call IDs always give distinct request IDs: a part that is not a short plain
// token is hashed (with an "h:" prefix no plain part can have), never cut.
export function requestIdFor(channel: 'voice', scope: string, callId: string) {
  const part = (value: string, max: number) => new RegExp(`^[a-zA-Z0-9_-]{1,${max}}$`).test(value) ? value : 'h:' + createHash('sha256').update(value).digest('hex').slice(0, 40);
  return `${channel}:${part(scope, 100)}:${part(callId, 64)}`;
}

// What the model gets when running a tool failed in the server itself, outside
// the tool's own error handling: read tools read nothing, a send may have happened.
export function toolFailure(ade: Pick<DirectAde, 'tools' | 'prompt'>, name: string | undefined): { status: 'refused' | 'error' | 'unknown'; output: string } {
  const tool = ade.tools.find(t => t.name === name);
  if (!tool) return { status: 'refused', output: `ERROR: the tool ${name || 'without a name'} is not available. Nothing was executed. Use only the tools of this session.` };
  if (tool.sends) return { status: 'unknown', output: `ERROR: ${tool.name} failed on the server without a confirmed result. The send may have happened: do not repeat it. Read ${ade.prompt.source || `the ${ade.prompt.target}`} now to check whether it arrived and tell the user.` };
  return { status: 'error', output: `ERROR: ${tool.name} failed on the server. Nothing was read; you may repeat the read once; if it fails again, tell the user.` };
}
// An abort or timeout error carries an English message from the runtime.
function describe(error: unknown) {
  const e = error as Error & { cause?: Error } | null;
  if ([e?.name, e?.cause?.name].some(n => n === 'TimeoutError' || n === 'AbortError') || /^(?:This|The) operation was aborted/.test(String(e?.message)))
    return 'the operation was interrupted: it exceeded the time limit or the session closed.';
  return redact(String(e?.message || error)).slice(0, 600);
}

// The ADE-agnostic core of a voice call: the turns that authorize a send, the
// per-call ID memory and the execution of one function call of the model.
export class DirectSession {
  history: Message[] = []; toolIds = new Set<string>(); submittedThrough?: Message;
  echoes = new WeakSet<Message>();
  // Messages placed in conversation order before their text arrives (voice).
  items = new Map<string, Message>();
  state: DirectCallState;
  constructor(readonly ade: DirectAde, now: () => number = Date.now) { this.state = new DirectCallState(now); }
  remember(role: 'user' | 'assistant', text: string) {
    const message: Message = { role, text };
    this.history.push(message); this.trim();
    return message;
  }
  // Reserves the place of a conversation item (a committed user turn, an
  // assistant answer) whose text arrives later; fill() gives it its text there.
  place(itemId: string, role: 'user' | 'assistant') {
    const known = this.items.get(itemId);
    if (known) return known;
    const message: Message = { role, text: '' };
    this.items.set(itemId, message); this.history.push(message); this.trim();
    return message;
  }
  // echo: a transcript that only recites the recognition hints (isHintEcho).
  // It keeps its place in the history but is not a user turn for the gate.
  fill(itemId: string | undefined, role: 'user' | 'assistant', text: string, { echo = false } = {}) {
    const placed = itemId ? this.items.get(itemId) : undefined;
    const message = placed || this.remember(role, text);
    if (placed) { placed.text = text; this.items.delete(itemId!); }
    if (echo) this.echoes.add(message);
    return message;
  }
  // An item that will never get text (failed transcription) leaves no gap.
  forget(itemId: string | undefined) {
    const placed = itemId ? this.items.get(itemId) : undefined;
    if (!placed) return;
    this.items.delete(itemId!);
    if (!placed.text) this.history = this.history.filter(m => m !== placed);
  }
  trim() {
    if (this.history.length <= 200) return;
    this.history = this.history.slice(-200);
    const kept = new Set(this.history);
    for (const [id, m] of this.items) if (!kept.has(m)) this.items.delete(id);
  }
  catalog() { return this.ade.catalog(this.state); }
  // The messages the send gate reads: only those with text (a place still
  // waiting for its transcript is not a turn) and no echo of the hints.
  turns() { return this.history.filter(m => m.text && !this.echoes.has(m)); }
  // Why a send must not run now, or null when the turn authorizes it.
  // through: only the conversation up to this item counts (see run's arrival).
  sendRefusal(through?: { at: Message | undefined }) {
    let history = this.turns();
    if (through) { const end = through.at ? history.indexOf(through.at) : -1; history = history.slice(0, end + 1); }
    // A send needs words of the user since the previous send.
    if (!userTurnSince(history, this.submittedThrough)) return 'NOT SENT (no_user_turn): there is no new request from the user. Nothing was sent; ask or listen.';
    return null;
  }
  // Runs one function call at most once per call ID. beforeSend lets the voice
  // wait for the transcript that authorizes a send; false abandons the call.
  // arrival: the latest conversation item when the provider asked for the call,
  // for a provider whose transcripts always precede the calls they authorize:
  // words transcribed after the call arrived never authorize it.
  async run(item: FunctionCall, { requestId, signal, beforeSend, arrival }: { requestId: string; signal: AbortSignal; beforeSend?: () => Promise<boolean>; arrival?: { at: Message | undefined } }): Promise<ToolRun | null> {
    const callId = item.call_id, tool = this.ade.tools.find(t => t.name === item.name);
    if (!callId || this.toolIds.has(callId)) return null;
    this.toolIds.add(callId);
    const name = item.name || 'desconocida';
    if (!tool) return { callId, name, args: null, status: 'refused', output: `ERROR: the tool ${name} is not available. Nothing was executed. Use only the tools of this session; if the operation is missing, explain the limit.` };
    let args: Record<string, unknown>;
    try { args = JSON.parse(item.arguments || '{}'); } catch { return { callId, name, args: null, status: 'refused', output: 'ERROR: invalid arguments; nothing was executed. Fix the JSON object according to the tool parameters.' }; }
    if (!args || typeof args !== 'object' || Array.isArray(args)) return { callId, name, args: null, status: 'refused', output: 'ERROR: invalid arguments; nothing was executed. Fix the JSON object according to the tool parameters.' };
    // A send error that already says what happened and what to do needs no generic tail.
    const notSent = (error: unknown) => {
      const message = describe(error);
      return { callId, name, args, status: 'error' as const,
        output: 'ERROR: ' + message + (tool.sends
          ? (/nothing was (?:sent|changed)/i.test(message) ? '' : '\nNothing was sent in this attempt. If you fix the cause, you may try again with the same authorized destination and request. If there is an earlier uncertain delivery, check it by reading and do not repeat it.')
          : '\nQuery without a verifiable result; it does not prove that the resource does not exist or that the work has finished. Fix the parameters if they are invalid; if the failure is temporary, you may repeat only the read. If it persists, report the limit and avoid a loop of queries.') };
    };
    let params = args, authorizedFrom: Message | undefined, consumed: Message | undefined;
    if (tool.sends) {
      if (beforeSend && !await beforeSend()) return null;
      const refusal = this.sendRefusal(arrival);
      if (refusal) return { callId, name, args, status: 'refused', output: refusal };
      // IDs and arguments are checked before the authorization is used: a bad
      // short ID sends nothing and leaves the user's yes for a corrected call.
      try { params = tool.prepare ? tool.prepare(args, this.state) : args; } catch (error) { return notSent(error); }
      if (!tool.keepsAuthorization) {
        authorizedFrom = this.submittedThrough;
        consumed = this.submittedThrough = arrival ? arrival.at : this.turns().at(-1);
      }
    }
    try {
      const result = await tool.execute(params, { requestId, signal, state: this.state });
      return { callId, name, args, status: 'completed', output: boundedResult(result.text, 12_000).text,
        ...(tool.sends && result.delivered ? { delivered: result.delivered } : {}), ...(result.read ? { read: result.read } : {}) };
    } catch (error) {
      // Only an error after the dispatch may have started is uncertain.
      if (!tool.sends || error instanceof NotDispatchedError) {
        // Nothing reached the ADE: the user's yes still authorizes a corrected call,
        // unless another send has used it meanwhile.
        if (tool.sends && consumed && this.submittedThrough === consumed) this.submittedThrough = authorizedFrom;
        return notSent(error);
      }
      return { callId, name, args, status: 'unknown', output: 'ERROR: ' + describe(error)
        + `\nDelivery not confirmed: it may have happened. Do not repeat it, not with another ID nor by starting another request. Read ${this.ade.prompt.source || `the ${this.ade.prompt.target}`} now to check whether it arrived and tell the user; an empty or failed read does not prove it was not delivered.` };
    }
  }
}
