import { double } from './fixtures.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Discovery } from '../src/adapters/discovery.mjs';
import { startupHarness } from '../scripts/measure-startup.mjs';

test('discovery coalesces pending reads, expires status and never caches catalogs or failures', async () => {
  let resolve!: (value: { projects: { id: string }[]; discovery: { complete: boolean } }) => void, reject!: (error: Error) => void; let calls = 0, now = 0;
  const discovery = new Discovery(double<ConstructorParameters<typeof Discovery>[0]>({ name: 'Demo', overview: () => { calls++; return new Promise<{ projects: { id: string }[]; discovery: { complete: boolean } }>((yes, no) => { resolve = yes; reject = no; }); } }), { now: () => now });
  assert.deepEqual(discovery.status(), { state: 'loading' });
  assert.equal(calls, 0);
  const first = discovery.read(); assert.equal(first, discovery.read());
  await Promise.resolve(); assert.equal(calls, 1);
  resolve({ projects: [], discovery: { complete: false } }); await first;
  assert.equal(discovery.status().state, 'partial');
  now = 20_000; assert.equal(discovery.status().state, 'loading');
  const failed = discovery.read(); await Promise.resolve(); reject(new Error('offline'));
  await assert.rejects(failed, /offline/); assert.equal(discovery.status().state, 'unreachable');
  const retry = discovery.read(); await Promise.resolve(); assert.equal(calls, 3);
  resolve({ projects: [{ id: 'new' }], discovery: { complete: true } });
  assert.equal((await retry).projects[0].id, 'new'); assert.equal(discovery.status().state, 'ready');
});

test('HTTP boot is independent of slow discovery; concurrent reads share one scan per refresh', async () => {
  const h = await startupHarness({ delay: 800 });
  try {
    assert.equal((await h.request('/api/status', { auth: false })).code, 401);
    assert.equal((await h.request('/api/status', { origin: 'https://invalid.example' })).code, 403);
    const status = await h.request('/api/status');
    assert.equal(status.data.runtime, 'loading');
    assert.equal(h.count(), 0, 'status never invokes CLI');
    let finished = false;
    const reads = Promise.all([h.request('/api/projects'), h.request('/api/context'), h.request('/api/projects')]).then(results => { finished = true; return results; });
    const pendingStatus = await h.request('/api/status');
    assert.equal(pendingStatus.data.runtime, 'loading'); assert.equal(finished, false);
    const results = await reads;
    assert.ok(results.every(r => r.code === 200)); assert.equal(h.count(), 1);
    assert.equal((await h.request('/api/status')).data.runtime, 'ready');
    await h.request('/api/projects'); assert.equal(h.count(), 2, 'explicit refresh starts a new scan');
    h.fail(true);
    const partial = await h.request('/api/projects');
    assert.equal(partial.data.discovery.complete, false);
    assert.equal((await h.request('/api/status')).data.runtime, 'partial');
    h.fail(false);
    h.unavailable(true);
    const unavailable = await h.request('/api/projects');
    assert.notEqual(unavailable.code, 200); assert.equal(unavailable.data.projects, undefined);
    assert.equal((await h.request('/api/status')).data.runtime, 'unreachable');
    h.unavailable(false);
    assert.equal((await h.request('/api/projects')).code, 200);
    assert.equal((await h.request('/api/status')).data.runtime, 'ready');
  } finally { await h.close(); }
});

test('ADE discovery stays separate and coalesces Orca reads without probing from status', async () => {
  const h = await startupHarness({ delay: 400 });
  try {
    const initial = await h.request('/api/status?backend=orca');
    assert.equal(initial.data.backend, 'orca'); assert.equal(initial.data.runtime, 'loading');
    assert.equal(h.count(), 0);
    const results = await Promise.all([
      h.request('/api/projects?backend=orca'), h.request('/api/context?backend=orca'),
      h.request('/api/projects?backend=t3'), h.request('/api/context?backend=t3')
    ]);
    assert.ok(results.every(r => r.code === 200));
    assert.equal(h.count(), 4, 'one T3 scan and one three-command Orca scan');
    assert.equal(results[1].data.backend, 'orca'); assert.equal(results[3].data.backend, 't3');
    assert.equal(results[0].data.projects.length, 0); assert.equal(results[2].data.projects.length, 1);
    h.fail(true);
    assert.notEqual((await h.request('/api/projects?backend=orca')).code, 200);
    assert.equal((await h.request('/api/status?backend=orca')).data.runtime, 'unreachable');
    assert.equal((await h.request('/api/status?backend=t3')).data.runtime, 'ready');
    h.fail(false);
    await h.request('/api/projects?backend=orca');
    assert.equal((await h.request('/api/status?backend=orca')).data.runtime, 'ready');
  } finally { await h.close(); }
});
