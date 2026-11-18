import { double } from './fixtures.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectContext } from '../src/conversation/context.mjs';

test('context retains thread evidence, suppresses timestamp-only updates and marks stale sources honestly', async () => {
  const state = mkdtempSync(join(tmpdir(), 'caller-context-'));
  writeFileSync(join(state, 'tracked-threads.json'), JSON.stringify([{ threadId: 'thread_test', project: 'demo', task: 'test' }]));
  let fail = false, threadReads = 0;
  const context = new ProjectContext(double<ConstructorParameters<typeof ProjectContext>[0]>({ state, store: {}, publish: () => {},
    readOverview: async () => { if (fail) throw new Error('Offline'); return { projects: [{ id: 'p', name: 'demo' }], workspaces: [], terminals: [] }; },
    readThread: async () => { threadReads++; return { thread: { status: 'running' }, messages: [{role: 'assistant', text: 'Tests passed sk-secret-example'}] }; }
  }));
  try {
    assert.equal(await context.refresh(), true);
    const observed = JSON.stringify(context.snapshot.tracked);
    assert.match(observed, /Tests passed/);
    assert.equal(observed.includes('sk-secret-example'), false);
    assert.equal(await context.refresh(), false); assert.equal(threadReads, 2);
    const checkedAt = context.snapshot.checkedAt; fail = true;
    await context.refresh(); assert.equal(context.snapshot.status, 'stale'); assert.equal(context.snapshot.checkedAt, checkedAt);
  } finally { rmSync(state, { recursive: true, force: true }); }
});

test('context preserves partial discovery, lineage and explicit truncation across restarts', async () => {
  const state = mkdtempSync(join(tmpdir(), 'caller-context-'));
  try {
    for (let restart = 0; restart < 2; restart++) {
      const context = new ProjectContext(double<ConstructorParameters<typeof ProjectContext>[0]>({ state, store: {}, publish() {},
        readOverview: async () => ({ projects: [], workspaces: [],
          discovery: { complete: false, warnings: [{ code: 'thread_status_unavailable' }] },
          threads: Array.from({ length: 41 }, (_, i) => ({ threadId: `child-${i}`, parentThreadId: 'parent', rootThreadId: 'root', relationshipToParent: 'subagent', status: 'unknown', statusVerified: false })) }) }));
      await context.refresh();
      const snapshot = context.snapshot;
      assert.equal(snapshot.status, 'partial');
      assert.equal(snapshot.discovery?.complete, false);
      assert.equal(snapshot.threadCount, 41);
      assert.equal(snapshot.threadsTruncated, true);
      assert.equal(snapshot.threads?.length, 40);
      assert.equal(snapshot.threads?.[0]?.rootThreadId, 'root');
      assert.equal(snapshot.threads?.[0]?.statusVerified, false);
    }
  } finally { rmSync(state, { recursive: true, force: true }); }
});
