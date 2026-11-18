import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { t3, t3Base } from './client.mjs';

// Each T3 CLI call costs about a second of process start-up on a small host,
// of which the query itself is a fraction. This cache keeps the CLI's own
// answers in server memory and reuses one only while a fingerprint read from
// T3's local projection (read only, under a millisecond) is unchanged. The
// voice receives the same text it would get from the CLI: no extra tokens.
// Any doubt (no fingerprint, database error, other commands) means a real CLI call.
type Run = typeof t3;
type Fingerprint = (kind: 'thread' | 'project', id: string) => string | null;
const MIN_FETCH = 60;
interface Entry { fingerprint: string; value: unknown; messages?: number; at: number }
// A CLI read in progress: a second reader of the same key and fingerprint waits for it.
interface Pending { fingerprint: string; messages?: number; value: Promise<unknown> }
type Open = (path: string) => DatabaseSync;
const openReadOnly: Open = path => new DatabaseSync(path, { readOnly: true });

// One read-only handle per fingerprint, opened on first use; an error closes
// it (no leaked descriptor or WAL reader) and the next call opens it again.
export function t3Fingerprint(base = t3Base, open: Open = openReadOnly): Fingerprint {
  let db: DatabaseSync | null = null;
  return (kind, id) => {
    try {
      db ||= open(join(base, 'userdata/statev2.sqlite'));
      // Thread row, its runs (status and completion) and its messages
      // (count, last change, streaming) all change what the CLI reports.
      const scope = kind === 'thread' ? 'thread_id = ?' : 'thread_id IN (SELECT thread_id FROM orchestration_v2_projection_threads WHERE project_id = ?)';
      const threads = db.prepare(`SELECT COUNT(*) AS n, MAX(updated_at) AS u, MAX(COALESCE(archived_at, '')) AS a, MAX(COALESCE(deleted_at, '')) AS d FROM orchestration_v2_projection_threads WHERE ${kind === 'thread' ? 'thread_id' : 'project_id'} = ?`).get(id);
      if (!threads || !threads.n) return null;
      const runs = db.prepare(`SELECT COUNT(*) AS n, MAX(ordinal) AS o, GROUP_CONCAT(status, ',') AS s, MAX(COALESCE(completed_at, '')) AS c FROM orchestration_v2_projection_runs WHERE ${scope}`).get(id);
      const messages = db.prepare(`SELECT COUNT(*) AS n, MAX(updated_at) AS u, SUM(CASE WHEN streaming THEN 1 ELSE 0 END) AS s FROM orchestration_v2_projection_messages WHERE ${scope}`).get(id);
      const requests = db.prepare(`SELECT COUNT(*) AS n, GROUP_CONCAT(status, ',') AS s FROM orchestration_v2_projection_runtime_requests WHERE ${scope}`).get(id);
      // A message being written changes on every token: never reuse it.
      if (Number(messages?.s || 0) > 0) return null;
      return JSON.stringify([threads, runs, messages, requests]);
    } catch {
      try { db?.close(); } catch { /* Already unusable. */ }
      db = null; return null;
    }
  };
}

export class T3ReadCache {
  entries = new Map<string, Entry>(); pending = new Map<string, Pending>(); hits = 0; misses = 0; shared = 0;
  // Created once: every read reuses the same read-only handle.
  readonly fingerprint: Fingerprint;
  constructor(readonly options: { run?: Run; fingerprint?: Fingerprint; maxEntries?: number; maxAgeMs?: number; now?: () => number } = {}) {
    this.fingerprint = options.fingerprint || t3Fingerprint();
  }
  get now() { return this.options.now?.() ?? Date.now(); }
  // Drop-in replacement for t3(): only reads are cached.
  run: Run = async (args, options = {}) => {
    const run = this.options.run || t3, fingerprint = this.fingerprint;
    const show = args[0] === 'thread' && args[1] === 'show' && args.length === 5 && args[3] === '--messages';
    const list = args[0] === 'thread' && args[1] === 'list' && args.length === 4 && args[2] === '--project';
    if (!show && !list) return run(args, options);
    const key = show ? `show:${args[2]}` : `list:${args[3]}`, wanted = show ? Number(args[4]) : undefined;
    // Taken before the call: a change during the call invalidates the result.
    const current = fingerprint(show ? 'thread' : 'project', show ? args[2] : args[3]);
    const entry = this.entries.get(key);
    if (current && entry && entry.fingerprint === current && this.now - entry.at < (this.options.maxAgeMs ?? 10 * 60_000)
      && (!show || (entry.messages ?? 0) >= wanted!)) {
      this.hits++;
      const value = structuredClone(entry.value) as { messages?: unknown[] };
      // The CLI returns the latest N messages in order: a larger read contains a smaller one.
      if (show && Array.isArray(value?.messages) && value.messages.length > wanted!) value.messages = value.messages.slice(-wanted!);
      return value as Awaited<ReturnType<Run>>;
    }
    // The same read already running (e.g. the prefetch) with an unchanged
    // fingerprint answers this one too; its failure means a call of our own.
    const pending = this.pending.get(key);
    if (current && pending && pending.fingerprint === current && (!show || (pending.messages ?? 0) >= wanted!)) {
      const value = await pending.value.then(v => structuredClone(v) as { messages?: unknown[] }, () => null);
      options.signal?.throwIfAborted();
      if (value) {
        this.shared++;
        if (show && Array.isArray(value?.messages) && value.messages.length > wanted!) value.messages = value.messages.slice(-wanted!);
        return value as Awaited<ReturnType<Run>>;
      }
    }
    this.misses++;
    // Start-up dominates a CLI call: fetch a generous window once so later
    // re-reads of this thread are served from memory, then return what was asked.
    const fetched = show ? Math.max(wanted!, MIN_FETCH) : undefined;
    const call = run(show ? [...args.slice(0, 4), String(fetched)] : args, options);
    // Waiters get a snapshot taken as soon as the CLI answers, before any caller can alter it.
    const mine: Pending | undefined = current ? { fingerprint: current, messages: fetched, value: call.then(v => structuredClone(v)) } : undefined;
    mine?.value.catch(() => { /* Each waiter falls back to its own call. */ });
    if (mine) this.pending.set(key, mine);
    let value: { messages?: unknown[] };
    try { value = await call as { messages?: unknown[] }; }
    finally { if (mine && this.pending.get(key) === mine) this.pending.delete(key); }
    if (current) this.store(key, { fingerprint: current, value: structuredClone(value), messages: fetched, at: this.now });
    if (show && Array.isArray(value?.messages) && value.messages.length > wanted!) value.messages = value.messages.slice(-wanted!);
    return value as Awaited<ReturnType<Run>>;
  };
  store(key: string, entry: Entry) {
    this.entries.delete(key); this.entries.set(key, entry);
    for (const old of this.entries.keys()) { if (this.entries.size <= (this.options.maxEntries ?? 120)) break; this.entries.delete(old); }
  }
  // Background warm-up, one CLI process at a time. Failures only mean a later miss.
  async prefetch(threadIds: string[], projectIds: string[], messages = MIN_FETCH, signal?: AbortSignal) {
    for (const [kind, id] of [...threadIds.map(id => ['thread', id] as const), ...projectIds.map(id => ['project', id] as const)]) {
      if (signal?.aborted) return;
      try { await this.run(kind === 'thread' ? ['thread', 'show', id, '--messages', String(messages)] : ['thread', 'list', '--project', id], { signal }); } catch { /* A miss later. */ }
    }
  }
}

// The threads with the most recent activity, and their projects: what a call
// is most likely to ask about first.
export function recentThreads(limit = 4, base = t3Base) {
  try {
    const db = new DatabaseSync(join(base, 'userdata/statev2.sqlite'), { readOnly: true });
    try {
      const rows = db.prepare(`SELECT thread_id AS threadId, project_id AS projectId FROM orchestration_v2_projection_threads
        WHERE archived_at IS NULL AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT ?`).all(limit) as { threadId: string; projectId: string }[];
      return { threadIds: rows.map(r => r.threadId), projectIds: [...new Set(rows.map(r => r.projectId))] };
    } finally { db.close(); }
  } catch { return { threadIds: [], projectIds: [] }; }
}
