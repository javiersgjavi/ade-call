import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateConfig, validateKey, validateVoiceSettings, voiceOptions, SettingsError } from '../src/voice/settings.mjs';
import { REALTIME_DEFAULTS } from '../src/voice/realtime.mjs';

test('voice settings accept only the offered values, and the current ones', () => {
  const current = { ...REALTIME_DEFAULTS, geminiVoice: 'Kore', voice: 'hand-picked', transcriptionModel: 'whisper-1' };
  assert.deepEqual(voiceOptions(current).voice, ['marin', 'cedar', 'hand-picked']);
  assert.deepEqual(validateVoiceSettings({ voice: 'hand-picked', transcriptionModel: 'gpt-4o-mini-transcribe' }, current), { ...current, transcriptionModel: 'gpt-4o-mini-transcribe' });
  assert.deepEqual(validateVoiceSettings({}, current), current);
  for (const bad of [null, [], 'low', { voice: 'alloy' }, { reasoning: '' }, { model: ['gpt-realtime-2.1'] }, JSON.parse('{"__proto__":"low"}'), { constructor: 'low' }])
    assert.throws(() => validateVoiceSettings(bad, current), SettingsError, JSON.stringify(bad));
});

test('Gemini Live models and voices are offered next to the Realtime ones', () => {
  const current = { ...REALTIME_DEFAULTS, geminiVoice: 'Kore' };
  assert.deepEqual(voiceOptions(current).model, ['gpt-realtime-2.1', 'gpt-realtime-2.1-mini', 'gemini-3.8-live', 'gemini-3.1-flash-live-preview']);
  assert.ok(voiceOptions(current).geminiVoice.includes('Puck'));
  assert.deepEqual(validateVoiceSettings({ model: 'gemini-3.8-live', geminiVoice: 'Puck' }, current), { ...current, model: 'gemini-3.8-live', geminiVoice: 'Puck' });
  for (const bad of [{ geminiVoice: 'marin' }, { voice: 'Kore' }, { model: 'gemini-made-up' }])
    assert.throws(() => validateVoiceSettings(bad, current), SettingsError, JSON.stringify(bad));
});

test('a key is trimmed and checked without quoting it', () => {
  assert.equal(validateKey('  sk-proj-abcdefghij_0123456789-XYZ \n'), 'sk-proj-abcdefghij_0123456789-XYZ');
  for (const bad of [undefined, null, 7, '', ' \t', 'sk-abc def-0123456789abcdef', 'sk-short', 'k'.repeat(513), 'sk-éééééééééééééééééééééé']) {
    assert.throws(() => validateKey(bad), (error: Error) => error instanceof SettingsError && (typeof bad !== 'string' || bad.trim().length < 6 || !error.message.includes(bad.trim().slice(0, 6))));
  }
});

test('config.json is replaced atomically with mode 0600, keeping unknown fields, and never overwritten when unreadable', t => {
  const dir = mkdtempSync(join(tmpdir(), 'ade-config-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.json');
  updateConfig(path, { realtimeVoice: 'cedar' });
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { realtimeVoice: 'cedar' }, 'created when missing');
  writeFileSync(path, JSON.stringify({ openaiKey: 'sk-old', other: { kept: true }, list: [1] }), { mode: 0o644 });
  updateConfig(path, { openaiKey: undefined, realtimeReasoning: 'high' });
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { other: { kept: true }, list: [1], realtimeReasoning: 'high' });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  writeFileSync(path, '{ "openaiKey": "sk-hand-edited", }');
  assert.throws(() => updateConfig(path, { realtimeVoice: 'marin' }), SettingsError);
  assert.equal(readFileSync(path, 'utf8'), '{ "openaiKey": "sk-hand-edited", }', 'an invalid file is left for the owner to fix');
  assert.deepEqual(readdirSync(dir), ['config.json'], 'no temporary file is left behind');
});
