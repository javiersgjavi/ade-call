import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { DirectTool } from '../src/direct/contract.mjs';
import { isHintEcho } from '../src/conversation/hint-echo.mjs';
import { vocabularyHints } from '../src/conversation/context.mjs';
import { DirectSession } from '../src/direct/session.mjs';
import { RealtimeCalls } from '../src/voice/realtime.mjs';
import { double, fakeAde } from './fixtures.mjs';

const hints = vocabularyHints('t3', ['huerto-app', 'pagos-api', 'pagos-web', 'blog-personal', 'Migración', 'OAuth']);

test('a transcript that only recites the recognition hints is an echo', () => {
  for (const echo of [
    't3, ADE Call, Claude, Codex, README, Git, huerto-app, pagos-api, pagos-web, blog-personal',
    'T3, ADE call, Claude, Codex.',
    'Claude, Codex, README, Git, huerto app, pagos',
    'huerto-app, pagos-api, pagos-web, blog-personal, migracion, oauth',
    't3 ADE Call, Claude, Codex',
    'pagos-web, blog-personal, t3'
  ]) assert.equal(isHintEcho(echo, hints), true, echo);
});

test('real speech, even with several project names, is not an echo', () => {
  for (const speech of [
    'Sí.', 'Okay, send it.', 'Three.', 't3,', 'Claude, Codex',
    'Send it to pagos-api and pagos-web.',
    'Compare pagos-api, pagos-web, and huerto-app.',
    'Sí, pagos-api, pagos-web, huerto-app.',
    'Read the README of huerto-app, please',
    'Claude, Codex, sí',
    ''
  ]) assert.equal(isHintEcho(speech, hints), false, speech);
  assert.equal(isHintEcho('Claude, Codex, README', []), false, 'without hints nothing is an echo');
});

const sender: DirectTool = { name: 'fake_send', description: 'Send', parameters: { type: 'object' }, sends: true, execute: async () => ({ text: 'SEND ACCEPTED' }) };

test('the send gate: after a proposal, an echo does not authorize a send; a real yes does', async () => {
  const session = new DirectSession(fakeAde([sender], 'CATALOG'));
  const run = (id: string) => session.run({ name: 'fake_send', call_id: id }, { requestId: id, signal: AbortSignal.timeout(1000) });
  session.fill(undefined, 'user', 'Tell pagos-api to add the tests.');
  session.fill(undefined, 'assistant', 'Shall I send it?');
  session.fill(undefined, 'user', 'Sí.');
  assert.equal((await run('c1'))!.status, 'completed');
  session.fill(undefined, 'assistant', 'Sent. Shall I also tell pagos-web?');
  const echo = 't3, ADE Call, Claude, Codex, README, Git, huerto-app, pagos-api';
  session.fill(undefined, 'user', echo, { echo: true });
  const refused = (await run('c2'))!;
  assert.equal(refused.status, 'refused'); assert.match(refused.output, /no_user_turn/);
  assert.ok(session.history.some(m => m.text === echo), 'the echo stays in the history');
  session.fill(undefined, 'user', 'Sí.');
  assert.equal((await run('c3'))!.status, 'completed');
  // The send consumed the real yes, not the echo: a later echo is again no turn.
  session.fill(undefined, 'user', echo, { echo: true });
  assert.equal((await run('c4'))!.status, 'refused');
});

class FakeSocket extends EventEmitter {
  readyState = 1; sent: { type: string; item?: { type?: string; output?: string } }[] = [];
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  close() { this.readyState = 3; }
}

test('a call stores and marks a transcribed echo of its hints, and it does not authorize a send', async t => {
  let sends = 0;
  const socket = new FakeSocket(), published: { type: string; data: Record<string, unknown> }[] = [];
  const tool: DirectTool = { ...sender, execute: async () => { sends++; return { text: 'SEND ACCEPTED' }; } };
  const realtime = new RealtimeCalls(double<ConstructorParameters<typeof RealtimeCalls>[0]>({
    key: 'test-key', ade: fakeAde([tool], 'CATALOG'), store: { meta() {} }, publish: (type, data) => published.push({ type, data }),
    context: { conversation: () => ({ id: 'current' }), resume: () => 'Earlier history.', vocabulary: () => hints, rememberClose() {}, timing: () => ({}) },
    fetch: async () => ({ ok: true, status: 201, text: async () => 'v=answer', headers: new Headers({ location: '/v1/realtime/calls/rtc_echo' }) }),
    connect: () => { setImmediate(() => socket.emit('open')); return socket; }
  }));
  t.after(() => realtime.shutdown());
  await realtime.create('v=offer');
  const emit = (event: Record<string, unknown>) => socket.emit('message', Buffer.from(JSON.stringify(event)));
  const wait = () => new Promise(resolve => setTimeout(resolve, 50));
  const heard = (id: string, transcript: string) => { emit({ type: 'input_audio_buffer.committed', item_id: id }); emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: id, transcript }); };
  const said = (id: string, transcript: string) => { emit({ type: 'response.output_item.added', item: { type: 'message', id } }); emit({ type: 'response.output_audio_transcript.done', item_id: id, transcript }); };
  const call = (id: string) => emit({ type: 'response.output_item.done', item: { type: 'function_call', name: 'fake_send', call_id: id, arguments: '{}' } });
  const outputs = () => socket.sent.filter(e => e.item?.type === 'function_call_output').map(e => e.item!.output!);

  heard('u1', 'Tell pagos-api to add the tests.'); said('a1', 'Shall I send it?'); heard('u2', 'Sí.');
  call('s1'); await wait();
  assert.equal(sends, 1);
  said('a2', 'Sent. Shall I also tell pagos-web?');
  heard('u3', 't3, ADE Call, Claude, Codex, README, Git, huerto-app, pagos-api, pagos-web');
  call('s2'); await wait();
  assert.equal(sends, 1, 'the echo is not a user turn');
  assert.match(outputs().at(-1)!, /no_user_turn/);
  const transcripts = published.filter(e => e.type === 'transcript' && e.data.role === 'user').map(e => e.data);
  assert.equal(transcripts.at(-1)!.echo, true, 'the echo is published, marked');
  assert.equal(transcripts.at(-2)!.echo, undefined, 'a real turn carries no mark');
  heard('u4', 'Sí.'); call('s3'); await wait();
  assert.equal(sends, 2, 'a real yes after the echo authorizes the send');
});
