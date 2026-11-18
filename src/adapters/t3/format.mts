import type { Thread, ThreadReference } from '../../shared/contracts.mjs';

// Annotated plain text for the model and the web. Every value comes from the T3 CLI or the
// coordinator; unknown fields are kept as "key: value" instead of being dropped.
const DELIVERY: Record<string, string> = {
  queued: 'queued for the next turn; not running yet',
  started: 'T3 started a turn with the message', steered: 'T3 added it to the turn in progress',
  restarted: 'T3 restarted the turn with the message', unverified: 'delivery mode not confirmed'
};
const clean = (value: unknown) => String(value).replace(/\s+/g, ' ').trim();
const extras = (data: object, known: string[]) => Object.entries(data)
  .filter(([key, value]) => !known.includes(key) && value !== undefined && value !== null && value !== '' && value !== false)
  .map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : clean(value)}`);

export const COMPLETED_NOTE = 'completed = end of turn, not finished work.';
export function threadLine(t: Partial<Thread> & Partial<ThreadReference>) {
  const parts = [`"${clean(t.title || 'untitled')}"`, `id ${t.threadId || t.id}`];
  if (t.projectId) parts.push(`project ${t.projectId}`);
  if (t.status) parts.push(t.status + (t.statusVerified === false ? ', unverified' : ''));
  if (t.parentThreadId) parts.push(`parent ${t.parentThreadId}${t.relationshipToParent ? ` (${t.relationshipToParent})` : ''}`);
  if (t.rootThreadId && t.rootThreadId !== t.parentThreadId) parts.push(`root ${t.rootThreadId}`);
  if (t.archived || t.archivedAt || t.state === 'archived') parts.push('archived');
  if (t.state === 'settled') parts.push('finished (settled)');
  if (t.deletedAt) parts.push('deleted');
  if (t.updatedAt) parts.push(`updated ${t.updatedAt}`);
  if (t.link) parts.push(t.link);
  return '- ' + parts.join(' · ');
}

export function formatThreadList(data: { checkedAt: string; scope: string; subagents: string; projects?: { id: string; name: string }[]; threads: Thread[]; discovery?: { complete: boolean; warnings?: { code: string; projectId?: string; threadId?: string; note?: string }[] } }) {
  const lines = [`THREADS (${data.scope}; subagents ${data.subagents === 'requested' ? 'included' : 'not queried'}) · checked ${data.checkedAt}`];
  if (data.discovery && !data.discovery.complete) lines.push('Incomplete discovery: the absence of a thread or subagent is not proven.');
  for (const w of data.discovery?.warnings || []) lines.push(`Warning: ${[w.code, w.projectId, w.threadId, w.note].filter(Boolean).join(' · ')}`);
  if (data.projects?.length) lines.push('PROJECTS:', ...data.projects.map(p => `- ${clean(p.name)} · id ${p.id}`));
  lines.push(`THREADS: ${data.threads.length}. ${COMPLETED_NOTE}`, ...data.threads.map(threadLine));
  return lines.join('\n');
}

type Found = ThreadReference & { score?: number; matchedBy?: string };
type FoundProject = { id: string; name: string; score?: number; matchedBy?: string };
const via = (x: { score?: number; matchedBy?: string }, similarity: boolean) =>
  `${similarity && x.score !== undefined ? ` · similarity ${x.score}` : ''}${x.matchedBy ? ` · by "${clean(x.matchedBy)}"` : ''}`;
export type FoundThreads = { threads: Found[]; total?: number; truncated?: boolean; metadataOnly?: boolean; searched?: { field: string; projects: number; catalogProjects: number; queries?: string[]; closed?: boolean; subagents?: boolean }; closedMatching?: { count: number; approximate?: number }; subagentsMatching?: { count: number; approximate?: number; parents: { threadId: string; title?: string }[] }; projectsMatchingName?: FoundProject[]; candidates?: Found[]; projectCandidates?: FoundProject[]; note?: string };
// One parent per line, its ID last: no separator is ever glued to an ID, so
// each one can be shortened and resolved back whole.
// Approximate ones are counted only when nothing matches as written.
const leftOut = (what: string, { count, approximate = 0 }: { count: number; approximate?: number }) =>
  `${count ? `${count} ${what} also match` : `${approximate} ${what} are possible approximate matches (imperfect transcription; confirm them before acting)`} and are not shown.`;
function subagentLines(data: NonNullable<FoundThreads['subagentsMatching']>) {
  // A parent may match too: the label only says how it relates to them.
  return [`${leftOut('subagent threads', data)} Search them with includeSubagents=true if the user is asking for a subagent or there is no other candidate; mention it before saying it does not exist.`,
    ...(data.parents.length ? ['Parents of those subagents:', ...data.parents.map(p => `- ${p.title ? `"${clean(p.title)}" · ` : ''}parent ${p.threadId}`)] : [])];
}
export function formatFound(data: FoundThreads & { checkedAt: string }) {
  return [`THREAD SEARCH · checked ${data.checkedAt} · ${data.threads.length}${data.total !== undefined ? ` of ${data.total}` : ''}${data.truncated ? ' (trimmed)' : ''}`,
    'Only titles and local metadata: it does not confirm activity or read messages. Zero matches do not prove the absence of projects or documents.',
    ...(data.searched ? [`Scope: ${data.searched.field}, ${data.searched.projects} of ${data.searched.catalogProjects} projects${data.searched.closed === false ? ', open only' : data.searched.closed ? ', including finished (settled) and archived' : ''}${data.searched.subagents === false ? ', main threads only' : data.searched.subagents ? ', including subagents' : ''}.${data.searched.queries && data.searched.queries.length > 1 ? ` Variants: ${data.searched.queries.map(q => `"${clean(q)}"`).join(', ')}.` : ''}`] : []),
    ...(data.projectsMatchingName?.length ? ['Projects whose name matches:', ...data.projectsMatchingName.map(p => `- ${clean(p.name)} · id ${p.id}${via(p, false)}`)] : []),
    ...(data.note ? [data.note] : []), ...data.threads.map(t => threadLine(t) + via(t, (t.score ?? 1) < 1)),
    ...(data.closedMatching ? [`${leftOut('closed threads (finished or archived)', data.closedMatching)} Search them with includeClosed=true if the user wants to see closed ones or if there is no other candidate; mention it before saying it does not exist.`] : []),
    ...(data.subagentsMatching ? subagentLines(data.subagentsMatching) : []),
    ...(data.candidates?.length || data.projectCandidates?.length ? ['Approximate candidates (possibly imperfect transcription; confirm them by reading or asking, they never authorize a send):',
      ...(data.projectCandidates || []).map(p => `- project ${clean(p.name)} · id ${p.id}${via(p, true)}`),
      ...(data.candidates || []).map(t => threadLine(t) + via(t, true))] : [])].join('\n');
}

export function formatReceipt(r: { status: string; delivery?: string; threadId?: string; project?: string; projectId?: string; link?: string | null; requestId?: string; runId?: string | null; note?: string }) {
  const lines = [`SEND ${r.status === 'delivered' ? 'ACCEPTED by T3' : r.status}${r.delivery ? ` · ${r.delivery}: ${DELIVERY[r.delivery] || r.delivery}` : ''}`];
  if (r.threadId) lines.push(`Thread: ${r.threadId}${r.project ? ` · project ${clean(r.project)}` : ''}${r.projectId ? ` (${r.projectId})` : ''}`);
  if (r.link) lines.push(`Link: ${r.link}`);
  if (r.requestId) lines.push(`Request: ${r.requestId}${r.runId ? ` · run ${r.runId}` : ''}`);
  if (r.note) lines.push(`Note: ${clean(r.note)}.`);
  lines.push(...extras(r, ['status', 'delivery', 'threadId', 'project', 'projectId', 'link', 'requestId', 'runId', 'before', 'note']));
  return lines.join('\n');
}
