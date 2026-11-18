import { NotDispatchedError, PROCESS_ID, errorMessage } from '../../shared/contracts.mjs';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { ago } from '../../direct/text.mjs';
import { errorText } from '../../resources.mjs';

interface Operation { id: string; project: string; payload: string; status: string; createdAt: number; receipt?: string | null; owner?: string; attempted?: number }
// Where an earlier send or launch went, how long ago, and how to check it now.
function earlier(row: Operation, now: number) {
  let payload: { kind?: string; terminal?: string; worktreeId?: string; agent?: string } = {};
  try { payload = JSON.parse(row.payload); } catch { /* Described without a target. */ }
  const when = `${ago(now - row.createdAt)} ago`;
  if (payload.kind === 'launch' && payload.worktreeId) return { when, where: `to start a${payload.agent ? ` ${payload.agent}` : 'n'} agent in workspace ${payload.worktreeId}`, check: 'list the project now with orca_list_projects to see whether its terminal appeared' };
  if (payload.terminal) return { when, where: `to terminal ${payload.terminal}`, terminal: payload.terminal, check: 'read that terminal now with orca_read_terminal' };
  return { when, where: 'to a destination the journal does not identify', check: 'list the project now with orca_list_projects and read its terminals' };
}
const UNCERTAIN = "status IN ('pending','unknown')";

// Separate from T3's journal. Persist intent before invoking any mutating CLI.
// Orca sends carry no reference (the text goes as typed into an agent's
// terminal, and terminal output cannot prove it was submitted), so an
// uncertain send is cleared only by orca_release_uncertain or, never
// attempted, automatically: see docs/orca.md.
export class OrcaDispatch {
  db: DatabaseSync; now: () => number; owner: string;
  constructor(state: string, now: () => number = Date.now, owner = PROCESS_ID) {
    this.now = now; this.owner = owner;
    mkdirSync(state, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(state, 'dispatch.sqlite'));
    chmodSync(join(state, 'dispatch.sqlite'), 0o600);
    // owner: the process that wrote the row; attempted: whether the mutating CLI was invoked (0 = not yet).
    this.db.exec(`PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, project TEXT NOT NULL, payload TEXT NOT NULL,
      status TEXT NOT NULL, receipt TEXT, createdAt INTEGER NOT NULL, owner TEXT NOT NULL, attempted INTEGER NOT NULL)`);
  }
  // A pending row of another process whose mutating CLI was never invoked
  // (attempted=0) provably changed nothing: release it.
  releaseStale() {
    this.db.prepare("UPDATE operations SET status='released', receipt=? WHERE status='pending' AND attempted=0 AND owner<>?")
      .run(JSON.stringify({ status: 'released', reason: 'not_attempted', at: this.now() }), this.owner);
  }
  blocking(project: string) {
    return this.db.prepare(`SELECT * FROM operations WHERE project=? AND ${UNCERTAIN} ORDER BY rowid DESC`).get(project) as unknown as Operation | undefined;
  }
  // Errors before the mutating CLI call are NotDispatchedError: nothing reached Orca.
  async dispatch(id: string | null, project: string, payload: unknown, preflight: () => Promise<unknown>, mutate: () => Promise<Record<string, unknown>>, signal?: AbortSignal) {
    try { signal?.throwIfAborted(); } catch (error) { throw new NotDispatchedError(errorMessage(error)); }
    if (typeof id !== 'string' || !/^[a-zA-Z0-9:_-]{8,180}$/.test(id)) throw new NotDispatchedError(errorText('send.missing_request_id'));
    const encoded = JSON.stringify(payload);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.releaseStale();
      const previous = this.db.prepare('SELECT * FROM operations WHERE id=?').get(id) as unknown as Operation | undefined;
      if (previous) {
        if (previous.project !== project || previous.payload !== encoded) throw Error(errorText('orca.send.request_conflict'));
        if (previous.status === 'rejected') throw Error(errorText('orca.send.repeat_rejected', { when: earlier(previous, this.now()).when }));
        if (previous.status === 'released') throw Error(errorText('orca.send.repeat_released', { when: earlier(previous, this.now()).when }));
        if (previous.status !== 'accepted') {
          const e = earlier(previous, this.now());
          throw Error(errorText('orca.send.repeat_uncertain', { when: e.when, where: e.where, check: e.check }));
        }
        this.db.exec('COMMIT'); return JSON.parse(previous.receipt as string) as Record<string, unknown>;
      }
      const blocking = this.blocking(project);
      if (blocking) {
        const e = earlier(blocking, this.now());
        throw Error(blocking.status === 'pending' && blocking.owner === this.owner
          ? errorText('orca.send.in_flight', { when: e.when, where: e.where, check: e.check })
          : errorText('orca.send.blocked', { when: e.when, where: e.where, Check: e.check[0].toUpperCase() + e.check.slice(1) }));
      }
      this.db.prepare("INSERT INTO operations(id,project,payload,status,receipt,createdAt,owner,attempted) VALUES (?,?,?,'pending',NULL,?,?,0)").run(id, project, encoded, this.now(), this.owner);
      this.db.exec('COMMIT');
    } catch (error) { if (this.db.isTransaction) this.db.exec('ROLLBACK'); throw new NotDispatchedError(errorMessage(error)); }
    let attempted = false;
    try {
      await preflight();
      signal?.throwIfAborted();
      // Durable before the CLI is invoked; a row released meanwhile sends nothing.
      if (this.db.prepare("UPDATE operations SET attempted=1 WHERE id=? AND status='pending'").run(id).changes !== 1) throw Error(errorText('send.released_while_preparing'));
      attempted = true;
      const receipt = { ...(await mutate()), requestId: id, status: 'accepted', completed: false };
      this.db.prepare("UPDATE operations SET status='accepted',receipt=? WHERE id=?").run(JSON.stringify(receipt), id);
      return receipt;
    } catch (error) {
      this.db.prepare("UPDATE operations SET status=? WHERE id=? AND status='pending'").run(attempted ? 'unknown' : 'rejected', id);
      if (attempted) {
        const e = earlier({ id, project, payload: encoded, status: 'unknown', createdAt: this.now() }, this.now());
        // eslint-disable-next-line preserve-caught-error -- Do not attach private CLI output to public errors.
        throw Error(errorText('orca.send.uncertain', { where: e.where, check: e.check }));
      }
      throw new NotDispatchedError(errorMessage(error));
    }
  }
  // The user's decision after checking: the most recent uncertain row of the
  // project becomes 'released' (not accepted) and new sends are allowed.
  // Nothing is sent; that request ID is never sent again. read(terminal,
  // since) says whether this session read that terminal after the send.
  release(project: string, requestId: string, read: (terminal: string, since: number) => boolean) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.releaseStale();
      const row = this.blocking(project);
      if (!row) { this.db.exec('COMMIT'); return 'NOT BLOCKED: no uncertain send is blocking this project. Nothing was changed or sent.'; }
      const e = earlier(row, this.now());
      if (row.status === 'pending' && row.owner === this.owner) throw new NotDispatchedError(errorText('release.in_flight', { when: e.when, where: e.where }));
      if (e.terminal && !read(e.terminal, row.createdAt)) throw new NotDispatchedError(errorText('orca.release.unread', { terminal: e.terminal }));
      this.db.prepare("UPDATE operations SET status='released', receipt=? WHERE id=?").run(JSON.stringify({ status: 'released', reason: 'user_decision', by: requestId, at: this.now() }), row.id);
      const more = this.blocking(project);
      this.db.exec('COMMIT');
      return `RELEASED: the uncertain send (${e.when}, ${e.where}) stays unchecked, released by the user's decision. Nothing was sent. ${more ? 'Another uncertain send remains in this project: check it too.' : 'The project accepts sends again: if the user asked to resend it, do so with the request they accepted.'}`;
    } catch (error) { if (this.db.isTransaction) this.db.exec('ROLLBACK'); throw error; }
  }
  close() { this.db.close(); }
}
