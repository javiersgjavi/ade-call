import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/conversation/store.mjs';

test('stored call events are read per ADE and conversation, oldest first, bounded and up to a cursor', () => {
  const dir = mkdtempSync(join(tmpdir(), 'call-events-'));
  const store = new Store(join(dir, 'caller.sqlite'));
  try {
    const ids = [];
    for (let i = 0; i < 6; i++) ids.push(store.event(i % 2 ? 'voice-tool' : 'transcript', { call: 'c', id: 'c', text: `t${i}`, backend: 'orca', conversationId: 'k' }).id);
    store.event('voice', { id: 'c', status: 'connected', backend: 'orca', conversationId: 'k' });
    store.event('notice', { backend: 'orca', conversationId: 'k' });
    const all = store.callEvents('orca', 'k');
    assert.deepEqual(all.events.map(e => e.id), ids); assert.equal(all.truncated, false);
    const last = store.callEvents('orca', 'k', Number.MAX_SAFE_INTEGER, 4);
    assert.deepEqual(last.events.map(e => e.id), ids.slice(2), 'the latest ones, in order'); assert.equal(last.truncated, true);
    assert.deepEqual(store.callEvents('orca', 'k', ids[2]).events.map(e => e.id), ids.slice(0, 3));
    assert.deepEqual(store.callEvents('t3', 'k').events, []); assert.deepEqual(store.callEvents('orca', 'other').events, []);
    // The read uses the per-conversation index: an empty new conversation does
    // not scan the history of the others.
    const plan = store.db.prepare(`EXPLAIN QUERY PLAN SELECT id FROM events WHERE type IN ('transcript','voice-tool')
      AND json_extract(payload, '$.backend')=? AND json_extract(payload, '$.conversationId')=? AND id<=? ORDER BY id DESC LIMIT ?`)
      .all('orca', 'nueva', Number.MAX_SAFE_INTEGER, 401).map(r => String(r.detail)).join('\n');
    assert.match(plan, /USING INDEX events_calls/); assert.doesNotMatch(plan, /TEMP B-TREE/);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
