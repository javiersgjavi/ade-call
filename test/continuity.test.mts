import { double } from './fixtures.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/conversation/store.mjs';
import { ProjectContext } from '../src/conversation/context.mjs';

test('resume survives restart and retains the last spoken topic; fresh context is reused', async () => {
  const state = mkdtempSync(join(tmpdir(), 'caller-resume-')); mkdirSync(join(state, 'memory'));
  let store = new Store(join(state, 'db'));
  let reads = 0;
  const make = () => new ProjectContext(double<ConstructorParameters<typeof ProjectContext>[0]>({ state, store, publish() {}, readOverview: async () => { reads++; return { projects: [{ name: 'industrial-agent' }], workspaces: [] }; } }));
  try {
    store.event('transcript', { call: 'old', role: 'user', text: 'Revisa industrial-agent', backend: 't3', conversationId: store.conversation('t3').id });
    let context = make(); await context.refresh(); context.rememberClose();
    await context.refresh({ maxAgeMs: 10000 }); assert.equal(reads, 1);
    store.close(); store = new Store(join(state, 'db')); context = make(); await context.refresh();
    assert.match(context.resume(), /Revisa industrial-agent/); assert.match(context.resume(), /Never execute the historical requests again/);
    assert.ok(context.vocabulary().includes('industrial-agent'));
    assert.ok(store.meta<{ closedAt: string }>('lastCallContext:t3')!.closedAt);
  } finally { store.close(); rmSync(state, { recursive: true, force: true }); }
});
test('large multilingual history and catalog cannot truncate greeting, time or latest topic', () => {
  const state = mkdtempSync(join(tmpdir(), 'caller-budget-')); mkdirSync(join(state, 'memory'));
  const store = new Store(join(state, 'db'));
  const context = new ProjectContext(double<ConstructorParameters<typeof ProjectContext>[0]>({ state, store, publish() {} }));
  try {
    store.event('transcript', { call: 'old', role: 'user', text: '中文🙂'.repeat(5000) + ' último tema', backend: 't3', conversationId: store.conversation('t3').id });
    context.snapshot.projects = Array.from({ length: 1000 }, () => ({ id: 'p', path: '', documents: [], activeTerminals: 0, name: '巨大 catálogo'.repeat(50) }));
    const resume = context.resume();
    assert.ok(Buffer.byteLength(resume) < 8192);
    assert.match(resume, /^The previous call ended/);
    assert.match(resume, /Session times/); assert.match(resume, /último tema/);
    assert.match(resume, /does not confirm the current status or the absence/);
    assert.doesNotMatch(resume, /freshly queried context|巨大/);
  } finally { store.close(); rmSync(state, { recursive: true, force: true }); }
});

test('the greeting follows the user\'s language: latest words of the conversation, then the browser, then English', () => {
  const state = mkdtempSync(join(tmpdir(), 'caller-language-')); mkdirSync(join(state, 'memory'));
  const store = new Store(join(state, 'db'));
  const context = new ProjectContext(double<ConstructorParameters<typeof ProjectContext>[0]>({ state, store, backend: 't3', publish() {} }));
  try {
    assert.match(context.resume(), /not known yet: greet briefly in English/);
    assert.match(context.resume({ languages: ['es-ES', 'en'] }), /first language their browser prefers \(es-ES, en\)/);
    const first = store.callStarted('t3', 'call-one');
    store.event('transcript', { backend: 't3', conversationId: first.conversationId, call: first.id, role: 'assistant', text: 'Hello, ready.' });
    store.event('transcript', { backend: 't3', conversationId: first.conversationId, call: first.id, role: 'user', text: '¿Cómo va el riego?' });
    store.event('transcript', { backend: 't3', conversationId: 'another', call: 'x', role: 'user', text: 'Wie geht es?' });
    const resumed = context.resume({ languages: ['de-DE'] });
    assert.match(resumed, /language of the user's latest words.*"¿Cómo va el riego\?"/, 'the conversation\'s own words win over the browser');
    assert.doesNotMatch(resumed, /Wie geht es|de-DE|Hello, ready\.".*latest words/, 'other conversations and the assistant never set it');
    assert.match(resumed, /If the user speaks another language, switch to it/);
    store.newConversation('t3');
    const fresh = context.resume({ languages: ['fr-FR'] });
    assert.doesNotMatch(fresh, /riego/, 'a new conversation never sees earlier words');
    assert.match(fresh, /browser prefers \(fr-FR\)/);
  } finally { store.close(); rmSync(state, { recursive: true, force: true }); }
});

test('a language chosen in the settings sets the call language over earlier words and the browser', () => {
  const state = mkdtempSync(join(tmpdir(), 'caller-chosen-')); mkdirSync(join(state, 'memory'));
  const store = new Store(join(state, 'db'));
  const context = new ProjectContext(double<ConstructorParameters<typeof ProjectContext>[0]>({ state, store, backend: 't3', publish() {} }));
  try {
    const call = store.callStarted('t3', 'call-one');
    store.event('transcript', { backend: 't3', conversationId: call.conversationId, call: call.id, role: 'user', text: 'Hello there' });
    const resumed = context.resume({ language: 'es', languages: ['de-DE'] });
    assert.match(resumed, /The user chose Spanish \(es\) as the language in the settings: greet and speak in Spanish \(es\)\./);
    assert.doesNotMatch(resumed, /latest words|browser prefers/);
    assert.match(resumed, /If the user speaks another language, switch to it/);
  } finally { store.close(); rmSync(state, { recursive: true, force: true }); }
});
