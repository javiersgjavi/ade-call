import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NotDispatchedError } from '../src/direct/contract.mjs';

// A simulated T3 CLI that records its arguments. The client reads T3_BIN and
// T3CODE_HOME when it is imported, so they are set before the import below.
const tmp = mkdtempSync(join(tmpdir(), 'ade-t3-args-'));
const log = join(tmp, 'argv.json');
const fake = join(tmp, 'fake-t3.mjs');
writeFileSync(fake, `#!${process.execPath}\nimport fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n'); console.log(JSON.stringify({ thread: { projectId: 'p1', status: 'idle' }, messages: [] }));`, { mode: 0o700 });
process.env.T3_BIN = fake; process.env.T3CODE_HOME = join(tmp, 't3');
const { t3, cliId } = await import('../src/adapters/t3/client.mjs');
const { T3Coordinator } = await import('../src/adapters/t3/coordinator.mjs');
const invocations = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]) : [];
test.after(() => rmSync(tmp, { recursive: true, force: true }));

test('thread show passes the thread ID after "--", behind every flag', async () => {
  rmSync(log, { force: true });
  await t3(['thread', 'show', 'abc-123', '--messages', '4']);
  assert.deepEqual(invocations(), [['thread', 'show', '--messages', '4', '--base-dir', join(tmp, 't3'), '--json', '--', 'abc-123']]);
});

test('an ID that starts with "-" or has spaces never reaches the T3 CLI', async () => {
  rmSync(log, { force: true });
  for (const args of [['thread', 'show', '-h'], ['thread', 'show', '--base-dir=/elsewhere', '--messages', '1'], ['thread', 'send', '--help', 'message'],
    ['thread', 'start', '-p', 'message', '--title', 'T'], ['thread', 'list', '--project', '--json'], ['thread', 'show', 'two words']])
    await assert.rejects(t3(args), /is not a valid ID.*Nothing was executed/, args.join(' '));
  assert.deepEqual(invocations(), [], 'the CLI was never invoked');
  assert.equal(cliId('thread:provider:codex:native-thread:0f0f0f0f-1111-4222-8333-444455556666'), true);
  for (const value of ['', '-x', ' x', 'x\ny', 'x\u0007', 42]) assert.equal(cliId(value), false, JSON.stringify(value));
});

test('a send to an ID the CLI would read as an option is refused before the journal and the CLI', async () => {
  const state = mkdtempSync(join(tmpdir(), 'ade-t3-args-journal-'));
  const calls: string[][] = [];
  const c = new T3Coordinator(state, async (args: string[]) => { calls.push(args); return { thread: { projectId: 'p1' } }; }, { projects: () => [{ id: 'p1', name: 'Demo' }] });
  try {
    await assert.rejects(c.dispatch({ requestId: 'r1', projectId: '--help', project: 'Demo', message: 'Hi' }), (error: unknown) => error instanceof NotDispatchedError && /projectId is not valid/.test(error.message));
    await assert.rejects(c.dispatch({ requestId: 'r2', projectId: 'p1', project: 'Demo', message: 'Hi', threadId: '-h' }), (error: unknown) => error instanceof NotDispatchedError && /threadId is not valid/.test(error.message));
    assert.deepEqual(calls, []);
    assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM dispatches').get()!.n, 0, 'no journal row: nothing can be left uncertain');
  } finally { c.close(); rmSync(state, { recursive: true, force: true }); }
});
