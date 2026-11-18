import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
import { t3Overview } from '../src/adapters/t3/client.mjs';
import { overview as orcaOverview } from '../src/adapters/orca/client.mjs';
import { documentTool } from '../src/adapters/documents.mjs';
import { orcaTools } from '../src/adapters/orca/tools.mjs';
import { t3DirectTools } from '../src/direct/t3.mjs';
import { DirectCallState } from '../src/direct/state.mjs';
import { double } from './fixtures.mjs';
import type { OrcaRun } from '../src/shared/contracts.mjs';

const tick = () => new Promise(resolve => setTimeout(resolve, 10));
async function until(check: () => boolean) {
  for (let i = 0; i < 500; i++) { if (check()) return; await tick(); }
  assert.fail('Condition did not settle');
}

test('an aborted direct T3 read stops the CLI process it started', { timeout: 10000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'direct-read-abort-'));
  const cli = join(dir, 'cli.mjs'), pidFile = join(dir, 'pid'), stopped = join(dir, 'stopped');
  writeFileSync(cli, `#!${process.execPath}
import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.on('SIGTERM', () => { fs.writeFileSync(${JSON.stringify(stopped)}, 'cancelled read'); process.exit(0); });
setInterval(() => {}, 1000);
`, { mode: 0o700 });
  const controller = new AbortController();
  // The read passes its signal to the CLI runner, as t3() does to execFile.
  const run = (async (args: string[], options: { signal?: AbortSignal } = {}) => { await exec(cli, args, { signal: options.signal }); return {}; }) as never;
  try {
    const read = t3DirectTools({}, run).find(t => t.name === 't3_read_thread')!;
    const state = new DirectCallState();
    const reading = assert.rejects(read.execute({ threadId: '11111111-aaaa-4aaa-8aaa-000000000001' }, { requestId: 'voice:c:r1', signal: controller.signal, state }));
    await until(() => existsSync(pidFile));
    controller.abort();
    await reading;
    await until(() => existsSync(stopped));
    await until(() => { try { process.kill(Number(readFileSync(pidFile, 'utf8')), 0); return false; } catch { return true; } });
  } finally {
    if (existsSync(pidFile)) { try { process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGTERM'); } catch { /* Already exited. */ } }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T3 cancellation stops all concurrent discovery reads and never starts the remaining projects', async () => {
  const controller = new AbortController(), calls: string[] = [];
  const reading = t3Overview({ signal: controller.signal,
    projects: () => Array.from({ length: 9 }, (_, i) => ({ id: String(i), name: String(i), path: '/example' })),
    metadata: () => ({ threads: [], excluded: [], warnings: [] }),
    run: async (args, options) => {
      calls.push(args[3]); assert.equal(options?.signal, controller.signal);
      await new Promise((_, reject) => options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true }));
      return [];
    }
  });
  const rejected = assert.rejects(reading, { name: 'AbortError' });
  assert.equal(calls.length, 4);
  controller.abort(); await rejected;
  assert.equal(calls.length, 4, 'cancellation must not turn into discovery warnings and continue scanning');
});

test('Orca cancellation is propagated instead of being reported as partial or empty discovery', async () => {
  for (const progressive of [false, true]) {
    const controller = new AbortController(), signals: (AbortSignal | undefined)[] = [];
    const read = orcaOverview(async (_args, options) => {
      signals.push(options?.signal);
      await new Promise((_, reject) => options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true }));
      return {};
    }, { signal: controller.signal, ...(progressive ? { projects: () => [] } : {}) });
    const rejected = assert.rejects(read, { name: 'AbortError' });
    assert.equal(signals.length, progressive ? 2 : 3); assert.ok(signals.every(s => s === controller.signal));
    controller.abort(); await rejected;
  }
});

test('document lookup passes cancellation and does not read a file after retirement', async () => {
  const controller = new AbortController();
  const tool = documentTool({ id: 't3', overview: async signal => {
    assert.equal(signal, controller.signal); controller.abort();
    return { projects: [{ id: 'project', name: 'Project', path: '/not-read' }] };
  } });
  await assert.rejects(tool.execute('read', { projectId: 'project', path: 'README.md' }, controller.signal), { name: 'AbortError' });
});

test('Orca preflight is cancellable but a send already started keeps its receipt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-read-signal-')), controller = new AbortController();
  const run: OrcaRun = async (args, options) => {
    assert.equal(options?.signal, undefined, 'never abort a CLI mutation that may have delivered');
    assert.deepEqual(args.slice(0, 2), ['terminal', 'send']);
    controller.abort(); return { send: { accepted: true, handle: 'term', prompt: { requestId: 'receipt' } } };
  };
  const tools = orcaTools({ state: dir, run,
    readOverview: async signal => {
      assert.equal(signal, controller.signal);
      return double<Awaited<ReturnType<typeof orcaOverview>>>({ projects: [{ id: 'project' }], workspaces: [{ id: 'workspace', projectId: 'project' }], terminals: [{ handle: 'term', worktreeId: 'workspace', agent: 'codex', connected: true, writable: true }] });
    }
  });
  try {
    const tool = tools.find(t => t.name === 'orca_send_message')!;
    const receipt = await tool.execute('request-example', { projectId: 'project', terminal: 'term', message: 'work' } as never, controller.signal);
    assert.match(receipt.content[0].text, /ACCEPTED/); assert.match(receipt.content[0].text, /receipt/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
