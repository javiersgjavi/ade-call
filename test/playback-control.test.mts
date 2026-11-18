import test from 'node:test';
import assert from 'node:assert/strict';
import { PlaybackControl } from '../public/playback-control.js';
import { SpeechGate } from '../public/speech-gate.js';
import { audioDiagnostics } from '../src/voice/diagnostics.mjs';

function playback() {
  const shown: boolean[] = [];
  const control = new PlaybackControl(speaking => shown.push(speaking));
  const gate = new SpeechGate({ onStart: () => control.automaticStart(), onEnd: () => control.end() });
  let now = 0;
  return { control, gate, shown, sample(mic: number, remote: number, duration = 40) { for (const until = now + duration; now < until;) { now += 40; gate.sample(mic, remote, now); } }, now: () => now };
}

test('microphone energy, echo and clicks only drive the indicator: the provider VAD cuts the voice', () => {
  const p = playback();
  p.sample(0.2, 0.1, 80); p.sample(0, 0.1, 400);
  p.sample(0.12, 0.1, 2000);
  p.sample(0, 0, 2000);
  assert.ok(p.shown.includes(true) && p.shown.at(-1) === false);
});

test('playback diagnostics are bounded and survive the server filter', () => {
  const p = playback();
  for (let i = 0; i < 30; i++) { p.control.automaticStart(); p.control.end(); }
  const diagnostics = p.control.diagnostics();
  assert.equal(diagnostics.playbackEvents.length, 20);
  assert.deepEqual(audioDiagnostics(diagnostics), diagnostics);
});
