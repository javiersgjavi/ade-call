import { readFileSync, writeFileSync, renameSync, rmSync, existsSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ENUMS, REALTIME_MODELS, type RealtimeSettings } from './realtime.mjs';

// The voice settings Settings can change, server-wide, and how config.json
// keeps them. The key is accepted here but never returned: callers only learn
// whether one is configured and where it comes from.
export type VoiceSettings = Required<RealtimeSettings>;
export type VoiceField = keyof VoiceSettings;
export const VOICE_FIELDS = ['model', 'voice', 'reasoning', 'eagerness', 'noiseReduction', 'transcriptionModel'] as const satisfies readonly VoiceField[];
// The config.json name of each field.
export const CONFIG_FIELDS: Record<VoiceField, string> = {
  model: 'realtimeModel', voice: 'realtimeVoice', reasoning: 'realtimeReasoning', eagerness: 'realtimeEagerness',
  noiseReduction: 'realtimeNoiseReduction', transcriptionModel: 'realtimeTranscriptionModel'
};
// Conservative lists: the voices OpenAI recommends for gpt-realtime and its
// two gpt-4o transcription models. A value configured by hand stays offered.
export const REALTIME_VOICES = ['marin', 'cedar'] as const;
export const TRANSCRIPTION_MODELS = ['gpt-4o-transcribe', 'gpt-4o-mini-transcribe'] as const;

/** The values each field accepts, given the settings in use (always offered). */
export function voiceOptions(current: VoiceSettings): Record<VoiceField, string[]> {
  const withCurrent = (list: readonly string[], value: string) => [...new Set([...list, value])];
  return {
    model: withCurrent(REALTIME_MODELS, current.model), voice: withCurrent(REALTIME_VOICES, current.voice),
    reasoning: [...ENUMS.reasoning], eagerness: [...ENUMS.eagerness], noiseReduction: [...ENUMS.noiseReduction],
    transcriptionModel: withCurrent(TRANSCRIPTION_MODELS, current.transcriptionModel)
  };
}

export class SettingsError extends Error {}

/** The settings after applying `input`, which may omit fields. Any unknown
 * field, non-string or value outside voiceOptions(current) is refused. */
export function validateVoiceSettings(input: unknown, current: VoiceSettings): VoiceSettings {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new SettingsError('The settings must be an object.');
  const options = voiceOptions(current), next = { ...current };
  for (const [field, value] of Object.entries(input)) {
    if (!(VOICE_FIELDS as readonly string[]).includes(field)) throw new SettingsError(`Unknown voice setting: ${field.slice(0, 40)}.`);
    const name = field as VoiceField;
    if (typeof value !== 'string' || !options[name].includes(value)) throw new SettingsError(`Invalid value for ${name}.`);
    next[name] = value;
  }
  return next;
}

/** A trimmed key, or a SettingsError that never quotes the input. */
export function validateKey(input: unknown) {
  if (typeof input !== 'string') throw new SettingsError('The API key must be text.');
  const key = input.trim();
  if (!key) throw new SettingsError('The API key is empty.');
  if (/\s/.test(key)) throw new SettingsError('The API key cannot contain spaces or line breaks.');
  if (key.length < 20 || key.length > 512) throw new SettingsError('The API key does not have a valid length.');
  if (!/^[\x21-\x7e]+$/.test(key)) throw new SettingsError('The API key contains characters that are not allowed.');
  return key;
}

export type Config = Record<string, unknown>;
export function readConfig(path: string): Config {
  if (!existsSync(path)) return {};
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new SettingsError('config.json does not contain a JSON object.');
  return parsed as Config;
}

/** Re-reads config.json, applies `changes` (undefined deletes a field) and
 * replaces it atomically with mode 0600. Unknown fields are kept as they are;
 * an unreadable file is never overwritten. */
export function updateConfig(path: string, changes: Record<string, string | undefined>) {
  let config: Config;
  try { config = readConfig(path); } catch { throw new SettingsError('config.json could not be read; it was not modified. Fix it by hand.'); }
  for (const [field, value] of Object.entries(changes)) { if (value === undefined) delete config[field]; else config[field] = value; }
  const temporary = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } catch {
    rmSync(temporary, { force: true });
    throw new SettingsError('config.json could not be saved.');
  }
  return config;
}
