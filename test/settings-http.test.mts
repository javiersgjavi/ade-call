import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';

// Settings → Voice and OpenAI API key, against an isolated server with no
// provider: nothing here reaches OpenAI. The keys are invented.
test('voice settings and the OpenAI key: authenticated, validated, saved atomically and never returned', async t => {
  const tmp = mkdtempSync(join(tmpdir(), 'ade-settings-http-'));
  const listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = (listener.address() as net.AddressInfo).port; await new Promise(resolve => listener.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const envKey = 'sk-test-environment-0123456789abcdef', savedKey = 'sk-test-saved-key-ABCDEFGHIJ0123456789';
  const configDir = join(tmp, 'config'), configPath = join(configDir, 'config.json');
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  // Hand-written fields the page does not know stay as they are.
  writeFileSync(configPath, JSON.stringify({ realtimeModel: 'gpt-realtime-2', realtimeReasoning: 'medium', geminiKey: 'legacy-value', custom: { nested: [1, 2] } }), { mode: 0o644 });
  const env = { ...process.env, PORT: String(port), ADE_CALL_HOST: '127.0.0.1', ADE_CALL_CONFIG: configDir, ADE_CALL_STATE: join(tmp, 'state'), T3CODE_HOME: join(tmp, 't3'), T3_BIN: join(tmp, 'missing-t3'), ORCA_BIN: join(tmp, 'missing-orca'), OPENAI_API_KEY: envKey };
  let child: ChildProcess | undefined, output = '';
  const stop = async () => { if (child && child.exitCode === null) { child.kill(); await once(child, 'exit'); } };
  const start = async (extra: Record<string, string> = {}) => {
    child = spawn(process.execPath, ['dist/src/server.mjs'], { env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout!.on('data', chunk => { output += chunk; }); child.stderr!.on('data', chunk => { output += chunk; });
    await Promise.race([once(child.stdout!, 'data'), new Promise((_, reject) => setTimeout(() => reject(new Error('Startup failed')), 5000).unref())]);
  };
  t.after(async () => { await stop(); rmSync(tmp, { recursive: true, force: true }); });
  await start();
  const token = readFileSync(join(configDir, 'access-token'), 'utf8');
  const bearer = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const responses: string[] = [];
  const call = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(base + path, init); const text = await response.text(); responses.push(text);
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  const post = (path: string, data: unknown, headers: Record<string, string> = bearer) => call(path, { method: 'POST', headers, body: typeof data === 'string' ? data : JSON.stringify(data) });
  const config = () => JSON.parse(readFileSync(configPath, 'utf8'));

  // Authentication and origin, as for every other API route.
  assert.equal((await call('/api/settings/voice')).status, 401);
  assert.equal((await post('/api/settings/voice', { reasoning: 'high' }, { 'Content-Type': 'application/json' })).status, 401);
  assert.equal((await post('/api/settings/key', { key: savedKey }, { 'Content-Type': 'application/json' })).status, 401);
  assert.equal((await post('/api/settings/voice', { reasoning: 'high' }, { ...bearer, Origin: 'https://attacker.invalid' })).status, 403);
  assert.equal((await post('/api/settings/key', { key: savedKey }, { ...bearer, Origin: 'https://attacker.invalid' })).status, 403);
  // A paired browser's cookie needs this installation's Origin on a POST.
  const invite = JSON.parse(execFileSync(process.execPath, ['dist/scripts/access.mjs', 'pair', '--url', base, '--name', 'Settings test'], { env, encoding: 'utf8' }));
  const paired = await fetch(base + '/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ code: invite.code }) });
  const cookie = paired.headers.get('set-cookie')!.split(';')[0];
  assert.equal((await post('/api/settings/voice', { reasoning: 'high' }, { Cookie: cookie, 'Content-Type': 'application/json' })).status, 403, 'a cookie without Origin');
  assert.equal((await call('/api/settings/voice', { headers: { Cookie: cookie } })).status, 200);
  assert.equal(config().realtimeReasoning, 'medium', 'nothing was saved by refused requests');

  // Current values, the options of each one and where the key comes from.
  const initial = await call('/api/settings/voice', { headers: bearer });
  assert.equal(initial.status, 200);
  assert.deepEqual(initial.body.settings, { model: 'gpt-realtime-2', voice: 'marin', reasoning: 'medium', eagerness: 'low', noiseReduction: 'near_field', transcriptionModel: 'gpt-4o-transcribe' });
  assert.deepEqual(initial.body.options.model, ['gpt-realtime-2.1', 'gpt-realtime-2.1-mini', 'gpt-realtime-2'], 'a hand-configured model stays offered');
  assert.deepEqual(initial.body.options.voice, ['marin', 'cedar']);
  assert.deepEqual(initial.body.options.transcriptionModel, ['gpt-4o-transcribe', 'gpt-4o-mini-transcribe']);
  assert.deepEqual(initial.body.options.reasoning, ['minimal', 'low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(initial.body.key, { set: true, source: 'env' });
  assert.equal(initial.body.busy, false);
  assert.equal((await call('/api/status', { headers: bearer })).body.voiceReady, true, 'OPENAI_API_KEY from the environment');

  // Strict validation: unknown fields, other types and values outside the lists.
  for (const bad of [{ model: 'gpt-4o-unlisted' }, { voice: 'nova' }, { reasoning: 'extreme' }, { eagerness: 'eager' }, { noiseReduction: 'loud' }, { transcriptionModel: 'whisper-2' }, { reasoning: 3 }, { apiKey: 'x' }, ['reasoning'], 'null'])
    assert.equal((await post('/api/settings/voice', bad)).status, 400, JSON.stringify(bad));
  assert.equal(config().realtimeReasoning, 'medium', 'a refused change saves nothing');

  const saved = await post('/api/settings/voice', { model: 'gpt-realtime-2.1-mini', reasoning: 'high', voice: 'cedar', eagerness: 'medium', noiseReduction: 'far_field', transcriptionModel: 'gpt-4o-mini-transcribe' });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.settings, { model: 'gpt-realtime-2.1-mini', voice: 'cedar', reasoning: 'high', eagerness: 'medium', noiseReduction: 'far_field', transcriptionModel: 'gpt-4o-mini-transcribe' });
  assert.deepEqual(saved.body.options.model, ['gpt-realtime-2.1', 'gpt-realtime-2.1-mini'], 'the earlier hand-configured model is no longer current');
  const status = (await call('/api/status', { headers: bearer })).body;
  assert.deepEqual(status.voiceModel, { model: 'gpt-realtime-2.1-mini', reasoning: 'high', eagerness: 'medium', noiseReduction: 'far_field', voice: 'cedar' }, 'applied without a restart');
  assert.deepEqual((await call('/api/status?backend=orca', { headers: bearer })).body.voiceModel.model, 'gpt-realtime-2.1-mini', 'the same for every ADE');
  assert.deepEqual(config(), { realtimeModel: 'gpt-realtime-2.1-mini', realtimeReasoning: 'high', geminiKey: 'legacy-value', custom: { nested: [1, 2] }, realtimeVoice: 'cedar', realtimeEagerness: 'medium', realtimeNoiseReduction: 'far_field', realtimeTranscriptionModel: 'gpt-4o-mini-transcribe' });
  assert.equal(statSync(configPath).mode & 0o777, 0o600);
  assert.equal((await post('/api/settings/voice', { reasoning: 'low' })).body.settings.model, 'gpt-realtime-2.1-mini', 'a partial change keeps the rest');

  // The key: format checks that never quote it, a saved key over the environment, removal.
  for (const bad of [{ key: '' }, { key: '   ' }, { key: 'sk-has space inside-0123456789' }, { key: 'sk-short' }, { key: 'x'.repeat(513) }, { key: 42 }, { key: 'sk-ñññññññññññññññññññññññ' }, {}]) {
    const refused = await post('/api/settings/key', bad), value = (bad as { key?: unknown }).key;
    assert.equal(refused.status, 400, JSON.stringify(bad).slice(0, 40));
    if (typeof value === 'string' && value.trim()) assert.ok(!JSON.stringify(refused.body).includes(value.trim().slice(3, 12)), 'the error does not quote the key');
  }
  const broken = await post('/api/settings/key', `{"key": "${savedKey}`);
  assert.equal(broken.status, 400); assert.deepEqual(broken.body, { error: 'Invalid request.' }, 'a malformed body is not echoed');
  const set = await post('/api/settings/key', { key: `  ${savedKey}\n` });
  assert.equal(set.status, 200); assert.deepEqual(set.body.key, { set: true, source: 'config' });
  assert.equal(config().openaiKey, savedKey, 'trimmed'); assert.equal(config().geminiKey, 'legacy-value');
  assert.equal(statSync(configPath).mode & 0o777, 0o600);
  const removed = await post('/api/settings/key', { key: null });
  assert.deepEqual(removed.body.key, { set: true, source: 'env' }, 'the environment key is used again');
  assert.equal('openaiKey' in config(), false);

  // Without OPENAI_API_KEY: the saved key alone decides whether voice is ready.
  await stop(); await start({ OPENAI_API_KEY: '' });
  assert.deepEqual((await call('/api/settings/voice', { headers: bearer })).body.key, { set: false, source: null });
  assert.equal((await call('/api/status', { headers: bearer })).body.voiceReady, false);
  assert.equal((await post('/api/settings/key', { key: savedKey })).status, 200);
  assert.equal((await call('/api/status', { headers: bearer })).body.voiceReady, true, 'the key applies without a restart');
  assert.deepEqual((await call('/api/settings/voice', { headers: bearer })).body.settings.reasoning, 'low', 'the saved settings are read at startup');
  await stop(); await start({ OPENAI_API_KEY: '' });
  assert.deepEqual((await call('/api/settings/voice', { headers: bearer })).body.key, { set: true, source: 'config' }, 'the saved key survives a restart');
  assert.equal((await post('/api/settings/key', { key: null })).status, 200);
  assert.equal((await call('/api/status', { headers: bearer })).body.voiceReady, false);

  // No response or log line ever carries either key, or a fragment of it.
  for (const secret of [savedKey, envKey]) for (const text of [...responses, output]) {
    assert.ok(!text.includes(secret.slice(8)), 'a key fragment was returned or logged');
  }
});
