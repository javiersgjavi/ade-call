import type { Project, Terminal, ToolDefinition, Workspace } from '../../shared/contracts.mjs';
import { overview, orca, orcaProjects } from './client.mjs';
import { OrcaDispatch } from './dispatch.mjs';
import { NotDispatchedError } from '../../shared/contracts.mjs';
import { formatOrcaList, formatOrcaReceipt, formatTerminalRead, redact } from './format.mjs';
import { join } from 'node:path';
import { nameIndex, spokenMatch, spokenWords } from '../../shared/spoken-match.mjs';
import { homedir } from 'node:os';
import { errorText, toolSchema } from '../../resources.mjs';
const result = (text: string) => ({ content: [{ type: 'text', text: redact(text) }], details: {} });
// A project ID that is not in Orca's listing, for any Orca tool.
export const UNKNOWN_PROJECT = errorText('orca.unknown_project');
const valid = (value: unknown) => typeof value === 'string' && value.trim() && value.length <= 32000 && !value.includes('\0');
// Same matcher as T3 thread search: rare words weigh more, written variants
// from the model cover pronunciations. The project name completes a
// workspace or terminal name but cannot match it alone.
export function searchNames(queries: string[], projects: Project[], workspaces: Workspace[], terminals: Terminal[]) {
  const unique = [...new Set(queries.map(q => q.trim()))].slice(0, 6);
  const projectName = new Map(projects.map(p => [p.id, p.name]));
  const workspace = new Map(workspaces.map(w => [w.id, w]));
  const items = [
    ...projects.map(p => ({ kind: 'project' as const, id: p.id, projectId: p.id, name: p.name, context: undefined as string | undefined })),
    ...workspaces.filter(w => w.name).map(w => ({ kind: 'workspace' as const, id: w.id, projectId: w.projectId, name: w.name!, context: projectName.get(w.projectId) })),
    ...terminals.filter(t => t.title && workspace.has(t.worktreeId)).map(t => ({ kind: 'terminal' as const, id: t.handle, projectId: workspace.get(t.worktreeId)!.projectId, name: t.title!, context: projectName.get(workspace.get(t.worktreeId)!.projectId) })),
  ];
  const index = nameIndex(items.map(i => i.name));
  const found = items.flatMap(item => { const match = spokenMatch(unique, item.name, index, item.context); return match ? [{ ...item, match }] : []; })
    .sort((a, b) => b.match.score - a.match.score);
  const written = found.filter(f => f.match.kind === 'words');
  // Approximate names only when nothing matches as written.
  const matches = (written.length ? written : found.slice(0, 10)).map(f => ({ kind: f.kind, id: f.id, projectId: f.projectId, name: f.name,
    approximate: f.match.kind === 'approximate', score: f.match.score, ...(unique.length > 1 ? { matchedBy: f.match.variant } : {}) }));
  return { queries: unique, matches };
}
// Orca operations. The voice reaches them through the Orca
// DirectAde (src/direct/orca.mts). requestId comes from the server and is the
// journal key of a send or launch; the model never chooses it.
// Orca's journal directory inside ADE Call's private state.
export const orcaState = () => join(process.env.ADE_CALL_STATE || join(homedir(), '.local/share/ade-call'), 'ades', 'orca');
export function orcaTools({ run = orca, readOverview = (signal?: AbortSignal) => overview(run, { signal }),
  state = orcaState() } = {}): ToolDefinition<'orca_list_projects' | 'orca_read_terminal' | 'orca_send_message' | 'orca_start_agent'>[] {
  async function target(projectId: string, worktreeId?: string | null, terminal?: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (!valid(projectId)) throw Error(errorText('orca.target.missing_project_id'));
    const data = await readOverview(signal);
    signal?.throwIfAborted();
    if (!data.projects.some(p => p.id === projectId)) throw Error(UNKNOWN_PROJECT);
    const t = terminal ? data.terminals.find(t => t.handle === terminal) : null;
    if (terminal && !t) throw Error(errorText('orca.target.terminal_gone', { terminal }));
    const workspace = data.workspaces.find(w => w.id === (t?.worktreeId || worktreeId) && w.projectId === projectId);
    if (!workspace) throw Error(terminal ? errorText('orca.target.terminal_other_project', { terminal, projectId })
      : errorText('orca.target.unknown_workspace', { worktreeId: String(worktreeId), projectId }));
    return { workspace, terminal: t };
  }
  async function dispatch(requestId: string, projectId: string, payload: unknown, preflight: () => Promise<unknown>, mutate: () => Promise<Record<string, unknown>>, signal?: AbortSignal) {
    let journal: OrcaDispatch;
    try { journal = new OrcaDispatch(state); } catch (error) { throw new NotDispatchedError(errorText('send.journal_unavailable', { code: (error as { code?: string })?.code || 'cause without a code' })); }
    // details.receipt lets the direct tools word the receipt for the voice.
    try { const receipt = await journal.dispatch(requestId, projectId, payload, preflight, mutate, signal); return { ...result(formatOrcaReceipt(receipt)), details: { receipt } }; }
    finally { journal.close(); }
  }
  // The direct Orca ADE (src/direct/orca.mts) offers its own descriptions; these
  // belong to the adapter layer (resources/tools.json, _orca_adapter).
  const schema = (name: string) => toolSchema(name, {}, '_orca_adapter');
  return [{ name: 'orca_list_projects', label: 'Consultar Orca', ...schema('orca_list_projects'),
    async execute(_id, { projectId, includeActivity = false, query, variants = [] }, signal) {
      signal?.throwIfAborted();
      if ((projectId !== undefined && !valid(projectId)) || typeof includeActivity !== 'boolean' ||
          (query !== undefined && !(valid(query) && spokenWords(query).length)) || !Array.isArray(variants) || variants.some(v => !valid(v))) throw Error(errorText('orca.list.invalid'));
      const data = includeActivity ? await readOverview(signal) : { projects: await orcaProjects(run, signal), workspaces: [], terminals: [], threads: [], discovery: { complete: false, warnings: [] } };
      signal?.throwIfAborted();
      if (projectId !== undefined && !data.projects.some(p => p.id === projectId)) throw Error(errorText('orca.unknown_project_not_listed'));
      let projects = data.projects.filter(p => projectId === undefined || p.id === projectId);
      let workspaces = data.workspaces.filter(w => projectId === undefined || w.projectId === projectId);
      let terminals = data.terminals.filter(t => workspaces.some(w => w.id === t.worktreeId));
      const search = query === undefined ? undefined : searchNames([query, ...variants], projects, workspaces, terminals);
      // With matches, show only their projects; without them, the full listing
      // stays visible so an empty search is not read as absence.
      if (search?.matches.length) {
        const keep = new Set(search.matches.map(m => m.projectId));
        projects = projects.filter(p => keep.has(p.id)); workspaces = workspaces.filter(w => keep.has(w.projectId));
        terminals = terminals.filter(t => workspaces.some(w => w.id === t.worktreeId));
      }
      return result(formatOrcaList({ ...data, projects, workspaces, terminals, search,
        activity: includeActivity ? 'requested' : 'not_requested' }));
    } },
  { name: 'orca_read_terminal', label: 'Read Orca terminal', ...schema('orca_read_terminal'),
    async execute(_id, { projectId, terminal, cursor, limit = 12000 }, signal) {
      if (!valid(terminal) || !Number.isSafeInteger(limit) || limit < 1 || limit > 24000 || (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 0))) throw Error(errorText('orca.read.invalid'));
      const { terminal: t } = await target(projectId, null, terminal, signal);
      const data = await run(['terminal', 'read', '--terminal', terminal, '--limit', String(limit), ...(cursor === undefined ? [] : ['--cursor', String(cursor)])], { signal });
      signal?.throwIfAborted();
      return result(formatTerminalRead(data, { projectId, terminal, agent: t?.agent, title: t?.title }));
    } },
  { name: 'orca_send_message', label: 'Send request to Orca terminal', ...schema('orca_send_message'),
    async execute(requestId, { projectId, terminal, message }, signal) {
      if (!valid(terminal)) throw new NotDispatchedError(errorText('orca.send.missing_terminal'));
      if (!valid(message)) throw new NotDispatchedError(errorText('orca.send.missing_message'));
      return dispatch(requestId, projectId, { kind: 'send', terminal, message }, async () => {
        const { terminal: t } = await target(projectId, null, terminal, signal);
        if (typeof t?.agent !== 'string' || !t.agent || t.agent === 'shell' || t.connected !== true || t.writable !== true || t.orphaned) throw Error(errorText('orca.send.not_agent', { terminal }));
      }, async () => {
        const data = await run(['terminal', 'send', '--terminal', terminal, '--text', message, '--enter', '--wait-submit', '1']);
        if (!data.send?.accepted || data.send.handle !== terminal || !data.send.prompt?.requestId || data.send.prompt.requestId === 'unsupported-old-host') throw Error('Durable receipt missing.');
        return { terminal, projectId, receipt: data.send };
      }, signal);
    } },
  { name: 'orca_start_agent', label: 'Start agent in Orca', ...schema('orca_start_agent'),
    async execute(requestId, { projectId, worktreeId, agent, message, model, effort }, signal) {
      const invalid = !valid(worktreeId) ? 'orca.start.missing_worktree_id'
        : !valid(agent) || !/^[a-z][a-z0-9-]{0,63}$/.test(agent) ? 'orca.start.invalid_agent'
          : !valid(message) ? 'orca.start.missing_message'
            : model !== undefined && !valid(model) ? 'orca.start.invalid_model'
              : effort !== undefined && !model ? 'orca.start.effort_needs_model'
                : effort !== undefined && !valid(effort) ? 'orca.start.invalid_effort' : null;
      if (invalid) throw new NotDispatchedError(errorText(invalid));
      return dispatch(requestId, projectId, { kind: 'launch', worktreeId, agent, message, model: model || null, effort: effort || null },
        () => target(projectId, worktreeId, undefined, signal), async () => {
          const data = await run(['agent', 'launch', '--worktree', 'id:' + worktreeId, '--agent', agent, '--surface', 'terminal', '--prompt', message,
            ...(model ? ['--model', model] : []), ...(effort ? ['--effort', effort] : [])], { timeout: 60000 });
          if (data.outcome?.kind !== 'terminal' || !data.outcome.handle || data.worktreeId !== worktreeId || !data.receipt) throw Error('Launch without the expected receipt.');
          return { projectId, terminal: data.outcome.handle, receipt: data };
        }, signal);
    } }];
}
