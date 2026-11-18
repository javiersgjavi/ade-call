import test from 'node:test';
import assert from 'node:assert/strict';
import { ProjectCatalog } from '../src/conversation/project-catalog.mjs';
import { ProjectContext, distinctiveWords } from '../src/conversation/context.mjs';
import { ades } from '../src/adapters/registry.mjs';
import { double } from './fixtures.mjs';

test('catalog warms once, refreshes routing metadata and preserves stale evidence after failure', () => {
  let now = 0, reads = 0, fail = false;
  let projects = [{ id: 'p1', name: 'First', path: '/private' }];
  const catalog = new ProjectCatalog('t3', () => { reads++; if (fail) throw new Error('private diagnostic'); return projects; }, undefined, () => now);
  assert.equal(reads, 1);
  assert.deepEqual(catalog.snapshot().projects, [{ id: 'p1', name: 'First' }]);
  projects = [{ id: 'p2', name: 'Second', path: '/private' }];
  now = 29_999; assert.equal(catalog.snapshot().projects[0].id, 'p1'); assert.equal(reads, 1);
  now = 30_000; assert.equal(catalog.snapshot({ refresh: true }).projects[0].id, 'p2'); assert.equal(reads, 2);
  fail = true; now = 60_000;
  const stale = catalog.snapshot({ refresh: true }); assert.equal(stale.status, 'stale'); assert.equal(stale.projects[0].id, 'p2');
  assert.doesNotMatch(JSON.stringify(stale), /private/);
  fail = false; projects = []; now = 90_000;
  assert.equal(catalog.snapshot({ refresh: true }).status, 'metadata_only'); assert.deepEqual(catalog.snapshot().projects, []);
  assert.equal(new ProjectCatalog('t3', () => { throw new Error(); }).snapshot().status, 'unavailable');
});

test('catalog is bounded valid JSON and stays separate from other ADEs', () => {
  const catalog = new ProjectCatalog('t3', () => Array.from({ length: 1000 }, (_, i) => ({ id: String(i), name: '名'.repeat(200), path: '' })));
  const data = catalog.snapshot();
  assert.equal(data.total, 1000); assert.equal(data.truncated, true);
  assert.ok(data.projects.length <= 100); assert.ok(Buffer.byteLength(JSON.stringify(data)) < 13_000);
  assert.deepEqual(JSON.parse(JSON.stringify(data)), data);
  const orca = new ProjectCatalog('orca');
  assert.equal(orca.snapshot().status, 'unavailable'); assert.deepEqual(orca.snapshot().projects, []);
  assert.equal(ades.orca.promptCatalog, undefined, 'no CLI preload or T3 fallback for Orca');
  assert.equal(typeof ades.t3.promptCatalog, 'function');
});

test('voice vocabulary comes from the local catalog before any overview and follows renames', () => {
  let name = 'billing-service';
  const context = new ProjectContext(double<ConstructorParameters<typeof ProjectContext>[0]>({
    state: '', store: {}, publish() {}, backend: 't3',
    readCatalog: () => [{ id: 'p', name, path: '/private' }],
    readCatalogThreads: () => [{ threadId: 't', projectId: 'p', title: 'OpenTelemetry export' }, { threadId: 'c', projectId: 'p', title: 'Child detail', relationshipToParent: 'subagent' }],
    readOverview: () => { throw new Error('Must not discover activity'); },
  }));
  assert.ok(context.vocabulary().includes('billing-service'));
  assert.ok(context.vocabulary().includes('OpenTelemetry'), 'distinctive words of a thread title');
  assert.ok(!context.vocabulary().includes('OpenTelemetry export'), 'never a whole title the transcriber could emit as speech');
  assert.ok(!context.vocabulary().includes('Child detail'));
  name = 'Ledger API';
  assert.ok(context.vocabulary().includes('Ledger API'));
  assert.equal(context.snapshot.status, 'not_checked');
  assert.doesNotMatch(JSON.stringify(context.vocabulary()), /private/);
});

test('voice vocabulary for an ADE without a light catalog uses names stored at the last call close', () => {
  const meta = new Map<string, unknown>([['lastCallContext:orca', { projects: [{ id: 'p', name: 'atarazana-web' }], workspaces: [{ name: 'checkout v2' }] }]]);
  const context = new ProjectContext(double<ConstructorParameters<typeof ProjectContext>[0]>({
    state: '', publish() {}, backend: 'orca', store: { meta: (key: string) => meta.get(key) },
    readOverview: () => { throw new Error('Must not launch the ADE CLI'); },
  }));
  assert.ok(context.vocabulary().includes('atarazana-web')); assert.ok(context.vocabulary().includes('checkout v2'));
  assert.equal(context.snapshot.status, 'not_checked');
});

test('only distinctive words of a thread title reach the transcription vocabulary', () => {
  assert.deepEqual(distinctiveWords('Explorar ElevenLabs como proveedor'), ['ElevenLabs']);
  assert.deepEqual(distinctiveWords('Probar Whisper en el NAS con T3'), ['Whisper', 'NAS', 'T3']);
  assert.deepEqual(distinctiveWords('revisar el riego'), []);
});
