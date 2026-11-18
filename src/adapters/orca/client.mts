import { cliFailure } from '../cli-failure.mjs';
import type { OrcaResponse, OrcaRun, Overview, DiscoveryOptions, Warning } from '../../shared/contracts.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { errorText } from '../../resources.mjs';
const exec = promisify(execFile);

// Orca answered, but not with the arrays this version of ADE Call reads.
export const ORCA_SCHEMA = errorText('orca.schema');

export async function orca(args: string[], { timeout = 20_000, signal }: { timeout?: number; signal?: AbortSignal } = {}) {
  signal?.throwIfAborted();
  const binary = process.env.ORCA_BIN || 'orca-ide';
  try {
    const { stdout } = await exec(binary, [...args, '--environment', 'local', '--json'], { timeout, maxBuffer: 8_000_000, signal });
    signal?.throwIfAborted();
    const result = JSON.parse(stdout) as { ok: boolean; result: OrcaResponse; error?: { message?: string } };
    if (!result.ok) throw Object.assign(new Error('Operation rejected'), { code: 'ADE_REJECTED' });
    return result.result;
  } catch (error) {
    signal?.throwIfAborted();
    // eslint-disable-next-line preserve-caught-error -- Never expose private CLI output.
    throw new Error(cliFailure('Orca', error));
  }
}

export async function orcaProjects(run = orca, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const data = await run(['repo', 'list'], { signal });
  signal?.throwIfAborted();
  if (!Array.isArray(data.repos)) throw new Error(ORCA_SCHEMA);
  return data.repos.map(r => ({ id: r.id, name: r.displayName, path: r.path }));
}

export async function overview(run: OrcaRun = orca, { projects, onProgress = () => {}, signal }: DiscoveryOptions = {}): Promise<Overview> {
  signal?.throwIfAborted();
  if (projects) {
    const data: Overview = { backend: 'orca', projects: projects(), workspaces: [], threads: [], terminals: [],
      discovery: { complete: false, warnings: [] } };
    const warnings: Warning[] = [];
    const publish = () => onProgress({ ...data, discovery: { complete: false, warnings: [...warnings] } });
    await Promise.all([
      (async () => {
        try {
          const result = await run(['worktree', 'ps'], { signal });
          signal?.throwIfAborted();
          if (!Array.isArray(result.worktrees)) throw new Error('schema');
          data.workspaces = result.worktrees.map(w => ({ id: w.worktreeId, projectId: w.repoId,
            name: w.displayName, path: w.path, status: w.status, cardStatus: w.workspaceStatus,
            comment: w.comment, activeTerminals: w.liveTerminalCount, updated: w.lastActivityAt }));
        } catch { signal?.throwIfAborted(); warnings.push({ code: 'workspaces_unavailable' }); }
        publish();
      })(),
      (async () => {
        try {
          const result = await run(['terminal', 'list'], { signal });
          signal?.throwIfAborted();
          if (!Array.isArray(result.terminals)) throw new Error('schema');
          data.terminals = result.terminals.map(t => ({ handle: t.handle, title: t.title, ...(t.paneTitle ? { paneTitle: t.paneTitle } : {}),
            worktreeId: t.worktreeId, agent: t.agentIdentity || t.agent || null, status: t.status,
            connected: t.connected, writable: t.writable, orphaned: t.orphaned }));
        } catch { signal?.throwIfAborted(); warnings.push({ code: 'terminals_unavailable' }); }
        publish();
      })()
    ]);
    return { ...data, discovery: { complete: warnings.length === 0, warnings } };
  }
  const [repos, worktrees, terminals] = await Promise.all([
    run(['repo', 'list'], { signal }), run(['worktree', 'ps'], { signal }), run(['terminal', 'list'], { signal })
  ]);
  signal?.throwIfAborted();
  if (!Array.isArray(repos.repos) || !Array.isArray(worktrees.worktrees) || !Array.isArray(terminals.terminals)) throw new Error(ORCA_SCHEMA);
  return {
    projects: (repos.repos || []).map(r => ({ id: r.id, name: r.displayName, path: r.path })),
    workspaces: (worktrees.worktrees || []).map(w => ({ id: w.worktreeId, projectId: w.repoId,
      name: w.displayName, path: w.path, status: w.status, cardStatus: w.workspaceStatus,
      comment: w.comment, activeTerminals: w.liveTerminalCount, updated: w.lastActivityAt })),
    threads: [], discovery: { complete: true },
    terminals: (terminals.terminals || []).map(t => ({ handle: t.handle, title: t.title, ...(t.paneTitle ? { paneTitle: t.paneTitle } : {}), worktreeId: t.worktreeId, agent: t.agentIdentity || t.agent || null, status: t.status, connected: t.connected, writable: t.writable, orphaned: t.orphaned }))
  };
}

// A scan owns these promises; concurrent catalog/activity readers share each CLI
// invocation, but the next explicit scan always performs fresh reads.
export function orcaDiscovery(run = orca) {
  const reads = new Map(['repo', 'worktree', 'terminal'].map((kind, i) => {
    const promise = Promise.resolve().then(() => run([kind, ['list', 'ps', 'list'][i]]));
    promise.catch(() => {});
    return [kind, promise];
  }));
  const shared: OrcaRun = args => reads.get(args[0])!;
  return { catalog: () => orcaProjects(shared), overview: (options?: DiscoveryOptions) => overview(shared, options) };
}
