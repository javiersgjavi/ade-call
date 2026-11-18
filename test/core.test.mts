import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/conversation/store.mjs';

test('the first use of an ADE starts a real conversation; it and the events survive a restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ade-call-test-'));
  let store = new Store(join(dir, 'test.sqlite'));
  try {
    const first = store.conversation('t3');
    assert.match(first.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.ok(Number.isFinite(Date.parse(first.createdAt)));
    assert.notEqual(store.conversation('orca').id, first.id, 'each ADE has its own conversation');
    store.event('transcript', { call: 'c', role: 'user', text: 'Hola', order: 1, backend: 't3', conversationId: first.id });
    store.close(); store = new Store(join(dir, 'test.sqlite'));
    assert.deepEqual(store.conversation('t3'), first);
    assert.equal(store.events(0).length, 1);
    assert.equal(store.events(1).length, 0);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
