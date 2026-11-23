import type { DirectAde } from './contract.mjs';
import { customInstructionsText, geminiPromptText, render, systemPrompt, voiceLanguageText } from '../resources.mjs';

// Names of the tools that change the ADE, as the instructions mention them.
export const sendingTools = (ade: Pick<DirectAde, 'tools'>) => ade.tools.filter(t => t.sends && !t.keepsAuthorization).map(t => t.name).join(' or ') || 'the sending tool';

// The language a call starts in: a BCP 47 tag and where it came from. The
// user can still switch during the call (the LANGUAGE rule).
export interface CallLanguage { tag: string; source: 'settings' | 'browser' }

// The chosen language (the page settings, usually a bare "es") wins; its
// accent takes the region of the browser's matching preference ("es-ES") when
// there is one. Without a choice, the browser's first preference.
export function callLanguage(chosen: string | undefined, browser: string[]): CallLanguage | undefined {
  if (chosen) {
    const primary = chosen.split('-')[0].toLowerCase();
    const regional = chosen.includes('-') ? undefined : browser.find(tag => tag.includes('-') && tag.split('-')[0].toLowerCase() === primary);
    return { tag: regional || chosen, source: 'settings' };
  }
  return browser[0] ? { tag: browser[0], source: 'browser' } : undefined;
}

function displayName(tag: string, standard: boolean) {
  try { return new Intl.DisplayNames(['en'], { type: 'language', ...(standard ? { languageDisplay: 'standard' as const } : {}) }).of(tag) || tag; } catch { return tag; }
}

// The first sentence of the LANGUAGE rule: "Spanish" to speak, "Spanish
// (Spain)" for the accent; English only while nothing is known.
export function spokenLanguage(language?: CallLanguage) {
  if (!language) return voiceLanguageText('unknown');
  return voiceLanguageText(language.source, { language: displayName(language.tag.split('-')[0], false), variety: displayName(language.tag, true) });
}

// Sent before each response the server asks for (tool results, notices, the
// greeting): long English data must not pull the voice's language or accent.
export const languageReminder = () => voiceLanguageText('reminder');

// Values known only when a session opens: the time context of a call, the
// ADE with its capabilities and the language the call starts in.
// custom: the owner's instructions from Settings; appended last, and only when not blank.
// provider: 'gemini' adds the Gemini part (resources/gemini_prompt.txt) before them.
export interface SessionValues { callStart?: unknown; capabilities?: unknown; language?: CallLanguage; custom?: string; provider?: 'realtime' | 'gemini' }

// The instructions of a voice call: resources/system_prompt_voice.txt
// filled with the ADE's own parts (resources/ade_prompts.json). The server
// checks remain the boundary; this only guides.
export function directInstructions(ade: Pick<DirectAde, 'name' | 'tools' | 'prompt'>, session: SessionValues = {}) {
  const p = ade.prompt, target = p.target;
  const text = render(systemPrompt(), {
    ade: ade.name, role: p.role, target, Target: target[0].toUpperCase() + target.slice(1), source: p.source || `the ${target}`,
    sending: sendingTools(ade), destination: p.destination, evidence: p.evidence, limits: p.limits, ids: p.ids, search: p.search ? ` ${p.search}` : '',
    spoken_language: spokenLanguage(session.language), call_start: JSON.stringify(session.callStart || {}), ade_capabilities: JSON.stringify(session.capabilities || {})
  }, 'system_prompt_voice.txt');
  const gemini = session.provider === 'gemini' ? `\n${geminiPromptText({ target, sending: sendingTools(ade) })}` : '';
  const custom = session.custom?.trim();
  return `${text}${gemini}${custom ? `\n\n${customInstructionsText(custom)}` : ''}`;
}
