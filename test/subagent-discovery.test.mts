import { testTool, type TestTool } from './fixtures.mjs';
import type { TestContext } from 'node:test';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { t3Overview, t3ThreadMetadata } from '../src/adapters/t3/client.mjs';
import { t3Tools } from '../src/adapters/t3/tools.mjs';

function fixture(t: TestContext) {
  const base = mkdtempSync(join(tmpdir(), 'subagents-'));
  mkdirSync(join(base, 'userdata'));
  const path = join(base, 'userdata/statev2.sqlite');
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE orchestration_v2_projection_threads(thread_id,project_id,title,archived_at,deleted_at,payload_json)');
  const add = (id: string, project = 'p', extra: { archived?: string; deleted?: string; payload?: string } = {}) => db.prepare('INSERT INTO orchestration_v2_projection_threads VALUES(?,?,?,?,?,?)').run(
    id, project, id, extra.archived ?? null, extra.deleted ?? null,
    extra.payload ?? JSON.stringify({ id, lineage: { parentThreadId: 'parent', rootThreadId: 'parent', relationshipToParent: 'subagent' } }));
  t.after(() => { db.close(); rmSync(base, { recursive: true, force: true }); });
  return { base, path, db, add, metadata: (ids: string[]) => t3ThreadMetadata(ids, base) };
}
const projects = () => [{ id: 'p', name: 'P', path: '/p' }, { id: 'other', name: 'Other', path: '/other' }];

test('discovers running children of completed parent after restart, deduplicates, filters projects and never writes T3', async t => {
  const f = fixture(t);
  f.add('child'); f.add('foreign', 'other'); f.add('archived', 'p', { archived: 'date' }); f.add('deleted', 'p', { deleted: 'date' });
  const before = readFileSync(f.path), calls: string[][] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    if (args[1] === 'list') return [
      { threadId: 'parent', projectId: 'p', status: 'completed' },
      { threadId: 'child', projectId: 'p', status: 'completed' },
      { threadId: 'archived', projectId: 'p', status: 'running' },
      { threadId: 'foreign', projectId: 'other', status: 'running' }];
    assert.equal(args[2], 'child');
    assert.deepEqual(args.slice(3), ['--messages', '1']);
    return { thread: { threadId: 'child', projectId: 'p', status: 'running', link: 'child-link' }, messages: [{ role: 'assistant', text: 'not retained' }] };
  };
  for (let restart = 0; restart < 2; restart++) {
    const data = await t3Overview({ projects, run, metadata: f.metadata, projectId: 'p' });
    assert.equal(data.discovery!.complete, true);
    assert.deepEqual(data.threads.map(t => t.threadId), ['parent', 'child']);
    assert.equal(data.threads[1].status, 'running');
    assert.equal(data.threads[1].parentThreadId, 'parent');
    assert.equal(data.threads[1].rootThreadId, 'parent');
    assert.equal(data.workspaces[1].activeTerminals, 1);
    assert.doesNotMatch(JSON.stringify(data), /not retained/);
  }
  assert.equal(calls.filter(a => a[1] === 'show').length, 2);
  assert.ok(calls.every(a => ['list', 'show'].includes(a[1])));
  assert.deepEqual(readFileSync(f.path), before);
});

test('missing schema and malformed metadata warn without discarding valid CLI or DB results', async t => {
  const f = fixture(t); f.add('good'); f.add('broken', 'p', { payload: '{' });
  f.add('bad-lineage', 'p', { payload: JSON.stringify({ id: 'bad-lineage', lineage: { relationshipToParent: 'subagent' } }) });
  const run = async (args: string[]) => args[1] === 'list' ? [{ threadId: 'parent', projectId: 'p', status: 'completed' }] : { thread: { status: 'running' } };
  const data = await t3Overview({ projects, run, metadata: f.metadata, projectId: 'p' });
  assert.equal(data.discovery!.complete, false);
  assert.equal(data.discovery!.warnings!.length, 2);
  assert.deepEqual(data.threads.map(t => t.threadId), ['parent', 'good']);
  f.db.exec('DROP TABLE orchestration_v2_projection_threads');
  const missing = await t3Overview({ projects, run, metadata: f.metadata, projectId: 'p' });
  assert.equal(missing.discovery!.complete, false);
  assert.equal(missing.discovery!.warnings![0].code, 'thread_metadata_unavailable');
  assert.equal(missing.threads[0].threadId, 'parent');
});

test('CLI failures preserve discovered children with unknown status and other projects', async t => {
  const f = fixture(t); f.add('good'); f.add('failed'); f.add('other-child', 'other');
  const data = await t3Overview({ projects, metadata: f.metadata, run: async (args: string[]) => {
    if (args[1] === 'list') { if (args[3] === 'p') throw new Error('private stderr'); return []; }
    if (args[2] === 'failed') throw new Error('private stderr');
    return { thread: { status: 'running' } };
  } });
  assert.equal(data.discovery!.complete, false);
  assert.equal(data.threads.length, 3);
  assert.equal(data.threads.find(t => t.threadId === 'failed')!.status, 'unknown');
  assert.equal(data.threads.find(t => t.threadId === 'failed')!.statusVerified, false);
  assert.doesNotMatch(JSON.stringify(data), /private stderr/);
});

test('filters lineage before status calls and bounds concurrency without truncation', async t => {
  const f = fixture(t);
  for (let i = 0; i < 15; i++) f.add(`child-${i}`);
  f.add('unrelated', 'p', { payload: JSON.stringify({ id: 'unrelated', lineage: { parentThreadId: 'another', rootThreadId: 'another', relationshipToParent: 'subagent' } }) });
  let active = 0, peak = 0, reads = 0;
  const data = await t3Overview({ projects, metadata: f.metadata, projectId: 'p', parentThreadId: 'parent', run: async (args: string[]) => {
    if (args[1] === 'list') return [];
    assert.notEqual(args[2], 'unrelated'); reads++; active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 3)); active--;
    return { thread: { status: 'running' } };
  } });
  assert.equal(reads, 15); assert.equal(data.threads.length, 15); assert.equal(peak, 4);
});

test('list tool forwards project and lineage filters and incomplete discovery', async () => {
  const tools = new Map<string, TestTool>();
  const filters = { projectId: 'p', rootThreadId: 'root', parentThreadId: 'parent' };
  for (const tool of t3Tools({ overview: async params => {
    assert.deepEqual(params, { ...filters, includeSubagents: true, signal: undefined });
    return { projects: [], threads: [], workspaces: [], terminals: [], discovery: { complete: false, warnings: [{ code: 'thread_metadata_unavailable' }] } };
  } })) tools.set(tool.name, testTool(tool));
  const result = await tools.get('t3_list_threads')!.execute('id', filters);
  assert.match(result.content[0].text, /Incomplete discovery/);
});

test('list tool accepts only a boolean includeSubagents; a parent or root still widens it', async () => {
  const seen: unknown[] = [];
  const [, list] = t3Tools({ overview: async params => { seen.push(params?.includeSubagents); return { projects: [], threads: [], workspaces: [], terminals: [], discovery: { complete: true, warnings: [] } }; } }).map(testTool);
  // A text "false" must not list every subagent: nothing is listed.
  for (const value of ['false', 'true', 0, 1, {}])
    await assert.rejects(list.execute('id', { includeSubagents: value } as never), { message: 'includeSubagents must be the boolean true or false, not text or a number. Nothing was listed.' }, JSON.stringify(value));
  assert.deepEqual(seen, []);
  // null is the same as omitted: main threads only.
  for (const params of [{}, { includeSubagents: null }, { includeSubagents: false }])
    assert.match((await list.execute('id', params as never)).content[0].text, /^THREADS \(top_level; subagents not queried\)/);
  assert.match((await list.execute('id', { parentThreadId: 'parent', includeSubagents: false })).content[0].text, /^THREADS \(direct_children; subagents included\)/);
  assert.match((await list.execute('id', { includeSubagents: true })).content[0].text, /^THREADS \(full; subagents included\)/);
  assert.deepEqual(seen, [false, false, false, true, true]);
});

test('root filter includes nested children and direct parent filter stays local', async t => {
  const f = fixture(t); f.add('child');
  f.add('grandchild', 'p', { payload: JSON.stringify({ id: 'grandchild', lineage: { parentThreadId: 'child', rootThreadId: 'parent', relationshipToParent: 'subagent' } }) });
  const run = async (args: string[]) => args[1] === 'list' ? [] : { thread: { status: 'running' } };
  const all = await t3Overview({ projects, metadata: f.metadata, run, projectId: 'p', rootThreadId: 'parent' });
  assert.deepEqual(all.threads.map(t => t.threadId), ['child', 'grandchild']);
  const direct = await t3Overview({ projects, metadata: f.metadata, run, projectId: 'p', parentThreadId: 'parent' });
  assert.deepEqual(direct.threads.map(t => t.threadId), ['child']);
});


test('the list defaults to principal threads without probing child status; explicit children stay scoped', async t => {
  const f = fixture(t); f.add('child');
  f.add('unrelated', 'p', { payload: JSON.stringify({ id: 'unrelated', lineage: { parentThreadId: 'elsewhere', rootThreadId: 'elsewhere', relationshipToParent: 'subagent' } }) });
  const calls: string[][] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    return args[1] === 'list' ? [{ threadId: 'parent', projectId: 'p', status: 'completed' }, { threadId: 'child', projectId: 'p', status: 'running' }]
      : { thread: { threadId: args[2], projectId: 'p', status: 'running' } };
  };
  const tools = new Map<string, TestTool>();
  for (const tool of t3Tools({
    overview: options => t3Overview({ ...options, projects, run, metadata: f.metadata })
  })) tools.set(tool.name, testTool(tool));
  const list = tools.get('t3_list_threads')!;
  const shallow = (await list.execute('shallow', { projectId: 'p' })).content[0].text;
  assert.match(shallow, /id parent/); assert.doesNotMatch(shallow, /id child|id unrelated/);
  assert.match(shallow, /subagents not queried/);
  assert.equal(calls.filter(args => args[1] === 'show').length, 0);
  calls.length = 0;
  const children = (await list.execute('children', { projectId: 'p', parentThreadId: 'parent' })).content[0].text;
  assert.match(children, /THREADS \(direct_children;/);
  assert.match(children, /id child/); assert.doesNotMatch(children, /id unrelated/);
  assert.deepEqual(calls.filter(args => args[1] === 'show').map(args => args[2]), ['child']);
});
