import type { VoiceSettingField } from '../src/shared/contracts.mjs';
import { t, locale, type MessageKey } from './i18n.js';

// The server-wide voice settings edited in Settings (GET/POST /api/settings/voice).
// The options come from the server; this only names them for people.
export const VOICE_FIELDS = ['model', 'reasoning', 'voice', 'geminiVoice', 'eagerness', 'noiseReduction', 'transcriptionModel'] as const satisfies readonly VoiceSettingField[];
export type VoiceValues = Record<VoiceSettingField, string>;

// "gpt-realtime-2.1-mini" → "GPT Realtime 2.1 Mini", "gemini-3.8-live" → "Gemini 3.8 Live": readable at a glance.
export const modelName = (id: string) => id.split('-').filter(Boolean).map(part => part === 'gpt' ? 'GPT' : part[0].toUpperCase() + part.slice(1)).join(' ');
// The provider a model runs on, as the server decides it (src/voice/gemini.mts isGeminiModel).
export const modelProvider = (model: string) => model.startsWith('gemini-') ? 'gemini' : 'realtime';
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
  if (field === 'voice' || field === 'geminiVoice') return capital(value);
  return value;
}

// Which server answer may fill the custom-instructions textarea. Its own
// counters, separate from the other settings: a voice or key save never
// cancels the load that brings the instructions, and never fills them itself.
// A load fills them only when the person is not editing, no instructions save
// started since the load began, and no later load has filled them already.
export class InstructionsSync {
  edited = false;
  private generation = 0; private loads = 0; private filled = 0;
  /** A settings load starts: its token. */
  loadStarted() { return { generation: this.generation, load: ++this.loads }; }
  /** That load's answer arrived: may it fill the textarea? */
  loadMayFill(token: { generation: number; load: number }) {
    if (this.edited || token.generation !== this.generation || token.load < this.filled) return false;
    this.filled = token.load; return true;
  }
  input() { this.edited = true; }
  /** Loads started before an instructions save may hold the old text. */
  saveStarted() { this.generation++; }
  /** Its answer is the saved text; loads started while it ran are dropped too. */
  saved() { this.generation++; this.edited = false; }
}
