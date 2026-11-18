import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { T3Coordinator } from '../src/adapters/t3/coordinator.mjs';
import { OrcaDispatch } from '../src/adapters/orca/dispatch.mjs';

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };

test('T3 interruption before CLI mutation rejects; after dispatch preserves receipt or uncertainty', async () => {
  const dir = mkdtempSync(join(tmpdir(), 't3-interruption-'));
  const gate = deferred(), entered = deferred(), controller = new AbortController();
  const calls: string[] = [];
  const coordinator = new T3Coordinator(dir, async args => {
    calls.push(args[1]);
    if (args[1] === 'show') { entered.resolve(); await gate.promise; return { thread: { projectId: 'p', link: 'link' } }; }
    return { threadId: 't', link: 'link' };
  });
  const request = { requestId: 'request-interrupted', projectId: 'p', project: 'project', message: 'work', threadId: 't' };
  try {
    const sending = coordinator.dispatch(request, controller.signal);
    const rejected = assert.rejects(sending);
    await entered.promise; controller.abort(); gate.resolve(); await rejected;
    assert.deepEqual(calls, ['show']);
    assert.equal(coordinator.db.prepare('SELECT status FROM dispatches').get()!.status, 'rejected');
    const afterSend = new AbortController();
    coordinator.run = async (_args, options) => { assert.equal(options?.signal, undefined, 'do not kill an in-flight delivery'); afterSend.abort(); return { threadId: 't' }; };
    const sent = await coordinator.dispatch({ ...request, requestId: 'request-delivered', projectId: 'new-project', threadId: undefined }, afterSend.signal);
    assert.equal(sent.status, 'delivered');
    coordinator.run = async () => { throw Error('Lost response'); };
    await assert.rejects(coordinator.dispatch({ ...request, requestId: 'request-uncertain', projectId: 'other', threadId: undefined }));
    assert.equal(coordinator.db.prepare('SELECT status FROM dispatches WHERE requestId=?').get('request-uncertain')!.status, 'unknown');
  } finally { coordinator.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('Orca preflight interruption prevents send, accepted delivery survives interruption, unknown blocks retry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-interruption-'));
  const journal = new OrcaDispatch(dir), controller = new AbortController();
  let mutations = 0;
  try {
    await assert.rejects(journal.dispatch('request-before', 'p', {}, async () => { controller.abort(); }, async () => { mutations++; return {}; }, controller.signal));
    assert.equal(mutations, 0);
    assert.equal(journal.db.prepare('SELECT status FROM operations').get()!.status, 'rejected');
    const after = new AbortController();
    const receipt = await journal.dispatch('request-after', 'p', {}, async () => {}, async () => { after.abort(); mutations++; return { receipt: 'accepted' }; }, after.signal);
    assert.equal(receipt.status, 'accepted');
    await assert.rejects(journal.dispatch('request-unknown', 'p', {}, async () => {}, async () => { mutations++; throw Error('lost'); }), /uncertain/i);
    await assert.rejects(journal.dispatch('request-retry', 'p', {}, async () => {}, async () => { mutations++; return {}; }), /uncertain/i);
    assert.equal(mutations, 2);
  } finally { journal.close(); rmSync(dir, { recursive: true, force: true }); }
});
