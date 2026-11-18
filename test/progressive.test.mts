import type { Overview } from '../src/shared/contracts.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Discovery } from '../src/adapters/discovery.mjs';
import { t3Overview } from '../src/adapters/t3/client.mjs';
import { overview } from '../src/adapters/orca/client.mjs';
import { startupHarness } from '../scripts/measure-startup.mjs';
const gate = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };

test('catalog is available while CLI is blocked; progress, coalescing, failures and generations stay isolated', async () => {
  const blocked = gate(); let scans = 0; let emit!: (data: Overview) => void;
  const a = new Discovery({ name: 'test', id: 't3', catalog: () => [{ id: 'p', name: 'P', path: '' }], overview: async ({ onProgress } = {}) => {
    scans++; emit = onProgress!; await blocked.promise; throw new Error('private CLI error');
  } });
  const b = new Discovery({ name: 'test', id: 'orca', catalog: () => [{ id: 'other', name: 'Other', path: '' }], overview: async ({ projects } = {}) => ({ projects: projects!(), threads: [], workspaces: [], terminals: [], discovery: { complete: true } }) });
  const catalog = await a.progressive();
  assert.equal(catalog.projects[0].id, 'p'); assert.equal(catalog.pending, true);
  assert.equal(catalog.discovery!.complete, false);
  const full = a.read(); assert.equal(full, a.read());
  emit({ ...catalog, workspaces: [{ id: 'verified', projectId: 'p' }] });
  assert.equal((await a.progressive(catalog.generation)).workspaces.length, 1);
  assert.equal((await b.progressive()).projects[0].id, 'other');
  blocked.resolve(); await assert.rejects(full!, /private/);
  const partial = await a.progressive(catalog.generation);
  assert.equal(partial.pending, false); assert.equal(partial.discovery!.complete, false);
  assert.equal(partial.projects[0].id, 'p'); assert.doesNotMatch(JSON.stringify(partial), /private CLI/);
  await a.progressive('older-generation'); assert.equal(scans, 1);
});

test('T3 progress keeps children unknown until verified and bounds all CLI work', async () => {
  const blocked = gate(); let active = 0, maximum = 0; const updates: Overview[] = [];
  const projects = Array.from({ length: 7 }, (_, i) => ({ id: String(i), name: String(i), path: '' }));
  const done = t3Overview({ projects: () => projects,
    metadata: () => ({ excluded: [], warnings: [], threads: projects.map(p => ({ threadId: `c${p.id}`, projectId: p.id, relationshipToParent: 'subagent' })) }),
    onProgress: data => updates.push(data), run: async (args: string[]) => {
      maximum = Math.max(maximum, ++active); await blocked.promise; active--;
      if (args[1] === 'list') return [];
      if (args[2] === 'c1') throw Error('offline');
      return { thread: { status: 'running' } };
    } });
  assert.equal(updates[0].threads.length, 7);
  assert.ok(updates[0].threads.every(t => t.status === 'unknown' && t.statusVerified === false));
  blocked.resolve(); const final = await done;
  assert.equal(maximum, 4); assert.equal(final.threads.length, 7);
  assert.equal(final.discovery.complete, false);
  assert.ok(updates.some(d => d.threads.some(t => t.statusVerified === true)));
  assert.equal(final.threads.find(t => t.threadId === 'c1')!.status, 'unknown');
});

test('Orca retains catalog and verified workspaces when terminals fail', async () => {
  const updates: Overview[] = [];
  const data = await overview(async (args: string[]) => {
    if (args[0] === 'terminal') throw Error('private');
    return { worktrees: [{ worktreeId: 'w', repoId: 'p', liveTerminalCount: 1 }] };
  }, { projects: () => [{ id: 'p', name: 'P', path: '' }], onProgress: d => updates.push(d) });
  assert.equal(data.projects.length, 1); assert.equal(data.workspaces.length, 1);
  assert.equal(data.discovery!.complete, false); assert.equal(updates.length, 2);
});

test('progressive HTTP authenticates, returns catalog before delayed CLI and polls without rescanning', async () => {
  const h = await startupHarness({ delay: 900 });
  try {
    assert.equal((await h.request('/api/projects?progressive=1', { auth: false })).code, 401);
    assert.equal((await h.request('/api/projects?progressive=1', { origin: 'https://invalid.example' })).code, 403);
    const catalog = await h.request('/api/projects?progressive=1');
    assert.equal(catalog.code, 200); assert.ok(catalog.ms < 600); assert.equal(catalog.data.pending, true);
    assert.equal(catalog.data.projects.length, 1);
    await h.request('/api/context');
    const final = await h.request(`/api/projects?progressive=1&generation=${catalog.data.generation}`);
    assert.equal(final.data.pending, false); assert.equal(final.data.discovery.complete, true);
    assert.equal(h.count(), 1);
  } finally { await h.close(); }
});

test('Orca scan starts all three reads together, coalesces and never retains reads for the next scan', async () => {
  const { orcaDiscovery } = await import('../src/adapters/orca/client.mjs');
  const blocked = gate(); let calls = 0;
  const discovery = new Discovery({ name: 'test', id: 'orca', overview: async () => { throw Error('must use scoped reader'); }, createDiscovery: () => orcaDiscovery(async () => {
    calls++; await blocked.promise; return { repos: [], worktrees: [], terminals: [] };
  }) });
  const initial = discovery.progressive();
  await new Promise<void>(r => setImmediate(r)); assert.equal(calls, 3);
  const full = discovery.read(); blocked.resolve();
  const catalog = await initial; await full;
  await discovery.progressive(catalog.generation); assert.equal(calls, 3);
  await discovery.read(); assert.equal(calls, 6);
});


test('Orca progressive discovery preserves local terminal capabilities and refreshes full reads', async () => {
  const { ades } = await import('../src/adapters/registry.mjs');
  const { orcaDiscovery } = await import('../src/adapters/orca/client.mjs');
  assert.equal(ades.orca.capabilities.readTerminalOutput, true);
  assert.equal(ades.orca.capabilities.sendMessagesOnRequest, true);
  assert.equal(ades.orca.capabilities.startAgent, true);
  const terminal = { handle: 't', worktreeId: 'w', agentIdentity: 'codex', connected: true, writable: true, orphaned: false };
  const run = async (args: string[]) => args[0] === 'repo' ? { repos: [{ id: 'p', displayName: 'P', path: '' }] }
    : args[0] === 'worktree' ? { worktrees: [{ worktreeId: 'w', repoId: 'p' }] } : { terminals: [terminal] };
  const direct = await overview(run);
  const discovery = new Discovery({ ...ades.orca, createDiscovery: () => orcaDiscovery(run) });
  const progressive = await discovery.read();
  assert.deepEqual(progressive.terminals, direct.terminals);
  assert.equal(progressive.terminals[0].agent, 'codex');
});

test('catalog failure rejects progressive reads without exposing an old catalog', async () => {
  let fail = false;
  const discovery = new Discovery({ name: 'test', id: 't3', catalog: () => {
    if (fail) throw new Error('catalog unavailable');
    return [{ id: 'p', name: 'P', path: '' }];
  }, overview: async ({ projects } = {}) => ({ projects: projects!(), threads: [], workspaces: [], terminals: [], discovery: { complete: true } }) });
  await discovery.read();
  fail = true;
  const progressive = discovery.progressive();
  const full = discovery.pending;
  await Promise.all([assert.rejects(progressive, /catalog unavailable/),
    assert.rejects(full!, /catalog unavailable/)]);
  assert.equal(discovery.snapshot, null);
});
