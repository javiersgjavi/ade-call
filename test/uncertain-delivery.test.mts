import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Message, T3Response } from '../src/shared/contracts.mjs';
import { NotDispatchedError } from '../src/shared/contracts.mjs';
import { T3Coordinator, referenceLine } from '../src/adapters/t3/coordinator.mjs';
import { formatReceipt } from '../src/adapters/t3/format.mjs';
import { OrcaDispatch } from '../src/adapters/orca/dispatch.mjs';
import { t3DirectTools } from '../src/direct/t3.mjs';
import { DirectCallState } from '../src/direct/state.mjs';
import { DirectSession } from '../src/direct/session.mjs';
import { fakeAde } from './fixtures.mjs';

// A simulated T3 CLI with invented projects and threads. Nothing reaches a real T3.
// `fail` makes the next send or start throw after it was invoked (uncertain).
function fakeT3(threads: Record<string, { projectId: string; title: string; archived?: boolean; messages?: Message[] }>) {
  const calls: string[][] = [];
  const fake = { calls, threads, fail: false, started: 0,
    async run(args: string[]): Promise<T3Response> {
      calls.push(args);
      if (args[1] === 'show') {
        const t = threads[args[2]];
        if (!t) throw new Error(`Thread ${args[2]} is no longer available.`);
        return { thread: { threadId: args[2], projectId: t.projectId, title: t.title, archived: t.archived }, messages: (t.messages || []).slice(-Number(args[4] || 6)) };
      }
      if (fake.fail) throw new Error('lost answer');
      if (args[1] === 'send') { threads[args[2]].messages = [...threads[args[2]].messages || [], { role: 'user', text: args[3] }]; return { threadId: args[2], runId: 'run', delivery: 'started' }; }
      const id = `nuevo-${++fake.started}`;
      threads[id] = { projectId: args[2], title: args[5], messages: [{ role: 'user', text: args[3] }] };
      return { threadId: id, runId: 'run', delivery: 'started' };
    } };
  return fake;
}
const sends = (calls: string[][]) => calls.filter(a => a[1] === 'send' || a[1] === 'start').length;
const status = (state: string, requestId: string) => {
  const db = new DatabaseSync(join(state, 'dispatch.sqlite'));
  try { return (db.prepare('SELECT status FROM dispatches WHERE requestId=?').get(requestId) as { status: string } | undefined)?.status; } finally { db.close(); }
};
const ctx = (state: DirectCallState, requestId = 'voice:call:c1') => ({ requestId, signal: AbortSignal.timeout(2000), state });
const base = { projectId: 'huerto', project: 'Huerto', message: 'Mide la humedad' };

test('reading a thread that shows the reference of an uncertain send records it as delivered and unblocks the project', async () => {
  const state = mkdtempSync(join(tmpdir(), 'uncertain-verify-'));
  const fake = fakeT3({ riego: { projectId: 'huerto', title: 'Riego' } });
  const c = new T3Coordinator(state, fake.run, { projects: () => [{ id: 'huerto', name: 'Huerto' }], threadGone: () => false });
  try {
    // The send reaches T3 but its answer is lost.
    fake.threads.riego.messages = [];
    const real = fake.run; fake.run = async args => { const r = await real(args); if (args[1] === 'send') throw new Error('lost answer'); return r; };
    c.run = fake.run;
    await assert.rejects(c.dispatch({ ...base, requestId: 'voice:call:c1', threadId: 'riego' }), e => !(e instanceof NotDispatchedError));
    assert.equal(status(state, 'voice:call:c1'), 'unknown');
    await assert.rejects(c.dispatch({ ...base, requestId: 'voice:call:c2', threadId: 'riego' }), /uncertain delivery.*"Reference: voice:call:c1"/s);

    // A read in a session (the direct tool) finds the reference in a user message.
    const tools = t3DirectTools({ coordinatorFactory: () => new T3Coordinator(state, fake.run, { projects: () => [], threadGone: () => false }) }, real);
    const read = tools.find(t => t.name === 't3_read_thread')!, session = new DirectCallState();
    session.remember('riego', 'Riego');
    const out = await read.execute({ threadId: 'riego' }, ctx(session));
    assert.match(out.text, /^\[CHECKED: the earlier uncertain send \(\d+ s ago\) to this thread did arrive: its reference is in a user message\. It is recorded as delivered and no longer blocks the project\.\]/);
    assert.equal(status(state, 'voice:call:c1'), 'delivered');
    // The replay of that request ID returns the verified receipt; nothing is sent again.
    const before = sends(fake.calls);
    const replay = await c.dispatch({ ...base, requestId: 'voice:call:c1', threadId: 'riego' });
    assert.equal(replay.status, 'delivered'); assert.equal(replay.threadId, 'riego'); assert.equal(sends(fake.calls), before);
    assert.match(formatReceipt(replay), /Note: delivery checked by reading the thread/);
    // The project accepts sends again.
    fake.run = real; c.run = real;
    assert.equal((await c.dispatch({ ...base, requestId: 'voice:call:c3', threadId: 'riego' })).status, 'delivered');
    // A second read does not repeat the line.
    assert.doesNotMatch((await read.execute({ threadId: 'riego' }, ctx(session))).text, /CHECKED/);
  } finally { c.close(); rmSync(state, { recursive: true, force: true }); }
});

test('a reference quoted by the agent, inside other text, or in another thread does not verify a send', async () => {
  const state = mkdtempSync(join(tmpdir(), 'uncertain-quoted-'));
  const fake = fakeT3({ riego: { projectId: 'huerto', title: 'Riego' }, otro: { projectId: 'huerto', title: 'Otro' } });
  const c = new T3Coordinator(state, fake.run, { projects: () => [], threadGone: () => false });
  try {
    fake.fail = true;
    await assert.rejects(c.dispatch({ ...base, requestId: 'voice:call:c1', threadId: 'riego' }), /lost answer/);
    fake.fail = false;
    const line = referenceLine('voice:call:c1');
    fake.threads.riego.messages = [{ role: 'assistant', text: `Received:\n${line}` }, { role: 'user', text: `What is "${line}"?` }];
    fake.threads.otro.messages = [{ role: 'user', text: `${line}\nSomething else` }];
    assert.deepEqual(c.verifyRead({ threadId: 'riego', projectId: 'huerto' }, fake.threads.riego.messages), [], 'agent quote or inline mention');
    assert.deepEqual(c.verifyRead({ threadId: 'otro', projectId: 'huerto' }, fake.threads.otro.messages), [], 'the send went to another thread');
    assert.deepEqual(c.verifyRead({ threadId: 'riego', projectId: 'faro' }, [{ role: 'user', text: line }]), [], 'another project');
    assert.equal(status(state, 'voice:call:c1'), 'unknown');
    await assert.rejects(c.dispatch({ ...base, requestId: 'voice:call:c2' }), /uncertain delivery/);
    // A send that was creating the main thread is verified by any thread of its project, which becomes the main.
    fake.fail = true;
    await assert.rejects(c.dispatch({ ...base, projectId: 'faro', project: 'Faro', requestId: 'voice:call:c4' }), /lost answer/);
    fake.fail = false;
    assert.equal(c.verifyRead({ threadId: 'nuevo-1', projectId: 'faro' }, [{ role: 'user', text: `${referenceLine('voice:call:c4')}\nYou are this project's main voice thread` }]).length, 1);
    fake.threads['nuevo-1'] = { projectId: 'faro', title: 'Voice · Faro · Main' };
    assert.equal((await c.dispatch({ ...base, projectId: 'faro', project: 'Faro', requestId: 'voice:call:c5' })).threadId, 'nuevo-1', 'the verified thread is the new main');
    assert.deepEqual(fake.calls.at(-1)!.slice(0, 3), ['thread', 'send', 'nuevo-1']);
  } finally { c.close(); rmSync(state, { recursive: true, force: true }); }
});

test('without the reference, the user decision releases the block once; the old request is never sent again', async () => {
  const state = mkdtempSync(join(tmpdir(), 'uncertain-release-'));
  const fake = fakeT3({ riego: { projectId: 'huerto', title: 'Riego', messages: [{ role: 'assistant', text: 'Nothing new' }] } });
  const factory = () => new T3Coordinator(state, fake.run, { projects: () => [], threadGone: () => false });
  const tools = t3DirectTools({ coordinatorFactory: factory }, fake.run);
  const ade = fakeAde(tools);
  const session = new DirectSession(ade);
  const call = (name: string, id: string, args: Record<string, unknown>) => session.run({ name, call_id: id, arguments: JSON.stringify(args) }, { requestId: `voice:call:${id}`, signal: AbortSignal.timeout(2000) });
  try {
    session.state.remember('huerto', 'Huerto'); session.state.remember('riego', 'Riego');
    session.remember('assistant', 'Shall I tell thread "Riego" to measure the humidity?'); session.remember('user', 'Yes');
    fake.fail = true;
    assert.equal((await call('t3_send_message', 'c1', { ...base, threadId: 'riego' }))!.status, 'unknown');
    fake.fail = false;
    session.remember('assistant', 'There is no confirmation.'); session.remember('user', 'Unblock it and resend it');
    // Not read since the send: the release asks to read first and changes nothing.
    const early = await call('t3_release_uncertain', 'c2', { projectId: 'huerto' });
    assert.equal(early!.status, 'error'); assert.match(early!.output, /^ERROR: Before releasing it has to be checked: read thread "Riego" · riego now with t3_read_thread.*Nothing was changed\.$/s);
    assert.doesNotMatch(early!.output, /\nNothing was sent in this attempt/, 'no generic send tail');
    assert.equal(status(state, 'voice:call:c1'), 'unknown');
    assert.doesNotMatch((await call('t3_read_thread', 'c3', { threadId: 'riego' }))!.output, /CHECKED/);
    const released = await call('t3_release_uncertain', 'c4', { projectId: 'huerto' });
    assert.equal(released!.status, 'completed');
    assert.match(released!.output, /^RELEASED: the uncertain send \(\d+ s ago, to thread "Riego" · riego\) stays unchecked.*Nothing was sent\. The project accepts sends again/);
    assert.equal(status(state, 'voice:call:c1'), 'released');
    // The release kept the user's authorization: the re-send of that same turn runs, once.
    const before = sends(fake.calls);
    assert.equal((await call('t3_send_message', 'c5', { ...base, threadId: 'riego' }))!.status, 'completed');
    assert.equal(sends(fake.calls), before + 1);
    assert.equal((await call('t3_send_message', 'c6', { ...base, threadId: 'riego' }))!.status, 'refused', 'a second send needs new words of the user');
    // The released request ID is never sent again, and nothing is left to release.
    const c = factory();
    try {
      await assert.rejects(c.dispatch({ ...base, requestId: 'voice:call:c1', threadId: 'riego' }), (e: Error) => e instanceof NotDispatchedError && /was released without confirming its delivery.*is not resent/.test(e.message));
      assert.match(c.release('huerto', 'r', () => true), /^NOT BLOCKED/);
    } finally { c.close(); }
    assert.equal(sends(fake.calls), before + 1);
    // Without a new user turn, the release does not run either.
    assert.equal((await call('t3_release_uncertain', 'c7', { projectId: 'huerto' }))!.status, 'refused');
  } finally { rmSync(state, { recursive: true, force: true }); }
});

test('a pending row left by a stopped process is released if its send was never invoked, and stays uncertain otherwise', async () => {
  const state = mkdtempSync(join(tmpdir(), 'uncertain-crash-'));
  const fake = fakeT3({ riego: { projectId: 'huerto', title: 'Riego' }, faro: { projectId: 'faro', title: 'Faro' } });
  // A previous process wrote these rows and stopped: one before invoking the CLI, one after.
  const previous = new T3Coordinator(state, fake.run, { owner: 'proceso-anterior', threadGone: () => false });
  previous.db.prepare("INSERT INTO dispatches(requestId,projectId,message,status,target,createdAt,owner,attempted) VALUES('antes','huerto','x','pending','riego',1,'proceso-anterior',0),('durante','faro','y','pending','faro',1,'proceso-anterior',1)").run();
  previous.close();
  const c = new T3Coordinator(state, fake.run, { projects: () => [], threadGone: () => false });
  try {
    assert.equal((await c.dispatch({ ...base, requestId: 'voice:call:c1', threadId: 'riego' })).status, 'delivered', 'never attempted: nothing was sent, so it does not block');
    assert.equal(status(state, 'antes'), 'released');
    // Attempted before the stop: uncertain, with the normal way out (not "in progress").
    await assert.rejects(c.dispatch({ ...base, projectId: 'faro', project: 'Faro', requestId: 'voice:call:c2' }), (e: Error) => /^An earlier send to this project has an uncertain delivery.*t3_release_uncertain/s.test(e.message));
    assert.equal(status(state, 'durante'), 'pending');
    assert.match(c.release('faro', 'voice:call:c4', () => true), /^RELEASED/);
    // A pending row of this process is in flight: it blocks and cannot be released.
    c.db.prepare("INSERT INTO dispatches(requestId,projectId,message,status,target,createdAt,owner,attempted) VALUES('ahora','vivo','w','pending',NULL,?,?,0)").run(Date.now(), c.owner);
    await assert.rejects(c.dispatch({ ...base, projectId: 'vivo', project: 'Vivo', requestId: 'voice:call:c5' }), /in progress right now.*uncertain/);
    assert.throws(() => c.release('vivo', 'voice:call:c6', () => true), /in progress right now: it cannot be released/);
  } finally { c.close(); rmSync(state, { recursive: true, force: true }); }
});

test('a pending row released by another process while its send was being prepared sends nothing', async () => {
  const state = mkdtempSync(join(tmpdir(), 'uncertain-race-'));
  const fake = fakeT3({ riego: { projectId: 'huerto', title: 'Riego' } });
  let other: T3Coordinator | undefined, second: Promise<unknown> | undefined;
  // Process A is reading the target (before invoking the CLI) when process B sends to the same project.
  const slow = async (args: string[]) => {
    if (args[1] === 'show' && !second) second = other!.dispatch({ ...base, requestId: 'b', threadId: 'riego' });
    if (args[1] === 'show') await second;
    return fake.run(args);
  };
  const a = new T3Coordinator(state, slow, { owner: 'a', threadGone: () => false });
  other = new T3Coordinator(state, fake.run, { owner: 'b', threadGone: () => false });
  try {
    await assert.rejects(a.dispatch({ ...base, requestId: 'a', threadId: 'riego' }), (e: Error) => e instanceof NotDispatchedError && /was released while it was being prepared/.test(e.message));
    assert.equal(sends(fake.calls), 1, 'only B sent');
    assert.equal(status(state, 'a'), 'released'); assert.equal(status(state, 'b'), 'delivered');
  } finally { a.close(); other.close(); rmSync(state, { recursive: true, force: true }); }
});

test('an archived or deleted main thread is replaced by a new main; an error after thread start stays uncertain', async () => {
  const state = mkdtempSync(join(tmpdir(), 'archived-main-'));
  const fake = fakeT3({ viejo: { projectId: 'huerto', title: 'Voice · Huerto · Main', archived: true } });
  mkdirSync(join(state, 'memory'), { recursive: true });
  let gone = false;
  const c = new T3Coordinator(state, fake.run, { projects: () => [], threadGone: () => gone });
  try {
    c.db.prepare("INSERT INTO main_threads VALUES('huerto','Huerto','viejo',NULL),('faro','Faro','borrado',NULL),('mar','Mar','perdido',NULL)").run();
    const receipt = await c.dispatch({ ...base, requestId: 'voice:call:c1' });
    assert.equal(receipt.threadId, 'nuevo-1');
    assert.deepEqual(fake.calls.at(-1)!.slice(0, 3), ['thread', 'start', 'huerto']);
    assert.match(formatReceipt(receipt), /\nNote: the previous main thread "Voice · Huerto · Main" was archived; a new one was created: "Voice · Huerto · Main"\.(?:\n|$)/);
    // The new main is registered: the next send without threadId goes there.
    await c.dispatch({ ...base, requestId: 'voice:call:c2', message: 'Y el bancal sur' });
    assert.deepEqual(fake.calls.at(-1)!.slice(0, 3), ['thread', 'send', 'nuevo-1']);
    // An explicit archived thread is still refused (the user named it).
    await assert.rejects(c.dispatch({ ...base, requestId: 'voice:call:c3', threadId: 'viejo' }), /is archived and does not accept sends/);
    // A main that T3 no longer has is replaced only if its projection says so; otherwise nothing is sent.
    await assert.rejects(c.dispatch({ ...base, projectId: 'mar', project: 'Mar', requestId: 'voice:call:c4' }), (e: Error) => e instanceof NotDispatchedError);
    gone = true;
    assert.match(formatReceipt(await c.dispatch({ ...base, projectId: 'faro', project: 'Faro', requestId: 'voice:call:c5' })), /the previous main thread was deleted; a new one was created: "Voice · Faro · Main"/);
    // After thread start was invoked, a failure is uncertain and blocks the project.
    fake.threads.viejo2 = { projectId: 'sur', title: 'Voice · Sur · Main', archived: true };
    c.db.prepare("INSERT INTO main_threads VALUES('sur','Sur','viejo2',NULL)").run();
    fake.fail = true;
    await assert.rejects(c.dispatch({ ...base, projectId: 'sur', project: 'Sur', requestId: 'voice:call:c6' }), (e: Error) => !(e instanceof NotDispatchedError));
    assert.equal(status(state, 'voice:call:c6'), 'unknown');
    fake.fail = false;
    await assert.rejects(c.dispatch({ ...base, projectId: 'sur', project: 'Sur', requestId: 'voice:call:c7' }), /uncertain delivery \(\d+ s ago, to create thread "Voice · Sur · Main"\)/);
  } finally { c.close(); rmSync(state, { recursive: true, force: true }); }
});

test('Orca: an uncertain send is released only by decision after reading its terminal; a never-attempted one by itself', async () => {
  const state = mkdtempSync(join(tmpdir(), 'uncertain-orca-'));
  try {
    const previous = new OrcaDispatch(state, Date.now, 'proceso-anterior');
    previous.db.prepare(`INSERT INTO operations(id,project,payload,status,createdAt,owner,attempted) VALUES('antes','huerto',?,'pending',1,'proceso-anterior',0)`).run(JSON.stringify({ kind: 'send', terminal: 't1', message: 'x' }));
    previous.close();
    const j = new OrcaDispatch(state);
    try {
      let mutations = 0;
      const mutate = async () => { mutations++; return { ok: true }; };
      assert.equal((await j.dispatch('request-1', 'huerto', { kind: 'send', terminal: 't1', message: 'a' }, async () => {}, mutate)).status, 'accepted', 'a never-attempted row does not block');
      await assert.rejects(j.dispatch('request-2', 'huerto', { kind: 'send', terminal: 't1', message: 'b' }, async () => {}, async () => { mutations++; throw new Error('no receipt'); }), /Uncertain delivery in Orca/);
      await assert.rejects(j.dispatch('request-3', 'huerto', { kind: 'send', terminal: 't1', message: 'c' }, async () => {}, mutate), /orca_release_uncertain/);
      assert.throws(() => j.release('huerto', 'request-4', () => false), /read terminal t1 now with orca_read_terminal/);
      assert.match(j.release('huerto', 'request-4', terminal => terminal === 't1'), /^RELEASED/);
      assert.equal((await j.dispatch('request-3', 'huerto', { kind: 'send', terminal: 't1', message: 'c' }, async () => {}, mutate)).status, 'accepted');
      await assert.rejects(j.dispatch('request-2', 'huerto', { kind: 'send', terminal: 't1', message: 'b' }, async () => {}, mutate), /was released without confirming its delivery/);
      assert.equal(mutations, 3, 'the released send was never repeated');
    } finally { j.close(); }
  } finally { rmSync(state, { recursive: true, force: true }); }
});
