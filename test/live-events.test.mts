import type { LiveEvent } from '../src/shared/contracts.mjs';
function fakeChannel() { return { readyState: 'connecting' as RTCDataChannelState, onopen() {}, onclose() {}, onmessage(event: { data: string }) { void event; } }; }
function fakePeer() { return { connectionState: 'new' as RTCPeerConnectionState, onconnectionstatechange() {} }; }
import test from 'node:test';
import assert from 'node:assert/strict';
import { bindLiveEvents } from '../public/live-events.js';

for (const first of ['open', 'started', 'connected']) test(`Live ${first} before session id, duplicate and late signals`, async () => {
  const channel = fakeChannel(), peer = fakePeer(), events: LiveEvent[] = [], ready: string[] = []; let current = true, state = 'connecting';
  const binding = bindLiveEvents({ channel, peer, isCurrent: () => current,
    ready: id => ready.push(id), onLive: () => { state = 'live'; },
    onEvent: e => events.push(e), onClose: () => { state = 'closed'; }, onError: assert.fail });
  const message = (event: unknown) => channel.onmessage({ data: JSON.stringify(event) });
  if (first === 'open') channel.onopen();
  if (first === 'started') message({ type: 'session.started' });
  if (first === 'connected') { peer.connectionState = 'connected'; peer.onconnectionstatechange(); }
  assert.equal(state, 'connecting'); assert.deepEqual(ready, []);
  binding.setId('call-one');
  message({ type: 'session.started' }); channel.onopen();
  channel.onmessage({ data: '{bad' }); message(null); message({});
  message({ type: 'session.input_transcript.delta', delta: 'hola' });
  message({ type: 'error', error: { code: 'test' } });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(state, 'live'); assert.deepEqual(ready, ['call-one']);
  assert.ok(events.some(e => e.delta === 'hola'));
  current = false; channel.onclose(); message({ type: 'session.closed' }); channel.onopen();
  assert.equal(state, 'live'); assert.deepEqual(ready, ['call-one']);
});

test('closing before signaling prevents greeting and late UI activation', async () => {
  const channel = fakeChannel(), peer = fakePeer(); let closed = 0;
  const binding = bindLiveEvents({ channel, peer, isCurrent: () => true, ready: assert.fail,
    onLive: assert.fail, onEvent: () => assert.fail('unexpected event'), onClose: () => closed++, onError: assert.fail });
  channel.onmessage({ data: '{"type":"session.closed"}' });
  binding.setId('late'); channel.onopen(); channel.onclose();
  peer.connectionState = 'connected'; peer.onconnectionstatechange();
  await Promise.resolve(); assert.equal(closed, 1);
});

test('id before channel open activates once; hangup cancels queued ready', async () => {
  const channel = fakeChannel(), peer = fakePeer(); let active = true, lives = 0;
  const binding = bindLiveEvents({ channel, peer, isCurrent: () => active, ready: assert.fail,
    onLive: () => lives++, onEvent() {}, onClose() {}, onError: assert.fail });
  binding.setId('call'); assert.equal(lives, 0);
  channel.onopen(); assert.equal(lives, 1);
  active = false;
  await Promise.resolve(); channel.onopen(); assert.equal(lives, 1);
});

test('temporary disconnects can recover without a new greeting, and failures retain a transport cause', async () => {
  const channel = fakeChannel(), peer = fakePeer(), states: string[] = [], closes: string[] = [];
  let greetings = 0;
  const binding = bindLiveEvents({ channel, peer, isCurrent: () => true, ready: () => { greetings++; }, onLive() {},
    onEvent() {}, onError: assert.fail, onClose: cause => closes.push(cause), onConnectionState: state => states.push(state) });
  binding.setId('call'); peer.connectionState = 'connected'; peer.onconnectionstatechange();
  await Promise.resolve();
  peer.connectionState = 'disconnected'; peer.onconnectionstatechange();
  assert.deepEqual(closes, []);
  peer.connectionState = 'connected'; peer.onconnectionstatechange();
  await Promise.resolve(); assert.equal(greetings, 1);
  peer.connectionState = 'failed'; peer.onconnectionstatechange(); channel.onclose();
  assert.deepEqual(states, ['connected', 'disconnected', 'connected', 'failed']);
  assert.deepEqual(closes, ['transport_failed']);
});

for (const reason of ['data_channel_closed', 'provider_closed', 'transport_closed']) test(`Live records ${reason} instead of a manual hangup`, () => {
  const channel = fakeChannel(), peer = fakePeer(), closes: string[] = [];
  bindLiveEvents({ channel, peer, isCurrent: () => true, ready() {}, onLive() {}, onEvent() {}, onError: assert.fail,
    onClose: cause => closes.push(cause) });
  if (reason === 'data_channel_closed') channel.onclose();
  if (reason === 'provider_closed') channel.onmessage({ data: '{"type":"session.closed"}' });
  if (reason === 'transport_closed') { peer.connectionState = 'closed'; peer.onconnectionstatechange(); }
  assert.deepEqual(closes, [reason]);
});
