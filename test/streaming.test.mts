import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveHealth } from '../public/live-health.js';
import { t } from '../public/i18n.js';
import { audioDiagnostics, clientCloseReason } from '../src/voice/diagnostics.mjs';
import { RealtimeCalls } from '../src/voice/realtime.mjs';
import { double, fakeAde } from './fixtures.mjs';
import type { RealtimeCall } from '../src/voice/realtime.mjs';

function rtcReport() {
  return double<RTCStatsReport>(new Map<string, unknown>([
    ['audio', { type: 'inbound-rtp', kind: 'audio', packetsReceived: 100, packetsLost: -1, bytesReceived: 1234,
      concealedSamples: 160, silentConcealedSamples: 80, totalSamplesReceived: 16000,
      jitter: 0.015, jitterBufferDelay: 8, jitterBufferEmittedCount: 100, trackIdentifier: 'private-track' }],
    ['video', { type: 'inbound-rtp', kind: 'video', packetsReceived: 9999, jitter: 99 }],
    ['transport', { type: 'transport', selectedCandidatePairId: 'selected' }],
    ['selected', { type: 'candidate-pair', currentRoundTripTime: 0.04, localCandidateId: 'private-id' }],
    ['candidate', { type: 'local-candidate', address: '192.0.2.1', url: 'turn:private.invalid', usernameFragment: 'secret' }]
  ]));
}


test('WebRTC health collects only audio counters, selected RTT and local playback state, without candidate metadata', async () => {
  const peer = double<RTCPeerConnection>({ getStats: async () => rtcReport(), connectionState: 'connected', iceConnectionState: 'completed' });
  const health = new LiveHealth(peer, { muted: true, paused: false, readyState: 4 });
  await health.sample();
  const snapshot = health.snapshot();
  assert.equal(snapshot.packetsReceived, 100); assert.equal(snapshot.packetsLost, -1);
  assert.equal(snapshot.concealedSamples, 160); assert.equal(snapshot.jitterMs, 15);
  assert.equal(snapshot.jitterBufferMeanMs, 80); assert.equal(snapshot.roundTripTimeMs, 40);
  assert.equal(snapshot.outputMuted, true); assert.equal(snapshot.outputPaused, false);
  assert.equal(snapshot.connectionState, 'connected'); assert.ok(snapshot.statsAgeMs! >= 0);
  assert.doesNotMatch(JSON.stringify(snapshot), /private|192\.0\.2\.1|secret|trackIdentifier/);
});

test('unsupported or pending stats cannot block cleanup, overlap collectors, or update a closed call', async () => {
  let resolve!: (report: RTCStatsReport) => void, requests = 0;
  const health = new LiveHealth(double<RTCPeerConnection>({ getStats: () => { requests++; return new Promise(done => { resolve = done; }); } }), { muted: false, paused: false, readyState: 4 });
  const pending = health.sample(); await health.sample(); assert.equal(requests, 1);
  health.close(); resolve(rtcReport()); await pending;
  assert.deepEqual(health.values, {});
  const unsupported = new LiveHealth(double<RTCPeerConnection>({ getStats: async () => { throw Error('unsupported'); } }), { muted: false, paused: false, readyState: 4 });
  await assert.doesNotReject(unsupported.sample()); assert.deepEqual(unsupported.values, {});
});

test('server diagnostics discard arbitrary browser payloads and preserve bounded counters only', () => {
  assert.deepEqual(audioDiagnostics({ packetsReceived: 1, packetsLost: -1, jitterMs: Infinity, bytesReceived: 1e20,
    concealedSamples: -5, outputMuted: true, outputPaused: 'secret', connectionState: 'failed', iceConnectionState: 'private text',
    sdp: 'secret', transcript: 'private conversation', address: '192.0.2.1', nested: { secret: 'hidden' } }),
  { packetsReceived: 1, packetsLost: -1, connectionState: 'failed', outputMuted: true });
  for (const input of [null, [], 'private']) assert.deepEqual(audioDiagnostics(input), {});
  assert.match(clientCloseReason('transport_failed'), /WebRTC/);
  assert.match(clientCloseReason('provider_closed'), /provider/);
  assert.equal(clientCloseReason('__proto__'), clientCloseReason(undefined));
});

test('diagnostics are rate limited, bound to a current call, and may include one final playback snapshot', () => {
  const events: unknown[] = [];
  const live = new RealtimeCalls(double<ConstructorParameters<typeof RealtimeCalls>[0]>({ ade: fakeAde(), publish: (_type, data) => events.push(data), context: { conversation: () => ({ id: 'current' }) } }));
  const call = double<RealtimeCall>({ id: 'call', backend: 't3', conversationId: 'current', closed: false });
  live.sessions.set(call.id, call);
  try {
    live.diagnostics(call.id, { packetsReceived: 1 }); live.diagnostics(call.id, { packetsReceived: 2 });
    assert.equal(events.length, 1);
    live.diagnostics(call.id, { packetsReceived: 3, connectionState: 'failed' }, true);
    assert.equal(events.length, 2);
    call.closed = true; live.diagnostics(call.id, { packetsReceived: 4 }, true);
    call.closed = false; call.conversationId = 'old'; live.diagnostics(call.id, { packetsReceived: 4 }, true);
    live.diagnostics('missing', { packetsReceived: 4 }, true);
    assert.equal(events.length, 2);
    assert.deepEqual(events[1], { id: 'call', backend: 't3', conversationId: 'current', at: call.diagnosticsAt,
      metrics: { packetsReceived: 3, connectionState: 'failed' } });
  } finally { live.sessions.clear(); live.shutdown(); }
});

test('short disconnects remain counted after recovery between diagnostic reports', () => {
  const health = new LiveHealth(double<RTCPeerConnection>({ connectionState: 'connected' }), { muted: false, paused: false, readyState: 4 });
  for (const state of ['connected', 'disconnected', 'disconnected', 'connected', 'disconnected', 'connected'] as const) health.connectionChanged(state);
  assert.equal(health.snapshot().disconnects, 2);
  health.close(); health.connectionChanged('disconnected'); assert.equal(health.snapshot().disconnects, 2);
});

test('a channel send failure still releases audio and reports the actual close cause', async () => {
  const { readFileSync } = await import('node:fs'); const { runInNewContext } = await import('node:vm');
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  let cleaned = false; const requests: unknown[] = [], states: string[] = [];
  const scope = { recordings: { current: null }, callId: 'call', languageChanged: false, liveDiagnostics: () => { assert.equal(cleaned, false); return { connectionState: 'failed' }; },
    channel: { readyState: 'open', send() { throw Error('closed during send'); } }, cleanup: () => { cleaned = true; },
    setCall: (state: string) => states.push(state), endedText: () => 'ended', notice: assert.fail, t,
    api: async (_path: string, payload: unknown) => { requests.push(payload); } };
  runInNewContext(app.slice(app.indexOf('async function closeCall('), app.indexOf('async function newSession(')), scope);
  await (scope as typeof scope & { closeCall(cause: string): Promise<void> }).closeCall('transport_failed');
  assert.equal(cleaned, true); assert.deepEqual(states, ['dropped']);
  assert.equal(JSON.stringify(requests), JSON.stringify([{ id: 'call', cause: 'transport_failed', diagnostics: { connectionState: 'failed' } }]));
});

test('keepalives do not wait for stats, overlap requests, or let a late response close a newer call', async () => {
  const { readFileSync } = await import('node:fs'); const { runInNewContext } = await import('node:vm');
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const source = app.slice(app.indexOf('function startHeartbeat('), app.indexOf('// The language fields of POST /api/live.')) + '\nstartHeartbeat(generation, callId, health);';
  for (const stale of [false, true]) {
    let tick!: () => void; const requests: { id: string }[] = [], closes: string[] = [];
    let resolve!: (data: { active: boolean }) => void;
    const scope = { recordings: { current: null }, callId: 'original', callGeneration: 1, generation: 1, heartbeat: undefined,
      health: { sample: () => new Promise(() => {}) }, liveDiagnostics: () => ({}),
      setInterval: (callback: () => void) => { tick = callback; }, AbortController, setTimeout, clearTimeout, notice: assert.fail,
      api: (_path: string, data: { id: string }) => { requests.push(data); return new Promise(done => { resolve = done; }); },
      closeCall: (cause: string) => closes.push(cause) };
    runInNewContext(source, scope);
    tick(); tick(); assert.equal(requests.length, 1); assert.equal(requests[0].id, 'original');
    if (stale) { scope.callGeneration++; scope.callId = 'new-call'; }
    resolve({ active: false }); await new Promise(done => setImmediate(done));
    assert.deepEqual(closes, stale ? [] : ['server_session_missing']);
  }
});

test('heartbeat deadlines abort and release the pending flag without AbortSignal.timeout', async () => {
  const { readFileSync } = await import('node:fs'); const { runInNewContext } = await import('node:vm');
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const source = app.slice(app.indexOf('function startHeartbeat('), app.indexOf('// The language fields of POST /api/live.')) + '\nstartHeartbeat(generation, callId, health);';
  let tick!: () => void, expire!: () => void, requests = 0, cleared = 0;
  const notices: string[] = [];
  const scope = { recordings: { current: null }, callId: 'call', languageChanged: false, callGeneration: 1, generation: 1, heartbeat: undefined,
    health: { sample: async () => {} }, liveDiagnostics: () => ({}), AbortController,
    AbortSignal: {}, // A browser without the newer static timeout method.
    setInterval: (callback: () => void) => { tick = callback; },
    setTimeout: (callback: () => void, ms: number) => { assert.equal(ms, 5000); expire = callback; return 1; },
    clearTimeout: () => { cleared++; }, notice: (text: string) => notices.push(text), closeCall: assert.fail, t,
    api: (_path: string, _data: unknown, signal: AbortSignal) => {
      requests++; return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Error('timed out'))));
    } };
  runInNewContext(source, scope);
  for (let attempt = 1; attempt <= 2; attempt++) {
    tick(); tick(); assert.equal(requests, attempt);
    expire(); await new Promise(done => setImmediate(done)); assert.equal(cleared, attempt);
  }
  assert.equal(notices.length, 1); assert.match(notices[0], /connection/);
});


test('playback diagnostics keep bounded events without transcript or arbitrary fields', () => {
  const event = { kind: 'local_speech_start', at: 123, outputEndMs: 456, text: 'private', secret: 'hidden' };
  assert.deepEqual(audioDiagnostics({ playbackPolicy: 'provider', manualPlaybackStops: 2, playbackEvents: [event,
    { kind: 'unknown', at: 12 }, { kind: 'manual_stop', at: 13 }, { kind: 'local_speech_start', at: Infinity }, { kind: 'local_speech_end', at: 124, outputEndMs: -1 }, null] }),
  { playbackPolicy: 'provider', playbackEvents: [{ kind: 'local_speech_start', at: 123 }, { kind: 'local_speech_end', at: 124 }] });
  const data = audioDiagnostics({ playbackEvents: Array(30).fill(event), manualPlaybackStops: -1, playbackPolicy: 'private' });
  assert.equal((data.playbackEvents as unknown[]).length, 20);
  assert.ok(!JSON.stringify(data).match(/private|hidden|secret|manualPlaybackStops/));
});

test('the in-call new session hangs up, opens a fresh conversation, then calls again; a failure stops the chain', async () => {
  const { readFileSync } = await import('node:fs'); const { runInNewContext } = await import('node:vm');
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const source = app.slice(app.indexOf('async function newSession('), app.indexOf('const listening ='));
  for (const failure of [null, 'close', 'new', 'boot', 'race'] as const) {
    const steps: string[] = [], notices: string[] = [], elements: Record<string, { disabled?: boolean; textContent?: string; onclick?: unknown }> = {};
    const scope: Record<string, unknown> = {
      backend: 't3', conversationId: 'old', callId: 'call', voiceReady: true, languageChanged: false, stream: null, restarting: false, t,
      setCall: (state: string, text: string) => { if (text) steps.push('state:' + state + ':' + text); },
      $: (id: string) => (elements[id] ??= {}), errorMessage: (error: Error) => error.message,
      confirm: () => assert.fail('a new session starts without asking'), play: (sound: string) => steps.push(sound === 'session' ? 'chime' : sound),
      notice: (text: string) => { if (text) notices.push(text); },
      closeCall: async () => { steps.push('hangup'); scope.callId = null; },
      api: async (path: string, data: { conversationId: string }) => {
        steps.push(path); assert.equal(data.conversationId, 'old');
        if (failure === 'new' || failure === 'close') throw Error(failure === 'close' ? 'End the call before starting another session.' : 'The session has already changed.');
        return { conversation: { id: 'fresh' } };
      },
      // 'race': the first reload is superseded by another and does not see the new conversation.
      boot: async () => { steps.push('boot'); if (failure === 'boot' || (failure === 'race' && steps.filter(s => s === 'boot').length === 1)) return; scope.conversationId = 'fresh'; },
      startCall: async () => { steps.push('call:' + scope.conversationId); }
    };
    runInNewContext(source + ';globalThis.restartSession = restartSession;', scope);
    await (scope.restartSession as () => Promise<void>)();
    const starting = 'state:connecting:' + t('session.restarting');
    const expected = failure === 'new' || failure === 'close' ? ['chime', 'hangup', starting, '/api/conversation/new']
      : failure === 'boot' ? ['chime', 'hangup', starting, '/api/conversation/new', 'boot', 'boot']
      : failure === 'race' ? ['chime', 'hangup', starting, '/api/conversation/new', 'boot', 'boot', 'call:fresh'] : ['chime', 'hangup', starting, '/api/conversation/new', 'boot', 'call:fresh'];
    assert.deepEqual(steps, expected, String(failure));
    if (failure === 'new' || failure === 'close') assert.equal(notices.length, 1);
    if (failure === 'boot') assert.ok(notices.includes(t('session.restartNoCall')), 'a restart that cannot call says so');
    assert.equal(scope.restarting, false, 'a later tap works again');
    if (failure === null) {
      // A second tap while the restart runs is ignored: one chain, one new conversation.
      steps.length = 0; scope.callId = 'call2'; scope.conversationId = 'fresh';
      const restart = scope.restartSession as () => Promise<void>;
      await Promise.all([restart(), restart()]);
      assert.equal(steps.filter(s => s === '/api/conversation/new').length, 1, 'double tap');
    }
    assert.equal(elements['new-session']?.disabled ?? false, false, 'the header control is usable again');
  }
});
