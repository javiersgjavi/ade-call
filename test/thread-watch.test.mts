import type { T3Response } from '../src/shared/contracts.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ThreadWatch, noticeHeader, type ThreadNotice } from '../src/conversation/thread-watch.mjs';

const RUN = 'run:thread:t1:ordinal:3';
const APPEND_BYTES = 480;
function thread(status: string, activeRunId: string | null, messages: { text: string; runId?: string }[] = [], extra: Record<string, unknown> = {}): T3Response {
  return { thread: { threadId: 't1', projectId: 'p', title: 'Cruzar asistentes', status, activeRunId, latestRunId: RUN, link: 'https://t3/t1', updatedAt: new Date(1000).toISOString(), ...extra },
    messages: [{ role: 'user', text: 'Encargo', runId: RUN }, ...messages.map(m => ({ role: 'assistant', runId: RUN, ...m }))] };
}
function harness(options: Partial<ConstructorParameters<typeof ThreadWatch>[0]> = {}) {
  let now = 0, response: T3Response = thread('running', RUN), accept = true, reads = 0;
  const notices: ThreadNotice[] = [];
  const watch = new ThreadWatch({ now: () => now, read: async () => { reads++; return response; }, deliver: n => { if (accept) notices.push(n); return accept; },
    activePollMs: 1000, idlePollMs: 60_000, progressEveryMs: 40_000, firstProgressMs: 15_000, heartbeatMs: 120_000, ...options });
  return { watch, notices, get reads() { return reads; },
    at(ms: number) { now = ms; }, respond(r: T3Response) { response = r; }, accept(value: boolean) { accept = value; } };
}

test('a followed thread reports its progress and, without being asked, the end of its turn', async () => {
  const h = harness();
  h.watch.add({ threadId: 't1', project: 'eventos-web', runId: RUN, conversationId: 'c' });
  h.at(2000); await h.watch.tick(true);
  assert.equal(h.notices.length, 0, 'nothing to say while it only started');
  h.respond(thread('running', RUN, [{ text: 'Lo compruebo en el registro. Solo voy a leer.' }]));
  h.at(5000); await h.watch.tick(true);
  assert.equal(h.notices.length, 0, 'the first progress waits a moment after the delivery acknowledgement');
  h.at(16_000); await h.watch.tick(true);
  assert.deepEqual(h.notices.map(n => [n.kind, n.text]), [['progress', 'Lo compruebo en el registro. Solo voy a leer.']]);
  h.respond(thread('running', RUN, [{ text: 'Lo compruebo en el registro. Solo voy a leer.' }, { text: 'Ya tengo los anfitriones.' }]));
  h.at(30_000); await h.watch.tick(true);
  assert.equal(h.notices.length, 1, 'progress is rate limited');
  h.at(57_000); await h.watch.tick(true);
  assert.equal(h.notices.at(-1)!.text, 'Ya tengo los anfitriones.');
  h.respond(thread('completed', null, [{ text: 'Ya tengo los anfitriones.' }, { text: 'Quedan 14 asistentes. ¿Los marco?' }]));
  h.at(60_000); await h.watch.tick(true);
  const final = h.notices.at(-1)!;
  assert.equal(final.kind, 'finished'); assert.equal(final.text, 'Quedan 14 asistentes. ¿Los marco?');
  assert.equal(final.title, 'Cruzar asistentes'); assert.equal(final.project, 'eventos-web'); assert.equal(final.quiet, false);
  assert.equal(h.watch.watches.size, 0, 'an announced end is not repeated');
});

test('an end nobody could hear is kept and offered again without reading the thread again', async () => {
  const h = harness();
  h.watch.add({ threadId: 't1', project: 'p', runId: RUN });
  h.respond(thread('completed', null, [{ text: 'Hecho.' }]));
  h.accept(false); h.at(2000); await h.watch.tick(false);
  assert.equal(h.reads, 1); assert.equal(h.watch.watches.size, 1);
  h.at(3000); await h.watch.tick(true); assert.equal(h.reads, 1);
  h.accept(true); h.at(4000); await h.watch.tick(true);
  assert.equal(h.notices.at(-1)!.kind, 'finished'); assert.equal(h.watch.watches.size, 0);
});

test('a queued delivery is not reported as finished before its run starts', async () => {
  const h = harness();
  h.watch.add({ threadId: 't1', project: 'p', runId: 'run:next' });
  h.respond(thread('running', RUN, [{ text: 'Otro turno anterior' }]));
  h.at(2000); await h.watch.tick(true);
  h.respond(thread('completed', null, [{ text: 'Otro turno anterior' }]));
  h.at(4000); await h.watch.tick(true);
  assert.equal(h.notices.length, 0); assert.equal(h.watch.watches.size, 1);
  h.respond({ ...thread('completed', null), thread: { ...thread('completed', null).thread, latestRunId: 'run:next' }, messages: [{ role: 'assistant', runId: 'run:next', text: 'Respuesta del encargo' }] });
  h.at(6000); await h.watch.tick(true);
  assert.equal(h.notices.at(-1)!.text, 'Respuesta del encargo');
});

test('an end already read with a tool is context only, and a long run gets a heartbeat', async () => {
  const h = harness();
  h.watch.add({ threadId: 't1', project: 'p', runId: RUN });
  h.at(2000); await h.watch.tick(true);
  h.at(130_000); await h.watch.tick(true);
  assert.equal(h.notices.at(-1)!.kind, 'working'); assert.equal(h.notices.at(-1)!.minutes, 2);
  h.respond(thread('completed', null, [{ text: 'Hecho.' }], { updatedAt: new Date(131_000).toISOString() }));
  h.at(132_000); h.watch.markRead('t1'); await h.watch.tick(true);
  assert.equal(h.notices.at(-1)!.kind, 'finished'); assert.equal(h.notices.at(-1)!.quiet, true);
});

test('every notice header fits one append', () => {
  const long = 'Ñandú áéíóú '.repeat(40);
  for (const kind of ['progress', 'working', 'finished', 'failed', 'stopped'] as const) for (const quiet of [false, true])
    assert.ok(Buffer.byteLength(noticeHeader({ kind, threadId: 't', title: long, project: long, minutes: 12, quiet })) <= APPEND_BYTES, kind);
});

const PREV = 'run:prev', NEXT = 'run:next';
function queuedThread(status: string, activeRunId: string | null, latestRunId: string, runCount: number, messages: { text: string; runId: string }[]): T3Response {
  return { thread: { threadId: 't1', projectId: 'p', title: 'Inventario', status, activeRunId, latestRunId, runCount, updatedAt: new Date(1000).toISOString() },
    messages: messages.map(m => ({ role: 'assistant', ...m })) };
}

test('a queued delivery does not adopt the turn active at delivery; it follows the next run', async () => {
  const h = harness();
  h.watch.add({ threadId: 't1', project: 'p', runId: null, before: { runs: 4, latestRunId: PREV } });
  h.respond(queuedThread('running', PREV, PREV, 4, [{ text: 'Respuesta del turno anterior', runId: PREV }]));
  h.at(2000); await h.watch.tick(true);
  h.respond(queuedThread('completed', null, PREV, 4, [{ text: 'Respuesta del turno anterior', runId: PREV }]));
  h.at(4000); await h.watch.tick(true);
  assert.equal(h.notices.length, 0, 'the previous turn ending is not our answer');
  assert.equal(h.watch.watches.size, 1);
  h.respond(queuedThread('running', NEXT, NEXT, 5, [{ text: 'Respuesta del turno anterior', runId: PREV }]));
  h.at(6000); await h.watch.tick(true);
  h.respond(queuedThread('completed', null, NEXT, 5, [{ text: 'Respuesta del turno anterior', runId: PREV }, { text: 'Inventario cuadrado.', runId: NEXT }]));
  h.at(8000); await h.watch.tick(true);
  assert.deepEqual(h.notices.map(n => [n.kind, n.text]), [['finished', 'Inventario cuadrado.']]);
});

test('a queued run that starts and ends between two polls is still announced', async () => {
  const h = harness();
  h.watch.add({ threadId: 't1', project: 'p', runId: null, before: { runs: 4, latestRunId: PREV } });
  h.respond(queuedThread('completed', null, NEXT, 5, [{ text: 'Antes', runId: PREV }, { text: 'Hecho entre sondeos.', runId: NEXT }]));
  h.at(2000); await h.watch.tick(true);
  assert.deepEqual(h.notices.map(n => [n.kind, n.text]), [['finished', 'Hecho entre sondeos.']]);
});

test('without a baseline, the first poll is one: the active turn then is never announced as ours', async () => {
  const h = harness();
  h.watch.add({ threadId: 't1', project: 'p', runId: null });
  h.respond(queuedThread('running', PREV, PREV, 4, [{ text: 'Turno anterior', runId: PREV }]));
  h.at(2000); await h.watch.tick(true);
  h.respond(queuedThread('completed', null, PREV, 4, [{ text: 'Turno anterior', runId: PREV }]));
  h.at(4000); await h.watch.tick(true);
  assert.equal(h.notices.length, 0);
  h.respond(queuedThread('completed', null, NEXT, 5, [{ text: 'Nuestro encargo hecho.', runId: NEXT }]));
  h.at(6000); await h.watch.tick(true);
  assert.equal(h.notices.at(-1)!.text, 'Nuestro encargo hecho.');
});
