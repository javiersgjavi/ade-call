import { readFileSync } from 'node:fs';

// The text the models read lives in resources/ (see resources/README.md):
// system prompts, the ADE parts of the prompt, tool and parameter
// descriptions and the error messages tools return. The code only fills in
// {{placeholders}}; a missing or unknown placeholder fails loudly.

// Compiled to dist/src/resources.mjs, two levels below the repository root.
const dir = new URL('../../resources/', import.meta.url);
export const resourceText = (name: string) => readFileSync(new URL(name, dir), 'utf8');
const json = <T,>(name: string) => JSON.parse(resourceText(name)) as T;

export type Vars = Record<string, string | number>;
export function render(template: string, vars: Vars = {}, source = 'template') {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    if (!Object.hasOwn(vars, key)) throw new Error(`${source}: missing value for {{${key}}}.`);
    return String(vars[key]);
  });
}

// --- Prompts -----------------------------------------------------------------
let prompt: string | undefined;
export const systemPrompt = () => prompt ??= resourceText('system_prompt_voice.txt').trimEnd();
// The owner's custom instructions from Settings, under a fixed header
// (resources/custom_instructions.txt). The text is a value: it is not scanned for placeholders.
let customHeader: string | undefined;
export const customInstructionsText = (instructions: string) =>
  render(customHeader ??= resourceText('custom_instructions.txt').trimEnd(), { instructions }, 'custom_instructions.txt');

// The language and accent a call starts in (resources/voice_language.json):
// the one chosen in the settings, the browser's, or unknown; and the short
// reminder sent before each response the server requests.
export type VoiceLanguageText = 'settings' | 'browser' | 'unknown' | 'reminder';
let languageTexts: Record<VoiceLanguageText, string> | undefined;
export function voiceLanguageText(key: VoiceLanguageText, vars: Vars = {}) {
  languageTexts ??= json<Record<VoiceLanguageText, string>>('voice_language.json');
  const template = languageTexts[key];
  if (template === undefined) throw new Error(`voice_language.json: missing text ${key}.`);
  return render(template, vars, `voice_language.json ${key}`);
}

// ADE-specific parts of the system prompt, keyed by ADE id.
export interface AdePrompt { role: string; target: string; source: string; destination: string; evidence: string; limits: string; ids: string; search?: string }
export const adePrompt = (id: 't3' | 'orca') => json<Record<string, AdePrompt>>('ade_prompts.json')[id];

// The message T3 receives for each accepted send: to the project's main voice
// thread, or to an existing thread the user chose.
export function t3DeliveryPrompt(kind: 'main' | 'existing', vars: { reference: string; message: string }) {
  const name = `t3_delivery_prompt_${kind}.txt`;
  return render(resourceText(name).trimEnd(), vars, name);
}

// --- Tools -------------------------------------------------------------------
// resources/tools.json describes each tool like a docstring: its description
// and, per parameter, a JSON Schema (type, limits) plus `required`,
// `description` and an optional `example`. The example is shown to the model
// at the end of the description.
export interface ParameterSpec { type: string; description: string; required?: boolean; example?: unknown; [keyword: string]: unknown }
export interface ToolSpec { description: string; parameters: Record<string, ParameterSpec> }
type ToolSpecs = Record<string, ToolSpec> & { _orca_adapter: Record<string, ToolSpec> };
let tools: ToolSpecs | undefined;
export const toolSpecs = () => tools ??= json<ToolSpecs>('tools.json');

// A value that is exactly one placeholder ("maximum": "{{max}}") takes the
// value itself (a number stays a number); other strings are rendered as text.
function fill(value: unknown, vars: Vars, source: string): unknown {
  if (typeof value === 'string') {
    const only = /^\{\{(\w+)\}\}$/.exec(value);
    return only && Object.hasOwn(vars, only[1]) ? vars[only[1]] : render(value, vars, source);
  }
  if (Array.isArray(value)) return value.map(v => fill(v, vars, source));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, vars, source)]));
  return value;
}

// The description and the JSON Schema of a tool's parameters, as the model gets them.
export function toolSchema(name: string, vars: Vars = {}, group?: '_orca_adapter') {
  const specs = toolSpecs(), entry = (group ? specs[group] : specs)[name] as ToolSpec | undefined;
  if (!entry?.description) throw new Error(`tools.json: missing tool ${group ? `${group}.` : ''}${name}.`);
  const properties: Record<string, unknown> = {}, required: string[] = [];
  for (const [field, { required: needed, example, description, ...schema }] of Object.entries(entry.parameters)) {
    if (!description) throw new Error(`tools.json: missing description of ${name}.${field}.`);
    if (needed) required.push(field);
    const text = render(description, vars, `${name}.${field}`);
    properties[field] = { ...fill(schema, vars, `${name}.${field}`) as object, description: example === undefined ? text : `${text}. Example: ${JSON.stringify(example)}` };
  }
  return { description: render(entry.description, vars, name), parameters: { type: 'object', additionalProperties: false, required, properties } };
}

// --- Errors ------------------------------------------------------------------
let errors: Record<string, string> | undefined;
export function errorText(key: string, vars: Vars = {}) {
  errors ??= json<Record<string, string>>('error_messages.json');
  const template = errors[key];
  if (template === undefined) throw new Error(`error_messages.json: missing message ${key}.`);
  return render(template, vars, key);
}
