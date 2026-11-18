import type { VoiceSettingField } from '../src/shared/contracts.mjs';
import { t, locale, type MessageKey } from './i18n.js';

// The server-wide voice settings edited in Settings (GET/POST /api/settings/voice).
// The options come from the server; this only names them for people.
export const VOICE_FIELDS = ['model', 'reasoning', 'voice', 'eagerness', 'noiseReduction', 'transcriptionModel'] as const satisfies readonly VoiceSettingField[];
export type VoiceValues = Record<VoiceSettingField, string>;

// "gpt-realtime-2.1-mini" → "GPT Realtime 2.1 Mini": readable at a glance.
export const modelName = (id: string) => id.split('-').filter(Boolean).map(part => part === 'gpt' ? 'GPT' : part[0].toUpperCase() + part.slice(1)).join(' ');
const capital = (text: string) => text.charAt(0).toLocaleUpperCase(locale()) + text.slice(1);
const LABELS: Partial<Record<string, MessageKey>> = {
  'reasoning:minimal': 'reasoning.minimal', 'reasoning:low': 'reasoning.low', 'reasoning:medium': 'reasoning.medium', 'reasoning:high': 'reasoning.high', 'reasoning:xhigh': 'reasoning.xhigh',
  'eagerness:low': 'eagerness.low', 'eagerness:medium': 'eagerness.medium', 'eagerness:high': 'eagerness.high', 'eagerness:auto': 'eagerness.auto',
  'noiseReduction:near_field': 'noise.near', 'noiseReduction:far_field': 'noise.far', 'noiseReduction:off': 'noise.off',
  'transcriptionModel:gpt-4o-transcribe': 'transcription.full', 'transcriptionModel:gpt-4o-mini-transcribe': 'transcription.mini'
};
/** A readable name for an option; a value configured by hand keeps its identifier. */
export function optionLabel(field: VoiceSettingField, value: string) {
  const key = LABELS[`${field}:${value}`];
  if (key) return capital(t(key));
  if (field === 'model') return modelName(value);
  if (field === 'voice') return capital(value);
  return value;
}
