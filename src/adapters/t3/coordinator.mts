import type { Message, T3Response } from '../../shared/contracts.mjs';
interface MainThread { projectId: string; project: string; threadId: string; link: string | null | undefined }
type Delivery = NonNullable<T3Response['delivery']> | 'unverified';
interface DispatchReceipt extends MainThread { requestId: string; status: string; runId: string | null; delivery?: Delivery; before?: { runs?: number; latestRunId?: string | null }; note?: string }
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { cliId, t3, t3Projects, t3ThreadGone } from './client.mjs';
import { NotDispatchedError, PROCESS_ID, errorMessage } from '../../shared/contracts.mjs';
import { ago } from '../../direct/text.mjs';
import { errorText, t3DeliveryPrompt } from '../../resources.mjs';

// The first line of every prompt the coordinator sends: a user message of a
// thread that starts with it (at a line start) carries that send's reference.
export const referenceLine = (requestId: string) => `Request received by ADE Call. Reference: ${requestId}.`;
const REFERENCE = /^Request received by ADE Call\. Reference: ([a-zA-Z0-9:_-]{8,180})\.$/gm;
// The references in the user messages of a thread. Agent or system messages
// do not count: an agent can quote a reference without the send having arrived there.
export function sentReferences(messages: Message[] = []) {
  return new Set(messages.filter(m => m.role === 'user').flatMap(m => [...String(m.text ?? '').matchAll(REFERENCE)].map(r => r[1])));
}

interface DispatchRow { requestId: string; projectId: string; message: string; status: string; receipt: string | null; target: string | null; createdAt: number; targetThread: string | null; targetTitle: string | null; owner: string; attempted: number }
const named = (id: string, title?: string | null) => title ? `"${title.replace(/\s+/g, ' ').trim()}" · ${id}` : id;
// Where an earlier send went and how long ago, from what the journal kept.
function earlier(row: DispatchRow, now: number) {
  const when = `${ago(now - row.createdAt)} ago`;
  const thread = row.targetThread || row.target;
  return { when, thread, where: thread ? `to thread ${named(thread, row.targetTitle)}` : row.targetTitle ? `to create thread "${row.targetTitle}"` : 'to the project\'s main thread' };
}
// What the model must do now to check an earlier send: read its thread, or find a main thread it may have created.
const check = (row: DispatchRow, now: number) => {
  const { thread } = earlier(row, now);
  return thread ? 'read that thread now with t3_read_thread' : `find ${row.targetTitle ? `"${row.targetTitle}"` : 'the main thread'} now with t3_find_threads and read it with t3_read_thread`;
};
// Uncertain rows: unknown, or pending (in flight in this process, or left by another one).
const UNCERTAIN = "status IN ('pending','unknown')";

// This journal is Caller-owned. Native T3 state is changed only through its CLI.
export class T3Coordinator {
  state: string; run: typeof t3; db: DatabaseSync; projects: () => { id: string; name: string }[]; now: () => number; owner: string; threadGone: (threadId: string) => boolean;
  // projects only names the project a thread belongs to in an error (read
  // only); threadGone tells a deleted main thread from a failed read (read only).
  constructor(state: string, run = t3, { projects = t3Projects, now = Date.now, owner = PROCESS_ID, threadGone = (id: string) => t3ThreadGone(id) }:
    { projects?: () => { id: string; name: string }[]; now?: () => number; owner?: string; threadGone?: (threadId: string) => boolean } = {}) {
    this.state = state; this.run = run; this.projects = projects; this.now = now; this.owner = owner; this.threadGone = threadGone;
    mkdirSync(state, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(state, 'dispatch.sqlite'));
    chmodSync(join(state, 'dispatch.sqlite'), 0o600);
    this.db.exec(`PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS main_threads(projectId TEXT PRIMARY KEY, project TEXT, threadId TEXT, link TEXT);
      -- target: the thread the user named (NULL: the project's main thread);
      -- createdAt, targetThread, targetTitle: what an error about an earlier send
      -- can say (when, where); owner: the process that wrote the row;
      -- attempted: whether the CLI send was invoked (0 = not yet).
      CREATE TABLE IF NOT EXISTS dispatches(requestId TEXT PRIMARY KEY, projectId TEXT NOT NULL, message TEXT NOT NULL, status TEXT NOT NULL, receipt TEXT,
        target TEXT, createdAt INTEGER NOT NULL, targetThread TEXT, targetTitle TEXT, owner TEXT NOT NULL, attempted INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS followed_threads(threadId TEXT PRIMARY KEY, projectId TEXT, project TEXT, link TEXT);`);
  }
  // A pending row of another process whose CLI send was never invoked
  // (attempted=0, written just before invoking it) provably sent nothing:
  // release it.
  releaseStale() {
    this.db.prepare(`UPDATE dispatches SET status='released', receipt=? WHERE status='pending' AND attempted=0 AND owner<>?`)
      .run(JSON.stringify({ status: 'released', reason: 'not_attempted', at: this.now() }), this.owner);
  }
  inFlight(row: DispatchRow) { return row.status === 'pending' && row.owner === this.owner; }
  blocking(projectId: string) {
    return this.db.prepare(`SELECT * FROM dispatches WHERE projectId=? AND ${UNCERTAIN} ORDER BY rowid DESC`).get(projectId) as unknown as DispatchRow | undefined;
  }
  // Errors before the CLI send is attempted are NotDispatchedError: nothing
  // reached T3. Later ones may have delivered and stay uncertain.
  async dispatch(request: { requestId: string; projectId: string; project: string; message: string; threadId?: string }, signal?: AbortSignal) {
    let attempted = false;
    try { return await this.deliver(request, () => { attempted = true; }, signal); }
    catch (error) { throw attempted || error instanceof NotDispatchedError ? error : new NotDispatchedError(errorMessage(error), { cause: error }); }
  }
  async deliver({ requestId, projectId, project, message, threadId }: { requestId: string; projectId: string; project: string; message: string; threadId?: string }, attempt: () => void, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const missing = (value: unknown) => typeof value !== 'string' || !value.trim();
    if (missing(requestId)) throw new Error(errorText('send.missing_request_id'));
    if (missing(projectId)) throw new Error(errorText('t3.send.missing_project_id'));
    if (missing(project)) throw new Error(errorText('t3.send.missing_project'));
    if (missing(message)) throw new Error(errorText('t3.send.missing_message'));
    if (!cliId(projectId)) throw new Error(errorText('t3.send.invalid_project_id'));
    if (threadId !== undefined && threadId !== null && (missing(threadId) || !cliId(threadId))) throw new Error(errorText('t3.send.invalid_thread_id'));
    this.db.exec('BEGIN IMMEDIATE');
    let main: MainThread | undefined;
    try {
      this.releaseStale();
      const previous = this.db.prepare('SELECT * FROM dispatches WHERE requestId=?').get(requestId) as unknown as DispatchRow | undefined;
      if (previous) {
        if (previous.projectId !== projectId || previous.message !== message || (previous.target || null) !== (threadId || null)) throw new Error(errorText('t3.send.request_conflict'));
        if (previous.status === 'rejected') throw new Error(errorText('t3.send.repeat_rejected', { when: earlier(previous, this.now()).when }));
        if (previous.status === 'released') throw new Error(errorText('t3.send.repeat_released', { when: earlier(previous, this.now()).when }));
        if (previous.status !== 'delivered') {
          const e = earlier(previous, this.now());
          throw new Error(errorText('t3.send.repeat_uncertain', { when: e.when, where: e.where, check: check(previous, this.now()) }));
        }
        this.db.exec('COMMIT'); this.registry();
        return JSON.parse(previous.receipt as string) as DispatchReceipt;
      }
      // Cleared by a read that finds its reference, by t3_release_uncertain, or
      // (never attempted) automatically: see docs/t3.md ("Uncertain deliveries").
      const blocking = this.blocking(projectId);
      if (blocking) {
        const e = earlier(blocking, this.now());
        throw new Error(this.inFlight(blocking)
          ? errorText('t3.send.in_flight', { when: e.when, where: e.where, check: check(blocking, this.now()) })
          : errorText('t3.send.blocked', { when: e.when, where: e.where, Check: capitalize(check(blocking, this.now())), reference: blocking.requestId }));
      }
      main = this.db.prepare('SELECT * FROM main_threads WHERE projectId=?').get(projectId) as unknown as MainThread | undefined;
      this.db.prepare("INSERT INTO dispatches(requestId,projectId,message,status,receipt,target,createdAt,owner,attempted) VALUES(?,?,?,'pending',NULL,?,?,?,0)").run(requestId, projectId, message, threadId || null, this.now(), this.owner);
      this.db.exec('COMMIT');
    } catch (error) { if (this.db.isTransaction) this.db.exec('ROLLBACK'); throw error; }
    // Only a send without threadId uses or creates the project's main thread. A
    // send with threadId, even to the registered main itself, gets the
    // existing-thread prompt and never registers, rewrites or replaces it.
    const explicit = !!threadId;
    let attempted = false, before: DispatchReceipt['before'], title: string | undefined, replaced: string | undefined;
    const startTitle = `Voice · ${project} · Main`;
    try {
      let target = threadId || main?.threadId, current: T3Response | undefined;
      if (target) {
        try { current = await this.run(['thread', 'show', target, '--messages', '1'], { signal }) as T3Response; }
        catch (error) {
          // A registered main that T3's projection no longer has (deleted) is replaced below.
          if (threadId || !this.threadGone(target)) throw error;
        }
        signal?.throwIfAborted();
        if (current && !current.thread) throw new Error(errorText('t3.send.no_thread_data', { thread: target }));
        title = current?.thread?.title || undefined;
        if (current?.thread && current.thread.projectId !== projectId) {
          const owner = current.thread.projectId, name = owner ? this.projectName(owner) : undefined;
          throw new Error(errorText('t3.send.wrong_project', { thread: named(target, title), project,
            owner: owner ? `project ${named(owner, name)}` : 'another project', retry: owner ? `projectId=${owner}${name ? ` and project="${name}"` : ''}` : 'the projectId of its project' }));
        }
        if (threadId && current?.thread?.archived) throw new Error(errorText('t3.send.archived', { thread: named(target, title) }));
        if (!threadId && (!current?.thread || current.thread.archived || current.thread.deletedAt)) {
          // The user's yes was for the project's main thread: an archived or
          // deleted one is replaced by a new main, as when there is none.
          replaced = `the previous main thread${title ? ` "${title.replace(/\s+/g, ' ').trim()}"` : ''} was ${current?.thread?.archived ? 'archived' : 'deleted'}; a new one was created: "${startTitle}"`;
          target = undefined; main = undefined; title = undefined;
        }
      }
      if (target) {
        this.db.prepare('UPDATE dispatches SET targetThread=?, targetTitle=? WHERE requestId=?').run(target, title || null, requestId);
        main = { projectId, project, threadId: target, link: current?.thread?.link };
        // What the thread had just before the send: a queued delivery has no
        // runId, and the follow-up must not take the turn already running for it.
        before = { ...(typeof current?.thread?.runCount === 'number' ? { runs: current.thread.runCount } : {}), latestRunId: current?.thread?.latestRunId ?? null };
        this.saveThread(main, explicit); this.registry();
      } else this.db.prepare('UPDATE dispatches SET targetTitle=? WHERE requestId=?').run(startTitle, requestId);
      // resources/t3_delivery_prompt_{main,existing}.txt; the reference line stays
      // in code because reads parse it back (REFERENCE).
      const prompt = t3DeliveryPrompt(explicit ? 'existing' : 'main', { reference: referenceLine(requestId), message });
      signal?.throwIfAborted();
      // Durable before the CLI is invoked: a row still at attempted=0 provably
      // sent nothing. If another process released it meanwhile, nothing goes out.
      if (this.db.prepare("UPDATE dispatches SET attempted=1 WHERE requestId=? AND status='pending'").run(requestId).changes !== 1)
        throw new NotDispatchedError(errorText('send.released_while_preparing'));
      attempted = true; attempt();
      const result = (target
        ? await this.run(['thread', 'send', target, prompt])
        : await this.run(['thread', 'start', projectId, prompt, '--title', startTitle])) as T3Response;
      if (!result?.threadId || (target && result.threadId !== target)) throw new Error(target
        ? errorText('t3.send.unconfirmed_thread', { thread: named(target, title) })
        : errorText('t3.send.unconfirmed_new_thread', { title: startTitle }));
      main = { projectId, project, threadId: result.threadId, link: result.link || main?.link || null };
      this.saveThread(main, explicit);
      // Acceptance by T3 is durable delivery, including a queued next turn. It
      // does not prove execution. Keep the CLI's distinction for the model and replays.
      const receipt: DispatchReceipt = { ...main, requestId, status: 'delivered', runId: result.runId || null,
        delivery: verifiedDelivery(result.delivery), ...(before ? { before } : {}), ...(replaced ? { note: replaced } : {}) };
      this.db.prepare("UPDATE dispatches SET status='delivered', receipt=? WHERE requestId=?").run(JSON.stringify(receipt), requestId);
      this.registry(); return receipt;
    } catch (error) {
      this.db.prepare("UPDATE dispatches SET status=? WHERE requestId=? AND status='pending'").run(attempted ? 'unknown' : 'rejected', requestId);
      throw error;
    }
  }
  // A read of a thread that shows, in a user message, the reference of an
  // uncertain send to that thread (or, for a send that was creating the main
  // thread, to any thread of its project) proves it arrived: it is recorded
  // as delivered. Returns what was verified, for one line in the read.
  verifyRead(thread: { threadId: string; projectId?: string; title?: string; link?: string | null }, messages: Message[] = []) {
    const references = sentReferences(messages);
    if (!references.size || !thread.projectId) return [];
    const verified: { requestId: string; when: string; created: boolean }[] = [];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const requestId of references) {
        const row = this.db.prepare(`SELECT * FROM dispatches WHERE requestId=? AND ${UNCERTAIN}`).get(requestId) as unknown as DispatchRow | undefined;
        if (!row || row.projectId !== thread.projectId) continue;
        const sentTo = row.targetThread || row.target;
        if (sentTo && sentTo !== thread.threadId) continue;
        const project = String((this.db.prepare('SELECT project FROM main_threads WHERE projectId=?').get(row.projectId) as { project?: string } | undefined)?.project || this.projectName(row.projectId) || '');
        const main = { projectId: row.projectId, project, threadId: thread.threadId, link: thread.link || null };
        const receipt: DispatchReceipt = { ...main, requestId, status: 'delivered', runId: null, delivery: 'unverified', note: 'delivery checked by reading the thread (its reference is in a user message)' };
        this.db.prepare("UPDATE dispatches SET status='delivered', receipt=?, targetThread=? WHERE requestId=?").run(JSON.stringify(receipt), thread.threadId, requestId);
        // A send that was creating the main thread created this one.
        this.saveThread(main, !!sentTo);
        verified.push({ requestId, when: earlier(row, this.now()).when, created: !sentTo });
      }
      this.db.exec('COMMIT');
    } catch (error) { if (this.db.isTransaction) this.db.exec('ROLLBACK'); throw error; }
    if (verified.length) this.registry();
    return verified;
  }
  // The user's decision after a read that did not find the send: the most
  // recent uncertain row of the project becomes 'released' (not delivered)
  // and new sends are allowed again. Nothing is sent. The row keeps its
  // request ID, so that same send is never repeated. read(threadId, since)
  // says whether this session read that thread after the send.
  release(projectId: string, requestId: string, read: (threadId: string, since: number) => boolean) {
    if (typeof projectId !== 'string' || !projectId.trim()) throw new NotDispatchedError(errorText('release.missing_project_id'));
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.releaseStale();
      const row = this.blocking(projectId);
      if (!row) { this.db.exec('COMMIT'); return 'NOT BLOCKED: no uncertain send is blocking this project. Nothing was changed or sent.'; }
      const e = earlier(row, this.now());
      if (this.inFlight(row)) throw new NotDispatchedError(errorText('release.in_flight', { when: e.when, where: e.where }));
      if (e.thread && !read(e.thread, row.createdAt)) throw new NotDispatchedError(errorText('t3.release.unread', { thread: named(e.thread, row.targetTitle) }));
      this.db.prepare("UPDATE dispatches SET status='released', receipt=? WHERE requestId=?").run(JSON.stringify({ status: 'released', reason: 'user_decision', by: requestId, at: this.now() }), row.requestId);
      const more = this.blocking(projectId);
      this.db.exec('COMMIT');
      return `RELEASED: the uncertain send (${e.when}, ${e.where}) stays unchecked, released by the user's decision. Nothing was sent. ${more ? 'Another uncertain send remains in this project: check it too.' : 'The project accepts sends again: if the user asked to resend it, use t3_send_message with the request they accepted.'}`;
    } catch (error) { if (this.db.isTransaction) this.db.exec('ROLLBACK'); throw error; }
  }
  projectName(id: string) {
    try { return this.projects().find(p => p.id === id)?.name; } catch { return undefined; }
  }
  saveThread(main: MainThread, preserveMain: boolean) {
    this.db.prepare('INSERT INTO followed_threads VALUES(?,?,?,?) ON CONFLICT(threadId) DO UPDATE SET link=excluded.link').run(main.threadId, main.projectId, main.project, main.link || null);
    if (preserveMain) return;
    this.db.prepare('INSERT INTO main_threads VALUES(?,?,?,?) ON CONFLICT(projectId) DO UPDATE SET threadId=excluded.threadId, link=excluded.link').run(main.projectId, main.project, main.threadId, main.link || null);
  }
  registry() {
    const rows = (this.db.prepare('SELECT * FROM main_threads').all() as unknown as MainThread[]).map(r => ({ ...r, role: 'main', task: 'Coordination of voice requests' }));
    const ids = new Set(rows.map(r => r.threadId));
    rows.push(...(this.db.prepare('SELECT * FROM followed_threads').all().filter(r => !ids.has(String(r.threadId))).map(r => ({ ...r, role: 'conversation', task: 'Conversation named by the user' })) as unknown as (MainThread & { role: string; task: string })[]));
    const path = join(this.state, 'tracked-threads.json');
    writeFileSync(path + '.tmp', JSON.stringify(rows, null, 2), { mode: 0o600 }); renameSync(path + '.tmp', path);
  }
  close() { this.db.close(); }
}

const capitalize = (text: string) => text[0].toUpperCase() + text.slice(1);
function verifiedDelivery(value: unknown): Delivery {
  return value === 'started' || value === 'queued' || value === 'steered' || value === 'restarted' ? value : 'unverified';
}
