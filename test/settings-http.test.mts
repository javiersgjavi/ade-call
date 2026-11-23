import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import http from 'node:http';
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Settings → Voice and OpenAI API key, against an isolated server with no
// provider: nothing here reaches OpenAI. The keys are invented.
test('voice settings and the OpenAI key: authenticated, validated, saved atomically and never returned', async t => {
  const tmp = mkdtempSync(join(tmpdir(), 'ade-settings-http-'));
  const listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = (listener.address() as net.AddressInfo).port; await new Promise(resolve => listener.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const envKey = 'sk-test-environment-0123456789abcdef', savedKey = 'sk-test-saved-key-ABCDEFGHIJ0123456789', geminiKey = 'AIzaTestGeminiKey-0123456789abcdefghijk', elevenKey = 'sk_test_elevenlabs_0123456789abcdefghij';
  const configDir = join(tmp, 'config'), configPath = join(configDir, 'config.json');
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  // Hand-written fields the page does not know stay as they are.
  writeFileSync(configPath, JSON.stringify({ realtimeModel: 'gpt-realtime-2', realtimeReasoning: 'medium', otherTool: 'legacy-value', custom: { nested: [1, 2] } }), { mode: 0o644 });
  const env = { ...process.env, PORT: String(port), ADE_CALL_HOST: '127.0.0.1', ADE_CALL_CONFIG: configDir, ADE_CALL_STATE: join(tmp, 'state'), T3CODE_HOME: join(tmp, 't3'), T3_BIN: join(tmp, 'missing-t3'), ORCA_BIN: join(tmp, 'missing-orca'), OPENAI_API_KEY: envKey, GEMINI_API_KEY: '', GOOGLE_API_KEY: '', ELEVENLABS_API_KEY: '' };
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
  assert.deepEqual(initial.body.settings, { model: 'gpt-realtime-2', voice: 'marin', reasoning: 'medium', eagerness: 'low', noiseReduction: 'near_field', transcriptionModel: 'gpt-4o-transcribe', geminiVoice: 'Kore', elevenlabsLlm: 'claude-haiku-5-5', elevenlabsVoice: 'Sarah' });
  assert.deepEqual(initial.body.options.model, ['gpt-realtime-2.1', 'gpt-realtime-2.1-mini', 'gemini-3.8-live', 'elevenlabs-agents', 'gpt-realtime-2'], 'a hand-configured model stays offered');
  assert.deepEqual(initial.body.options.voice, ['marin', 'cedar']);
  assert.deepEqual(initial.body.options.transcriptionModel, ['gpt-4o-transcribe', 'gpt-4o-mini-transcribe']);
  assert.deepEqual(initial.body.options.reasoning, ['minimal', 'low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(initial.body.key, { set: true, source: 'env' });
  assert.deepEqual(initial.body.geminiKey, { set: false, source: null }); assert.deepEqual(initial.body.elevenlabsKey, { set: false, source: null }); assert.equal(initial.body.provider, 'realtime');
  assert.equal(initial.body.busy, false);
  assert.equal((await call('/api/status', { headers: bearer })).body.voiceReady, true, 'OPENAI_API_KEY from the environment');

  // Strict validation: unknown fields, other types and values outside the lists.
  for (const bad of [{ model: 'gpt-4o-unlisted' }, { voice: 'nova' }, { reasoning: 'extreme' }, { eagerness: 'eager' }, { noiseReduction: 'loud' }, { transcriptionModel: 'whisper-2' }, { reasoning: 3 }, { apiKey: 'x' }, ['reasoning'], 'null'])
    assert.equal((await post('/api/settings/voice', bad)).status, 400, JSON.stringify(bad));
  assert.equal(config().realtimeReasoning, 'medium', 'a refused change saves nothing');

  const saved = await post('/api/settings/voice', { model: 'gpt-realtime-2.1-mini', reasoning: 'high', voice: 'cedar', eagerness: 'medium', noiseReduction: 'far_field', transcriptionModel: 'gpt-4o-mini-transcribe' });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.settings, { model: 'gpt-realtime-2.1-mini', voice: 'cedar', reasoning: 'high', eagerness: 'medium', noiseReduction: 'far_field', transcriptionModel: 'gpt-4o-mini-transcribe', geminiVoice: 'Kore', elevenlabsLlm: 'claude-haiku-5-5', elevenlabsVoice: 'Sarah' });
  assert.deepEqual(saved.body.options.model, ['gpt-realtime-2.1', 'gpt-realtime-2.1-mini', 'gemini-3.8-live', 'elevenlabs-agents'], 'the earlier hand-configured model is no longer current');
  const status = (await call('/api/status', { headers: bearer })).body;
  assert.deepEqual(status.voiceModel, { provider: 'realtime', model: 'gpt-realtime-2.1-mini', reasoning: 'high', eagerness: 'medium', noiseReduction: 'far_field', voice: 'cedar' }, 'applied without a restart');
  assert.deepEqual((await call('/api/status?backend=orca', { headers: bearer })).body.voiceModel.model, 'gpt-realtime-2.1-mini', 'the same for every ADE');
  assert.deepEqual(config(), { realtimeModel: 'gpt-realtime-2.1-mini', realtimeReasoning: 'high', otherTool: 'legacy-value', custom: { nested: [1, 2] }, realtimeVoice: 'cedar', realtimeEagerness: 'medium', realtimeNoiseReduction: 'far_field', realtimeTranscriptionModel: 'gpt-4o-mini-transcribe' });
  assert.equal(statSync(configPath).mode & 0o777, 0o600);
  assert.equal((await post('/api/settings/voice', { reasoning: 'low' })).body.settings.model, 'gpt-realtime-2.1-mini', 'a partial change keeps the rest');

  // Custom instructions: authenticated, validated, saved as customInstructions and removed when empty.
  assert.equal((await post('/api/settings/instructions', { instructions: 'x' }, { 'Content-Type': 'application/json' })).status, 401);
  assert.equal((await post('/api/settings/instructions', { instructions: 'x' }, { ...bearer, Origin: 'https://attacker.invalid' })).status, 403);
  assert.equal((await call('/api/settings/voice', { headers: bearer })).body.instructions, '');
  assert.equal((await call('/api/settings/voice', { headers: bearer })).body.instructionsMax, 4000);
  for (const bad of [{}, { instructions: 3 }, { instructions: ['a'] }, { instructions: 'a', extra: 1 }, { instructions: 'x'.repeat(4001) }, { instructions: 'bell\u0007' }])
    assert.equal((await post('/api/settings/instructions', bad)).status, 400, JSON.stringify(bad).slice(0, 40));
  assert.equal('customInstructions' in config(), false, 'a refused change saves nothing');
  const instructions = await post('/api/settings/instructions', { instructions: '  Tell me everything the agent says.\r\nIn full.  ' });
  assert.equal(instructions.status, 200);
  assert.equal(instructions.body.instructions, 'Tell me everything the agent says.\nIn full.');
  assert.equal(config().customInstructions, 'Tell me everything the agent says.\nIn full.');
  assert.equal(config().realtimeModel, 'gpt-realtime-2.1-mini', 'the other fields stay');
  assert.equal(statSync(configPath).mode & 0o777, 0o600);
  assert.equal((await post('/api/settings/instructions', { instructions: 'x'.repeat(4000) })).status, 200, 'the maximum is accepted');
  // Text pasted with spaces around it counts after trimming: nothing is cut.
  assert.equal((await post('/api/settings/instructions', { instructions: ` ${'y'.repeat(4000)}\n` })).body.instructions, 'y'.repeat(4000));
  assert.equal(config().customInstructions, 'y'.repeat(4000));
  assert.equal((await post('/api/settings/instructions', { instructions: '  \n ' })).body.instructions, '', 'blank removes them');
  assert.equal('customInstructions' in config(), false);
  assert.equal((await post('/api/settings/instructions', { instructions: 'Keep agent answers complete.' })).status, 200);
  // A control character is refused, never trimmed into a removal: the saved text stays.
  for (const bad of ['\r', 'a\rb', '\u000b', 'A\u0085B', '\u001f', 'tab\tok but bell\u0007'])
    assert.equal((await post('/api/settings/instructions', { instructions: bad })).status, 400, JSON.stringify(bad));
  assert.equal(config().customInstructions, 'Keep agent answers complete.');
  assert.equal((await call('/api/settings/voice', { headers: bearer })).body.instructions, 'Keep agent answers complete.');

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
  assert.equal(config().openaiKey, savedKey, 'trimmed'); assert.equal(config().otherTool, 'legacy-value');
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
  assert.equal((await call('/api/settings/voice', { headers: bearer })).body.instructions, 'Keep agent answers complete.', 'the instructions are read at startup');
  assert.equal((await post('/api/settings/instructions', { instructions: null })).status, 200);
  assert.equal('customInstructions' in config(), false, 'null removes them');
  await stop(); await start({ OPENAI_API_KEY: '' });
  assert.deepEqual((await call('/api/settings/voice', { headers: bearer })).body.key, { set: true, source: 'config' }, 'the saved key survives a restart');
  assert.equal((await post('/api/settings/key', { key: null })).status, 200);
  assert.equal((await call('/api/status', { headers: bearer })).body.voiceReady, false);

  // Gemini Live: the model picks the provider, and its own key decides whether voice is ready.
  assert.equal((await post('/api/settings/key', { provider: 'other', key: geminiKey })).status, 400);
  // A call request still arriving while Settings switches the provider is refused, not opened on the old one.
  const prefix = '{"provider":"realtime","backend":"t3","sdp":"v=0';
  let finishLive!: () => void;
  const pending = new Promise<{ status: number; body: string }>(resolve => {
    const request = http.request(base + '/api/live', { method: 'POST', headers: { ...bearer, 'Content-Length': '200' } }, response => {
      let text = ''; response.on('data', chunk => { text += chunk; }); response.on('end', () => resolve({ status: response.statusCode || 0, body: text }));
    });
    request.write(prefix);
    finishLive = () => request.end('"'.padEnd(200 - prefix.length - 1, ' ') + '}');
  });
  await wait(100);
  const gemini = await post('/api/settings/voice', { model: 'gemini-3.8-live', geminiVoice: 'Puck' });
  finishLive();
  const late = await pending;
  assert.equal(late.status, 409, late.body); assert.match(late.body, /voice model has changed/);
  assert.equal(gemini.status, 200); assert.equal(gemini.body.provider, 'gemini');
  let geminiStatus = (await call('/api/status', { headers: bearer })).body;
  assert.equal(geminiStatus.voiceReady, false, 'no Gemini key yet'); assert.equal(geminiStatus.voiceModel.provider, 'gemini'); assert.equal(geminiStatus.voiceModel.voice, 'Puck');
  const geminiSet = await post('/api/settings/key', { provider: 'gemini', key: geminiKey });
  assert.equal(geminiSet.status, 200); assert.deepEqual(geminiSet.body.geminiKey, { set: true, source: 'config' }); assert.deepEqual(geminiSet.body.key, { set: false, source: null }, 'the OpenAI key is separate');
  assert.equal(config().geminiKey, geminiKey); assert.equal(config().realtimeModel, 'gemini-3.8-live'); assert.equal(config().geminiVoice, 'Puck');
  geminiStatus = (await call('/api/status', { headers: bearer })).body;
  assert.equal(geminiStatus.voiceReady, true, 'the Gemini key applies without a restart');
  // The audio socket of a relayed call follows the API's authentication.
  const upgrade = (headers: Record<string, string>) => new Promise<number>(resolve => {
    const request = http.get(base + '/api/live/stream?id=gem_none', { headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', ...headers } });
    request.on('response', response => { response.resume(); resolve(response.statusCode || 0); });
    request.on('upgrade', (_response, socket) => { socket.destroy(); resolve(101); });
    request.on('error', () => resolve(0));
  });
  assert.equal(await upgrade({}), 401);
  assert.equal(await upgrade({ Cookie: cookie, Origin: 'https://attacker.invalid' }), 403);
  assert.equal(await upgrade({ Cookie: cookie }), 403, 'a browser cookie without Origin');
  assert.equal(await upgrade({ Cookie: cookie, Origin: base }), 404, 'no such call');
  assert.equal((await post('/api/settings/key', { provider: 'gemini', key: null })).status, 200);
  assert.equal('geminiKey' in config(), false);
  assert.equal((await call('/api/status', { headers: bearer })).body.voiceReady, false);

  // ElevenLabs Agents: its model, LLM, voice and key, the same way.
  const eleven = await post('/api/settings/voice', { model: 'elevenlabs-agents', elevenlabsLlm: 'claude-haiku-5-5', elevenlabsVoice: 'George' });
  assert.equal(eleven.status, 200); assert.equal(eleven.body.provider, 'elevenlabs');
  let elevenStatus = (await call('/api/status', { headers: bearer })).body;
  assert.equal(elevenStatus.voiceReady, false, 'no ElevenLabs key yet');
  assert.deepEqual([elevenStatus.voiceModel.provider, elevenStatus.voiceModel.voice, elevenStatus.voiceModel.llm], ['elevenlabs', 'George', 'claude-haiku-5-5']);
  const elevenSet = await post('/api/settings/key', { provider: 'elevenlabs', key: elevenKey });
  assert.equal(elevenSet.status, 200); assert.deepEqual(elevenSet.body.elevenlabsKey, { set: true, source: 'config' }); assert.deepEqual(elevenSet.body.geminiKey, { set: false, source: null }, 'each key is separate');
  assert.equal(config().elevenlabsKey, elevenKey); assert.equal(config().elevenlabsLlm, 'claude-haiku-5-5'); assert.equal(config().elevenlabsVoice, 'George');
  elevenStatus = (await call('/api/status', { headers: bearer })).body;
  assert.equal(elevenStatus.voiceReady, true, 'the ElevenLabs key applies without a restart');
  assert.equal((await post('/api/settings/key', { provider: 'elevenlabs', key: null })).status, 200);
  assert.equal('elevenlabsKey' in config(), false);

  // No response or log line ever carries any key, or a fragment of it.
  for (const secret of [savedKey, envKey, geminiKey, elevenKey]) for (const text of [...responses, output]) {
    assert.ok(!text.includes(secret.slice(8)), 'a key fragment was returned or logged');
  }
});
