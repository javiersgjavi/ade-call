import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { directInstructions, languageReminder, spokenLanguage } from '../src/direct/prompt.mjs';
import { t3DirectTools, T3_PROMPT } from '../src/direct/t3.mjs';
import { orcaDirectTools, ORCA_PROMPT } from '../src/direct/orca.mjs';
import { orcaTools } from '../src/adapters/orca/tools.mjs';
import { render, resourceText, t3DeliveryPrompt, toolSchema, toolSpecs, type ParameterSpec } from '../src/resources.mjs';

// The resources are read from the repository root, next to src/ (see resources/README.md).
const root = fileURLToPath(new URL('../../', import.meta.url));
const sources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
  .flatMap(e => e.isDirectory() ? sources(join(dir, e.name)) : e.name.endsWith('.mts') ? [readFileSync(join(dir, e.name), 'utf8')] : []);
const code = sources(join(root, 'src')).join('\n');
const errors = JSON.parse(resourceText('error_messages.json')) as Record<string, string>;

test('render fills every placeholder once and fails on a missing one', () => {
  assert.equal(render('{{a}} and {{b}}', { a: '{{b}}', b: 2 }), '{{b}} and 2');
  assert.throws(() => render('Hello {{name}}', {}, 'greeting'), /greeting: missing value for \{\{name\}\}/);
});

test('the voice system prompt renders completely for every ADE', () => {
  for (const [name, prompt, list] of [['T3', T3_PROMPT, t3DirectTools({ state: '/nonexistent' })], ['Orca', ORCA_PROMPT, orcaDirectTools({ state: '/nonexistent' })]] as const) {
    const text = directInstructions({ name, prompt, tools: list }, { callStart: { now: 'x' }, capabilities: { backend: name } });
    assert.doesNotMatch(text, /\{\{|\}\}/, name);
    assert.ok(text.includes(prompt.role) && text.includes(prompt.ids), name);
    assert.ok(text.endsWith(`ADE and capabilities: {"backend":"${name}"}`), name);
  }
  const delivery = t3DeliveryPrompt('main', { reference: 'Reference: x.', message: 'Use {{literal}}' });
  // The instructions are English but never fix the language of the call or of the threads.
  const voice = directInstructions({ name: 'T3', prompt: T3_PROMPT, tools: t3DirectTools({ state: '/nonexistent' }) });
  assert.match(voice, /^LANGUAGE: Until the user speaks, use the language of their latest words in the history, or English if there are none\. Speak each language with its native accent, stable from the first word to the last\./);
  assert.match(voice, /never changes your language or accent\. Speak the language the user speaks: switch only when they ask or say a complete request in another language, then answer that turn in it and keep it\. A name, greeting, filler or borrowed term is no reason to switch\./);
  assert.match(voice, /Write the message in the language the user is speaking to you; when continuing an existing thread written in another language, use the language of that thread\./);
  assert.match(voice, /Answer only the latest turn: a greeting, small talk or a question about you \("how are you\?"\) gets a brief, natural answer in kind, without tools/);
  assert.match(voice, /never guess one from the catalog/);
  assert.match(delivery, /Write in the language of the current request below, not in the language of these instructions\./);
  assert.match(t3DeliveryPrompt('existing', { reference: 'r', message: 'm' }), /Write in the language of this thread/);
  assert.ok(delivery.startsWith('Reference: x.\nYou are this project\'s main voice thread') && delivery.endsWith('\nUse {{literal}}'));
});

test('custom instructions go last, under the fixed header, and only when not blank', () => {
  const ade = { name: 'T3', prompt: T3_PROMPT, tools: t3DirectTools({ state: '/nonexistent' }) };
  const base = directInstructions(ade);
  for (const custom of [undefined, '', '  \n\t ']) assert.equal(directInstructions(ade, { custom }), base, JSON.stringify(custom));
  assert.doesNotMatch(base, /OWNER INSTRUCTIONS/);
  const text = directInstructions(ade, { custom: '  Tell me everything the agent says.\nUse {{literal}} braces.  ' });
  assert.ok(text.startsWith(`${base}\n\nOWNER INSTRUCTIONS:`), 'appended after the whole prompt');
  assert.ok(text.endsWith('\nTell me everything the agent says.\nUse {{literal}} braces.'), 'trimmed, and the text is never rendered as a template');
  assert.match(text, /never overrides SENDING/);
});

test('voice_language.json names any language and accent it is given, and every text is used', () => {
  const texts = JSON.parse(resourceText('voice_language.json')) as Record<string, string>;
  assert.deepEqual(Object.keys(texts).sort(), ['browser', 'reminder', 'settings', 'unknown']);
  for (const [tag, name, variety] of [['es-ES', 'Spanish', 'Spanish (Spain)'], ['ja', 'Japanese', 'Japanese'], ['en-AU', 'English', 'English (Australia)']])
    for (const source of ['settings', 'browser'] as const) {
      const line = spokenLanguage({ tag, source });
      assert.ok(line.includes(name) && line.includes(`native ${variety} accent`), line);
    }
  assert.doesNotMatch(spokenLanguage(), /Spanish|Japanese/, 'nothing invented without a language');
  assert.match(languageReminder(), /native accent/);
});

test('every error message key used in src exists, and every message is used', () => {
  // Keys appear literally: errorText('key') or as a ternary value passed to it.
  const used = new Set([...code.matchAll(/'((?:ids|send|release|document|t3|orca)\.[a-z_.]+)'/g)].map(m => m[1]));
  for (const key of used) assert.ok(Object.hasOwn(errors, key), `error_messages.json: missing ${key}`);
  for (const key of Object.keys(errors)) assert.ok(used.has(key), `error_messages.json: ${key} is unused`);
});

// An example must be a valid value for its own schema: the model copies its form.
function valid(spec: ParameterSpec, value: unknown): boolean {
  if (spec.type === 'string') return typeof value === 'string' && value.length >= ((spec.minLength as number) ?? 0);
  if (spec.type === 'integer') return Number.isInteger(value);
  if (spec.type === 'boolean') return typeof value === 'boolean';
  if (spec.type === 'array') return Array.isArray(value) && value.length <= ((spec.maxItems as number) ?? Infinity) && value.every(v => valid(spec.items as ParameterSpec, v));
  return false;
}

test('tools.json declares type, description and valid examples, and the offered tools are built from it', () => {
  const specs = toolSpecs();
  const groups = [Object.entries(specs).filter(([name]) => name !== '_orca_adapter'), Object.entries(specs._orca_adapter)];
  for (const [name, spec] of groups.flat()) for (const [field, p] of Object.entries(spec.parameters)) {
    assert.ok(['string', 'integer', 'boolean', 'array'].includes(p.type), `${name}.${field}: type`);
    assert.ok(p.description && p.description.length >= 8, `${name}.${field}: description`);
    if (p.example !== undefined) assert.ok(valid(p, p.example), `${name}.${field}: example ${JSON.stringify(p.example)}`);
  }
  const offered = [...t3DirectTools({ state: '/nonexistent' }), ...orcaDirectTools({ state: '/nonexistent' })];
  const key = (name: string) => name.endsWith('_read_document') ? 'read_document' : name;
  const vars = { max: 0, default: 0 };
  for (const tool of offered) {
    const built = toolSchema(key(tool.name), vars) as { description: string; parameters: { properties: Record<string, object> } };
    assert.deepEqual(Object.keys((tool.parameters as typeof built.parameters).properties), Object.keys(built.parameters.properties), tool.name);
    assert.equal(tool.description, built.description, tool.name);
  }
  const names = new Set(offered.map(t => key(t.name)));
  for (const name of Object.keys(specs)) if (name !== '_orca_adapter') assert.ok(names.has(name), `${name} is not offered`);
  for (const tool of orcaTools({ state: '/nonexistent' })) assert.ok(specs._orca_adapter[tool.name], tool.name);
  // Placeholders become numbers in the schema and text in the description; the example closes it.
  const read = toolSchema('t3_read_thread', { max: 50, default: 6 }).parameters.properties as Record<string, { maximum?: unknown; description: string }>;
  assert.equal(read.messages.maximum, 50);
  assert.equal(read.messages.description, 'How many messages (1-50; 6 by default)');
  assert.equal(read.threadId.description, 'Short thread ID, from the catalog or a search. Example: "7b2d40e9"');
});
