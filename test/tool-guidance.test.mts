import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { T3Response } from '../src/shared/contracts.mjs';
import { NotDispatchedError, type DirectTool } from '../src/direct/contract.mjs';
import { DirectSession, requestIdFor, toolFailure } from '../src/direct/session.mjs';
import { DirectCallState } from '../src/direct/state.mjs';
import { t3DirectTools } from '../src/direct/t3.mjs';
import { orcaDirectTools } from '../src/direct/orca.mjs';
import { T3Coordinator } from '../src/adapters/t3/coordinator.mjs';
import { REQUEST_ID } from '../src/adapters/t3/tools.mjs';
import { OrcaDispatch } from '../src/adapters/orca/dispatch.mjs';
import { orcaTools } from '../src/adapters/orca/tools.mjs';
import { fakeAde, testTool } from './fixtures.mjs';

// What the model sees of the tools: names, descriptions and parameter schemas.
const schemas = (tools: DirectTool[]) => JSON.stringify(tools.map(({ name, description, parameters }) => ({ type: 'function', name, description, parameters })));
const t3 = () => t3DirectTools({ state: '/nonexistent-ade-call-state' });
const orca = () => orcaDirectTools({ state: '/nonexistent-ade-call-state' });
const signal = () => AbortSignal.timeout(2000);

test('every T3 and Orca tool parameter has a description and the schemas stay valid function parameters', () => {
  for (const tool of [...t3(), ...orca()]) {
    const p = tool.parameters as { type: string; properties: Record<string, { type: string; description?: string }>; required?: string[]; additionalProperties: boolean };
    assert.equal(p.type, 'object', tool.name); assert.equal(p.additionalProperties, false, tool.name);
    for (const field of p.required || []) assert.ok(field in p.properties, `${tool.name}.${field} is required but not declared`);
    for (const [field, schema] of Object.entries(p.properties)) {
      assert.ok(['string', 'integer', 'boolean', 'array'].includes(schema.type), `${tool.name}.${field}`);
      assert.ok(schema.description && schema.description.length >= 8, `${tool.name}.${field} needs a description`);
    }
    // Valid for voice and text, without internal jargon.
    assert.doesNotMatch(tool.description + JSON.stringify(p), /\bcalls?\b|settled/i, tool.name);
  }
  const send = t3().find(t => t.name === 't3_send_message')!;
  assert.match(send.description, /only after proposing it and hearing their yes.*delivered or queued, not finished.*do not repeat it: read the thread now and tell the user what you see/);
  // Reading is never offered: every tool text tells the model to read now.
  for (const tool of [...t3(), ...orca()]) assert.doesNotMatch(tool.description, /ofrece (?:leer|listar|buscar|comprobar)/, tool.name);
  const read = t3().find(t => t.name === 't3_read_thread')!;
  assert.match(JSON.stringify(read.parameters), /messages=6, offset=6 reads the 6 before the latest 6/);
});

test('tool schemas stay within the token budget', () => {
  // Before the rewrite: T3 3109 and Orca 3693 characters (about 890 and 1055 tokens).
  // The release tools (t3_release_uncertain, orca_release_uncertain) add about 470 each.
  // Parameter examples and clearer ID descriptions (resources/tools.json) add about
  // 600 more each (T3 4117 → 4688, Orca 4711 → 5341; about 160 tokens per session).
  // Searching main threads first (includeSubagents on t3_find_threads) adds about 210 (T3 4732 → 4939).
  assert.ok(schemas(t3()).length <= 4950, `T3 tool schemas: ${schemas(t3()).length} characters`);
  assert.ok(schemas(orca()).length <= 5400, `Orca tool schemas: ${schemas(orca()).length} characters`);
});

test('distinct function calls get distinct request IDs; the same call ID runs at most once', async () => {
  const ids = ['call_ab', 'call_a.b', 'call_a b', 'x'.repeat(64) + 'a', 'x'.repeat(64) + 'b', 'call:1', 'call_1'];
  const made = ids.map(id => requestIdFor('voice', 'rtc_scope-1', id));
  assert.equal(new Set(made).size, ids.length, 'request IDs collide');
  for (const id of made) assert.match(id, REQUEST_ID);
  assert.equal(requestIdFor('voice', 'rtc_scope-1', 'call_ab'), 'voice:rtc_scope-1:call_ab', 'plain IDs stay readable');
  assert.notEqual(requestIdFor('voice', 'a'.repeat(120) + '1', 'c'), requestIdFor('voice', 'a'.repeat(120) + '2', 'c'), 'long scopes are hashed, not cut');
  const seen: string[] = [];
  const session = new DirectSession(fakeAde([{ name: 'read', description: '', parameters: {}, execute: async (_p, { requestId }) => { seen.push(requestId); return { text: 'ok' }; } }]));
  const run = (callId: string) => session.run({ name: 'read', call_id: callId, arguments: '{}' }, { requestId: requestIdFor('voice', 'rtc_1', callId), signal: signal() });
  assert.ok(await run('c1')); assert.ok(await run('c2'));
  assert.equal(await run('c1'), null, 'a repeated call ID never runs again');
  assert.deepEqual(seen, ['voice:rtc_1:c1', 'voice:rtc_1:c2']);
});

test('a reused request ID with different content is rejected before anything is sent', async () => {
  const state = mkdtempSync(join(tmpdir(), 'guidance-reuse-'));
  const calls: string[][] = [];
  const c = new T3Coordinator(state, async args => { calls.push(args); return args[1] === 'show' ? { thread: { projectId: 'p', title: 'Riego' } } : { threadId: 'th' }; }, { projects: () => [] });
  try {
    const request = { requestId: 'voice:rtc_1:c1', projectId: 'p', project: 'Demo', message: 'Revisa el riego', threadId: 'th' };
    assert.equal((await c.dispatch(request)).status, 'delivered');
    const before = calls.length;
    for (const changed of [{ message: 'Another request' }, { projectId: 'q' }, { threadId: 'otro' }])
      await assert.rejects(c.dispatch({ ...request, ...changed }), (e: Error) => e instanceof NotDispatchedError && e.message === 'The identifier belongs to another request.');
    assert.equal(calls.length, before, 'no CLI call for a reused ID');
  } finally { c.close(); rmSync(state, { recursive: true, force: true }); }
});

test('T3 send errors say what failed, whether anything was sent and what to do next', async () => {
  const state = mkdtempSync(join(tmpdir(), 'guidance-t3-'));
  let now = 1_000_000, lose = false;
  const calls: string[][] = [];
  const threads: Record<string, Record<string, unknown>> = {
    th: { projectId: 'p', title: 'Riego' }, viejo: { projectId: 'p', title: 'Antiguo', archived: true }, ajeno: { projectId: 'q', title: 'Faro' }
  };
  const run = async (args: string[]) => {
    calls.push(args);
    if (args[1] === 'show') return (args[2] === 'vacío' ? {} : { thread: threads[args[2]] }) as T3Response;
    if (lose) return { threadId: 'otro' };
    return { threadId: args[1] === 'start' ? 'main' : args[2] };
  };
  const c = new T3Coordinator(state, run, { projects: () => [{ id: 'q', name: 'Faro' }], now: () => now });
  const base = { projectId: 'p', project: 'Demo', message: 'Revisa el riego' };
  const notSent = (pattern: RegExp) => (e: Error) => { assert.ok(e instanceof NotDispatchedError, e.message); assert.match(e.message, pattern); return true; };
  try {
    for (const [field, pattern] of [['projectId', /^projectId is missing: the short project ID/], ['project', /^project is missing: the project name/], ['message', /^message is missing: the request/]] as const)
      await assert.rejects(c.dispatch({ ...base, requestId: 'missing-' + field, [field]: ' ' }), notSent(new RegExp(pattern.source + '.*Nothing was sent\\.')));
    await assert.rejects(c.dispatch({ ...base, requestId: 'wrong-thread', threadId: 'ajeno' }),
      notSent(/^Thread "Faro" · ajeno belongs to project "Faro" · q, not to "Demo"\. Nothing was sent\. If it is the thread the user accepted, repeat the send with projectId=q and project="Faro"/));
    await assert.rejects(c.dispatch({ ...base, requestId: 'archived', threadId: 'viejo' }),
      notSent(/^Thread "Antiguo" · viejo is archived and does not accept sends\. Nothing was sent\. Propose to the user sending it to the project's main thread \(without threadId\) or to another open thread/));
    await assert.rejects(c.dispatch({ ...base, requestId: 'no-data', threadId: 'vacío' }), notSent(/^T3 did not return the data of the destination thread vacío\. Nothing was sent/));
    // A rejected attempt keeps nothing blocked.
    assert.equal(calls.filter(a => a[1] !== 'show').length, 0);
    await assert.rejects(c.dispatch({ ...base, requestId: 'archived', threadId: 'viejo' }), notSent(/^This same send was already attempted \(1 s ago\) and was rejected before going out: nothing was sent then or now/));

    // After the send was invoked, a reply without the thread is uncertain.
    lose = true;
    await assert.rejects(c.dispatch({ ...base, requestId: 'lost', threadId: 'th' }), (e: Error) => !(e instanceof NotDispatchedError)
      && e.message === 'T3 answered the send without confirming the destination thread: the message may have reached thread "Riego" · th. Do not repeat it; read that thread now with t3_read_thread and tell the user what you see.');
    lose = false; now += 12 * 60_000;
    const sends = calls.filter(a => a[1] === 'send').length;
    await assert.rejects(c.dispatch({ ...base, requestId: 'lost' , threadId: 'th' }),
      notSent(/^This same send was already attempted \(12 min ago, to thread "Riego" · th\) and its delivery is uncertain: it may have arrived\. Nothing was sent now\. Do not repeat it; read that thread now with t3_read_thread and tell the user what you see\.$/));
    await assert.rejects(c.dispatch({ ...base, requestId: 'next', message: 'Otra cosa' }),
      notSent(/^An earlier send to this project has an uncertain delivery \(12 min ago, to thread "Riego" · th\).*nothing more is sent to this project until it is cleared up\. Nothing was sent now\. Read that thread now with t3_read_thread: if its message is there \("Reference: lost"\), the read records it as delivered and unblocks the project\. If it is not, tell the user; only if they decide to unblock or resend, call t3_release_uncertain and then, if they asked, resend\.$/));
    assert.equal(calls.filter(a => a[1] === 'send').length, sends, 'nothing more is sent to a blocked project');
  } finally { c.close(); rmSync(state, { recursive: true, force: true }); }
});

test('an archived main thread and a lost new main thread are described honestly', async () => {
  const state = mkdtempSync(join(tmpdir(), 'guidance-main-'));
  const run = async (args: string[]) => args[1] === 'show' ? { thread: { projectId: 'archivado', title: 'Voice · Viejo · Main', archived: true } } : {};
  const c = new T3Coordinator(state, run as never, { projects: () => [] });
  c.db.prepare("INSERT INTO main_threads VALUES('archivado', 'Viejo', 'main-old', NULL)").run();
  try {
    // An archived main is replaced with thread start; a reply without the new ID stays uncertain.
    await assert.rejects(c.dispatch({ requestId: 'r-main', projectId: 'archivado', project: 'Viejo', message: 'Hola' }), (e: Error) => !(e instanceof NotDispatchedError)
      && /^T3 answered without returning the ID of the new thread: "Voice · Viejo · Main" may have been created/.test(e.message));
    await assert.rejects(c.dispatch({ requestId: 'r-start', projectId: 'nuevo', project: 'Nuevo', message: 'Hola' }), (e: Error) => !(e instanceof NotDispatchedError)
      && /^T3 answered without returning the ID of the new thread: "Voice · Nuevo · Main" may have been created with the message\. Do not repeat it; find it now with t3_find_threads, read it and tell the user what you see\.$/.test(e.message));
    await assert.rejects(c.dispatch({ requestId: 'r-start-2', projectId: 'nuevo', project: 'Nuevo', message: 'Otra' }),
      /has an uncertain delivery \(\d+ s ago, to create thread "Voice · Nuevo · Main"\).*Find "Voice · Nuevo · Main" now with t3_find_threads/);
  } finally { c.close(); rmSync(state, { recursive: true, force: true }); }
});

test('T3 direct errors name threads and projects by the short IDs of the session', async () => {
  const P = '11111111-2222-4333-8444-555555555555', Q = '99999999-2222-4333-8444-555555555555', T = 'abcdef12-2222-4333-8444-555555555555';
  const state = mkdtempSync(join(tmpdir(), 'guidance-short-'));
  try {
    const tools = t3DirectTools({ state, coordinatorFactory: () => new T3Coordinator(state, async () => ({ thread: { projectId: Q, title: 'Riego' } }), { projects: () => [{ id: Q, name: 'Faro' }] }) });
    const calls = new DirectCallState();
    calls.remember(P, 'Huerto'); calls.remember(Q, 'Faro'); calls.remember(T, 'Riego');
    const send = tools.find(t => t.name === 't3_send_message')!;
    await assert.rejects(send.execute({ projectId: '11111111', project: 'Huerto', threadId: 'abcdef12', message: 'Hola' }, { requestId: 'voice:rtc:c1', signal: signal(), state: calls }), (e: Error) => {
      assert.ok(e instanceof NotDispatchedError);
      assert.equal(e.message, 'Thread "Riego" · abcdef12 belongs to project "Faro" · 99999999, not to "Huerto". Nothing was sent. If it is the thread the user accepted, repeat the send with projectId=99999999 and project="Faro"; if not, ask them.');
      return true;
    });
    const read = tools.find(t => t.name === 't3_read_thread')!;
    const context = { requestId: 'r', signal: signal(), state: calls };
    await assert.rejects(read.execute({ threadId: '' }, context), /threadId is missing: the short thread ID.*Nothing was read\.$/);
    await assert.rejects(read.execute({ threadId: 'abcdef12', messages: 0 }, context), /messages must be an integer from 1 to 50 \(6 by default\)\. Nothing was read\.$/);
    await assert.rejects(read.execute({ threadId: 'abcdef12', offset: -1 }, context), /offset must be an integer from 0 up.*Nothing was read\.$/);
    assert.throws(() => calls.resolve('77777777', 'threadId'), /any ID shown in this session/);
  } finally { rmSync(state, { recursive: true, force: true }); }
});

test('Orca send and launch errors name the field or the pending send and say what to do', async () => {
  const state = mkdtempSync(join(tmpdir(), 'guidance-orca-'));
  try {
    const [, , send, start] = orcaTools({ state, run: async () => { throw new Error('no debe ejecutarse'); }, readOverview: async () => ({ projects: [{ id: 'p', name: 'Huerto', path: '/p' }], workspaces: [{ id: 'w', projectId: 'p' }], terminals: [{ handle: 'sh', worktreeId: 'w', agent: 'shell', connected: true, writable: true }], threads: [] }) }).map(testTool);
    const launch = (params: Record<string, unknown>) => start.execute('request-0001', { projectId: 'p', worktreeId: 'w', agent: 'codex', message: 'Encargo', ...params });
    for (const [params, pattern] of [
      [{ worktreeId: '' }, /^worktreeId is missing/], [{ agent: 'Codex IDE' }, /^agent is not valid: the provider the user said, in lowercase/],
      [{ message: '' }, /^message is missing/], [{ effort: 'high' }, /^effort requires model/], [{ model: 'm', effort: ' ' }, /^effort is not valid/]
    ] as const) await assert.rejects(launch(params), (e: Error) => e instanceof NotDispatchedError && pattern.test(e.message) && /Nothing was sent\.$/.test(e.message));
    await assert.rejects(send.execute('request-0002', { projectId: 'p', terminal: 'sh', message: 'Hola' }), (e: Error) => e instanceof NotDispatchedError
      && /^Terminal sh has no connected, writable agent.*Propose to the user another terminal with an agent or starting one with orca_start_agent\.$/.test(e.message));
    await assert.rejects(send.execute('request-0003', { projectId: 'otro', terminal: 'sh', message: 'Hola' }), (e: Error) => e instanceof NotDispatchedError && /^That projectId is not among the Orca projects/.test(e.message));

    // A launch whose receipt is missing is uncertain and blocks the project.
    const journal = new OrcaDispatch(join(state, 'launch'), () => 5_000_000);
    try {
      await assert.rejects(journal.dispatch('request-0004', 'p', { kind: 'launch', worktreeId: 'w', agent: 'codex', message: 'x' }, async () => {}, async () => { throw new Error('no receipt'); }),
        (e: Error) => !(e instanceof NotDispatchedError) && e.message === 'Uncertain delivery in Orca: there is no confirmed receipt of the send to start a codex agent in workspace w, and it may have arrived. Do not repeat it; list the project now with orca_list_projects to see whether its terminal appeared and tell the user what you see.');
      await assert.rejects(journal.dispatch('request-0005', 'p', { kind: 'send', terminal: 't', message: 'y' }, async () => {}, async () => ({})),
        (e: Error) => e instanceof NotDispatchedError && /^An earlier send to this project has an uncertain delivery \(1 s ago, to start a codex agent in workspace w\).*until it is cleared up\..*List the project now with orca_list_projects.*orca_release_uncertain/.test(e.message));
    } finally { journal.close(); }
  } finally { rmSync(state, { recursive: true, force: true }); }
});

test('engine failures name the tool and keep read, refused and uncertain semantics', async () => {
  const tools: DirectTool[] = [
    { name: 'read_it', description: '', parameters: {}, execute: async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); } },
    { name: 'send_it', description: '', parameters: {}, sends: true, execute: async () => { throw new NotDispatchedError('message is missing: the request. Nothing was sent.'); } }];
  const ade = fakeAde(tools);
  assert.deepEqual(toolFailure(ade, 'read_it'), { status: 'error', output: 'ERROR: read_it failed on the server. Nothing was read; you may repeat the read once; if it fails again, tell the user.' });
  assert.deepEqual(toolFailure(ade, 'send_it'), { status: 'unknown', output: 'ERROR: send_it failed on the server without a confirmed result. The send may have happened: do not repeat it. Read the thread now to check whether it arrived and tell the user.' });
  assert.equal(toolFailure(ade, 'bash').status, 'refused');
  const session = new DirectSession(ade);
  session.remember('assistant', 'Shall I send it?'); session.remember('user', 'Yes');
  const read = await session.run({ name: 'read_it', call_id: 'a', arguments: '{}' }, { requestId: 'r:a', signal: signal() });
  assert.match(read!.output, /^ERROR: the operation was interrupted: it exceeded the time limit or the session closed\.\nQuery without a verifiable result/);
  const refused = await session.run({ name: 'send_it', call_id: 'b', arguments: '{}' }, { requestId: 'r:b', signal: signal() });
  assert.equal(refused!.status, 'error');
  assert.equal(refused!.output, 'ERROR: message is missing: the request. Nothing was sent.', 'a complete error gets no generic tail');
});
