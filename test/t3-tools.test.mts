import { double } from './fixtures.mjs';
import { testTool, type TestTool } from './fixtures.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { t3Tools } from '../src/adapters/t3/tools.mjs';
import { T3Coordinator } from '../src/adapters/t3/coordinator.mjs';
import { NotDispatchedError } from '../src/shared/contracts.mjs';

test('T3 operations have no Bash, list read-only and bind sends to the server request ID', async () => {
  const calls: string[][] = [], deliveries: Parameters<T3Coordinator['dispatch']>[0][] = [];
  const tools = new Map<string, TestTool>(t3Tools({
    overview: async () => ({ workspaces: [], terminals: [], discovery: { complete: true, warnings: [] }, projects: [{ id: 'p', name: 'P', path: '/p' }], threads: [{ threadId: 'existing', projectId: 'p' }] }),
    run: async (args: string[]) => { calls.push(args); return {}; },
    coordinatorFactory: () => double<T3Coordinator>({ dispatch: async params => { deliveries.push(params); return { status: 'delivered' }; }, close() {} })
  }).map(t => [t.name, testTool(t)]));
  assert.deepEqual([...tools.keys()], ['t3_find_threads', 't3_list_threads', 't3_send_message']);
  const execute = async (id: string, name: string, params: Parameters<TestTool['execute']>[1]) => (await tools.get(name)!.execute(id, params)).content[0].text;
  assert.match(await execute('voice:c:1', 't3_list_threads', {}), /id existing/);
  assert.equal(deliveries.length, 0, 'listing must never send');
  await assert.rejects(execute('', 't3_send_message', { projectId: 'p', project: 'Demo', message: 'Hola' }), /identifier/);
  await execute('voice:call:real-request-123', 't3_send_message', { projectId: 'p', project: 'Demo', threadId: 'existing', message: 'Hola', requestId: 'model-invented-id' });
  assert.equal(deliveries[0].requestId, 'voice:call:real-request-123');
  assert.equal(calls.length, 0, 'the coordinator, not the tool, runs the CLI');
});

test('explicit existing conversation receives message even when project has a different principal', async () => {
  const state = mkdtempSync(join(tmpdir(), 't3-target-')); const sent: string[][] = [];
  const run = async (args: string[]) => {
    if (args[1] === 'show') return { thread: { projectId: 'p', link: 'https://app.t3.codes/' + args[2] } };
    sent.push(args); return { threadId: args[1] === 'start' ? 'main' : args[2], link: 'https://app.t3.codes/thread' };
  };
  const c = new T3Coordinator(state, run);
  try {
    const input = { projectId: 'p', project: 'Demo', message: 'Encargo' };
    await c.dispatch({ ...input, requestId: 'create-main' });
    await c.dispatch({ ...input, requestId: 'existing-message', threadId: 'other' });
    assert.equal(sent[1][2], 'other');
    await c.dispatch({ ...input, requestId: 'default-again' });
    assert.equal(sent[2][2], 'main');
    const followed = JSON.parse(readFileSync(join(state, 'tracked-threads.json'), 'utf8'));
    assert.deepEqual(followed.map((t: { threadId: string; role: string }) => [t.threadId, t.role]), [['main', 'main'], ['other', 'conversation']]);
    await assert.rejects(c.dispatch({ ...input, requestId: 'existing-message', threadId: 'different' }), /another request/);
  } finally { c.close(); rmSync(state, { recursive: true, force: true }); }
});

test('failed read before delivery does not block later correctly addressed requests', async () => {
  const state = mkdtempSync(join(tmpdir(), 't3-preflight-'));
  let sends = 0;
  const c = new T3Coordinator(state, async (args: string[]) => {
    if (args[1] === 'show') return { thread: { projectId: args[2] === 'wrong' ? 'other-project' : 'p', title: 'Riego' } };
    sends++; return { threadId: args[2] };
  }, { projects: () => [{ id: 'other-project', name: 'Otro' }] });
  try {
    const input = { projectId: 'p', project: 'Demo', message: 'Encargo' };
    await assert.rejects(c.dispatch({ ...input, requestId: 'bad-target', threadId: 'wrong' }), (e: Error) => e instanceof NotDispatchedError
      && e.message === 'Thread "Riego" · wrong belongs to project "Otro" · other-project, not to "Demo". Nothing was sent. If it is the thread the user accepted, repeat the send with projectId=other-project and project="Otro"; if not, ask them.');
    assert.equal(sends, 0);
    assert.equal((await c.dispatch({ ...input, requestId: 'fixed-target', threadId: 'right' })).status, 'delivered');
    assert.equal(sends, 1);
  } finally { c.close(); rmSync(state, { recursive: true, force: true }); }
});

test('T3 send errors before the CLI send are NotDispatchedError; after it they stay uncertain', async () => {
  const state = mkdtempSync(join(tmpdir(), 'caller-notsent-'));
  let failSend = false;
  const coordinator = new T3Coordinator(state, (async (args: string[]) => {
    if (args[1] === 'show') return { thread: { projectId: args[2] === 'th-otro' ? 'otro' : 'p', archived: false } };
    if (failSend) throw new Error('timeout');
    return { threadId: 'th1', runId: 'run1', delivery: 'started' };
  }) as never, { projects: () => [] });
  try {
    await assert.rejects(coordinator.dispatch({ requestId: 'req-00001', projectId: 'p', project: 'Faro', threadId: 'th-otro', message: 'Revisa' }), (e: Error) => e instanceof NotDispatchedError);
    failSend = true;
    await assert.rejects(coordinator.dispatch({ requestId: 'req-00002', projectId: 'p', project: 'Faro', threadId: 'th1', message: 'Revisa' }), (e: Error) => !(e instanceof NotDispatchedError) && /timeout/.test(e.message));
  } finally { coordinator.close(); rmSync(state, { recursive: true, force: true }); }
});
