// Explicit integration check: synthetic tones, intercepted HTTP, temporary archive.
// Requires Playwright Chromium. Never contacts a provider or uses personal state.
import { chromium } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import assert from 'node:assert/strict';
import { Recordings } from '../src/voice/recordings.mjs';

const root = await mkdtemp(join(tmpdir(), 'recording-browser-'));
const archive = new Recordings(root);
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
try {
  const page = await browser.newPage(); const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/recordings') return route.fulfill({ json: { recordings: await archive.list('t3', 'fixture') } });
    if (url.pathname === '/api/recordings/part') {
      await archive.save(route.request().postDataJSON(), 't3', 'fixture', 'fixture');
      return route.fulfill({ json: { ok: true } });
    }
    if (url.pathname === '/fixture-audio') {
      const [info] = await archive.list('t3', 'fixture');
      return route.fulfill({ body: await readFile(join(root, info.id, 'audio.webm')), contentType: 'audio/webm' });
    }
    if (url.pathname.endsWith('.js')) return route.fulfill({ body: await readFile(new URL(`../public/${basename(url.pathname)}`, import.meta.url)), contentType: 'text/javascript' });
    return route.fulfill({ body: '<!doctype html><title>Recording fixture</title><input id="record-call" type="checkbox"><p id="recording-status"></p>', contentType: 'text/html' });
  });
  await page.goto('http://localhost/recording-fixture');
  const result = await page.evaluate(async () => {
    const { RecordingPanel } = await import('../public/recording-panel.js');
    const audio = new AudioContext(); await audio.resume();
    const mic = audio.createMediaStreamDestination(), remote = audio.createMediaStreamDestination();
    const low = audio.createOscillator(), high = audio.createOscillator();
    low.frequency.value = 440; high.frequency.value = 880; low.connect(mic); high.connect(remote); low.start(); high.start();
    const panel = new RecordingPanel(), options = { provider: 'realtime', backend: 't3', conversationId: 'fixture' };
    await panel.start(mic.stream, options);
    if (panel.current) throw new Error('Recording must be opt-in');
    panel.idle();
    const toggle = document.getElementById('record-call') as HTMLInputElement; toggle.checked = true;
    await panel.start(mic.stream, options);
    const recording = panel.current!;
    recording.remoteStream(remote.stream);
    recording.event('transcript', { role: 'user', text: 'Synthetic fixture' });
    await new Promise(resolve => setTimeout(resolve, 1200));
    mic.stream.getAudioTracks()[0].enabled = false; recording.event('microphone_muted', { value: true });
    await new Promise(resolve => setTimeout(resolve, 400));
    toggle.checked = false; toggle.dispatchEvent(new Event('change'));
    await recording.stop();
    const decoded = await audio.decodeAudioData(await (await fetch('/fixture-audio')).arrayBuffer());
    const power = (channel: number, frequency: number, offset: number) => {
      const samples = decoded.getChannelData(channel); let real = 0, imaginary = 0;
      for (let i = 0; i < 4096; i++) { const phase = 2 * Math.PI * frequency * i / decoded.sampleRate; const value = samples[offset + i] || 0; real += value * Math.cos(phase); imaginary += value * Math.sin(phase); }
      return real * real + imaginary * imaginary;
    };
    const offset = Math.floor(decoded.sampleRate * 0.4);
    const powers = [power(0, 440, offset), power(0, 880, offset), power(1, 440, offset), power(1, 880, offset)];
    const tail = Math.floor(decoded.sampleRate * 1.4);
    const mutedPower = power(0, 440, tail);
    low.stop(); high.stop(); await audio.close();
    return { status: document.getElementById('recording-status')!.textContent, channels: decoded.numberOfChannels, duration: decoded.duration, powers, mutedPower };
  });
  assert.deepEqual(errors, []); assert.match(result.status!, /saved on the server/);
  assert.equal(result.channels, 2); assert.ok(result.duration >= 1.5);
  assert.ok(result.powers[0] > result.powers[1] * 100, 'microphone stays on the left');
  assert.ok(result.powers[3] > result.powers[2] * 100, 'received audio stays on the right');
  assert.ok(result.mutedPower < result.powers[0] / 100, 'muting does not archive microphone speech');
  const [info] = await archive.list('t3', 'fixture');
  assert.equal(info.status, 'complete'); assert.equal(info.reason, 'disabled_by_user');
  const timeline = await readFile(join(root, info.id, 'timeline.jsonl'), 'utf8');
  assert.match(timeline, /Synthetic fixture/); assert.match(timeline, /microphone_muted/);
  console.log('Chromium: stereo audio, microphone mute, final chunk, server files and timeline verified with synthetic tones.');
} finally { await browser.close(); await rm(root, { recursive: true, force: true }); }
