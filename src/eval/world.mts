import type { Message, T3Response, Thread } from '../shared/contracts.mjs';
import { DirectCallState } from '../direct/state.mjs';
import { NotDispatchedError, type DirectAde } from '../direct/contract.mjs';
import { errorText, t3DeliveryPrompt } from '../resources.mjs';
import { WORKING } from '../conversation/thread-watch.mjs';
import { evalText } from './judge.mjs';
import type { World, WorldThread } from './scenario.mjs';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { t3DirectAde, t3DirectCatalog } from '../direct/t3.mjs';
import { T3ReadCache } from '../adapters/t3/read-cache.mjs';
import { dispatchArgumentError, referenceLine, sentReferences } from '../adapters/t3/coordinator.mjs';
import { t3Projects, t3OpenThreadIndex, t3FindThreads, t3ThreadMetadata, t3Overview } from '../adapters/t3/client.mjs';

// A simulated T3 for evaluations. The voice gets the production T3 DirectAde
// (same prompt, tools, catalog, search, read formats and send gate); only the
// data underneath is invented: a temporary copy of T3's local projection in
// SQLite and a T3 CLI that answers from the scenario's world. Sends are
// recorded and never leave the process.

export interface SimulatedSend {
  at: number; requestId: string; projectId: string; project: string; threadId?: string; message: string;
  // World keys of the destination ("" for a thread created by the send).
  projectKey: string; threadKey: string | null;
  // The CLI failed after the message arrived: the voice was told it is uncertain.
  uncertain?: boolean; arrival?: 'confirmed' | 'unknown';
}
export interface SimulatedReply { threadId: string; threadKey: string; title: string; project: string; text: string; status: string; runId: string }

// Stable UUIDs from world keys: the same scenario shows the same short IDs every run.
export function worldId(kind: string, key: string) {
  const h = createHash('sha256').update(`${kind}:${key}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

interface LiveThread { key: string; projectKey: string; spec: WorldThread; thread: Thread; messages: Message[] }

export class SimulatedT3 {
  readonly base: string; readonly ade: DirectAde;
  readonly sends: SimulatedSend[] = [];
  readonly resolvedTargets = new Map<string, Record<string, unknown>>();
  readonly cliCalls: string[][] = [];
  threads = new Map<string, LiveThread>();
  projects = new Map<string, { key: string; id: string; name: string }>();
  // Uncertain sends by project ID, as T3 Coordinator's journal keeps them: the
  // project takes no more sends until a read finds the reference or the user releases it.
  uncertain = new Map<string, { requestId: string; threadId: string | null; title: string; at: number }>();
  timers = new Set<NodeJS.Timeout>();
  // When the last pending simulated reply is due (epoch ms).
  lastDue = 0;
  // The user turn being spoken, and replies waiting for a later one (onSend.afterTurn).
  turn = 0;
  // Messages waiting for a busy thread, by thread ID: each starts its run when the current one ends.
  queued = new Map<string, (() => string)[]>();
  deferred: { turn: number; arm: () => void }[] = [];
  // Called when a simulated agent finishes the turn a send started.
  onReply: (reply: SimulatedReply) => void = () => {};

  constructor(readonly world: World, readonly now: () => number = Date.now) {
    this.base = mkdtempSync(join(tmpdir(), 'ade-call-eval-t3-'));
    mkdirSync(join(this.base, 'userdata'));
    const start = now();
    for (const p of world.projects) {
      const project = { key: p.key, id: worldId('project', p.key), name: p.name };
      this.projects.set(p.key, project);
      (p.threads || []).forEach((t, i) => {
        const id = worldId('thread', t.key);
        const updatedAt = t.updatedAt || new Date(start - (i + 1) * 3_600_000).toISOString();
        this.threads.set(id, { key: t.key, projectKey: p.key, spec: t, messages: (t.messages || []).map(m => ({ role: m.role, text: m.text, runId: 'run-0' })),
          thread: { threadId: id, projectId: project.id, title: t.title, status: t.status || 'completed', updatedAt, runCount: 1, latestRunId: 'run-0',
            ...(t.parent ? { parentThreadId: worldId('thread', t.parent), relationshipToParent: 'subagent' } : {}) } });
      });
    }
    this.writeProjection();
    const cache = new T3ReadCache({ run: this.run, fingerprint: () => null });
    const base = this.base;
    this.ade = t3DirectAde({
      snapshot: () => ({ projects: [], threads: [] }) as never, cache,
      // With the statuses the server would have observed, as the production catalog shows them.
      catalog: () => t3DirectCatalog({ projects: () => t3Projects(base), threads: ids => t3OpenThreadIndex(ids, base, { dated: true }), observed: [...this.threads.values()].map(t => ({ ...t.thread })) }),
      tools: {
        run: this.run, findThreads: params => t3FindThreads(params, base),
        overview: params => t3Overview({ ...params, projects: () => t3Projects(base), run: this.run, metadata: ids => t3ThreadMetadata(ids, base) }),
        coordinatorFactory: () => this.coordinator() as never,
        // The simulated world has no documents: nothing is read from the real installation.
        documents: async () => ({ projects: [] })
      }
    });
    // Snapshot ID resolution at execution time, using the same call memory as the
    // adapter. Later discoveries must not change the destination in the evidence.
    this.ade.tools = this.ade.tools.map(tool => ({ ...tool, execute: (args, context) => {
      const resolved: Record<string, unknown> = {}, snapshot = new DirectCallState(context.state.now);
      snapshot.ids = new Set(context.state.ids); snapshot.aliases = new Map(context.state.aliases);
      const fields = tool.name === 't3_read_thread' ? ['threadId'] : ['projectId', 'threadId', 'parentThreadId', 'rootThreadId'];
      try {
        for (const field of fields) if (field in args) resolved[field] = snapshot.resolve(args[field], field);
        this.resolvedTargets.set(context.requestId, resolved);
      } catch { /* The adapter reports invalid IDs; no resolved destination is asserted. */ }
      return tool.execute(args, context);
    } }));
    // The production prefetch reads the real T3 installation.
    this.ade.prefetch = undefined;
  }

  // The runner tells when each user turn starts.
  startTurn(turn: number) {
    this.turn = turn;
    const due = this.deferred.filter(d => d.turn <= turn);
    this.deferred = this.deferred.filter(d => d.turn > turn);
    for (const d of due) d.arm();
  }

  // T3's local projection, rewritten after every change the CLI makes.
  writeProjection() {
    const path = join(this.base, 'userdata/statev2.sqlite');
    rmSync(path, { force: true });
    const db = new DatabaseSync(path);
    try {
      db.exec(`CREATE TABLE projection_projects(project_id,title,workspace_root,deleted_at,archived_at);
        CREATE TABLE orchestration_v2_projection_threads(thread_id,project_id,title,payload_json,archived_at,deleted_at,updated_at);`);
      for (const p of this.projects.values()) db.prepare('INSERT INTO projection_projects VALUES(?,?,?,NULL,NULL)').run(p.id, p.name, `/projects/${p.key}`);
      for (const t of this.threads.values()) {
        const parent = t.spec.parent ? worldId('thread', t.spec.parent) : undefined;
        const root = parent ? this.root(parent) : undefined;
        const payload = { id: t.thread.threadId, projectId: t.thread.projectId, status: t.thread.status, settledAt: t.spec.settled ? t.thread.updatedAt : null, settledOverride: null,
          ...(parent ? { lineage: { parentThreadId: parent, rootThreadId: root, relationshipToParent: 'subagent' } } : {}) };
        db.prepare('INSERT INTO orchestration_v2_projection_threads VALUES(?,?,?,?,?,NULL,?)').run(t.thread.threadId, t.thread.projectId, t.thread.title || '', JSON.stringify(payload), t.spec.archived ? t.thread.updatedAt! : null, t.thread.updatedAt!);
      }
    } finally { db.close(); }
  }
  root(id: string): string {
    const parent = this.threads.get(id)?.spec.parent;
    return parent ? this.root(worldId('thread', parent)) : id;
  }
  keyOf(threadId?: string) { return threadId ? this.threads.get(threadId)?.key ?? null : null; }
  projectKeyOf(projectId?: string) { return [...this.projects.values()].find(p => p.id === projectId)?.key ?? ''; }

  // The T3 CLI as the adapter calls it: thread show and thread list.
  run = async (args: string[], options: { signal?: AbortSignal } = {}): Promise<T3Response | Thread[]> => {
    options.signal?.throwIfAborted();
    this.cliCalls.push(args);
    await new Promise(resolve => setTimeout(resolve, 150));
    if (args[0] === 'thread' && args[1] === 'show') {
      const id = args[2] === '--' ? args[3] : args[2];
      const count = Number(args[args.indexOf('--messages') + 1]) || 6;
      const live = this.threads.get(id);
      if (!live) throw new Error(evalText('sim_thread_not_found'));
      if (live.spec.failReads) throw new Error(evalText('sim_cli_failed'));
      // As T3's CLI: the thread carries its archived and settled state.
      return { thread: { ...live.thread, ...(live.spec.archived ? { archived: true } : {}), ...(live.spec.settled ? { settled: true } : {}) } as Thread, messages: live.messages.slice(-count).map(m => ({ ...m })) };
    }
    if (args[0] === 'thread' && args[1] === 'list' && args[2] === '--project') {
      return [...this.threads.values()].filter(t => t.thread.projectId === args[3] && !t.spec.parent && !t.spec.archived).map(t => ({ ...t.thread }));
    }
    throw new Error(evalText('sim_not_implemented', { command: args.slice(0, 2).join(' ') }));
  };

  coordinator() {
    return {
      dispatch: async (params: { requestId: string; projectId: string; project: string; message: string; threadId?: string }) => {
        // As the production coordinator: what it refuses before sending is
        // NotDispatchedError (nothing was sent), never an uncertain delivery.
        // The production argument checks first: a refused call sends nothing and keeps the yes.
        const invalid = dispatchArgumentError(params);
        if (invalid) throw new NotDispatchedError(invalid);
        // As T3 Coordinator, an uncertain send blocks the project before any destination is looked at.
        const blocking = this.uncertain.get(params.projectId);
        if (blocking) throw new NotDispatchedError(errorText('t3.send.blocked', { when: `${Math.max(1, Math.round((this.now() - blocking.at) / 1000))} s ago`,
          where: blocking.threadId ? `to "${blocking.title}" · ${blocking.threadId}` : `to create thread "${blocking.title}"`, Check: blocking.threadId ? `Read "${blocking.title}" · ${blocking.threadId}` : `Find "${blocking.title}" with t3_find_threads and read it with t3_read_thread`, reference: blocking.requestId }));
        const found = [...this.projects.values()].find(p => p.id === params.projectId);
        // As T3 Coordinator: without a thread, `thread start` is attempted in an unknown
        // project and its failure leaves the delivery uncertain (the yes is spent);
        // with one, the thread is read first and decides (below).
        if (!found && !params.threadId) {
          this.sends.push({ at: this.now(), ...params, projectKey: '', threadKey: null, uncertain: true, arrival: 'unknown' });
          this.uncertain.set(params.projectId, { requestId: params.requestId, threadId: null, title: `Voice · ${params.project} · Main`, at: this.now() });
          throw new Error(evalText('sim_cli_failed'));
        }
        let live = params.threadId ? this.threads.get(params.threadId) : undefined;
        if (params.threadId && !live) throw new NotDispatchedError(evalText('sim_send_thread_not_found'));
        if (live && live.thread.projectId !== params.projectId) {
          // The production wording of T3 Coordinator for this refusal.
          const owner = [...this.projects.values()].find(p => p.id === live!.thread.projectId);
          throw new NotDispatchedError(errorText('t3.send.wrong_project', { thread: `"${live.thread.title}" · ${live.thread.threadId}`, project: params.project,
            owner: owner ? `project "${owner.name}" · ${owner.id}` : 'another project', retry: owner ? `projectId=${owner.id} and project="${owner.name}"` : 'the projectId of its project' }));
        }
        // Here the project exists: an unknown one either sent nothing or was refused above.
        const project = found!;
        // As T3 Coordinator, an existing destination is read before the send: a thread that cannot be read gets nothing.
        if (live?.spec.failReads) throw new NotDispatchedError(evalText('sim_send_read_failed'));
        if (live?.spec.archived) throw new NotDispatchedError(errorText('t3.send.archived', { thread: `"${live.thread.title}" · ${live.thread.threadId}` }));
        // A send without a thread goes to the project's main voice thread,
        // created by the first one and reused by the next, as T3 Coordinator does.
        const key = `main:${project.key}`, id = worldId('thread', key);
        if (!live && this.threads.has(id)) live = this.threads.get(id);
        this.sends.push({ at: this.now(), ...params, projectKey: project.key, threadKey: params.threadId ? live!.key : null });
        if (!live) {
          live = { key, projectKey: project.key, spec: { key, title: `Voice · ${params.project} · Main` }, messages: [],
            thread: { threadId: id, projectId: project.id, title: `Voice · ${params.project} · Main`, status: 'completed', updatedAt: new Date(this.now()).toISOString(), runCount: 0, latestRunId: null } };
          this.threads.set(id, live);
        }
        // As T3 Coordinator, the project name the voice gave is the one in titles,
        // receipts and notices; routing goes by the ID.
        // As T3: a busy thread takes the message as its next turn (queued, no run
        // yet); it starts when the current run ends.
        const target = live, busy = WORKING.has(live.thread.status || ''), uncertain = !!live.spec.onSend?.uncertain;
        const before = { runs: live.thread.runCount, latestRunId: live.thread.latestRunId };
        const start = () => {
          const runs = (target.thread.runCount || 0) + 1, runId = `run-${runs}`;
          // What T3 Coordinator writes into the thread: the delivery prompt with the request reference.
          const delivered = t3DeliveryPrompt(params.threadId ? 'existing' : 'main', { reference: referenceLine(params.requestId), message: params.message });
          if (!target.spec.onSend?.uncertain) target.messages.push({ role: 'user', text: delivered, runId });
          Object.assign(target.thread, { status: 'running', runCount: runs, latestRunId: runId, activeRunId: runId, updatedAt: new Date(this.now()).toISOString() });
          this.writeProjection();
          const reply = target.spec.onSend;
          // An uncertain delivery did arrive (with its reference, as T3 Coordinator writes it); only the receipt was lost.
          if (reply?.uncertain) { target.messages.push({ role: 'user', text: delivered, runId }); this.writeProjection(); return runId; }
          const delay = reply?.delayMs ?? 6000;
          const arm = () => {
          const timer = setTimeout(() => {
            this.timers.delete(timer);
            // As the thread watch: the final notice carries the last message; reads show them all.
            const text = (reply?.reply || []).filter(part => part.trim()).at(-1) ?? '';
            for (const part of reply?.reply || []) target.messages.push({ role: 'assistant', text: part, runId });
            // Only the latest run decides the thread's status: an older run
            // ending never marks a newer one, still running, as finished.
            if (target.thread.latestRunId === runId) Object.assign(target.thread, { status: reply?.status || 'completed', activeRunId: null });
            target.thread.updatedAt = new Date(this.now()).toISOString();
            this.writeProjection();
            // A newer send replaced the watch on this thread: the older reply stays in the history, unannounced.
            if (target.thread.latestRunId !== runId) return;
            this.onReply({ threadId: target.thread.threadId, threadKey: target.key, title: target.thread.title || '', project: params.project, text, status: reply?.status || 'completed', runId });
            // The next queued message starts its run now that this one ended.
            this.queued.get(target.thread.threadId)?.shift()?.();
          }, delay);
          this.timers.add(timer);
          this.lastDue = Math.max(this.lastDue, Date.now() + delay);
          };
          // A thread without onSend keeps working: no reply, as an agent still busy.
          // A reply timed from a later user turn waits for that turn to start.
          if (!reply) { /* running */ }
          else if (reply.afterTurn && this.turn < reply.afterTurn) this.deferred.push({ turn: reply.afterTurn, arm });
          else arm();
          return runId;
        };
        if (uncertain) {
          // The CLI timed out: the project is blocked and the voice is told the delivery may have happened.
          this.uncertain.set(project.id, { requestId: params.requestId, threadId: target.thread.threadId, title: target.thread.title || '', at: this.now() });
          this.sends.at(-1)!.uncertain = true;
          this.sends.at(-1)!.arrival = 'confirmed';
          if (busy) (this.queued.get(target.thread.threadId) ?? this.queued.set(target.thread.threadId, []).get(target.thread.threadId)!).push(start);
          else start();
          throw new Error(evalText('sim_send_timeout'));
        }
        if (busy) {
          (this.queued.get(target.thread.threadId) ?? this.queued.set(target.thread.threadId, []).get(target.thread.threadId)!).push(start);
          return { requestId: params.requestId, projectId: project.id, project: params.project, threadId: live.thread.threadId, link: null, runId: null, status: 'delivered', delivery: 'queued' as const, before };
        }
        const runId = start();
        return { requestId: params.requestId, projectId: project.id, project: params.project, threadId: live.thread.threadId, link: null, runId, status: 'delivered', delivery: 'started' as const, before };
      },
      // A read that finds the reference of the uncertain send records it as delivered.
      verifyRead: (thread: { threadId: string; projectId?: string }, messages: Message[] = []) => {
        const blocking = thread.projectId ? this.uncertain.get(thread.projectId) : undefined;
        if (!blocking || blocking.threadId !== thread.threadId || !sentReferences(messages).has(blocking.requestId)) return [];
        this.uncertain.delete(thread.projectId!);
        return [{ requestId: blocking.requestId, when: `${Math.max(1, Math.round((this.now() - blocking.at) / 1000))} s ago`, created: false }];
      },
      // The production wording, so the voice gets the same resend guidance.
      release: (projectId: string, _requestId?: string, read: (threadId: string, since: number) => boolean = () => false) => {
        if (typeof projectId !== 'string' || !projectId.trim()) throw new NotDispatchedError(errorText('release.missing_project_id'));
        const blocking = this.uncertain.get(projectId);
        if (!blocking) return errorText('t3.release.not_blocked');
        // As T3 Coordinator: the thread must have been read after the send.
        if (blocking.threadId && !read(blocking.threadId, blocking.at)) throw new NotDispatchedError(errorText('t3.release.unread', { thread: `"${blocking.title}" · ${blocking.threadId}` }));
        this.uncertain.delete(projectId);
        return errorText('t3.release.done', { when: `${Math.max(1, Math.round((this.now() - blocking.at) / 1000))} s ago`, where: blocking.threadId ? `to "${blocking.title}" · ${blocking.threadId}` : `to create thread "${blocking.title}"`, next: errorText('t3.release.open') });
      },
      close() {}
    };
  }
  close() {
    this.deferred = [];
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    rmSync(this.base, { recursive: true, force: true });
  }
}
