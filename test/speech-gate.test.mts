import test from 'node:test';
import assert from 'node:assert/strict';
import { SpeechGate } from '../public/speech-gate.js';
import { audioDiagnostics } from '../src/voice/diagnostics.mjs';

// Regressions from the independent review: long speech with short pauses,
// a stationary noise floor and a delayed acoustic echo after each phrase.
function simulate(mic: (now: number, output: (time: number) => number, muted: boolean) => number, leadIn = 0) {
  let muted = false, starts = 0, ended = 0, current = 0, longest = 0;
  const gate = new SpeechGate({ onStart: () => { starts++; muted = true; return true; }, onEnd: () => { ended++; muted = false; } });
  const output = (time: number) => time >= leadIn && (time - leadIn) % 800 < 600 ? 0.1 : 0;
  for (let now = 0; now <= 20000; now += 40) {
    gate.sample(mic(now, output, muted), output(now), now);
    current = muted ? current + 40 : 0; longest = Math.max(longest, current);
  }
  return { gate, starts, ended, longest };
}

test('stationary noise cannot hold or repeatedly rearm an automatic mute', () => {
  for (const leadIn of [0, 5000]) {
    const result = simulate(() => 0.03, leadIn);
    assert.ok(result.starts <= 1); assert.equal(result.ended, result.starts);
    assert.ok(result.longest <= 1200); assert.equal(result.gate.speaking, false);
    assert.ok(result.gate.diagnostics(20000).localGateActiveMs <= 1200);
  }
  // Even sustained loud near-end energy cannot hold the automatic protection.
  // After this bound, conversational interruption belongs to the provider.
  const loud = simulate(() => 0.2);
  assert.equal(loud.starts, 1); assert.equal(loud.ended, 1);
  assert.equal(loud.longest, 1200); assert.equal(loud.gate.diagnostics(20000).localGateTimeouts, 1);
});

test('delayed moderate echo in phrase gaps does not trigger automatic muting', () => {
  for (const delay of [80, 160, 280]) for (const gain of [0.3, 0.5]) {
    const result = simulate((now, output, muted) => muted ? 0 : output(now - delay) * gain);
    assert.equal(result.starts, 0, `echo delay ${delay} ms, gain ${gain}`);
    assert.equal(result.gate.diagnostics(20000).localGateActiveMs, 0);
  }
});

test('a new sustained user intervention can interrupt after rearming, and brief clicks cannot extend lastVoice', () => {
  let starts = 0;
  const gate = new SpeechGate({ onStart: () => { starts++; }, onEnd() {} });
  gate.sample(0.2, 0.1, 0); gate.sample(0.2, 0.1, 120);
  gate.sample(0, 0.1, 160); gate.sample(0.2, 0.1, 400); gate.sample(0, 0.1, 440);
  assert.equal(gate.lastVoice, 120, 'one loud sample is not sustained speech');
  gate.sample(0.2, 0.1, 1320); assert.equal(gate.speaking, false);
  gate.sample(0.2, 0.1, 1600); assert.equal(starts, 1, 'noise above the mic floor cannot rearm');
  for (let now = 1640; now <= 2040; now += 40) gate.sample(0, 0.1, now);
  gate.sample(0.2, 0.1, 2080); gate.sample(0.2, 0.1, 2200);
  assert.equal(starts, 2); assert.equal(gate.speaking, true);
});

test('gate counters retain complete and ongoing automatic activations', () => {
  const gate = new SpeechGate({ onStart() {}, onEnd() {} });
  gate.sample(0.1, 0.1, 0); gate.sample(0.1, 0.1, 120);
  assert.deepEqual(gate.diagnostics(620), { localGateActivations: 1, localGateActiveMs: 500, localGateTimeouts: 0 });
  for (let now = 640; now <= 1400; now += 40) gate.sample(0, 0, now);
  assert.equal(gate.speaking, false);
  const { localGateActiveMs } = gate.diagnostics(1400);
  assert.ok(localGateActiveMs > 500 && localGateActiveMs <= 1200);
  assert.equal(gate.diagnostics(6000).localGateActiveMs, localGateActiveMs);
  assert.deepEqual(audioDiagnostics(gate.diagnostics(6000)), gate.diagnostics(6000));
  assert.deepEqual(audioDiagnostics({ localGateActivations: -1, localGateActiveMs: Infinity, localGateTimeouts: 'secret' }), {});
});
