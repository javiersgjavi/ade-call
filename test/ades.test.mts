import type { ToolParameters } from '../src/shared/contracts.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ades, getAde, availability } from '../src/adapters/registry.mjs';
import { overview } from '../src/adapters/orca/client.mjs';
import { documentTool, PAGE_BYTES } from '../src/adapters/documents.mjs';

test('registry isolates tools and state per ADE; unknown ADE never falls back', async () => {
  assert.equal(ades.t3.statePath('/state'), '/state/ades/t3');
  assert.equal(ades.orca.statePath('/state'), '/state/ades/orca');
  assert.throws(() => getAde('hedr'));
  const t3 = ades.t3.direct!({ snapshot: () => ({ projects: [], threads: [] }) });
  assert.deepEqual(t3.tools.map(t => t.name), ['t3_find_threads', 't3_list_threads', 't3_read_thread', 't3_send_message', 't3_read_document', 't3_release_uncertain']);
  assert.deepEqual(t3.tools.filter(t => t.sends && !t.keepsAuthorization).map(t => t.name), ['t3_send_message'], 'only the send changes T3');
  assert.equal(ades.orca.capabilities.sendMessagesOnRequest, true);
  assert.equal((await availability({ name: 'Orca', overview: async () => { throw Error('private'); } })).state, 'unreachable');
  assert.equal((await availability({ name: 'test', overview: async () => ({ discovery: { complete: false } }) })).state, 'partial');
});
test('Orca lists only documented commands and rejects incompatible output', async () => {
  const calls: string[][] = [];
  const data = await overview(async (args: string[]) => { calls.push(args); return { repos: [{ id: 'p', displayName: 'P', path: '/p' }], worktrees: [], terminals: [] }; });
  assert.deepEqual(calls, [['repo', 'list'], ['worktree', 'ps'], ['terminal', 'list']]);
  assert.equal(data.projects[0].id, 'p'); assert.deepEqual(data.threads, []);
  await assert.rejects(overview(async () => ({})), /incompatible Orca version\)\. Nothing was read or sent\. Do not repeat it/);
  await assert.rejects(overview(async (args: string[]) => { if (args[0] === 'terminal') throw Error('offline'); return { repos: [], worktrees: [] }; }), /offline/);
});
test('document reads are restricted to selected ADE project and canonical document paths', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ade-doc-'));
  try {
    mkdirSync(join(dir, 'project')); writeFileSync(join(dir, 'project/README.md'), 'document');
    writeFileSync(join(dir, 'secret.txt'), 'private'); symlinkSync(join(dir, 'secret.txt'), join(dir, 'project/alias.txt'));
    const tool = documentTool({ id: 'orca', overview: async () => ({ projects: [{ id: 'p', name: 'P', path: join(dir, 'project') }] }) });
    const run = (params: Partial<ToolParameters>) => tool.execute('call', { projectId: 'p', path: 'README.md', ...params } as never);
    assert.match(JSON.stringify(await run({})), /document/);
    await assert.rejects(run({ projectId: 't3-project' }));
    await assert.rejects(run({ path: 'missing.md' }), (error: Error) => {
      assert.match(error.message, /not found/);
      assert.ok(!error.message.includes(dir), 'filesystem paths stay private');
      return true;
    });
    await assert.rejects(run({ offset: 999 }), /offset is past the end.*Nothing was read.*offset the previous read gave/);
    for (const path of ['../secret.txt', 'alias.txt', '.env', '/etc/passwd']) await assert.rejects(run({ path }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('Orca maps actual CLI agent identity and writable connection for send preflight', async () => {
  const data = await overview(async () => ({ repos: [], worktrees: [],
    terminals: [{ handle: 'term_real', worktreeId: 'w', agentIdentity: 'codex', connected: true, writable: true, orphaned: false }] }));
  assert.equal(data.terminals[0].agent, 'codex');
  assert.equal(data.terminals[0].writable, true);
});
test('document pages fit one tool output whole, so following nextOffset skips nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ade-doc-'));
  try {
    mkdirSync(join(dir, 'project'));
    const original = Array.from({ length: 2500 }, (_, i) => `Línea ${i} con acentos ñandú y un emoji 🌱.`).join('\n');
    writeFileSync(join(dir, 'project/NOTAS.md'), original);
    const tool = documentTool({ id: 't3', overview: async () => ({ projects: [{ id: 'p', name: 'P', path: join(dir, 'project') }] }) });
    let offset: number | null = 0, joined = '', pages = 0;
    while (offset !== null) {
      const result = await tool.execute('call', { projectId: 'p', path: 'NOTAS.md', offset } as never);
      const page = JSON.parse(result.content[0].text) as { content: string; nextOffset: number | null };
      assert.ok(Buffer.byteLength(page.content) <= PAGE_BYTES);
      assert.ok(Buffer.byteLength(result.content[0].text) < 12_000, 'within the engine budget, never cut in the middle');
      joined += page.content; offset = page.nextOffset; pages++;
    }
    assert.equal(joined, original); assert.ok(pages > 5);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
