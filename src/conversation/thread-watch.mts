import type { T3Response, Message } from '../shared/contracts.mjs';
import { boundedResult } from '../voice/result-parts.mjs';

// Follows threads that received a confirmed delivery so the voice can report
// progress and the end of the agent's turn without waiting to be asked. It only
// reads through the ADE CLI; it never sends, retries or cancels work.
export type ThreadNoticeKind = 'progress' | 'working' | 'finished' | 'failed' | 'stopped';
export interface ThreadNotice {
  kind: ThreadNoticeKind; threadId: string; title: string; project: string; conversationId?: string;
  link?: string | null; text?: string; minutes?: number;
  // Already read with a tool after it ended: context only, not to be spoken.
  quiet?: boolean;
}
// before: runs and latest run of the thread just before a delivery without
// runId (queued). Only a later run is followed. Without it, the first poll is
// the baseline: a run that started and ended before that poll is missed (no
// notice), never confused with an earlier turn.
export interface WatchRequest { threadId: string; project: string; runId?: string | null; conversationId?: string; link?: string | null; before?: { runs?: number; latestRunId?: string | null } }
interface Watch extends WatchRequest {
  addedAt: number; polledAt: number; spokenAt: number; seenActive: boolean; failures: number;
  seen: Set<string>; pendingProgress?: string; final?: ThreadNotice; title: string; readAt?: number;
}
// Spontaneous voice notices wait until the user has been quiet this long.
export const USER_QUIET_MS = 2500;
type Reader = (threadId: string) => Promise<T3Response>;
type Deliver = (notice: ThreadNotice) => boolean;

const WORKING = new Set(['running', 'starting', 'preparing', 'queued', 'in_progress', 'busy']);
const FAILED = new Set(['failed', 'error']);
const STOPPED = new Set(['interrupted', 'stopped', 'cancelled', 'canceled']);
const key = (m: Message) => `${m.runId || ''}\u0000${m.role}\u0000${m.text}`;
// Byte bound keeps headers under the append limit whatever the alphabet.
function clip(text: string, maxBytes: number) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (Buffer.byteLength(clean) <= maxBytes) return clean;
  let out = '';
  for (const char of clean) { if (Buffer.byteLength(out + char) > maxBytes - 3) break; out += char; }
  return out + '…';
}

export interface ThreadWatchOptions {
  read: Reader; deliver: Deliver; now?: () => number;
  activePollMs?: number; idlePollMs?: number; progressEveryMs?: number; firstProgressMs?: number; heartbeatMs?: number;
  maxAgeMs?: number; maxQueuedMs?: number; maxWatches?: number;
}
export class ThreadWatch {
  read: Reader; deliver: Deliver; now: () => number; watches: Map<string, Watch>; ticking: Promise<void> | null;
  activePollMs: number; idlePollMs: number; progressEveryMs: number; firstProgressMs: number; heartbeatMs: number;
  maxAgeMs: number; maxQueuedMs: number; maxWatches: number;
  constructor({ read, deliver, now = Date.now, activePollMs = 8000, idlePollMs = 60_000, progressEveryMs = 40_000, firstProgressMs = 15_000,
    heartbeatMs = 120_000, maxAgeMs = 3 * 3600_000, maxQueuedMs = 30 * 60_000, maxWatches = 6 }: ThreadWatchOptions) {
    this.read = read; this.deliver = deliver; this.now = now; this.watches = new Map(); this.ticking = null;
    this.activePollMs = activePollMs; this.idlePollMs = idlePollMs; this.progressEveryMs = progressEveryMs; this.firstProgressMs = firstProgressMs;
    this.heartbeatMs = heartbeatMs; this.maxAgeMs = maxAgeMs; this.maxQueuedMs = maxQueuedMs; this.maxWatches = maxWatches;
  }
  add(request: WatchRequest) {
    if (typeof request.threadId !== 'string' || !request.threadId) return;
    const now = this.now(), previous = this.watches.get(request.threadId);
    this.watches.delete(request.threadId);
    // A new delivery to the same thread follows its new run; messages already
    // observed are not reported again.
    this.watches.set(request.threadId, { ...request, title: previous?.title || '', addedAt: now, polledAt: -Infinity,
      spokenAt: now - this.progressEveryMs + this.firstProgressMs, seenActive: false, failures: 0, seen: previous?.seen || new Set() });
    while (this.watches.size > this.maxWatches) this.watches.delete(this.watches.keys().next().value!);
  }
  // A tool read this thread: an end already seen is not announced again.
  markRead(threadId: string) { const watch = this.watches.get(threadId); if (watch) watch.readAt = this.now(); }
  // Only the conversation in use receives notices; older ones are discarded.
  retain(conversationId: string) { for (const [id, watch] of this.watches) if (watch.conversationId && watch.conversationId !== conversationId) this.watches.delete(id); }
  tick(active: boolean) {
    this.ticking ||= this.poll(active).finally(() => { this.ticking = null; });
    return this.ticking;
  }
  async poll(active: boolean) {
    for (const watch of [...this.watches.values()]) {
      const now = this.now();
      if (now - watch.addedAt > this.maxAgeMs) { this.watches.delete(watch.threadId); continue; }
      if (watch.final) { if (this.deliver(watch.final)) this.watches.delete(watch.threadId); continue; }
      if (now - watch.polledAt < (active ? this.activePollMs : this.idlePollMs)) continue;
      watch.polledAt = now;
      let data: T3Response;
      try { data = await this.read(watch.threadId); watch.failures = 0; }
      catch { if (++watch.failures >= 5) this.watches.delete(watch.threadId); continue; }
      if (this.watches.get(watch.threadId) !== watch) continue; // Replaced meanwhile.
      this.observe(watch, data, active);
    }
  }
  observe(watch: Watch, data: T3Response, active: boolean) {
    const thread = data.thread, now = this.now();
    if (!thread) return;
    watch.title = thread.title || watch.title; watch.link = thread.link || watch.link;
    const activeRun = thread.activeRunId || null, latestRun = thread.latestRunId || null;
    // A delivery without runId (queued) follows the first run that starts
    // after it, running or already ended; the run active at delivery is not ours.
    if (!watch.runId) {
      const runs = typeof thread.runCount === 'number' ? thread.runCount : undefined;
      watch.before ||= { runs, latestRunId: latestRun };
      const later = runs !== undefined && watch.before.runs !== undefined ? runs > watch.before.runs
        : !!latestRun && latestRun !== (watch.before.latestRunId ?? null);
      if (later && latestRun) watch.runId = latestRun;
      else { if (now - watch.addedAt > this.maxQueuedMs) this.watches.delete(watch.threadId); return; }
    }
    const ours = (m: Message) => m.role === 'assistant' && !!m.text?.trim() && m.runId === watch.runId;
    const messages = (data.messages || []).filter(ours);
    const running = activeRun === watch.runId || (latestRun === watch.runId && WORKING.has(thread.status || ''));
    const fresh = messages.filter(m => !watch.seen.has(key(m)));
    for (const m of fresh) watch.seen.add(key(m));
    const base = { threadId: watch.threadId, title: watch.title, project: watch.project, conversationId: watch.conversationId, link: watch.link };
    if (running) {
      watch.seenActive = true;
      if (fresh.length) watch.pendingProgress = fresh.at(-1)!.text;
      if (!active) return;
      if (watch.pendingProgress && now - watch.spokenAt >= this.progressEveryMs) {
        if (this.deliver({ ...base, kind: 'progress', text: watch.pendingProgress })) { watch.pendingProgress = undefined; watch.spokenAt = now; }
      } else if (!watch.pendingProgress && now - watch.spokenAt >= this.heartbeatMs) {
        if (this.deliver({ ...base, kind: 'working', minutes: Math.max(1, Math.round((now - watch.addedAt) / 60_000)) })) watch.spokenAt = now;
      }
      return;
    }
    const started = watch.seenActive || latestRun === watch.runId || messages.length > 0;
    if (!started) { if (now - watch.addedAt > this.maxQueuedMs) this.watches.delete(watch.threadId); return; }
    const status = thread.status || '';
    const endedAt = Date.parse(thread.updatedAt || '');
    const quiet = watch.readAt != null && (!Number.isFinite(endedAt) || watch.readAt > endedAt);
    watch.final = { ...base, kind: FAILED.has(status) ? 'failed' : STOPPED.has(status) ? 'stopped' : 'finished', text: messages.at(-1)?.text, quiet };
    if (this.deliver(watch.final)) this.watches.delete(watch.threadId);
  }
}

// Spoken wording shared by every voice provider. Each piece stays well under
// the 480-byte append bound; long final answers are split by the provider.
export function noticeHeader(n: ThreadNotice) {
  const where = `"${clip(n.title || 'untitled', 90)}"${n.project ? ` (${clip(n.project, 50)})` : ''}`;
  if (n.quiet) return `System notice: the T3 agent finished its turn in ${where} and you have read that thread since. Do not announce it again unless the user asks.`;
  if (n.kind === 'working') return `System notice: the T3 agent is still working in ${where}; it has been about ${n.minutes} min and there are no new messages. If the user is not speaking, tell them in one very short sentence so they know it is still going.`;
  if (n.kind === 'progress') return `System notice: the T3 agent is still working in ${where}. If the user is not speaking, report this progress in one or two natural sentences, without reading it literally or saying it has finished.`;
  const outcome = n.kind === 'failed' ? 'has finished with an error' : n.kind === 'stopped' ? 'has stopped' : 'has finished its turn';
  return `System notice: the T3 agent ${outcome} in ${where}${n.kind === 'finished' ? ' and has answered' : ''}. Report it now, without waiting to be asked (if the user is speaking, as soon as they finish), with a short summary and its final question if there is one.`;
}
export function noticeBody(n: ThreadNotice, maxBytes: number) {
  if (n.quiet || n.kind === 'working') return '';
  return n.text?.trim() ? boundedResult(n.text, maxBytes).text : n.kind === 'progress' ? '' : 'There is no visible answer text; the details are on the web.';
}
