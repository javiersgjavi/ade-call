declare global { interface Window { __testPeer: RTCPeerConnection; __voiceTranscript: string } }
// Explicit integration test. With TEST_VOICE=1 this uses the configured paid voice API.
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const base = process.env.CALLER_URL || 'http://127.0.0.1:8787';
const token = readFileSync(process.env.ACCESS_TOKEN_FILE || join(homedir(), '.config/ade-call/access-token'), 'utf8').trim();
const args = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'];
if (process.env.TEST_AUDIO_FILE) args.push(`--use-file-for-fake-audio-capture=${process.env.TEST_AUDIO_FILE}%noloop`);
if (process.env.CHROME_NO_SANDBOX === '1') args.push('--no-sandbox');
const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || undefined, headless: true, args });
const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1300, height: 950 }, permissions: ['microphone'] });
const page = await context.newPage();
const errors: string[] = []; let greeting = '';
page.on('pageerror', error => errors.push(error.message));
await page.addInitScript(() => {
  const Base = window.RTCPeerConnection;
  window.RTCPeerConnection = class extends Base { constructor(...args: ConstructorParameters<typeof RTCPeerConnection>) { super(...args); window.__testPeer = this; window.__voiceTranscript = ''; } createDataChannel(...args: Parameters<RTCPeerConnection['createDataChannel']>) { const c = super.createDataChannel(...args); c.addEventListener('message', e => { try { const m = JSON.parse(e.data); if (m.type === 'session.output_transcript.delta') window.__voiceTranscript += m.delta || ''; } catch { /* Best-effort cleanup or notification; lifecycle continues. */ } }); return c; } };
});
try {
  // The admin token as a Bearer header on every request of the page: no pairing code is used up.
  await context.setExtraHTTPHeaders({ Authorization: `Bearer ${token}` });
  assert.equal((await context.request.get(base + '/api/status')).status(), 200);
  await page.goto(base);
  await page.locator('#workspace').waitFor({ state: 'visible' });
  await page.locator('.project').first().waitFor();
  console.log('UI projects:', await page.locator('.project').count());
  if (process.env.TEST_VOICE === '1') {
    await page.locator('#call').click();
    await page.locator('#hangup').waitFor({ state: 'visible', timeout: 60_000 });
    await page.waitForFunction(() => document.getElementById('call-status')!.textContent!.includes('I\'m listening'), undefined, { timeout: 45_000 });
    console.log('Voice connected: GPT Realtime');
    if (process.env.TEST_GREETING === '1') {
      for (let attempt = 0; attempt < 30; attempt++) {
        greeting = await page.evaluate(() => window.__voiceTranscript || '');
        if (greeting.length > 100) break;
        await page.waitForTimeout(1000);
      }
      assert.ok(greeting.length > 30, 'Expected spoken greeting without a user request');
      console.log('Spoken greeting:', greeting);
    }
    if (process.env.TEST_AUDIO_FILE) {
      // The recorded question should get a spoken answer after the greeting.
      const start = (await page.evaluate(() => window.__voiceTranscript || '')).length;
      let answer = '';
      for (let attempt = 0; attempt < 60; attempt++) {
        answer = (await page.evaluate(() => window.__voiceTranscript || '')).slice(start);
        if (answer.length > 40 && (!process.env.EXPECTED_PROJECT || answer.includes(process.env.EXPECTED_PROJECT))) break;
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      console.log('Spoken answer:', answer.slice(0, 1500));
      assert.ok(answer.length > 40, 'No spoken answer within two minutes');
      if (process.env.EXPECTED_PROJECT) assert.ok(answer.includes(process.env.EXPECTED_PROJECT), 'Expected the project in the answer');
      const audioBytes = await page.evaluate(async () => {
        const stats = await window.__testPeer.getStats(); let bytes = 0;
        stats.forEach(s => { if (s.type === 'inbound-rtp' && s.kind === 'audio') bytes += s.bytesReceived || 0; }); return bytes;
      });
      console.log('Received audio bytes:', audioBytes); assert.ok(audioBytes > 0);
    }
    await page.locator('#hangup').click();
    await page.locator('#call').waitFor({ state: 'visible', timeout: 25_000 });
    console.log('Voice closed.');
  }
  await page.screenshot({ path: process.env.SCREENSHOT_FILE || '/tmp/ade-call.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log('Browser smoke test passed.');
} finally {
  const status = await (await context.request.get(base + '/api/status')).json().catch(() => ({}));
  for (const id of status.voiceActive || []) await context.request.post(base + '/api/live/close', { data: { id }, headers: { Origin: new URL(base).origin } });
  await browser.close();
}
