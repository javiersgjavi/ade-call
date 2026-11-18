import type { T3Response } from '../src/shared/contracts.mjs';
import { double } from './fixtures.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { NotDispatchedError } from '../src/shared/contracts.mjs';
import { T3Coordinator } from '../src/adapters/t3/coordinator.mjs';
import { t3Projects, t3Overview, t3ThreadMetadata } from '../src/adapters/t3/client.mjs';
import { Store } from '../src/conversation/store.mjs';
import { ProjectContext } from '../src/conversation/context.mjs';

test('T3 coordinator reuses main thread across restarts, deduplicates and never retries uncertain delivery', async () => {
  const state = mkdtempSync(join(tmpdir(), 'caller-t3-'));
  const calls: string[][] = [];
  let fail = false;
  const run = async (args: string[]) => {
    calls.push(args);
    if (args[1] === 'show') return { thread: { projectId: 'p1', link: 'https://app.t3.codes/threads/test/main' } };
    if (fail) throw new Error('lost response');
    return { threadId: 'main', runId: 'r1', link: 'https://app.t3.codes/threads/test/main' };
  };
  let c = new T3Coordinator(state, run);
  const first = { requestId: 'one', projectId: 'p1', project: 'Demo', message: 'Ejecuta el plan' };
  try {
    const receipt = await c.dispatch(first);
    assert.equal(receipt.status, 'delivered'); assert.equal(calls[0][1], 'start');
    assert.equal(JSON.parse(readFileSync(join(state, 'tracked-threads.json'), 'utf8'))[0].threadId, 'main');
    c.close(); c = new T3Coordinator(state, run);
    assert.deepEqual(await c.dispatch(first), receipt); assert.equal(calls.length, 1);
    await c.dispatch({ ...first, requestId: 'two', message: 'Fix that request' });
    assert.deepEqual(calls.slice(1).map(a => a[1]), ['show', 'send']);
    await assert.rejects(c.dispatch({ ...first, message: 'Diferente' }), /another request/);
    fail = true;
    await assert.rejects(c.dispatch({ ...first, requestId: 'three' }), /lost response/);
    const count = calls.length;
    await assert.rejects(c.dispatch({ ...first, requestId: 'three' }), /uncertain/);
    await assert.rejects(c.dispatch({ ...first, requestId: 'four' }), /uncertain/);
    assert.equal(calls.length, count);
  } finally { c.close(); rmSync(state, { recursive: true, force: true }); }
});

test('T3 discovers active projects read-only and uses native thread states', async () => {
  const base = mkdtempSync(join(tmpdir(), 'caller-t3-projects-'));
  mkdirSync(join(base, 'userdata'));
  const db = new DatabaseSync(join(base, 'userdata/statev2.sqlite'));
  db.exec("CREATE TABLE projection_projects(project_id,title,workspace_root,deleted_at,archived_at); INSERT INTO projection_projects VALUES('p','Demo','/demo',NULL,NULL),('gone','Gone','/gone','date',NULL)"); db.close();
  try {
    const data = await t3Overview({ projects: () => t3Projects(base), metadata: ids => t3ThreadMetadata(ids, base), run: async (args: string[]) => {
      assert.deepEqual(args, ['thread', 'list', '--project', 'p']);
      return [{ threadId: 't', projectId: 'p', title: 'Work', status: 'running' }];
    } });
    assert.equal(data.projects.length, 1); assert.equal(data.workspaces[0].activeTerminals, 1);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('busy or waiting main threads are sent once immediately and preserve the CLI delivery receipt', async t => {
  const state = mkdtempSync(join(tmpdir(), 'caller-delivery-'));
  const calls: string[][] = [];
  let delivery: unknown = 'queued';
  const run = async (args: string[]): Promise<T3Response> => {
    calls.push(args);
    if (args[1] === 'show') return { thread: { projectId: 'p', status: 'waiting', runCount: 7, latestRunId: 'run:7' } };
    return { threadId: 'main', runId: 'run', delivery: delivery as T3Response['delivery'] };
  };
  let coordinator = new T3Coordinator(state, run);
  t.after(() => { coordinator.close(); rmSync(state, { recursive: true, force: true }); });
  const request = { requestId: 'queued-once', projectId: 'p', project: 'Demo', threadId: 'main', message: 'Extend the request' };
  const receipt = await coordinator.dispatch(request);
  assert.equal(receipt.status, 'delivered');
  assert.equal(receipt.delivery, 'queued');
  assert.deepEqual(receipt.before, { runs: 7, latestRunId: 'run:7' }, 'the follow-up baseline is taken before the send');
  assert.deepEqual(calls.map(args => args[1]), ['show', 'send']);
  assert.equal(calls[1].length, 4, 'no wait, interrupt or unsupported delivery flag');
  coordinator.close(); coordinator = new T3Coordinator(state, run);
  assert.deepEqual(await coordinator.dispatch(request), receipt);
  assert.equal(calls.length, 2, 'queued acceptance must not be retried after restart');
  for (const [index, mode] of ['started', 'steered', 'restarted', undefined, 'invented'].entries()) {
    delivery = mode;
    const next = await coordinator.dispatch({ ...request, requestId: `next-${index}` });
    assert.equal(next.status, 'delivered', 'unrecognized mode does not undo confirmed acceptance');
    assert.equal(next.delivery, typeof mode === 'string' && mode !== 'invented' ? mode : 'unverified');
  }
});

test('new sessions isolate old requests and transcripts across restarts', async () => {
  const state = mkdtempSync(join(tmpdir(), 'caller-session-'));
  let store = new Store(join(state, 'caller.sqlite'));
  try {
    const old = store.newConversation('t3');
    store.event('transcript', {call:'old',role:'user',text:'old conversation',backend:'t3',conversationId:old.id});
    const fresh = store.newConversation('t3');
    store.event('transcript', {call:'new',role:'user',text:'current conversation',backend:'t3',conversationId:fresh.id});
    store.close(); store = new Store(join(state, 'caller.sqlite'));
    const c = new ProjectContext(double<ConstructorParameters<typeof ProjectContext>[0]>({state,store,publish(){},readOverview:async()=>({projects:[],workspaces:[]})}));
    await c.refresh();
    assert.match(c.resume(), /current conversation/); assert.doesNotMatch(c.resume(), /old conversation/);
    assert.equal(store.conversation('t3').id,fresh.id);
  } finally { store.close(); rmSync(state,{recursive:true,force:true}); }
});

test('pending delivery blocks concurrent duplicates durably but leaves other projects available', async t => {
  const state = mkdtempSync(join(tmpdir(), 'caller-pending-'));
  const calls: string[][] = [];
  let release!: (value: T3Response) => void;
  const pending = new Promise<T3Response>(resolve => { release = resolve; });
  const run = async (args: string[]) => {
    calls.push(args);
    if (args[2] === 'p1') return pending;
    return { threadId: 'other-thread' };
  };
  const first = new T3Coordinator(state, run);
  let reopened: T3Coordinator | undefined;
  t.after(() => { first.close(); reopened?.close(); rmSync(state, { recursive: true, force: true }); });
  const request = { requestId: 'pending', projectId: 'p1', project: 'Demo', message: 'Work' };
  const delivery = first.dispatch(request);
  // A separate connection models another process observing a persisted pending intent.
  reopened = new T3Coordinator(state, run);
  await assert.rejects(reopened.dispatch(request), /uncertain/);
  await assert.rejects(reopened.dispatch({ ...request, requestId: 'duplicate' }), /uncertain/);
  assert.equal(calls.length, 1);
  assert.equal((await reopened.dispatch({ ...request, requestId: 'independent', projectId: 'p2' })).status, 'delivered');
  release({}); // Missing confirmation must become unknown, never an automatic retry.
  await assert.rejects(delivery, /T3 answered without returning the ID of the new thread: "Voice · Demo · Main" may have been created.*Do not repeat it; find it now with t3_find_threads/);
  reopened.close(); reopened = new T3Coordinator(state, run);
  await assert.rejects(reopened.dispatch(request), /uncertain/);
  await assert.rejects(reopened.dispatch({ ...request, requestId: 'after-restart' }), /uncertain/);
  assert.equal(calls.length, 2, 'exactly one mutation per project despite concurrent requests and restart');
});

// A simulated T3 CLI for main-thread registration. Nothing reaches a real T3.
function mainThreadT3(onShow: (threadId: string) => void = () => {}) {
  const calls: string[][] = [];
  let started = 0;
  const run = async (args: string[]): Promise<T3Response> => {
    calls.push(args);
    if (args[1] === 'show') { onShow(args[2]); return { thread: { threadId: args[2], projectId: 'p', title: 'Chosen thread' } }; }
    if (args[1] === 'send') return { threadId: args[2], runId: 'run', delivery: 'started' };
    return { threadId: `new-main-${++started}`, runId: 'run', delivery: 'started' };
  };
  return { calls, run };
}
const mainOf = (c: T3Coordinator, projectId: string) => (c.db.prepare('SELECT threadId FROM main_threads WHERE projectId=?').get(projectId) as { threadId?: string } | undefined)?.threadId;
const MAIN_TEMPLATE = /You are this project's main voice thread/;
const EXISTING_TEMPLATE = /Continue this existing thread/;

test('a send to an explicit thread of a project without a main thread does not make it the main thread', async t => {
  const state = mkdtempSync(join(tmpdir(), 'caller-explicit-'));
  const fake = mainThreadT3();
  const c = new T3Coordinator(state, fake.run, { projects: () => [], threadGone: () => false });
  t.after(() => { c.close(); rmSync(state, { recursive: true, force: true }); });
  const input = { projectId: 'p', project: 'Demo', message: 'Review the plan' };
  const receipt = await c.dispatch({ ...input, requestId: 'explicit', threadId: 'chosen' });
  assert.equal(receipt.status, 'delivered');
  const sent = fake.calls.at(-1)!;
  assert.deepEqual(sent.slice(0, 3), ['thread', 'send', 'chosen']);
  assert.match(sent[3], EXISTING_TEMPLATE, 'the thread the user chose gets the existing-thread prompt');
  assert.doesNotMatch(sent[3], MAIN_TEMPLATE);
  assert.equal(mainOf(c, 'p'), undefined, 'an explicit send never registers the main thread');
  const tracked = JSON.parse(readFileSync(join(state, 'tracked-threads.json'), 'utf8')) as { threadId: string; role: string }[];
  assert.deepEqual(tracked.map(r => [r.threadId, r.role]), [['chosen', 'conversation']]);
  // The next send without threadId creates the project's main thread.
  await c.dispatch({ ...input, requestId: 'default', message: 'Coordinate the rest' });
  const start = fake.calls.at(-1)!;
  assert.deepEqual([start[1], start[2], start[4], start[5]], ['start', 'p', '--title', 'Voice · Demo · Main']);
  assert.match(start[3], MAIN_TEMPLATE);
  assert.equal(mainOf(c, 'p'), 'new-main-1');
  // An explicit send to the registered main thread is treated as any named
  // thread: existing-thread prompt, and its main_threads row is not rewritten.
  c.db.prepare("UPDATE main_threads SET link='sentinel' WHERE projectId='p'").run();
  const row = () => c.db.prepare("SELECT * FROM main_threads WHERE projectId='p'").get();
  const registered = row();
  await c.dispatch({ ...input, requestId: 'explicit-main', threadId: 'new-main-1' });
  assert.deepEqual(fake.calls.at(-1)!.slice(0, 3), ['thread', 'send', 'new-main-1']);
  assert.match(fake.calls.at(-1)![3], EXISTING_TEMPLATE);
  assert.doesNotMatch(fake.calls.at(-1)![3], MAIN_TEMPLATE);
  assert.deepEqual(row(), registered, 'an explicit send never rewrites the main thread row');
  // Another explicit thread does not replace it.
  await c.dispatch({ ...input, requestId: 'explicit-other', threadId: 'chosen' });
  assert.match(fake.calls.at(-1)![3], EXISTING_TEMPLATE);
  assert.equal(mainOf(c, 'p'), 'new-main-1');
});

test('an explicit send that fails before the CLI leaves no main thread registered', async t => {
  const state = mkdtempSync(join(tmpdir(), 'caller-explicit-fail-'));
  let c: T3Coordinator | undefined;
  // Another process releases the pending row while this one reads the destination.
  const fake = mainThreadT3(() => { c!.db.prepare("UPDATE dispatches SET status='released' WHERE requestId='explicit'").run(); });
  c = new T3Coordinator(state, fake.run, { projects: () => [], threadGone: () => false });
  t.after(() => { c!.close(); rmSync(state, { recursive: true, force: true }); });
  const input = { projectId: 'p', project: 'Demo', message: 'Review the plan' };
  await assert.rejects(c.dispatch({ ...input, requestId: 'explicit', threadId: 'chosen' }),
    (e: Error) => e instanceof NotDispatchedError && /was released while it was being prepared/.test(e.message));
  assert.deepEqual(fake.calls.map(a => a[1]), ['show'], 'nothing was sent');
  assert.equal(mainOf(c, 'p'), undefined, 'a failed explicit send leaves no main thread');
  await c.dispatch({ ...input, requestId: 'default' });
  assert.deepEqual(fake.calls.at(-1)!.slice(0, 3), ['thread', 'start', 'p']);
});
