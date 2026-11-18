import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Recordings } from '../src/voice/recordings.mjs';

function fragment(id = randomUUID()) {
  return { info: { id, backend: 't3', conversationId: 'conversation', provider: 'realtime', mime: 'audio/webm;codecs=opus', startedAt: new Date().toISOString(), bytes: 9999, durationMs: 0, status: 'recording' },
    sequence: 0, audio: Buffer.from('first').toString('base64'), events: [{ ms: 0, type: 'recording_started' }] };
}
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'recordings-')); t.after(() => rm(root, { recursive: true, force: true }));
  return { root, archive: new Recordings(root) };
}

test('archive persists ordered fragments, rejects changed retries and assembles private audio plus timeline', async t => {
  const { root, archive } = await fixture(t), first = fragment();
  await archive.save(first, 't3', 'conversation', 'browser');
  await archive.save(first, 't3', 'conversation', 'browser');
  assert.equal((await archive.list('t3', 'browser'))[0].bytes, 5, 'client byte counter is not trusted');
  await assert.rejects(archive.save({ ...first, audio: Buffer.from('different').toString('base64') }, 't3', 'conversation', 'browser'));
  const last = { ...first, sequence: 1, info: { ...first.info, callId: 'call', status: 'complete', durationMs: 1000 }, audio: Buffer.from('last').toString('base64'), events: [{ ms: 1000, type: 'recording_stopped' }] };
  await archive.save(last, 't3', 'new-conversation', 'browser'); // An in-flight final upload survives conversation reset.
  const folder = join(root, first.info.id);
  assert.equal(await readFile(join(folder, 'audio.webm'), 'utf8'), 'firstlast');
  assert.equal((await readFile(join(folder, 'timeline.jsonl'), 'utf8')).trim().split('\n').length, 2);
  const manifest = JSON.parse(await readFile(join(folder, 'manifest.json'), 'utf8'));
  assert.equal(manifest.status, 'complete'); assert.equal(manifest.bytes, 9); assert.equal(manifest.callId, 'call');
  assert.equal((await stat(folder)).mode & 0o777, 0o700);
  for (const file of ['audio.webm', 'timeline.jsonl', 'manifest.json', 'parts/000000.json']) assert.equal((await stat(join(folder, file))).mode & 0o777, 0o600);
  await assert.rejects(archive.save({ ...last, sequence: 2 }, 't3', 'conversation', 'browser'));
});

test('archive enforces browser and ADE ownership, fresh conversation and contiguous sequences', async t => {
  const { archive } = await fixture(t), first = fragment();
  await assert.rejects(archive.save(first, 't3', 'wrong', 'browser'));
  await assert.rejects(archive.save({ ...first, info: { ...first.info, id: '../../outside' } }, 't3', 'conversation', 'browser'));
  await archive.save(first, 't3', 'conversation', 'browser');
  assert.deepEqual(await archive.list('t3', 'other-browser'), []);
  assert.deepEqual(await archive.list('orca', 'browser'), []);
  await assert.rejects(archive.save(first, 't3', 'conversation', 'other-browser'));
  await assert.rejects(archive.save({ ...first, sequence: 1, info: { ...first.info, backend: 'orca' } }, 'orca', 'conversation', 'browser'));
  await assert.rejects(archive.save({ ...first, sequence: 3 }, 't3', 'conversation', 'browser'));
  await assert.rejects(archive.save({ ...first, sequence: 1, audio: 'not base64' }, 't3', 'conversation', 'browser'));
  await assert.rejects(archive.save({ ...first, sequence: 1, info: { ...first.info, durationMs: 999999999 } }, 't3', 'conversation', 'browser'));
});

test('interrupted archives survive server restart and can be recovered offline without claiming completeness', async t => {
  const { root, archive } = await fixture(t), first = fragment();
  await archive.save(first, 't3', 'conversation', 'browser');
  const restarted = new Recordings(root);
  const result = await restarted.recover(first.info.id);
  assert.equal(result.status, 'incomplete');
  assert.equal(await readFile(join(result.directory, 'audio.webm'), 'utf8'), 'first');
  assert.equal((await restarted.list('t3', 'browser'))[0].status, 'incomplete');
  await assert.rejects(restarted.recover('../x'));
});
