import { cliFailure } from '../cli-failure.mjs';
import type { Project, Thread, ThreadReference, T3Response, Warning, Overview } from '../../shared/contracts.mjs';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { FoundThreads } from './format.mjs';
import { nameIndex, spokenMatch, spokenWords, type SpokenMatch } from '../../shared/spoken-match.mjs';
import { errorText } from '../../resources.mjs';
const exec = promisify(execFile);
export const t3Base = process.env.T3CODE_HOME || join(homedir(), '.t3');
export const t3Binary = process.env.T3_BIN || (existsSync(join(homedir(), '.local/bin/t3')) ? join(homedir(), '.local/bin/t3') : 't3');
// An ID reaches the CLI as an argument: one starting with "-" would be parsed
// as an option, and T3 IDs never contain spaces or control characters.
export function cliId(value: unknown): value is string {
  return typeof value === 'string' && /^[^\s-]\S*$/.test(value) && !/\p{Cc}/u.test(value);
}
// The argument of each command that is an ID: the positional of show, send and
// start, and the value of --project.
function idArguments(args: string[]) {
  const ids = args[0] === 'thread' && ['show', 'send', 'start'].includes(args[1]) ? [args[2]] : [];
  for (let i = 0; i < args.length - 1; i++) if (args[i] === '--project') ids.push(args[i + 1]);
  return ids;
}
// The flags go before "--" and the thread ID after it, so even an ID that got
// past validation is read as an argument. Only thread show is invoked this way:
// T3 0.1.9 was checked to accept "--" there with a read; sends keep their form.
function cliArguments(args: string[]) {
  const flags = ['--base-dir', t3Base, '--json'];
  if (args[0] === 'thread' && args[1] === 'show' && args.length >= 3) return ['thread', 'show', ...args.slice(3), ...flags, '--', args[2]];
  return [...args, ...flags];
}
export async function t3(args: string[], { timeout = 20_000, signal }: { timeout?: number; signal?: AbortSignal } = {}) {
  signal?.throwIfAborted();
  const invalid = idArguments(args).find(id => !cliId(id));
  if (invalid !== undefined) throw new Error(errorText('ids.invalid_cli', { value: String(invalid).slice(0, 80) }));
  try {
    const { stdout } = await exec(t3Binary, cliArguments(args), { timeout, maxBuffer: 4_000_000, signal });
    signal?.throwIfAborted();
    return JSON.parse(stdout) as T3Response | Thread[];
  } catch (error) {
    signal?.throwIfAborted();
    // CLI stderr may contain prompts or credentials. Keep it server-side.
    // eslint-disable-next-line preserve-caught-error -- Do not attach private CLI output to public errors.
    throw new Error(cliFailure('T3', error));
  }
}
// What reaches the model when T3's local projection cannot be read: SQLite
// messages are English and may carry paths.
export const T3_LOCAL_UNREADABLE = 'T3: its local database of projects and threads could not be read (missing, locked or from another version). Nothing was read; do not repeat it in a loop: tell the user, the T3 installation needs checking.';
export const T3_LOCAL_INCOMPATIBLE = 'T3: the local thread metadata has a format this version of ADE Call does not recognize. Nothing was read; do not repeat it: tell the user, ADE Call needs updating.';
function localRead<T>(base: string, read: (db: DatabaseSync) => T): T {
  let db: DatabaseSync;
  // SQLite errors may contain private paths.
  try { db = new DatabaseSync(join(base, 'userdata/statev2.sqlite'), { readOnly: true }); } catch { throw new Error(T3_LOCAL_UNREADABLE); }
  try { return read(db); }
  catch (error) {
    if (error instanceof Error && error.message === T3_LOCAL_INCOMPATIBLE) throw error;
    // eslint-disable-next-line preserve-caught-error -- SQLite errors may contain private paths.
    throw new Error(T3_LOCAL_UNREADABLE);
  } finally { db.close(); }
}
export function t3Projects(base = t3Base): Project[] {
  // T3 0.1.9 has no project list CLI. Only discover IDs/paths from its projection;
  // never write to this database or read credentials/provider conversations here.
  return localRead(base, db => db.prepare('SELECT project_id AS id, title AS name, workspace_root AS path FROM projection_projects WHERE deleted_at IS NULL AND archived_at IS NULL').all() as unknown as Project[]);
}
// Read projection metadata only. Status and messages always come from the CLI.
export function t3ThreadMetadata(projectIds: string[], base = t3Base) {
  const threads: Thread[] = [], excluded: string[] = [], warnings: Warning[] = [];
  let db;
  try {
    db = new DatabaseSync(join(base, 'userdata/statev2.sqlite'), { readOnly: true });
    const query = db.prepare(`SELECT thread_id, project_id, title, archived_at, deleted_at,
      payload_json FROM orchestration_v2_projection_threads WHERE project_id = ?`);
    for (const projectId of projectIds) {
      for (const row of query.all(projectId) as unknown as { thread_id: string; title: string; payload_json: string; archived_at: string | null; deleted_at: string | null }[]) {
        if (row.archived_at != null || row.deleted_at != null) { excluded.push(row.thread_id); continue; }
        try {
          const payload = JSON.parse(row.payload_json);
          if (!payload || payload.id !== row.thread_id) throw new Error('invalid id');
          const lineage = payload.lineage;
          if (lineage != null && (typeof lineage !== 'object' || Array.isArray(lineage))) throw new Error('invalid lineage');
          if (lineage?.relationshipToParent !== 'subagent') continue;
          if (typeof lineage.parentThreadId !== 'string' || !lineage.parentThreadId ||
              typeof lineage.rootThreadId !== 'string' || !lineage.rootThreadId) throw new Error('invalid lineage');
          threads.push({ threadId: row.thread_id, projectId, title: row.title,
            parentThreadId: lineage.parentThreadId, rootThreadId: lineage.rootThreadId, relationshipToParent: 'subagent' });
        } catch {
          warnings.push({ code: 'invalid_thread_metadata', projectId, threadId: row.thread_id });
        }
      }
    }
  } catch {
    warnings.push({ code: 'thread_metadata_unavailable', note: 'The subagent schema could not be read; the listing may be incomplete.' });
  } finally { db?.close(); }
  return { threads, excluded, warnings };
}

async function mapBounded<T, R>(items: T[], fn: (item: T) => Promise<R>, signal?: AbortSignal): Promise<R[]> {
  let index = 0;
  const results = new Array<R>(items.length);
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
    while (index < items.length) { signal?.throwIfAborted(); const i = index++; results[i] = await fn(items[i]); }
  }));
  return results;
}

export async function t3Overview({ projects = t3Projects, run = t3, metadata = t3ThreadMetadata,
  projectId, parentThreadId, rootThreadId, includeSubagents = true, onProgress = () => {}, signal }: { projects?: () => Project[]; run?: typeof t3; metadata?: typeof t3ThreadMetadata; projectId?: string; parentThreadId?: string; rootThreadId?: string; includeSubagents?: boolean; onProgress?: (data: Overview) => void; signal?: AbortSignal } = {}): Promise<Overview & { discovery: { complete: boolean; warnings: Warning[] } }> {
  signal?.throwIfAborted();
  const catalog = projects().filter(p => !projectId || p.id === projectId);
  const discovered = metadata(catalog.map(p => p.id));
  const warnings = [...discovered.warnings];
  const excluded = new Set(discovered.excluded);
  const byId = new Map<string, Thread>();
  const publish = () => onProgress({ backend: 't3', projects: catalog,
    threads: [...byId.values()], workspaces: [...byId.values()].map(t => ({ id: t.threadId,
      projectId: t.projectId, name: t.title, cardStatus: t.status, link: t.link,
      activeTerminals: ['running', 'starting', 'preparing', 'queued'].includes(t.status || '') ? 1 : 0,
      updated: t.updatedAt })), terminals: [], discovery: { complete: false, warnings: [...warnings] } });
  for (const child of discovered.threads) byId.set(child.threadId, { ...child, status: 'unknown', statusVerified: false });
  publish();
  const lists = await mapBounded(catalog, async p => {
    try {
      const rows = await run(['thread', 'list', '--project', p.id], { signal });
      signal?.throwIfAborted();
      if (!Array.isArray(rows)) throw new Error('invalid list');
      const valid = rows.filter(t => t.projectId === p.id && !excluded.has(t.threadId) && !t.archivedAt && !t.deletedAt);
      for (const t of valid) if (!byId.has(t.threadId)) byId.set(t.threadId, t);
      publish();
      return valid;
    } catch { signal?.throwIfAborted(); warnings.push({ code: 'thread_list_unavailable', projectId: p.id }); return []; }
  }, signal);
  byId.clear();
  for (const thread of lists.flat()) byId.set(thread.threadId, thread);
  for (const child of discovered.threads) byId.set(child.threadId, { ...byId.get(child.threadId), ...child, status: 'unknown', statusVerified: false });
  const selected = [...byId.values()].filter(t => (includeSubagents || t.relationshipToParent !== 'subagent') && (!parentThreadId || t.parentThreadId === parentThreadId) &&
    (!rootThreadId || t.rootThreadId === rootThreadId));
  const threads = (await mapBounded(selected, async t => {
    if (t.relationshipToParent !== 'subagent') return t;
    try {
      const { thread } = await run(['thread', 'show', t.threadId, '--messages', '1'], { signal }) as T3Response;
      signal?.throwIfAborted();
      if (!thread || typeof thread.status !== 'string' ||
          (thread.projectId && thread.projectId !== t.projectId) ||
          (thread.threadId && thread.threadId !== t.threadId) || (thread.id && thread.id !== t.threadId)) throw new Error('invalid thread');
      if (thread.archivedAt || thread.deletedAt) { byId.delete(t.threadId); publish(); return null; }
      // Do not retain messages in the overview, nor infer a child's state from its parent.
      const verified = { ...t, status: thread.status, link: thread.link, updatedAt: thread.updatedAt, statusVerified: true };
      byId.set(t.threadId, verified); publish();
      return verified;
    } catch {
      signal?.throwIfAborted();
      warnings.push({ code: 'thread_status_unavailable', projectId: t.projectId, threadId: t.threadId });
      return { ...t, status: 'unknown', statusVerified: false };
    }
  }, signal)).filter(t => t !== null);
  return { backend: 't3', projects: catalog, threads,
    discovery: { complete: warnings.length === 0, warnings: warnings.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) },
    workspaces: threads.map(t => ({ id: t.threadId, projectId: t.projectId, name: t.title,
      status: t.status, cardStatus: t.status, activeTerminals: ['running', 'starting', 'preparing', 'queued'].includes(t.status || '') ? 1 : 0,
      updated: t.updatedAt, link: t.link })), terminals: [] };
}

// Routing metadata only. Match T3's unsettled predicate, not last-run status.
// `dated` adds the projection's update time (the voice catalog shows it); the
// model's index stays lean.
export function t3OpenThreadIndex(projectIds: string[], base = t3Base, { dated = false } = {}): ThreadReference[] {
  return threadReferences(projectIds, base, false, dated);
}
export function t3FindThreads({ projectId, query, variants = [], includeClosed = false, includeSubagents = false }: { projectId?: string; query: string; variants?: string[]; includeClosed?: boolean; includeSubagents?: boolean }, base = t3Base): FoundThreads {
  if (typeof query !== 'string' || !spokenWords(query).length) throw new Error(errorText('t3.find.missing_query'));
  if (!Array.isArray(variants) || variants.some(v => typeof v !== 'string')) throw new Error(errorText('t3.find.invalid_variants'));
  // A text "false" must not widen the search: only real booleans are accepted.
  for (const [field, value] of [['includeClosed', includeClosed], ['includeSubagents', includeSubagents]] as const)
    if (value !== null && typeof value !== 'boolean') throw new Error(errorText('t3.find.invalid_flag', { field }));
  // null means omitted: the same results and the same stated scope.
  includeClosed ??= false; includeSubagents ??= false;
  // The spoken text first, then at most five written alternatives from the model.
  const queries = [...new Set([query, ...variants].map(q => q.trim()).filter(q => spokenWords(q).length))].slice(0, 6);
  const catalog = t3Projects(base);
  const projects = catalog.filter(p => !projectId || p.id === projectId);
  // A wrong ID would otherwise look like a project with no matching threads.
  if (projectId && !projects.length) throw new Error(errorText('t3.find.unknown_project'));
  const names = new Map(catalog.map(p => [p.id, p.name]));
  // Weights use every title so they do not shift with the scope; closed
  // threads (settled or archived) are only listed when explicitly requested.
  const all = threadReferences(projects.map(p => p.id), base, true);
  const index = nameIndex([...all.map(t => t.title), ...catalog.map(p => p.name)]);
  // Higher score first; recent activity breaks ties (rows arrive newest first).
  const rank = <T,>(items: T[], name: (item: T) => string, context?: (item: T) => string | undefined) => items.flatMap(item => {
    const match = spokenMatch(queries, name(item), index, context?.(item));
    return match ? [{ item, match }] : [];
  }).sort((a, b) => b.match.score - a.match.score);
  const describe = <T,>(f: { item: T; match: SpokenMatch }) => ({ ...f.item, score: f.match.score, ...(queries.length > 1 ? { matchedBy: f.match.variant } : {}) });
  // Main threads first, as in t3_list_threads: a topic the user describes is
  // usually a main thread, and old subagent titles share its words.
  const subagent = (t: ThreadReference) => t.relationshipToParent === 'subagent';
  const ranked = rank(all, t => t.title, t => names.get(t.projectId)).sort((a, b) => Number(subagent(a.item)) - Number(subagent(b.item)));
  const scoped = includeClosed ? ranked : ranked.filter(f => f.item.state === 'open');
  const found = includeSubagents ? scoped : scoped.filter(f => !subagent(f.item));
  // Left-out closed threads are counted like the visible results: words
  // matches apart from approximate ones, and the approximate ones only where
  // widening with includeClosed would list them as candidates.
  const widenable = ranked.filter(f => includeSubagents || !subagent(f.item));
  const closed = includeClosed ? [] : widenable.filter(f => f.item.state !== 'open');
  const closedWords = closed.filter(f => f.match.kind === 'words').length;
  const closedApproximate = widenable.some(f => f.match.kind === 'words') ? 0 : closed.length - closedWords;
  // Left-out subagents are counted with their parents, so the model can tell
  // "no main thread" from "nothing" and widen the search when it fits. As in the
  // visible results, words matches and approximate ones are kept apart, and the
  // approximate ones count only where widening would list them as candidates.
  const hidden = includeSubagents ? [] : scoped.filter(f => subagent(f.item));
  const hiddenWords = hidden.filter(f => f.match.kind === 'words');
  const hiddenApproximate = scoped.some(f => f.match.kind === 'words') ? [] : hidden.filter(f => f.match.kind === 'approximate');
  const titles = new Map(all.map(t => [t.threadId, t.title]));
  const parents = [...new Set([...hiddenWords, ...hiddenApproximate].flatMap(f => f.item.parentThreadId ?? []))].slice(0, 5)
    .map(id => ({ threadId: id, ...(titles.has(id) ? { title: titles.get(id) } : {}) }));
  const named = rank(catalog, p => p.name);
  const exact = found.filter(f => f.match.kind === 'words').map(describe);
  // Approximate candidates only when nothing matches as written: they help with
  // misheard names, but the model must confirm them before acting.
  const candidates = exact.length ? [] : found.filter(f => f.match.kind === 'approximate').slice(0, 10).map(describe);
  const projectsMatchingName = named.filter(f => f.match.kind === 'words').map(f => ({ id: f.item.id, name: f.item.name, ...(queries.length > 1 ? { matchedBy: f.match.variant } : {}) }));
  const projectCandidates = projectsMatchingName.length ? [] : named.filter(f => f.match.kind === 'approximate').slice(0, 5)
    .map(f => ({ id: f.item.id, name: f.item.name, score: f.match.score, ...(queries.length > 1 ? { matchedBy: f.match.variant } : {}) }));
  // State what was compared, so an empty list is not read as a wider absence.
  return { threads: exact.slice(0, 100), total: exact.length, truncated: exact.length > 100, metadataOnly: true,
    searched: { field: 'thread_titles', projects: projects.length, catalogProjects: catalog.length, queries, closed: includeClosed, subagents: includeSubagents },
    projectsMatchingName,
    ...(candidates.length ? { candidates } : {}), ...(projectCandidates.length ? { projectCandidates } : {}),
    ...(closedWords || closedApproximate ? { closedMatching: { count: closedWords, ...(closedApproximate ? { approximate: closedApproximate } : {}) } } : {}),
    ...(hiddenWords.length || hiddenApproximate.length ? { subagentsMatching: { count: hiddenWords.length, ...(hiddenApproximate.length ? { approximate: hiddenApproximate.length } : {}), parents } } : {}),
    ...(exact.length ? {} : { note: `No ${includeClosed ? '' : 'open '}${includeSubagents ? '' : 'main '}thread title contains those words in the compared projects. Messages, documents and folder names were not checked: it does not prove that the matter or the project does not exist.` }) };
}
function threadReferences(projectIds: string[], base: string, includeClosed: boolean, dated = includeClosed): ThreadReference[] {
  return localRead(base, db => {
    const allowed = new Set(projectIds);
    const rows = db.prepare(`SELECT thread_id, project_id, title, payload_json, archived_at, updated_at
      FROM orchestration_v2_projection_threads
      WHERE deleted_at IS NULL ORDER BY updated_at DESC, thread_id`).all();
    const threads: ThreadReference[] = [];
    for (const row of rows) {
      if (!allowed.has(String(row.project_id))) continue;
      let data;
      // The parser message names no field the model can use.
      try { data = JSON.parse(String(row.payload_json)); } catch { throw new Error(T3_LOCAL_INCOMPATIBLE); }
      if (!data || data.id !== row.thread_id || data.projectId !== row.project_id ||
          !Object.hasOwn(data, 'settledAt') || !Object.hasOwn(data, 'settledOverride') ||
          ![null, 'active', 'settled'].includes(data.settledOverride)) throw new Error(T3_LOCAL_INCOMPATIBLE);
      if (data.deletedAt != null) continue;
      if (!includeClosed && (row.archived_at != null || data.archivedAt != null || data.settledAt != null || data.settledOverride === 'settled')) continue;
      const thread: ThreadReference = { threadId: String(row.thread_id), projectId: String(row.project_id), title: String(row.title) };
      // Closed references carry their state and date so the model can tell
      // "yesterday's one" from an old archived namesake; the open index stays lean.
      if (includeClosed) {
        thread.state = row.archived_at != null || data.archivedAt != null ? 'archived' : data.settledAt != null || data.settledOverride === 'settled' ? 'settled' : 'open';
      }
      if (dated && row.updated_at != null) thread.updatedAt = String(row.updated_at);
      if (typeof data.lineage?.parentThreadId === 'string') thread.parentThreadId = data.lineage.parentThreadId;
      if (typeof data.lineage?.relationshipToParent === 'string') thread.relationshipToParent = data.lineage.relationshipToParent;
      threads.push(thread);
    }
    return threads;
  });
}
// Whether T3's local projection shows a thread as deleted (or no longer has
// it), read only. Any doubt (unreadable base, other schema) answers false.
export function t3ThreadGone(threadId: string, base = t3Base) {
  try {
    return localRead(base, db => {
      const row = db.prepare('SELECT deleted_at FROM orchestration_v2_projection_threads WHERE thread_id = ?').get(threadId) as { deleted_at: unknown } | undefined;
      return !row || row.deleted_at != null;
    });
  } catch { return false; }
}
