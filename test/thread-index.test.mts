import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { t3OpenThreadIndex, t3FindThreads } from '../src/adapters/t3/client.mjs';
import { t3Tools } from '../src/adapters/t3/tools.mjs';
import { testTool, type TestTool } from './fixtures.mjs';
import { formatFound } from '../src/adapters/t3/format.mjs';
import { toolSchema } from '../src/resources.mjs';

test('open index follows settlement metadata, excludes archives/deletions and search can locate closed references', () => {
  const dir = mkdtempSync(join(tmpdir(), 'caller-thread-index-')); mkdirSync(join(dir, 'userdata'));
  const db = new DatabaseSync(join(dir, 'userdata/statev2.sqlite'));
  try {
    db.exec(`CREATE TABLE projection_projects(project_id,title,workspace_root,deleted_at,archived_at);
      INSERT INTO projection_projects VALUES('p','Project','/p',NULL,NULL);
      CREATE TABLE orchestration_v2_projection_threads(thread_id,project_id,title,payload_json,archived_at,deleted_at,updated_at);`);
    const add = (id: string, extra: Record<string, unknown> = {}, project = 'p') => {
      const payload = { id, projectId: project, settledAt: null, settledOverride: null, ...extra };
      db.prepare('INSERT INTO orchestration_v2_projection_threads VALUES(?,?,?,?,?,?,?)').run(id, project, 'Topic ' + id, JSON.stringify(payload), extra.archivedAt as string || null, extra.deletedAt as string || null, '2026-11-14');
    };
    add('open', { status: 'completed' }); // End of a turn is not settlement.
    add('child', { lineage: { parentThreadId: 'open', relationshipToParent: 'subagent' } });
    add('settled', { settledOverride: 'settled' });
    add('settled-date', { settledAt: '2026-11-13' });
    add('archived', { archivedAt: '2026-11-13' });
    add('deleted', { deletedAt: '2026-11-13' });
    add('other', {}, 'other-project');
    assert.deepEqual(t3OpenThreadIndex(['p'], dir).map(t => t.threadId).sort(), ['child', 'open']);
    assert.equal(t3OpenThreadIndex(['p'], dir)[0].relationshipToParent, 'subagent');
    // Open threads by default; closed ones are only counted until requested.
    const openOnly = t3FindThreads({ query: 'Topic', projectId: 'p', includeSubagents: true }, dir);
    assert.deepEqual(openOnly.threads.map(t => t.threadId).sort(), ['child', 'open']);
    assert.deepEqual(openOnly.closedMatching, { count: 3 }); assert.equal(openOnly.searched!.closed, false);
    const found = t3FindThreads({ query: 'Topic', projectId: 'p', includeClosed: true, includeSubagents: true }, dir);
    assert.deepEqual(found.threads.map(t => t.threadId).sort(), ['archived', 'child', 'open', 'settled', 'settled-date']);
    assert.equal(found.closedMatching, undefined);
    assert.equal(found.metadataOnly, true);
    assert.deepEqual(found.searched, { field: 'thread_titles', projects: 1, catalogProjects: 1, queries: ['Topic'], closed: true, subagents: true });
    assert.equal(found.threads.find(t => t.threadId === 'archived')!.state, 'archived');
    assert.equal(found.threads.find(t => t.threadId === 'settled-date')!.state, 'settled');
    assert.equal(found.threads.find(t => t.threadId === 'open')!.updatedAt, '2026-11-14');
    assert.equal(found.note, undefined);
    // An unknown project is an error, not a project without matching threads.
    assert.throws(() => t3FindThreads({ query: 'Topic', projectId: 'missing' }, dir), /not among the T3 projects/);
    // Word order, case, accents and punctuation do not hide a title.
    db.prepare('UPDATE orchestration_v2_projection_threads SET title=? WHERE thread_id=?').run('Migración: Árbol de DECISIÓN', 'settled');
    assert.deepEqual(t3FindThreads({ query: 'decision  arbol', includeClosed: true }, dir).threads.map(t => t.threadId), ['settled']);
    // No title match states its scope and still reports a project of that name.
    const none = t3FindThreads({ query: 'project' }, dir);
    assert.deepEqual(none.threads, []); assert.equal(none.total, 0);
    assert.match(none.note!, /Messages, documents and folder names were not checked/);
    assert.deepEqual(none.projectsMatchingName, [{ id: 'p', name: 'Project' }]);
    const absent = t3FindThreads({ query: 'Proyecto inexistente' }, dir);
    assert.deepEqual(absent.projectsMatchingName, []); assert.match(absent.note!, /does not prove/);
    assert.throws(() => t3FindThreads({ query: ' ' }, dir), /query is missing.*Nothing was searched/);
    // Speech-shaped queries: spacing and spelled digits match; slips become
    // ranked candidates only when nothing matches, never confirmed threads.
    db.prepare('UPDATE orchestration_v2_projection_threads SET title=? WHERE thread_id=?').run('Bridge v2 WebSocket', 'archived');
    // A spoken letter joins the following digit: "uve dos" → v2.
    assert.deepEqual(t3FindThreads({ query: 'uve dos', projectId: 'p', includeClosed: true }, dir).threads.map(t => t.threadId), ['archived']);
    // Written variants are compared in the same search and report which one matched.
    const viaVariant = t3FindThreads({ query: 'el puente', variants: ['bridge'], projectId: 'p', includeClosed: true }, dir);
    assert.deepEqual(viaVariant.threads.map(t => [t.threadId, t.matchedBy]), [['archived', 'bridge']]);
    assert.deepEqual(viaVariant.searched!.queries, ['el puente', 'bridge']);
    // Words about the request do not outweigh the name: "el hilo del proyecto bridge" (Spanish for "the bridge project's thread").
    assert.deepEqual(t3FindThreads({ query: 'el hilo del proyecto bridge', includeClosed: true }, dir).threads.map(t => t.threadId), ['archived']);
    assert.equal(t3FindThreads({ query: 'Topic', variants: Array(9).fill(0).map((_, i) => 'v' + i) }, dir).searched!.queries!.length, 6);
    assert.throws(() => t3FindThreads({ query: 'Topic', variants: [3 as unknown as string] }, dir), /variants/);
    assert.deepEqual(t3FindThreads({ query: 'v dos web socket', projectId: 'p', includeClosed: true }, dir).threads.map(t => t.threadId), ['archived']);
    const closedOnly = t3FindThreads({ query: 'bridge v2 websocket', projectId: 'p' }, dir);
    assert.deepEqual(closedOnly.threads, []); assert.deepEqual(closedOnly.closedMatching, { count: 1 }); assert.match(closedOnly.note!, /No open main thread title/);
    const near = t3FindThreads({ query: 'bridge v2 websoket', projectId: 'p', includeClosed: true }, dir);
    assert.deepEqual(near.threads, []); assert.equal(near.total, 0);
    assert.deepEqual(near.candidates!.map(t => t.threadId), ['archived']); assert.ok(near.candidates![0].score! < 1);
    assert.equal(near.closedMatching, undefined);
    assert.deepEqual(t3FindThreads({ query: 'projekt' }, dir).projectCandidates?.map(p => p.id), ['p']);
    assert.equal(t3FindThreads({ query: 'Topic', projectId: 'p' }, dir).candidates, undefined);
    assert.equal(t3FindThreads({ query: 'industrial agent' }, dir).candidates, undefined);
    db.prepare('UPDATE orchestration_v2_projection_threads SET payload_json=? WHERE thread_id=?').run('{"id":"open"}', 'open');
    assert.throws(() => t3OpenThreadIndex(['p'], dir), /format this version of ADE Call does not recognize\. Nothing was read/);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('closed-thread lookup exposes only discovery and never sends or reads messages', async () => {
  const tools = new Map<string, TestTool>(); let lookups = 0;
  for (const tool of t3Tools({
    findThreads: params => { lookups++; assert.deepEqual(params, { query: 'Past topic', projectId: 'p' }); return { threads: [{ threadId: 'archived', projectId: 'p', title: 'Past topic' }], total: 1, truncated: false, metadataOnly: true, searched: { field: 'thread_titles', projects: 1, catalogProjects: 1 }, projectsMatchingName: [] }; },
    run: async () => { throw new Error('Unexpected CLI call'); },
  })) tools.set(tool.name, testTool(tool));
  const result = await tools.get('t3_find_threads')!.execute('test', { query: 'Past topic', projectId: 'p' });
  assert.match(result.content[0].text, /id archived/); assert.equal(lookups, 1);
});

// A spoken topic ("the reviews of the Pi thing") whose words also appear in
// old subagent titles must not hide the project's recent main thread.
test('search looks at main threads first and reports the subagents it left out', () => {
  const dir = mkdtempSync(join(tmpdir(), 'caller-main-first-')); mkdirSync(join(dir, 'userdata'));
  const db = new DatabaseSync(join(dir, 'userdata/statev2.sqlite'));
  try {
    db.exec(`CREATE TABLE projection_projects(project_id,title,workspace_root,deleted_at,archived_at);
      INSERT INTO projection_projects VALUES('p','ADE Call','/p',NULL,NULL);
      CREATE TABLE orchestration_v2_projection_threads(thread_id,project_id,title,payload_json,archived_at,deleted_at,updated_at);`);
    const add = (id: string, title: string, updated: string, parent?: string) => db.prepare('INSERT INTO orchestration_v2_projection_threads VALUES(?,?,?,?,?,?,?)').run(id, 'p', title,
      JSON.stringify({ id, projectId: 'p', settledAt: null, settledOverride: null, ...(parent ? { lineage: { parentThreadId: parent, relationshipToParent: 'subagent' } } : {}) }), null, null, updated);
    add('main-new', 'Revisión final de master', '2026-11-17T10:00:00Z');
    add('root-old', 'Voz en tiempo real', '2026-10-01T10:00:00Z');
    add('sub-auth', '/root/review_pi_auth_fast', '2026-10-02T10:00:00Z', 'root-old');
    add('sub-events', 'Review pi realtime events', '2026-10-03T10:00:00Z', 'root-old');
    add('sub-nested', 'Pi tool schema audit', '2026-10-04T10:00:00Z', 'sub-events');
    // (a) Only subagent titles contain "Pi": none is listed, but they are counted with their parents.
    const pi = t3FindThreads({ query: 'Pi', variants: ['Realtime Pi'] }, dir);
    assert.deepEqual(pi.threads, []); assert.equal(pi.searched!.subagents, false);
    assert.equal(pi.subagentsMatching!.count, 3);
    assert.deepEqual(pi.subagentsMatching!.parents, [{ threadId: 'sub-events', title: 'Review pi realtime events' }, { threadId: 'root-old', title: 'Voz en tiempo real' }]);
    assert.match(pi.note!, /No open main thread title.*does not prove/);
    const text = formatFound({ checkedAt: 'now', ...pi });
    assert.match(text, /top-level threads only/);
    assert.match(text, /3 subagent threads also match and are not shown\. Search them with includeSubagents=true.*\nParents of those subagents:\n- "Review pi realtime events" · parent sub-events\n- "Voz en tiempo real" · parent root-old$/m);
    assert.doesNotMatch(text, /review_pi_auth_fast/);
    // (b) Several words of what was said reach the main thread: as written, or as a candidate for the spoken plural.
    assert.deepEqual(t3FindThreads({ query: 'Pi', variants: ['revisión'] }, dir).threads.map(t => t.threadId), ['main-new']);
    const spoken = t3FindThreads({ query: 'revisiones', variants: ['Pi'] }, dir);
    assert.deepEqual(spoken.candidates!.map(t => t.threadId), ['main-new']); assert.equal(spoken.subagentsMatching!.count, 3);
    // (c) Requested subagents come after the main threads; recent first among equals.
    add('main-pi', 'Pi manager prompt', '2026-09-01T10:00:00Z');
    const all = t3FindThreads({ query: 'Pi', includeSubagents: true }, dir);
    assert.deepEqual(all.threads.map(t => t.threadId), ['main-pi', 'sub-nested', 'sub-events', 'sub-auth']);
    assert.equal(all.subagentsMatching, undefined); assert.equal(all.searched!.subagents, true);
    assert.deepEqual(t3FindThreads({ query: 'Pi' }, dir).threads.map(t => t.threadId), ['main-pi']);
    assert.match(formatFound({ checkedAt: 'now', ...all }), /including subagents/);
    // (d) A misheard word that only approximates a subagent title is reported as
    // a possible candidate, not as a match, just as it appears when widened.
    add('sub-ws', 'WebSocket reconnect', '2026-10-05T10:00:00Z', 'root-old');
    const near = t3FindThreads({ query: 'websoket' }, dir);
    assert.deepEqual(near.threads, []); assert.equal(near.candidates, undefined);
    assert.deepEqual(near.subagentsMatching, { count: 0, approximate: 1, parents: [{ threadId: 'root-old', title: 'Voz en tiempo real' }] });
    const nearText = formatFound({ checkedAt: 'now', ...near });
    assert.match(nearText, /1 subagent threads are possible approximate matches \(imperfect transcription; confirm them before acting\) and are not shown/);
    assert.doesNotMatch(nearText, /also match/);
    const widened = t3FindThreads({ query: 'websoket', includeSubagents: true }, dir);
    assert.deepEqual(widened.threads, []); assert.deepEqual(widened.candidates!.map(t => t.threadId), ['sub-ws']);
    // Where something matches as written, approximate subagents are not counted.
    assert.deepEqual(t3FindThreads({ query: 'reconnect', variants: ['websoket'] }, dir).subagentsMatching, { count: 1, parents: [{ threadId: 'root-old', title: 'Voz en tiempo real' }] });
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

// A misheard word that only resembles a closed title is not a match: counted
// apart, as the candidate it would be with includeClosed=true.
test('closed threads that only approximate the query are reported as possible candidates, not matches', () => {
  const dir = mkdtempSync(join(tmpdir(), 'caller-closed-near-')); mkdirSync(join(dir, 'userdata'));
  const db = new DatabaseSync(join(dir, 'userdata/statev2.sqlite'));
  try {
    db.exec(`CREATE TABLE projection_projects(project_id,title,workspace_root,deleted_at,archived_at);
      INSERT INTO projection_projects VALUES('p','ADE Call','/p',NULL,NULL);
      CREATE TABLE orchestration_v2_projection_threads(thread_id,project_id,title,payload_json,archived_at,deleted_at,updated_at);`);
    const add = (id: string, title: string, archived: string | null) => db.prepare('INSERT INTO orchestration_v2_projection_threads VALUES(?,?,?,?,?,?,?)').run(id, 'p', title,
      JSON.stringify({ id, projectId: 'p', settledAt: null, settledOverride: null }), archived, null, '2026-11-14');
    add('ws', 'Websocket', '2026-11-13');
    const near = t3FindThreads({ query: 'websoket' }, dir);
    assert.deepEqual(near.threads, []); assert.equal(near.total, 0);
    assert.deepEqual(near.closedMatching, { count: 0, approximate: 1 });
    const text = formatFound({ checkedAt: 'now', ...near });
    assert.match(text, /^1 closed threads \(finished or archived\) are possible approximate matches \(imperfect transcription; confirm them before acting\) and are not shown\. Search them with includeClosed=true/m);
    assert.doesNotMatch(text, /also match/);
    // Widened, it is the candidate the count announced.
    const widened = t3FindThreads({ query: 'websoket', includeClosed: true }, dir);
    assert.deepEqual(widened.threads, []); assert.deepEqual(widened.candidates!.map(t => t.threadId), ['ws']);
    // Where something matches as written, approximate closed ones are not counted.
    add('ws-new', 'Websoket notes', null);
    const written = t3FindThreads({ query: 'websoket' }, dir);
    assert.deepEqual(written.threads.map(t => t.threadId), ['ws-new']); assert.equal(written.closedMatching, undefined);
    // null flags are the same as omitted ones, stated scope included.
    const omitted = formatFound({ checkedAt: 'now', ...t3FindThreads({ query: 'websoket' }, dir) });
    assert.match(omitted, /open only, top-level threads only/);
    assert.equal(formatFound({ checkedAt: 'now', ...t3FindThreads({ query: 'websoket', includeClosed: null, includeSubagents: null } as never, dir) }), omitted);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('search flags accept only booleans: a text "false" searches nothing', () => {
  // No base exists here: a widened search would fail on it instead.
  const base = join(tmpdir(), 'caller-no-base-' + process.pid);
  for (const field of ['includeSubagents', 'includeClosed'])
    for (const value of ['false', 'true', 0, 1, {}])
      assert.throws(() => t3FindThreads({ query: 'Pi', [field]: value } as never, base), { message: `${field} must be the boolean true or false, not text or a number. Nothing was searched.` }, `${field}=${JSON.stringify(value)}`);
});

test('the find tool passes includeSubagents through and its schema defaults to main threads', async () => {
  const seen: unknown[] = [];
  const [find] = t3Tools({ findThreads: params => { seen.push(params); return { threads: [], projectsMatchingName: [] }; }, run: async () => { throw new Error('Unexpected CLI call'); } });
  await testTool(find).execute('test', { query: 'Pi', includeSubagents: true });
  assert.deepEqual(seen, [{ query: 'Pi', includeSubagents: true }]);
  const schema = toolSchema('t3_find_threads');
  assert.match(schema.description, /top-level threads only by default/);
  assert.match(JSON.stringify(schema.parameters), /"includeSubagents":\{"type":"boolean","description":"[^"]*false by default/);
});
