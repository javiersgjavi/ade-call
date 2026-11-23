import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { SOUNDS, play } from '../public/sounds.js';
import { t, locale, language, isMessageKey, dictionaries, localize, pickLanguage, translatePage, DEFAULT_LANGUAGE, storedPreference, storePreference, voiceLanguages, PREFERENCE_KEY, type MessageKey } from '../public/i18n.js';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]));
const tag = (id: string) => html.match(new RegExp(`<[a-z]+[^>]*\\sid="${id}"[^>]*>`))?.[0] || '';

test('every element the client script addresses exists exactly once in the page', () => {
  const used = new Set([...app.matchAll(/\$\('([\w-]+)'\)/g)].map(m => m[1]));
  for (const id of used) assert.ok(ids.has(id), `falta #${id} en index.html`);
  for (const id of ids) assert.equal([...html.matchAll(new RegExp(`\\sid="${id}"`, 'g'))].length, 1, `#${id} duplicado`);
  for (const id of ['login', 'login-form', 'access', 'workspace', 'voice-name', 'voice-reasoning', 'voice-language', 'call', 'hangup', 'restart-session', 'mute', 'call-status', 'audio', 'refresh', 'projects', 'threads', 'new-session', 'session-status', 'messages', 'calls-truncated', 'empty', 'notice', 'connection'])
    assert.ok(ids.has(id), `contrato: falta #${id}`);
});

test('call-only controls and gated sections start hidden', () => {
  for (const id of ['login', 'workspace', 'hangup', 'restart-session', 'mute', 'audio', 'notice'])
    assert.match(tag(id), /\shidden[\s>]/, `#${id} debe empezar oculto`);
  assert.doesNotMatch(tag('call'), /\shidden[\s>]/);
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  for (const id of ['call', 'hangup', 'restart-session', 'mute', 'new-session', 'refresh'])
    assert.ok(app.includes(`$('${id}').onclick`), `#${id} sin manejador`);
});

test('one voice design per provider (GPT Realtime or Gemini Live), always with direct tools', () => {
  assert.deepEqual([...html.matchAll(/<select id="([^"]+)"/g)].map(m => m[1]), ['ui-language', 'setting-model', 'setting-reasoning', 'setting-voice', 'setting-gemini-voice', 'setting-eagerness', 'setting-noise', 'setting-transcription'], 'the interface language and the server-wide voice settings');
  assert.doesNotMatch(app, /realtime-model|voice-model|localStorage[^;]*model/, 'the voice model is one server setting, not a per-browser choice');
  assert.match(html, /<span id="voice-name" class="voice-name">GPT Realtime<\/span><span class="voice-chips"><span id="voice-reasoning" class="voice-chip" hidden><\/span><span id="voice-language" class="voice-chip" hidden><\/span><\/span>/);
  assert.doesNotMatch(html, /id="voice-model"|stage-title|id="transcript"/, 'no model details, stage kicker or live caption: the conversation panel shows the transcript');
  assert.match(app, /provider: 'realtime'/);
});

test('page stays within the server CSP and loads nothing external', () => {
  assert.doesNotMatch(html, /\sstyle="/, 'atributo style inline bloqueado por CSP');
  assert.doesNotMatch(html, /<style[\s>]/);
  assert.doesNotMatch(html, /<script(?![^>]*\ssrc="\/)[^>]*>/, 'solo scripts propios');
  assert.doesNotMatch(html, /\son[a-z]+="/, 'manejadores inline bloqueados por CSP');
  assert.doesNotMatch(html + css, /(?:src|href)="https?:|@import|url\(\s*["']?https?:/);
  assert.doesNotMatch(app, /innerHTML|insertAdjacentHTML|setAttribute\('style'/);
});

test('ADE switch is named, persistent and guards active work and late results', () => {
  assert.match(tag('backend'), /role="radiogroup"/); assert.match(tag('backend'), /aria-label="ADE"/);
  for (const id of ['t3', 'orca']) {
    assert.match(html, new RegExp(`role="radio" data-ade="${id}" aria-checked="(true|false)"`));
    assert.match(html, new RegExp(`<symbol id="i-logo-${id}" viewBox="[^"]+"><path fill="currentColor"[^>]* d="[Mm][^"]{400,}"`), `falta el trazado del logo de ${id}`);
  }
  assert.match(html, /<span class="ade-name">T3<\/span>/); assert.match(html, /<span class="ade-name">Orca<\/span>/);
  assert.doesNotMatch(html + app, /ade-capabilities|ade-limitation|Funciones disponibles/);
  assert.match(app, /localStorage.setItem\('ade', backend\)/);
  assert.match(app, /generation !== viewGeneration/);
  assert.match(app, /notice\(t\('ade\.switchDuringCall'\)\)/); assert.equal(t('ade.switchDuringCall'), 'End the call before switching ADE.');
  assert.match(app, /ArrowRight/); assert.match(app, /'Home'/);
  assert.match(css, /data-ade="orca"/);
});

test('ADE palette animates only on an explicit switch and never with transition: all', () => {
  assert.match(app, /prefers-reduced-motion: reduce/);
  assert.match(app, /applyAde\(false\);/); assert.match(app, /applyAde\(true\);/);
  for (const token of ['bg', 'surface', 'line', 'text', 'accent']) assert.match(css, new RegExp(`@property --${token} \\{ syntax: '<color>'`));
  assert.match(css, /:root\.ade-shift \{\s*transition-property: --bg,/);
  assert.match(css, /:root\.ade-shift \.ade-switch::before \{ transition: transform/);
  // The brand mark is inline (not <use>) so its fills follow the palette frame by frame.
  assert.match(html, /<svg class="brand-mark"[^>]*viewBox="0 0 32 32"><circle[^>]*class="mark-disc"/);
  assert.match(css, /:root\.ade-shift \.mark-disc, :root\.ade-shift \.mark-ink \{ transition: fill/);
  assert.doesNotMatch(css, /transition:\s*all\b/);
  assert.match(css, /prefers-reduced-motion: reduce\) \{\s*\*, \*::before, \*::after \{[^}]*transition: none !important/);
});

test('ADE switch marks one option, slides to it and is rebuilt from the server list', async () => {
  const { runInNewContext } = await import('node:vm');
  class Node {
    tag: string; children: Node[]; dataset: Record<string, string>; attrs: Record<string, string>; props: Record<string, string>;
    style: { setProperty: (key: string, value: string | number) => void }; textContent = ''; tabIndex = 0;
    constructor(tag: string) { this.tag = tag; this.children = []; this.dataset = {}; this.attrs = {}; this.props = {}; this.style = { setProperty: (k, v) => { this.props[k] = String(v); } }; }
    setAttribute(k: string, v: string) { this.attrs[k] = v; } append(...c: Node[]) { this.children.push(...c); } replaceChildren(...c: Node[]) { this.children = c; }
    querySelectorAll() { return this.children.filter(c => c.attrs?.role === 'radio'); }
  }
  const option = (id: string, name: string) => { const n = new Node('button'); n.dataset.ade = id; n.attrs.role = 'radio'; n.textContent = name; return n; };
  const adeSwitch = new Node('div'); adeSwitch.children = [option('t3', 'T3'), option('orca', 'Orca')];
  const scope = { adeSwitch, backend: 'orca', document: { getElementById: () => null, createElementNS: () => new Node('svg') },
    el: (tag: string, cls?: string, text?: string) => Object.assign(new Node(tag), { className: cls, textContent: text }) };
  runInNewContext('const adeOptions = () => [...adeSwitch.querySelectorAll()];\n' + app.slice(app.indexOf('function markAde('), app.indexOf('// Palette and thumb')) + app.slice(app.indexOf('function icon('), app.indexOf('function safeLink(')), scope);
  (scope as typeof scope & { markAde(): void }).markAde();
  assert.deepEqual(adeSwitch.children.map(n => [n.attrs['aria-checked'], n.tabIndex]), [['false', -1], ['true', 0]]);
  assert.equal(adeSwitch.props['--ade-index'], '1'); assert.equal(adeSwitch.props['--ade-count'], '2');
  const kept = adeSwitch.children[0];
  (scope as typeof scope & { renderAdes(list: { id: string; name: string }[]): void }).renderAdes([{ id: 't3', name: 'T3' }, { id: 'orca', name: 'Orca' }, { id: 'next', name: 'Next' }]);
  assert.equal(adeSwitch.children[0], kept); assert.equal(adeSwitch.children.length, 3);
  assert.equal(adeSwitch.children[2].children[1].textContent, 'Next');
  assert.equal(adeSwitch.children[2].children[0].textContent, 'N');
  assert.equal(adeSwitch.props['--ade-count'], '3'); assert.equal(adeSwitch.props['--ade-index'], '1');
});

test('form controls have accessible names', () => {
  assert.ok(html.includes('for="access"'), '#access sin etiqueta');
  assert.match(tag('refresh'), /aria-label="[^"]+"/);
  assert.match(tag('messages'), /role="log"[^>]*aria-label="Transcript of the calls and the tools run"/);
  assert.match(tag('mute'), /aria-pressed="false"/);
  assert.match(html, /<html lang="en">/);
});

test('the conversation loads stored call events up to the status cursor and adds live ones from the stream', () => {
  assert.match(app, /await api\(`\/api\/calls\?through=\$\{status\.eventCursor\}`\)/);
  assert.match(app, /new EventSource\('\/api\/events\?after=' \+ status\.eventCursor\)/);
  assert.match(app, /if \(event\.type === 'transcript' \|\| event\.type === 'voice-tool'\)\s*receiveCallEvent\(event\);/);
  assert.match(app, /resetCalls\(\)/);
});

test('each call shows its turns in order with their time and its tools after the turn they followed, collapsed, safely and once', async () => {
  const { runInNewContext } = await import('node:vm');
  class Element {
    children: (Element | string)[] = []; dataset: Record<string, string> = {}; open = false; hidden = false;
    className = ''; textContent = ''; dateTime = ''; scrollHeight = 0; scrollTop = 0; clientHeight = 0; parent?: Element;
    constructor(readonly tag: string) {}
    append(...children: (Element | string)[]) {
      for (const child of children) { if (child instanceof Element) { child.remove(); child.parent = this; } this.children.push(child); }
    }
    remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = undefined; }
    replaceChildren(...children: (Element | string)[]) { for (const c of this.nodes) c.parent = undefined; this.children = []; this.append(...children); }
    // Only the selectors the panel uses: "details" and "details[open]".
    querySelectorAll(selector: string) {
      const open = selector.endsWith('[open]'), tag = selector.replace('[open]', ''), found: Element[] = [];
      const walk = (e: Element) => { for (const c of e.nodes) { if (c.tag === tag && (!open || c.open)) found.push(c); walk(c); } };
      walk(this); return found;
    }
    get nodes() { return this.children.filter((c): c is Element => c instanceof Element); }
  }
  const messages = new Element('div'), truncated = new Element('p'), empty = new Element('div'); messages.append(empty);
  const scope = { backend: 't3', conversationId: 'current', emptyState: empty, $: (id: string) => id === 'messages' ? messages : truncated,
    el: (tag: string, cls?: string | null, text?: string) => Object.assign(new Element(tag), { className: cls || '', textContent: text ?? '' }),
    linkify: (text: string) => text, time: (value: string) => `hora ${value}`, t, locale, isMessageKey };
  runInNewContext(app.slice(app.indexOf('// The "Conversation" panel'), app.indexOf('function threadRow(')), scope);
  const api = scope as typeof scope & { receiveCallEvent(event: unknown): void; resetCalls(): void };
  const at = '2026-11-17T10:00:00.000Z', base = { backend: 't3', conversationId: 'current' };
  const events = [
    { id: 1, type: 'transcript', data: { ...base, call: 'c1', role: 'user', text: '<img src=x onerror=alert(1)>', at } },
    { id: 2, type: 'voice-tool', data: { ...base, id: 'c1', callId: 'f1', name: '<script>bad()</script>', status: 'completed', ok: true, args: { path: 'README.md' }, result: { content: [{ type: 'text', text: 'line read' }] } } },
    { id: 3, type: 'voice-tool', data: { ...base, id: 'c1', callId: 'f2', name: 't3_send_message', status: 'refused', ok: false, args: { message: 'Hola' }, result: 'NOT SENT (needs_confirmation)' } },
    { id: 4, type: 'transcript', data: { ...base, call: 'c1', role: 'assistant', text: 'Sending it.', at: '2026-11-17T10:00:09.000Z' } },
    { id: 5, type: 'voice-tool', data: { ...base, id: 'c1', callId: 'f3', name: 't3_send_message', status: 'unknown', ok: false, args: { message: 'Hola' }, result: 'It may have arrived', delivered: { threadId: 'thread-1' } } },
    { id: 2, type: 'voice-tool', data: { ...base, id: 'c1', callId: 'f1', name: 'repetido', status: 'completed', ok: true } },
    { id: 6, type: 'transcript', data: { ...base, backend: 'orca', call: 'c1', role: 'user', text: 'Otro ADE' } },
    { id: 7, type: 'voice-tool', data: { ...base, conversationId: 'other', id: 'c1', callId: 'f9', name: 'ajeno', status: 'completed', ok: true } },
    { id: 8, type: 'transcript', data: { ...base, call: 'c2', role: 'user', text: 'Segunda llamada', at: '2026-11-17T11:00:00.000Z' } }
  ].map(event => ({ ...event, data: { order: event.id, ...event.data } }));
  for (const event of events) api.receiveCallEvent(event);
  assert.equal(empty.parent, undefined, 'the empty state leaves with the first event');
  assert.deepEqual(messages.nodes.map(n => [n.className, n.dataset.call]), [['call-log', 'c1'], ['call-log', 'c2']]);
  const [first] = messages.nodes;
  assert.deepEqual(first.nodes.map(n => n.className), ['call-head', 'turn', 'tool-details', 'turn', 'tool-details']);
  const [head, asked, tools, answered, later] = first.nodes;
  assert.equal(head.textContent, 'Call'); assert.equal(head.nodes[0].dateTime, at);
  const user = asked.nodes[0];
  assert.equal(user.className, 'message user'); assert.equal(user.nodes[0].textContent, 'You');
  assert.deepEqual([user.nodes[0].nodes[0].textContent, user.nodes[0].nodes[0].dateTime], [`hora ${at}`, at]);
  assert.equal(user.children[1], '<img src=x onerror=alert(1)>', 'text, never parsed HTML');
  assert.equal(answered.nodes[0].className, 'message assistant'); assert.equal(answered.nodes[0].nodes[0].textContent, 'Agent');
  assert.equal(tools.open, false); assert.equal(tools.nodes[0].textContent, 'Tools (2)');
  const [read, refused] = tools.nodes.slice(1);
  assert.equal(read.open, false); assert.equal(read.nodes[0].textContent, '<script>bad()</script> · Finished');
  assert.deepEqual(read.nodes.filter(n => n.tag === 'p').map(n => n.textContent), ['Parameters', 'Result']);
  assert.deepEqual(read.nodes.filter(n => n.tag === 'pre').map(n => n.textContent), ['path: README.md', 'line read']);
  assert.equal(read.nodes.filter(n => n.className === 'tool-raw')[0].nodes[1].textContent, JSON.stringify({ path: 'README.md' }, null, 2));
  assert.match(refused.nodes[0].textContent, /t3_send_message · Not run/, 'a send refused by the gate is not shown as an error');
  assert.equal(later.nodes[0].textContent, 'Tools (1)');
  assert.match(later.nodes[1].nodes[0].textContent, /No confirmed result/);
  assert.ok(later.nodes[1].nodes.some(n => n.textContent === 'Delivery receipt'));
  assert.doesNotMatch(JSON.stringify(messages, (key, value) => key === 'parent' ? undefined : value), /repetido|Otro ADE|ajeno/);

  api.resetCalls(); assert.equal(messages.nodes.length, 0); assert.equal(truncated.hidden, true);
  api.receiveCallEvent({ id: 1, type: 'transcript', data: { ...base, call: 'old', role: 'user', text: 'Antiguo', order: 1 } });
  assert.equal(messages.nodes.length, 1, 'a reset view draws stored events again');
  assert.equal(messages.nodes[0].nodes[0].textContent, 'Call', 'no time without a stored one');

  // The user's transcript completes after the answer started and after a tool
  // ran: the call is drawn in the order the provider created the items. What
  // the user opened stays open when the call is redrawn.
  api.resetCalls();
  api.receiveCallEvent({ id: 10, type: 'transcript', data: { ...base, call: 'c3', role: 'assistant', text: 'Respuesta', order: 3 } });
  api.receiveCallEvent({ id: 11, type: 'voice-tool', data: { ...base, id: 'c3', callId: 'f7', name: 't3_read_thread', status: 'completed', ok: true, order: 2 } });
  const group = () => messages.nodes[0].nodes.find(n => n.className === 'tool-details')!;
  group().open = true; group().nodes[1].open = true;
  api.receiveCallEvent({ id: 12, type: 'transcript', data: { ...base, call: 'c3', role: 'user', text: 'Pregunta', order: 1 } });
  const late = messages.nodes[0].nodes;
  assert.deepEqual(late.map(n => n.className), ['call-head', 'turn', 'tool-details', 'turn']);
  assert.deepEqual([late[1].nodes[0].children[1], late[3].nodes[0].children[1]], ['Pregunta', 'Respuesta']);
  assert.equal(group().open, true); assert.equal(group().nodes[1].open, true, 'open details survive a redraw');

  // A call opened by a tool run takes its time from its first stored turn.
  api.resetCalls();
  api.receiveCallEvent({ id: 20, type: 'voice-tool', data: { ...base, id: 'c4', callId: 'f8', name: 't3_read_thread', status: 'completed', ok: true, order: 2 } });
  api.receiveCallEvent({ id: 21, type: 'transcript', data: { ...base, call: 'c4', role: 'user', text: 'Hola, ¿me escuchas?', order: 1, item: 'u1', at } });
  assert.equal(messages.nodes[0].nodes[0].nodes[0].dateTime, at);
});

test('the conversation panel never draws live transcript deltas, only final transcripts', () => {
  // Deltas stream words still being recognized and answers ahead of their
  // audio; the panel waits for the stored transcript of each turn.
  const start = app.indexOf('onEvent: event => {'), body = app.slice(start, app.indexOf('\n      }', start));
  assert.ok(start > 0);
  const uses = body.split('\n').filter(line => /delta/.test(line));
  assert.deepEqual(uses.map(line => /recordings\.current\?\.event\('provider_event'/.test(line)), [true], 'deltas only reach the diagnostic recording');
  assert.doesNotMatch(app, /receiveDraft|dropDrafts|message \$\{[^}]*\} draft/);
  assert.doesNotMatch(css, /\.message\.draft/);
});

test('project/context loads overlap and late failures cannot change a new view', async () => {
  const { runInNewContext } = await import('node:vm');
  const nodes = new Map();
  const node = (id: string) => { if (!nodes.has(id)) nodes.set(id, { textContent: '', setAttribute() {}, removeAttribute() {}, replaceChildren() {}, append() {} }); return nodes.get(id); };
  const pending: { path: string; resolve: (data: unknown) => void; reject: (error: Error) => void }[] = [], states: string[] = [], notices: string[] = [];
  const sandbox = { viewGeneration: 1, $: node, discovered: (state: string) => states.push(state), notice: (text: string) => notices.push(text),
    api: (path: string) => new Promise((resolve, reject) => pending.push({ path, resolve, reject })),
    time: () => 'now', el: () => ({}), safeLink: () => null, t };
  runInNewContext(app.slice(app.indexOf('let projectRequest ='), app.indexOf('async function boot()')), sandbox);
  const old = (sandbox as typeof sandbox & { projects(): Promise<void> }).projects();
  assert.deepEqual(pending.map(p => p.path).sort(), ['/api/context', '/api/projects?progressive=1']);
  sandbox.viewGeneration++;
  const fresh = (sandbox as typeof sandbox & { projects(): Promise<void> }).projects();
  pending[0].reject(new Error('old context')); pending[1].reject(new Error('old projects')); await old;
  assert.equal(notices.length, 0); assert.equal(node('refresh').disabled, true);
  pending[2].resolve({ status: 'verified', tracked: [] });
  pending[3].resolve({ projects: [], workspaces: [], discovery: { complete: false } }); await fresh;
  assert.equal(states.at(-1), 'partial'); assert.equal(node('refresh').disabled, false);
  assert.match(node('projects-updated').textContent, /Partial read/);
});

test('progress polling stops on ADE/conversation changes and discards an already pending response', async () => {
  const { runInNewContext } = await import('node:vm');
  const requests: { path: string; resolve: (value: unknown) => void }[] = [], timers: (() => void)[] = [], states: string[] = [];
  const nodes = new Map();
  const node = (id: string) => { if (!nodes.has(id)) nodes.set(id, { textContent: '', setAttribute() {}, removeAttribute() {}, replaceChildren() {}, append() {} }); return nodes.get(id); };
  const sandbox = { viewGeneration: 1, $: node, discovered: (s: string) => states.push(s), notice() {},
    api: (path: string) => new Promise(resolve => requests.push({ path, resolve })),
    setTimeout: (fn: () => void) => timers.push(fn), time: () => 'now', el: () => ({}), safeLink: () => null, t };
  runInNewContext(app.slice(app.indexOf('let projectRequest ='), app.indexOf('async function boot()')), sandbox);
  const run = (sandbox as typeof sandbox & { projects(): Promise<void> }).projects();
  requests[0].resolve({ tracked: [] });
  requests[1].resolve({ projects: [], workspaces: [], pending: true, generation: '1', discovery: { complete: false } });
  await new Promise(r => setImmediate(r));
  assert.match(node('projects-updated').textContent, /Checking activity/);
  timers.shift()!(); await new Promise(r => setImmediate(r));
  assert.match(requests[2].path, /generation=1/);
  sandbox.viewGeneration++;
  requests[2].resolve({ projects: [], workspaces: [], pending: false, discovery: { complete: true } });
  await run;
  assert.equal(states.at(-1), 'loading'); assert.equal(timers.length, 0);
});

test('pairing links remove the secret before boot and never authorize on open', async () => {
  const { runInNewContext } = await import('node:vm');
  const source = app.slice(app.indexOf('const fragment = new URLSearchParams'), app.indexOf('async function refreshBrowsers'));
  assert.ok(source.length > 0);
  const hash = '#pair=ABCDEF-123456-ABCDEF-123456';
  const access = { value: '' }; const historyCalls: unknown[][] = [];
  runInNewContext(source, { URLSearchParams, location: { hash, pathname: '/' },
    history: { replaceState: (...args: unknown[]) => historyCalls.push(args) }, $: () => access,
    api: () => assert.fail('Opening a link must not authenticate automatically') });
  assert.deepEqual(historyCalls[0], [null, '', '/']);
  assert.equal(access.value, hash.slice(6));
});

// Every source of the page: the static markup and the compiled modules.
const modules = readdirSync(new URL('../public/', import.meta.url)).filter(name => name.endsWith('.js'))
  .map(name => readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8')).join('\n');
const htmlKeys = [...html.matchAll(/\sdata-i18n(?:-aria-label|-title)?="([^"]+)"/g)].map(m => m[1]);
const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();

test('every interface key exists in every dictionary with the same placeholders, and every key is used', () => {
  const english = dictionaries[DEFAULT_LANGUAGE];
  assert.ok(Object.keys(dictionaries).length >= 2 && Object.hasOwn(dictionaries, 'es'));
  for (const [name, dictionary] of Object.entries(dictionaries)) {
    assert.deepEqual(Object.keys(dictionary).sort(), Object.keys(english).sort(), `${name}: same keys as English`);
    for (const [key, text] of Object.entries(dictionary)) {
      assert.ok(text.trim(), `${name}: ${key} is empty`);
      assert.deepEqual(placeholders(text), placeholders(english[key as MessageKey]), `${name}: ${key} placeholders`);
    }
  }
  // Keys appear literally in t('key'), as a ternary branch passed to t(), in the markup or as a state prefix.
  const used = new Set([...htmlKeys, ...[...modules.matchAll(/'([a-z]+\.[A-Za-z.]+)'/g)].map(m => m[1]).filter(isMessageKey)]);
  for (const key of htmlKeys) assert.ok(isMessageKey(key), `index.html: unknown key ${key}`);
  for (const key of Object.keys(english)) assert.ok(used.has(key) || /^(?:thread|tool|call\.state)\./.test(key), `${key} is unused`);
});

test('the markup keeps the English text of its keys, so the page reads well before the script runs', () => {
  const english = dictionaries[DEFAULT_LANGUAGE];
  const texts = [...html.matchAll(/<([a-z0-9]+)[^>]*\sdata-i18n="([^"]+)"[^>]*>([^<]*)<\/\1>/g)];
  assert.equal(texts.length, [...html.matchAll(/\sdata-i18n="/g)].length, 'every data-i18n element holds plain text');
  for (const [, , key, text] of texts) assert.equal(text, english[key as MessageKey], key);
  const attributes = [...html.matchAll(/\s(aria-label|title)="([^"]*)" data-i18n-(aria-label|title)="([^"]+)"/g)];
  assert.equal(attributes.length, [...html.matchAll(/\sdata-i18n-(?:aria-label|title)="/g)].length, 'each translated attribute follows its English value');
  for (const [, attribute, text, target, key] of attributes) { assert.equal(attribute, target, key); assert.equal(text, english[key as MessageKey], key); }
  assert.equal(htmlKeys.length, [...html.matchAll(/\sdata-i18n/g)].length);
});

// A minimal page made from the real markup: elements with their data-i18n* attributes.
function page() {
  const nodes = [...html.matchAll(/<([a-z0-9]+)((?:\s[\w-]+(?:="[^"]*")?)*)\s*>([^<]*)/g)].map(([, tag, attrs, text]) => {
    const attributes = Object.fromEntries([...attrs.matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map(m => [m[1], m[2] ?? '']));
    return { tag, attributes, textContent: text, getAttribute(name: string) { return this.attributes[name] ?? null; }, setAttribute(name: string, value: string) { this.attributes[name] = value; } };
  });
  return { documentElement: { lang: 'en' }, nodes,
    querySelectorAll(selector: string) { const name = selector.slice(1, -1); return nodes.filter(node => Object.hasOwn(node.attributes, name)); } };
}

test('a Spanish browser gets the interface in Spanish and lang="es"', async t_ => {
  const { runInNewContext } = await import('node:vm');
  t_.after(() => localize({ languages: [] }));
  const doc = page();
  assert.equal(localize({ languages: ['es-ES', 'en-US'], language: 'es-ES' }, doc), 'es');
  assert.equal(doc.documentElement.lang, 'es'); assert.equal(language(), 'es'); assert.equal(locale(), 'es-ES');
  const byKey = (key: string) => doc.nodes.find(node => node.attributes['data-i18n'] === key)!;
  assert.equal(byKey('call.button').textContent, 'Llamar');
  assert.equal(byKey('call.state.idle').textContent, 'Disponible');
  assert.equal(byKey('login.submit').textContent, 'Vincular navegador');
  assert.equal(doc.nodes.find(node => node.attributes['data-i18n-aria-label'] === 'conversation.log')!.attributes['aria-label'], 'Transcripción de las llamadas y de las herramientas ejecutadas');
  for (const node of doc.querySelectorAll('[data-i18n]')) assert.equal(node.textContent, dictionaries.es[node.attributes['data-i18n'] as MessageKey]);
  assert.equal(t('conversation.tools', { count: 2 }), 'Herramientas (2)');
  assert.equal(t('browsers.unpairNamed', { name: 'Móvil' }), 'Desvincular Móvil');
  const { lastAccess } = await import('../public/browser-list.js');
  assert.equal(lastAccess(Date.UTC(2026, 10, 18, 10), Date.UTC(2026, 10, 18, 12)), 'hace 2 horas');
  // The page's dynamic text follows the language; server text is not translated.
    const scope = { t, isMessageKey, locale } as Record<string, unknown>;
  runInNewContext(app.slice(app.indexOf('const THREAD_ALIASES'), app.indexOf('const coarse')) + '\nObject.assign(globalThis, { threadStatus, callWord, time });', scope);
  const status = scope as { threadStatus(s: string): string; callWord(s: string): string; time(v: number): string };
  assert.equal(status.threadStatus('running'), 'En marcha'); assert.equal(status.threadStatus('done'), 'Turno terminado');
  assert.equal(status.threadStatus('custom_state'), 'custom_state'); assert.equal(status.callWord('live'), 'En línea');
  assert.equal(status.time(Date.UTC(2026, 10, 17, 10, 5)), new Date(Date.UTC(2026, 10, 17, 10, 5)).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }));
});

test('an unsupported or missing browser language falls back to English', () => {
  try {
    const doc = page();
    assert.equal(localize({ languages: ['de-DE', 'fr'], language: 'de-DE' }, doc), 'en');
    assert.equal(doc.documentElement.lang, 'en'); assert.equal(locale(), 'en');
    assert.equal(doc.nodes.find(node => node.attributes['data-i18n'] === 'call.button')!.textContent, 'Call');
    assert.equal(t('call.state.idle'), 'Available');
    assert.deepEqual(pickLanguage([]), { language: 'en', locale: 'en' });
    assert.deepEqual(pickLanguage(['de-DE', 'ES_mx']), { language: 'es', locale: 'es-MX' }, 'the first supported primary subtag wins');
    assert.equal(localize({ languages: [], language: 'es-AR' }), 'es', 'navigator.language when languages is empty');
    localize({ languages: ['en-GB', 'es-ES'] }); assert.equal(language(), 'en'); assert.equal(locale(), 'en-GB');
    assert.equal(t('api.httpError', { status: 502 }), 'Error 502'); assert.equal(t('projects.more', {}), 'and {count} more running');
    const plain = { documentElement: { lang: '' }, querySelectorAll: () => [] }; translatePage(plain); assert.equal(plain.documentElement.lang, 'en');
  } finally { localize({ languages: [] }); }
});

test('the language chosen in Settings wins over the browser, is stored per browser and reaches the voice', () => {
  try {
    assert.equal(localize({ languages: ['en-US'] }, undefined, 'es'), 'es'); assert.equal(locale(), 'es');
    assert.equal(localize({ languages: ['es-ES'] }, undefined, 'en'), 'en');
    assert.equal(localize({ languages: ['es-ES'] }, undefined, 'auto'), 'es', 'Browser follows navigator.languages');
    assert.equal(localize({ languages: ['es-ES'] }, undefined, 'xx'), 'es', 'an unknown stored value means Browser');
    const items = new Map<string, string>();
    const storage = { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => { items.set(k, v); }, removeItem: (k: string) => { items.delete(k); } };
    assert.equal(storedPreference(storage), 'auto');
    storePreference('es', storage); assert.equal(items.get(PREFERENCE_KEY), 'es'); assert.equal(storedPreference(storage), 'es');
    storePreference('auto', storage); assert.equal(items.has(PREFERENCE_KEY), false);
    assert.equal(storedPreference({ getItem: () => { throw new Error('blocked'); } }), 'auto', 'blocked storage falls back to Browser');
    assert.deepEqual(voiceLanguages({ languages: ['en-US', 'es'] }, 'es'), ['es', 'en-US']);
    assert.deepEqual(voiceLanguages({ languages: ['en-US'], language: 'en-US' }), ['en-US']);
  } finally { localize({ languages: [] }); }
});

test('voice settings: readable option names, only changed fields sent, a key field that is never prefilled', async () => {
  const { optionLabel, modelName } = await import('../public/voice-settings.js');
  assert.equal(modelName('gpt-realtime-2.1-mini'), 'GPT Realtime 2.1 Mini');
  assert.equal(optionLabel('model', 'gpt-realtime-2.1'), 'GPT Realtime 2.1');
  assert.equal(optionLabel('reasoning', 'xhigh'), 'Very high');
  assert.equal(optionLabel('eagerness', 'low'), 'Patient · waits for you to finish');
  assert.equal(optionLabel('noiseReduction', 'far_field'), 'Hands-free or computer');
  assert.equal(optionLabel('transcriptionModel', 'gpt-4o-mini-transcribe'), 'GPT-4o mini Transcribe · faster');
  assert.equal(optionLabel('voice', 'cedar'), 'Cedar');
  assert.equal(optionLabel('transcriptionModel', 'custom-transcriber'), 'custom-transcriber', 'a hand-configured value keeps its identifier');
  // The key input: password type, no autocomplete, no value; Save is a submit, Remove starts hidden.
  assert.match(tag('openai-key'), /type="password"/); assert.match(tag('openai-key'), /autocomplete="off"/); assert.doesNotMatch(tag('openai-key'), /\svalue=/);
  assert.match(tag('reveal-key'), /aria-controls="openai-key"/); assert.match(tag('save-key'), /type="submit"/); assert.match(tag('remove-key'), /\shidden[\s>]/);
  for (const id of ['voice-settings', 'key-settings', 'browser-access']) assert.match(tag(id), /data-auth/, `#${id} needs a paired session`);
  // Four tabs, each controlling one panel; only General starts visible.
  const tabs = [...html.matchAll(/role="tab" id="tab-([a-z]+)" data-tab="\1" aria-controls="([a-z-]+)"/g)].map(m => [m[1], m[2]]);
  assert.deepEqual(tabs, [['general', 'general-settings'], ['voice', 'voice-settings'], ['key', 'key-settings'], ['devices', 'browser-access']]);
  for (const [name, panel] of tabs) { assert.match(tag(panel), new RegExp(`role="tabpanel" aria-labelledby="tab-${name}"`)); assert.equal(/\shidden[\s>]/.test(tag(panel)), name !== 'general', `#${panel} starts ${name === 'general' ? 'shown' : 'hidden'}`); }
  // Voice choices save themselves: no Save button, one request per changed select.
  assert.doesNotMatch(html, /id="save-voice"/);
  assert.match(app, /\$\(VOICE_SELECTS\[field\]\)\.onchange = \(\) => saveVoiceField\(field,/);
  assert.match(app, /api\('\/api\/settings\/voice', \{ \[field\]: value \}\)/);
  assert.match(app, /\$\('openai-key'\)\.value = ''/, 'the typed key is cleared');
  assert.match(app, /'\/api\/settings\/key', \{ key: null \}/);
});

test('custom instructions: only a current load or their own save fill the textarea, whatever order answers arrive in', async () => {
  const { InstructionsSync } = await import('../public/voice-settings.js');
  // An ordinary load fills it; its own counters mean a voice or key save made
  // meanwhile (settingsRequest) does not stop it.
  let sync = new InstructionsSync();
  const reopened = sync.loadStarted();
  assert.equal(sync.loadMayFill(reopened), true);
  // Two loads answering in reverse order: the older one does not overwrite the newer.
  sync = new InstructionsSync();
  const first = sync.loadStarted(), second = sync.loadStarted();
  assert.equal(sync.loadMayFill(second), true); assert.equal(sync.loadMayFill(first), false);
  // Text being edited is never replaced by a load.
  sync = new InstructionsSync(); const whileEditing = sync.loadStarted(); sync.input();
  assert.equal(sync.loadMayFill(whileEditing), false);
  // A load started before or during a save answers after it: dropped, so the saved text stays.
  sync = new InstructionsSync(); sync.input();
  const before = sync.loadStarted(); sync.saveStarted(); const during = sync.loadStarted(); sync.saved();
  assert.equal(sync.edited, false);
  assert.equal(sync.loadMayFill(before), false); assert.equal(sync.loadMayFill(during), false);
  assert.equal(sync.loadMayFill(sync.loadStarted()), true, 'a load started after the save fills it');
  // A failed save keeps the person's text: they are still editing.
  sync = new InstructionsSync(); sync.input(); sync.saveStarted();
  assert.equal(sync.loadMayFill(sync.loadStarted()), false);
});

test('after a reload Settings shows the stored language and server values, and the recording switch is off by design', async () => {
  // Language: this browser's localStorage, put back into the select on load.
  assert.match(app, /\$\('ui-language'\)\.value = storedPreference\(localStorage\);/);
  // Voice and key: read from the server each time Settings opens, never from this browser.
  assert.match(app, /if \(signedIn\) \{\s*void refreshBrowsers\(\);\s*void loadVoiceSettings\(\);\s*watchSettingsBusy\(\);\s*\}/);
  assert.match(app, /select\.value = pendingVoice\[field\] \?\? result\.settings\[field\];/);
  // Custom instructions: text being edited is never replaced, and is sent as typed for the server to validate.
  // Only loadVoiceSettings and the instructions' own save fill the textarea, as InstructionsSync decides.
  assert.match(app, /if \(instructionsSync\.loadMayFill\(instructions\)\)\s*\$\('custom-instructions'\)\.value = result\.instructions;\s*if \(request !== settingsRequest\)\s*return;/);
  assert.equal([...app.matchAll(/\$\('custom-instructions'\)\.value = /g)].length, 2, 'no other answer writes the textarea');
  assert.match(app, /if \(saved\) \{\s*instructionsSync\.saved\(\);\s*\$\('custom-instructions'\)\.value = saved\.instructions;\s*\}/);
  assert.match(app, /const instructions = \$\('custom-instructions'\)\.value, max = /);
  assert.match(app, /'\/api\/settings\/instructions', \{ instructions \}/);
  // While Settings is open, a call from another browser locks or unlocks it: only the busy flag changes.
  const watch = app.slice(app.indexOf('function watchSettingsBusy'), app.indexOf('}, 4000);'));
  assert.match(watch, /settingsBusy = busy && !localCall\(\);\s*lockSettings\(\);/);
  assert.doesNotMatch(watch, /showVoiceSettings|\.value =/, 'the poll does not touch options or edited text');
  assert.match(watch, /if \(settingsBusyPolling \|\|/, 'one poll at a time');
  assert.match(watch, /watch !== settingsBusyWatch \|\| request !== settingsRequest/, 'a superseded answer is dropped');
  // No raw length cap: pasted text with spaces around 4000 characters is not cut before the server trims it.
  assert.doesNotMatch(tag('custom-instructions'), /maxlength/);
  assert.doesNotMatch(app, /custom-instructions'\)\.maxLength|instructions\.maxLength/);
  assert.match(app, /instructions\.trim\(\)\.length > max/);
  assert.match(app, /addEventListener\('close', \(\) => \{[^\n]*clearInterval\(settingsBusyTimer\)/);
  assert.doesNotMatch(app, /localStorage\.setItem\('(?!ade')/, 'only the ADE choice and, through i18n.ts, the language are stored in the browser');
  // Diagnostic recording: off on every load, even when the browser restores form state.
  assert.match(tag('record-call'), /autocomplete="off"/);
  for (const dictionary of Object.values(dictionaries)) assert.match(dictionary['recording.explain'], /reload|recarg/, 'the switch says it turns off on reload');
  const toggle = { checked: true, disabled: false, onchange: null as (() => void) | null };
  const previous = globalThis.document;
  globalThis.document = { getElementById: (id: string) => id === 'record-call' ? toggle : { textContent: '' } } as unknown as Document;
  try {
    const { RecordingPanel } = await import('../public/recording-panel.js');
    new RecordingPanel();
    assert.equal(toggle.checked, false, 'a switch restored as on starts off');
  } finally { globalThis.document = previous; }
});

test('paired browsers: this one first with a badge and no own Unpair, inactive ones hidden, names kept as text', async () => {
  const { browserRows, browserNote, lastAccess } = await import('../public/browser-list.js');
  class Element {
    children: Element[] = []; dataset: Record<string, string> = {}; attrs: Record<string, string> = {};
    className = ''; textContent = ''; type = ''; dateTime = ''; title = ''; onclick: (() => void) | null = null;
    constructor(readonly tag: string) {}
    append(...children: Element[]) { this.children.push(...children); }
    setAttribute(name: string, value: string) { this.attrs[name] = value; }
    find(cls: string): Element | undefined { for (const c of this.children) { if (c.className.split(' ').includes(cls)) return c; const f = c.find(cls); if (f) return f; } }
  }
  const previous = globalThis.document;
  globalThis.document = { createElement: (tag: string) => new Element(tag) } as unknown as Document;
  try {
    const now = Date.UTC(2026, 10, 18, 12), hour = 3_600_000;
    const device = (id: string, name: string, lastSeen: number, extra = {}) => ({ id, name, lastSeen, expiresAt: now + hour, revokedAt: null, ...extra });
    const unpaired: string[] = [];
    const rows = browserRows([
      device('old', 'Laptop', now - 2 * hour), device('gone', 'Revoked', now, { revokedAt: now - 1 }),
      device('expired', 'Expired', now, { expiresAt: now - 1 }), device('me', '<img src=x onerror=alert(1)> Phone with a very long name', now - 5 * 60_000),
      device('recent', 'Tablet', now - 30_000)
    ], 'me', d => unpaired.push(d.id), now) as unknown as Element[];
    assert.deepEqual(rows.map(r => r.find('device-name')!.textContent), ['<img src=x onerror=alert(1)> Phone with a very long name', 'Tablet', 'Laptop']);
    assert.ok(Object.hasOwn(rows[0].dataset, 'current'));
    assert.equal(rows[0].find('device-badge')!.textContent, 'This browser');
    assert.equal(rows[0].find('btn'), undefined, 'the current browser is unpaired with "Unpair this browser"');
    assert.equal(rows[0].find('device-meta')!.textContent, 'Last access 5 minutes ago');
    assert.equal(rows[1].find('device-meta')!.textContent, 'Last access now');
    assert.equal(rows[2].find('device-meta')!.textContent, 'Last access 2 hours ago');
    assert.equal(rows[2].find('device-meta')!.dateTime, new Date(now - 2 * hour).toISOString());
    assert.equal(rows[1].find('device-badge'), undefined);
    const button = rows[2].find('btn')!;
    assert.equal(button.textContent, 'Unpair'); assert.equal(button.type, 'button'); assert.equal(button.attrs['aria-label'], 'Unpair Laptop');
    button.onclick!(); assert.deepEqual(unpaired, ['old']);
    const empty = browserRows([device('gone', 'Revoked', now, { revokedAt: now })], null, () => {}, now) as unknown as Element[];
    assert.equal(empty.length, 1); assert.equal(empty[0].className, 'device-note'); assert.equal(empty[0].textContent, 'No paired browsers.');
    assert.equal((browserNote('browsers.loading') as unknown as Element).textContent, 'Loading paired browsers…');
    assert.equal(lastAccess(now - 3 * 24 * hour, now), '3 days ago');
    assert.equal(lastAccess(Date.UTC(2026, 0, 5, 12), now), 'Jan 5');
    assert.equal(lastAccess(Date.UTC(2025, 0, 5, 12), now), 'Jan 5, 2025');
  } finally { globalThis.document = previous; }
  assert.match(tag('refresh-browsers'), /class="icon-btn" aria-label="Refresh list"/);
  assert.match(app, /browserRows\(result\.devices, result\.currentId/);
  assert.match(app, /api\('\/api\/browsers\/revoke', \{ id: device\.id \}\)/);
});

test('call, connection and new-session tones are distinct two-note sounds, played in the right moments', () => {
  const sounds = Object.values(SOUNDS).map(notes => notes.join('-'));
  assert.equal(new Set(sounds).size, sounds.length, 'each moment sounds different');
  for (const notes of Object.values(SOUNDS)) assert.equal(notes.length, 2);
  assert.ok(SOUNDS.connected[0] > SOUNDS.call[1], 'the connection tone is higher than the call tone');
  assert.doesNotThrow(() => play('call'), 'without audio output the call goes on silently');
  assert.match(app, /\$\('call'\)\.onclick = \(\) => \{ play\('call'\); void startCall\(\); \};/, 'the call tone plays inside the tap');
  assert.match(app, /onLive: \(\) => \{ play\('connected'\);/, 'the connection tone plays when the line opens');
});

test('pairing another device: name rule, countdown, translated refusals and redeemed device', async () => {
  const { deviceName, countdown, pairError, redeemedBy, NAME_LIMIT } = await import('../public/pair-device.js');
  assert.equal(deviceName('  My phone '), 'My phone');
  for (const bad of ['', '   ', 'x'.repeat(NAME_LIMIT + 1), 'tab\there', 'del\u007f']) assert.equal(deviceName(bad), null, JSON.stringify(bad));
  assert.equal(deviceName('x'.repeat(NAME_LIMIT)), 'x'.repeat(NAME_LIMIT));
  assert.equal(countdown(600_000), '10:00');
  assert.equal(countdown(599_001), '10:00', 'rounded up');
  assert.equal(countdown(65_000), '1:05');
  assert.equal(countdown(1), '0:01');
  assert.equal(countdown(0), '0:00'); assert.equal(countdown(-5000), '0:00');
  assert.match(pairError(Object.assign(new Error('raw'), { reason: 'origin_missing' })), /npm run access -- pair --url URL --name NAME/);
  assert.equal(pairError(Object.assign(new Error('raw'), { reason: 'invalid_name' })), 'Write a name of 1 to 80 characters.');
  assert.match(pairError(Object.assign(new Error('raw'), { reason: 'too_many_codes' })), /cancel-codes/);
  assert.equal(pairError(Object.assign(new Error('Server says no'), { reason: 'other' })), 'Server says no');
  assert.equal(pairError(new Error('Unreachable')), 'Unreachable');
  const now = Date.UTC(2026, 10, 18, 12);
  const device = (id: string, name: string, extra = {}) => ({ id, name, lastSeen: now, expiresAt: now + 1000, revokedAt: null, ...extra });
  const before = new Set(['old']);
  assert.equal(redeemedBy([device('old', 'Phone')], before, 'Phone', now), null, 'listed before the code');
  assert.equal(redeemedBy([device('new', 'Laptop')], before, 'Phone', now), null, 'another name');
  assert.equal(redeemedBy([device('new', 'Phone', { revokedAt: now })], before, 'Phone', now), null, 'revoked');
  assert.equal(redeemedBy([device('old', 'Phone'), device('new', 'Phone')], before, 'Phone', now)?.id, 'new');
  // The code is never stored and the panel is wired to Settings.
  const pairModule = readFileSync(new URL('../public/pair-device.js', import.meta.url), 'utf8');
  assert.doesNotMatch(pairModule, /localStorage|sessionStorage|history\.|location\./);
  assert.match(app, /api\('\/api\/browsers\/pair', \{ name \}\)/);
  assert.match(app, /\$\('settings'\)\.addEventListener\('close', \(\) => pairDevice\.dismiss\(\)\)/);
  assert.match(html, /id="pair-open" class="btn btn-accent" aria-expanded="false" aria-controls="pair-panel"/);
});

test('first-visit tour: shown once, skippable, repeatable from Settings and placed on screen', async () => {
  const { TOUR_STEPS, TOUR_KEY, TOUR_VERSION, tourSeen, markTourSeen, placeCard, spotlight } = await import('../public/tour.js');
  // Every step names a part of the page and has text in every language.
  for (const step of TOUR_STEPS) {
    if (step.target) assert.ok(step.target.startsWith('#') ? ids.has(step.target.slice(1)) : step.target.startsWith('.setting[') ? html.includes(`class="setting" data-field="${step.target.match(/"(\w+)"/)![1]}"`) : html.includes(`class="${step.target.slice(1)}"`), `missing ${step.target}`);
    // A step in Settings names a real tab and an element inside its panel.
    if (step.settings) assert.match(html, new RegExp(`data-tab="${step.settings}"`));
    for (const [name, dictionary] of Object.entries(dictionaries)) assert.ok(dictionary[step.title] && dictionary[step.body], `${name}: ${step.title}`);
  }
  assert.equal(TOUR_STEPS[0].target, undefined, 'opens with a centered welcome');
  assert.deepEqual([...new Set(TOUR_STEPS.map(step => step.settings).filter(Boolean))], ['general', 'voice', 'key', 'devices'], 'walks through every Settings tab in order');
  assert.equal(TOUR_STEPS.at(-1)!.settings, undefined, 'ends outside Settings');
  // Seen once it ends, whether finished or skipped; blocked storage never nags.
  const store = new Map<string, string>();
  const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value) };
  assert.equal(tourSeen(storage), false);
  store.set(TOUR_KEY, '0'); assert.equal(tourSeen(storage), false, 'an older tour version shows again');
  const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  assert.equal(tourSeen(blocked), true);
  markTourSeen(storage); assert.equal(store.get(TOUR_KEY), TOUR_VERSION); assert.equal(tourSeen(storage), true);
  // Storage that reads but refuses writes (full): ended in this page, it stays ended.
  const fresh = await import(new URL('../public/tour.js?full-storage', import.meta.url).href) as typeof import('../public/tour.js');
  const full = { getItem: () => null, setItem: () => { throw new Error('quota'); } };
  assert.equal(fresh.tourSeen(full), false);
  assert.doesNotThrow(() => fresh.markTourSeen(full)); assert.equal(fresh.tourSeen(full), true);
  // Placement: below, else above, else over a tall target; always inside the viewport.
  const view = { width: 400, height: 800 }, card = { width: 360, height: 200 };
  assert.deepEqual(placeCard(null, card, view), { top: 300, left: 20, side: 'center' });
  assert.deepEqual(placeCard({ top: 10, left: 340, width: 44, height: 44 }, card, view), { top: 68, left: 24, side: 'below' });
  assert.equal(placeCard({ top: 600, left: 0, width: 400, height: 150 }, card, view).side, 'above');
  assert.deepEqual(placeCard({ top: 0, left: 0, width: 400, height: 790 }, card, view), { top: 584, left: 20, side: 'over' });
  assert.deepEqual(spotlight({ top: -50, left: 4, width: 500, height: 100 }, view), { top: 0, left: 0, width: 400, height: 58 });
  // Wiring: a modal dialog with skip, back and next; started on boot only if unseen;
  // repeated from Settings, which offers it only outside a call.
  assert.match(tag('tour'), /<dialog id="tour" class="tour" aria-labelledby="tour-title" aria-describedby="tour-body">/);
  for (const id of ['tour-skip', 'tour-back', 'tour-next', 'tour-restart']) assert.match(tag(id), /type="button"/);
  assert.match(app, /if \(!tourSeen\(localStorage\) && !\$\('settings'\)\.open && !localCall\(\)\)\s+tour\.start\(\)/);
  assert.match(app, /\$\('tour-restart'\)\.onclick = \(\) => \{ \$\('settings'\)\.close\(\);\s+if \(!localCall\(\)\)\s+tour\.start\(\);\s+\}/);
  assert.match(app, /\$\('tour-restart'\)\.disabled = localCall\(\)/);
  // The tour opens Settings on a tab, keeps it open between its steps and closes it at the end.
  assert.match(app, /\$\('open-settings'\)\.onclick = \(\) => openSettings\(\)/);
  assert.match(app, /if \(\$\('settings'\)\.open\) \{\s*showSettingsTab\(tab, false, false\);\s*return false;\s*\}\s*openSettings\(tab\);\s*return true;/);
  assert.match(html, /<div class="tour-text" aria-live="polite">/, 'each step is announced');
  assert.match(readFileSync(new URL('../src/server.mjs', import.meta.url), 'utf8'), /'tour'/, 'the module is served');
  assert.equal(t('tour.count', { current: 2, total: 7 }), '2 of 7');
});
