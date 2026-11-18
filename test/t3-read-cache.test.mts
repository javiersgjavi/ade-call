import test from 'node:test';
import assert from 'node:assert/strict';
import { T3ReadCache, t3Fingerprint } from '../src/adapters/t3/read-cache.mjs';

function fixture() {
  const calls: string[][] = [];
  let fingerprint: string | null = 'v1';
  const cache = new T3ReadCache({
    fingerprint: () => fingerprint,
    run: async args => { calls.push(args); return { thread: { threadId: args[2] }, messages: Array.from({ length: Number(args[4] || 3) }, (_, i) => ({ role: 'agent', text: `m${i}` })) } as never; }
  });
  return { cache, calls, set(value: string | null) { fingerprint = value; } };
}

test('an unchanged thread is served from memory, a changed one is read again', async () => {
  const f = fixture();
  await f.cache.run(['thread', 'show', 'th1', '--messages', '6']);
  await f.cache.run(['thread', 'show', 'th1', '--messages', '6']);
  assert.equal(f.calls.length, 1); assert.equal(f.cache.hits, 1);
  f.set('v2');
  await f.cache.run(['thread', 'show', 'th1', '--messages', '6']);
  assert.equal(f.calls.length, 2);
});

test('a larger cached read serves a smaller one with the latest messages', async () => {
  const f = fixture();
  await f.cache.run(['thread', 'show', 'th1', '--messages', '30']);
  const small = await f.cache.run(['thread', 'show', 'th1', '--messages', '2']) as { messages: { text: string }[] };
  assert.deepEqual(small.messages.map(m => m.text), ['m58', 'm59']);
  await f.cache.run(['thread', 'show', 'th1', '--messages', '40']);
  assert.equal(f.calls.length, 1, 'the first read fetched a generous window');
  assert.equal(f.calls[0][4], '60');
  await f.cache.run(['thread', 'show', 'th1', '--messages', '80']);
  assert.equal(f.calls.length, 2, 'a larger request than cached reads again');
});

test('without a fingerprint, and for sends, the CLI always runs', async () => {
  const f = fixture();
  f.set(null);
  await f.cache.run(['thread', 'show', 'th1', '--messages', '6']); await f.cache.run(['thread', 'show', 'th1', '--messages', '6']);
  f.set('v1');
  await f.cache.run(['thread', 'send', 'th1', 'hola']); await f.cache.run(['thread', 'send', 'th1', 'hola']);
  assert.equal(f.calls.length, 4);
});

test('cached values are copies: a caller cannot alter the next answer', async () => {
  const f = fixture();
  const first = await f.cache.run(['thread', 'show', 'th1', '--messages', '3']) as { messages: unknown[] };
  first.messages.length = 0;
  const second = await f.cache.run(['thread', 'show', 'th1', '--messages', '3']) as { messages: unknown[] };
  assert.equal(second.messages.length, 3);
});

test('a read while the same read is in flight shares it instead of a second CLI call', async () => {
  const calls: string[][] = [];
  let answer!: (value: unknown) => void;
  const cache = new T3ReadCache({ fingerprint: () => 'v1', run: ((args: string[]) => { calls.push(args); return new Promise(resolve => { answer = resolve; }); }) as never });
  const prefetch = cache.run(['thread', 'show', 'th1', '--messages', '60']);
  const read = cache.run(['thread', 'show', 'th1', '--messages', '6']);
  answer({ thread: { threadId: 'th1' }, messages: Array.from({ length: 60 }, (_, i) => ({ role: 'assistant', text: `m${i}` })) });
  const [full, small] = await Promise.all([prefetch, read]) as { messages: { text: string }[] }[];
  assert.equal(calls.length, 1);
  assert.equal(full.messages.length, 60);
  assert.deepEqual(small.messages.map(m => m.text), ['m54', 'm55', 'm56', 'm57', 'm58', 'm59']);
  assert.equal(cache.shared, 1);
});

test('a failed shared read falls back to a call of its own; a changed fingerprint does not share', async () => {
  const calls: string[][] = [];
  let fp = 'v1', fail!: (error: Error) => void;
  const cache = new T3ReadCache({ fingerprint: () => fp, run: (async (args: string[]) => {
    calls.push(args);
    if (calls.length === 1) return new Promise((_, reject) => { fail = reject; });
    return { thread: { threadId: 'th1' }, messages: [{ role: 'assistant', text: fp }] };
  }) as never });
  const first = cache.run(['thread', 'show', 'th1', '--messages', '6']).catch(error => error as Error);
  const second = cache.run(['thread', 'show', 'th1', '--messages', '6']);
  await Promise.resolve();
  fail(new Error('cli caída'));
  assert.equal((await first as Error).message, 'cli caída');
  assert.equal(((await second) as { messages: { text: string }[] }).messages[0].text, 'v1');
  assert.equal(calls.length, 2);
  fp = 'v2';
  const a = cache.run(['thread', 'show', 'th2', '--messages', '6']);
  fp = 'v3';
  const b = cache.run(['thread', 'show', 'th2', '--messages', '6']);
  await Promise.all([a, b]);
  assert.equal(calls.length, 4, 'a fingerprint changed meanwhile means its own read');
});

test('the fingerprint opens one read-only handle, reuses it and reopens after an error', () => {
  let opened = 0, closed = 0, broken = false;
  const fakeDb = () => ({
    prepare: () => ({ get: () => { if (broken) throw new Error('database is locked'); return { n: 1, s: 0 }; } }),
    close: () => { closed++; }
  });
  const fingerprint = t3Fingerprint('/nonexistent-base', (() => { opened++; return fakeDb(); }) as never);
  for (let i = 0; i < 5; i++) assert.ok(fingerprint('thread', 'th1'));
  assert.equal(opened, 1);
  broken = true;
  assert.equal(fingerprint('thread', 'th1'), null);
  assert.equal(closed, 1, 'a failed handle is closed, not leaked');
  broken = false;
  assert.ok(fingerprint('thread', 'th1'));
  assert.equal(opened, 2);
});
