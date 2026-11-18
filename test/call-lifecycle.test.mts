import { double } from './fixtures.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/conversation/store.mjs';
import { ProjectContext } from '../src/conversation/context.mjs';
import { SpeechGate } from '../public/speech-gate.js';

test('call boundaries persist and a new conversation excludes old messages without deleting them', () => {
  const state = mkdtempSync(join(tmpdir(), 'caller-lifecycle-')); mkdirSync(join(state, 'memory'));
  const store = new Store(join(state, 'state.sqlite'));
  const context = new ProjectContext(double<ConstructorParameters<typeof ProjectContext>[0]>({ state, store, backend: 't3', publish() {} }));
  try {
    const first = store.callStarted('t3', 'call-one');
    store.event('transcript', { backend: 't3', conversationId: first.conversationId, call: first.id, role: 'user', text: 'Tema anterior único' });
    const end = store.callEnded('t3', first.id, 'the user hung up'); context.rememberClose();
    assert.ok(end!.endedAt); assert.equal(store.callEnded('t3', first.id, 'Again'), null);
    const resumed = store.callStarted('t3', 'call-two');
    assert.equal(resumed.previousEndedAt, end!.endedAt);
    assert.match(context.resume(), /Tema anterior único/); assert.match(context.resume(), /previousEndedAt/);
    store.callEnded('t3', 'call-two', 'Hung up');
    const fresh = store.newConversation('t3');
    assert.notEqual(fresh.id, first.conversationId);
    assert.doesNotMatch(context.resume(), /Tema anterior único/);
    assert.equal(store.callEvents('t3', first.conversationId).events.length, 1, 'old messages stay stored');
  } finally { store.close(); rmSync(state, { recursive: true, force: true }); }
});

test('local speech protection ignores clicks and stays muted while stale remote speech continues', () => {
  const events: string[] = []; const gate = new SpeechGate({ onStart:()=>{ events.push('mute'); }, onEnd:()=>events.push('unmute') });
  gate.sample(0.1,0,100); gate.sample(0,0,140); assert.deepEqual(events, []);
  gate.sample(0.1,0.1,200); gate.sample(0.1,0.1,330); assert.deepEqual(events, ['mute']);
  gate.sample(0,0.1,1400); assert.deepEqual(events, ['mute']);
  gate.sample(0,0,1800); assert.deepEqual(events, ['mute','unmute']);
});

test('ordinary user speech does not suppress the fresh answer while waiting for output silence', () => {
  const events: string[] = []; const gate = new SpeechGate({ onStart: () => { events.push('mute'); return false; }, onEnd: () => events.push('unmute') });
  gate.sample(0.1,0,100); gate.sample(0.1,0,240);
  gate.sample(0,0.1,1000);
  assert.deepEqual(events,['mute','unmute']);
});

test('playback leakage and brief clicks do not take the floor, sustained louder speech does', () => {
  let starts = 0;
  const gate = new SpeechGate({ onStart: () => { starts++; }, onEnd() {} });
  for (let now = 0; now <= 2000; now += 40) gate.sample(0.035, 0.1, now);
  assert.equal(starts, 0);
  gate.sample(0.2, 0.1, 2040); gate.sample(0.01, 0.1, 2080);
  assert.equal(starts, 0);
  for (let now = 2120; now <= 2320; now += 40) gate.sample(0.12, 0.1, now);
  assert.equal(starts, 1);
});

test('automatic mute recovers during continuous remote output after the microphone is quiet', () => {
  const events: string[] = [];
  const gate = new SpeechGate({ onStart: () => { events.push('mute'); }, onEnd: () => events.push('unmute') });
  gate.sample(0.1, 0.1, 0); gate.sample(0.1, 0.1, 120);
  for (let now = 160; now <= 1400; now += 40) gate.sample(0, 0.1, now);
  assert.deepEqual(events, ['mute', 'unmute']);
  assert.equal(gate.speaking, false);
});

test('local speech detection only drives the indicator and records bounded events', async () => {
  const { PlaybackControl } = await import('../public/playback-control.js');
  const shown: boolean[] = [];
  const control = new PlaybackControl(speaking => shown.push(speaking));
  const gate = new SpeechGate({ onStart: () => control.automaticStart(), onEnd: () => control.end() });
  gate.sample(0.1, 0, 0); gate.sample(0.1, 0, 160);
  gate.sample(0, 0, 1600);
  assert.deepEqual(shown, [true, false]);
  assert.deepEqual(control.diagnostics().playbackEvents.map(e => e.kind), ['local_speech_start', 'local_speech_end']);
});
