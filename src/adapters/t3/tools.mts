import type { ToolDefinition } from '../../shared/contracts.mjs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { t3, t3Overview, t3FindThreads } from './client.mjs';
import { T3Coordinator } from './coordinator.mjs';
import { formatFound, formatReceipt, formatThreadList } from './format.mjs';
import { redact } from '../../direct/text.mjs';
import { errorText, toolSchema } from '../../resources.mjs';
import { NotDispatchedError } from '../../shared/contracts.mjs';

const result = (text: string, details: Record<string, unknown> = {}) => ({ content: [{ type: 'text', text: redact(text) }], details });
export const REQUEST_ID = /^[a-zA-Z0-9:_-]{8,180}$/;

// The T3 operations offered to the model: search, list and send. Thread reads
// are shaped per call by the direct layer (src/direct/t3.mts). No Bash or
// arbitrary writes; T3 state changes only through its CLI. requestId comes
// from the server, never from the model.
// ADE Call's private state (the T3 journal lives here).
export const defaultState = () => join(process.env.ADE_CALL_STATE || join(homedir(), '.local/share/ade-call'), 'ades', 't3');
export function t3Tools({ run = t3, overview = t3Overview, findThreads = t3FindThreads,
  state = defaultState(),
  coordinatorFactory = () => new T3Coordinator(state, run) } = {}): ToolDefinition<'t3_find_threads' | 't3_list_threads' | 't3_send_message'>[] {
  return [{ name: 't3_find_threads', label: 'Find threads by title', ...toolSchema('t3_find_threads'),
    async execute(_id, params, signal) { signal?.throwIfAborted(); return result(formatFound({ checkedAt: new Date().toISOString(), ...findThreads(params) })); } },
  { name: 't3_list_threads', label: 'Browse T3 projects and threads', ...toolSchema('t3_list_threads'),
    async execute(_id, params, signal) {
      signal?.throwIfAborted();
      // A text "false" must not widen the listing: only a boolean, or null for omitted.
      if (params.includeSubagents != null && typeof params.includeSubagents !== 'boolean') throw new Error(errorText('t3.list.invalid_flag', { field: 'includeSubagents' }));
      // A parent or root asks for subagents by itself.
      const includeSubagents = !!(params.parentThreadId || params.rootThreadId || params.includeSubagents);
      const data = await overview({ ...params, includeSubagents, signal });
      signal?.throwIfAborted();
      return result(formatThreadList({ checkedAt: new Date().toISOString(), subagents: includeSubagents ? 'requested' : 'not_requested', scope: params.parentThreadId ? 'direct_children' : params.rootThreadId ? 'descendants' : includeSubagents ? 'full' : 'top_level', projects: data.projects, discovery: data.discovery,
        threads: data.threads.filter(t => (!params.projectId || t.projectId === params.projectId) && (!params.parentThreadId || t.parentThreadId === params.parentThreadId) && (!params.rootThreadId || t.rootThreadId === params.rootThreadId)) }));
    } },
  { name: 't3_send_message', label: 'Send message to T3', ...toolSchema('t3_send_message'),
    async execute(requestId, params, signal) {
      if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) throw new NotDispatchedError(errorText('send.missing_request_id'));
      let coordinator: ReturnType<typeof coordinatorFactory>;
      try { coordinator = coordinatorFactory(); } catch (error) { throw new NotDispatchedError(errorText('send.journal_unavailable', { code: (error as { code?: string })?.code || 'cause without a code' })); }
      try {
        const receipt = await coordinator.dispatch({ ...params, requestId }, signal);
        // Structured copy for the server's thread follow-up; the model reads the text.
        return result(formatReceipt(receipt), { receipt: { status: receipt.status, threadId: receipt.threadId, project: receipt.project, runId: receipt.runId, link: receipt.link, before: receipt.before } });
      }
      finally { coordinator.close(); }
    } }];
}
