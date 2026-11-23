import type { Capabilities, Overview, LiveResponse, Workspace, StatusResponse, CallEvent, CallsResponse, VoiceToolData, VoiceSettingsResponse, VoiceSettingField, VoiceProvider } from '../src/shared/contracts.mjs';
import type { Snapshot } from '../src/shared/contracts.mjs';
interface Elements {
  'refresh-browsers': HTMLElementTagNameMap['button'];
  'settings': HTMLElementTagNameMap['dialog'];
  'ui-language': HTMLElementTagNameMap['select'];
  'voice-form': HTMLElementTagNameMap['form'];
  'setting-model': HTMLElementTagNameMap['select'];
  'setting-reasoning': HTMLElementTagNameMap['select'];
  'setting-voice': HTMLElementTagNameMap['select'];
  'setting-eagerness': HTMLElementTagNameMap['select'];
  'setting-noise': HTMLElementTagNameMap['select'];
  'setting-transcription': HTMLElementTagNameMap['select'];
  'setting-gemini-voice': HTMLElementTagNameMap['select'];
  'gemini-key-form': HTMLElementTagNameMap['form'];
  'gemini-key': HTMLElementTagNameMap['input'];
  'reveal-gemini-key': HTMLElementTagNameMap['button'];
  'save-gemini-key': HTMLElementTagNameMap['button'];
  'remove-gemini-key': HTMLElementTagNameMap['button'];
  'setting-elevenlabs-voice': HTMLElementTagNameMap['select'];
  'elevenlabs-key-form': HTMLElementTagNameMap['form'];
  'elevenlabs-key': HTMLElementTagNameMap['input'];
  'reveal-elevenlabs-key': HTMLElementTagNameMap['button'];
  'save-elevenlabs-key': HTMLElementTagNameMap['button'];
  'remove-elevenlabs-key': HTMLElementTagNameMap['button'];
  'instructions-form': HTMLElementTagNameMap['form'];
  'custom-instructions': HTMLElementTagNameMap['textarea'];
  'save-instructions': HTMLElementTagNameMap['button'];
  'key-form': HTMLElementTagNameMap['form'];
  'openai-key': HTMLElementTagNameMap['input'];
  'reveal-key': HTMLElementTagNameMap['button'];
  'save-key': HTMLElementTagNameMap['button'];
  'remove-key': HTMLElementTagNameMap['button'];
  'logout': HTMLElementTagNameMap['button'];
  'login-form': HTMLElementTagNameMap['form'];
  'access': HTMLElementTagNameMap['input'];
  'reveal': HTMLElementTagNameMap['button'];
  'login-submit': HTMLElementTagNameMap['button'];
  'call': HTMLElementTagNameMap['button'];
  'mute': HTMLElementTagNameMap['button'];
  'restart-session': HTMLElementTagNameMap['button'];
  'hangup': HTMLElementTagNameMap['button'];
  'audio': HTMLElementTagNameMap['audio'];
  'new-session': HTMLElementTagNameMap['button'];
  'refresh': HTMLElementTagNameMap['button'];
  'transcript-toggle': HTMLElementTagNameMap['button'];
}
import { errorMessage } from './errors.js';
import { LiveHealth } from './live-health.js';
import { bindLiveEvents, type LiveCloseCause } from './live-events.js';
import { SpeechGate } from './speech-gate.js';
import { PlaybackControl } from './playback-control.js';
import { RelayedCall, streamUrl } from './relayed-call.js';
import { RecordingPanel } from './recording-panel.js';
import { browserRows, browserNote, type PairedBrowser } from './browser-list.js';
import { PairDevice, type PairInvite } from './pair-device.js';
import { play } from './sounds.js';
import { InstructionsSync, modelName, modelProvider, optionLabel, VOICE_FIELDS, type VoiceValues } from './voice-settings.js';
import { t, locale, isMessageKey, storedPreference, storePreference, voiceLanguages } from './i18n.js';
const recordings = new RecordingPanel();
const $ = <K extends string>(id: K) => document.getElementById(id)! as K extends keyof Elements ? Elements[K] : HTMLElement;
const adeSwitch = $('backend');
const adeOptions = () => [...adeSwitch.querySelectorAll<HTMLElement>('[role="radio"]')];
const storedAde = localStorage.getItem('ade');
let backend = adeOptions().some(option => option.dataset.ade === storedAde) ? storedAde! : adeOptions()[0].dataset.ade!;
let viewGeneration = 0; let adeCapabilities: Capabilities = {}; let paletteTimer: ReturnType<typeof setTimeout>;
let conversationId: string;
let liveHealth: LiveHealth | null = null;
// A call whose audio the server relays (Gemini Live, ElevenLabs Realtime), and the provider the server's next call uses.
let relay: RelayedCall | null = null, voiceProvider: VoiceProvider = 'realtime';
let speechGate: SpeechGate | null; let callGeneration = 0;
let playback: PlaybackControl | null = null;
let wakeLock: WakeLockSentinel | null | undefined;
let stream: MediaStream | null, peer: RTCPeerConnection | null, channel: RTCDataChannel | null, callId: string | null;
let heartbeat: ReturnType<typeof setInterval>, eventSource: EventSource | null, muted = false;
let languageChanged = false;
// A one-tap restart into a new session is in progress: further taps are ignored.
let restarting = false;
let voiceReady = false, runtimeReady = false, runtimeState = 'loading', callStartedAt = 0; let callTimer: ReturnType<typeof setInterval>;
const emptyState = $('empty');
const stage = $('stage');
const ACTIVE_THREAD = ['running', 'starting', 'preparing', 'queued'];
const THREAD_ALIASES: Record<string, string> = { ready: 'idle', done: 'completed', error: 'failed' };
// Known ADE states are translated; any other is shown as the ADE sent it.
const threadStatus = (status: string) => { const key = `thread.${THREAD_ALIASES[status] || status}`; return isMessageKey(key) ? t(key) : status; };
const callWord = (state: string) => { const key = `call.state.${state}`; return isMessageKey(key) ? t(key) : state; };
const time = (value: string | number) => new Date(value).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
const coarse = matchMedia('(pointer: coarse)');

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string | null, text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function icon(name: string) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use'); use.setAttribute('href', `#i-${name}`);
  svg.append(use); return svg;
}
function safeLink(link: string | undefined) {
  try { const url = new URL(link || ''); return ['http:', 'https:'].includes(url.protocol) ? url.href : null; } catch { return null; }
}
// Plain text with http(s) links made clickable. Never parses HTML.
function linkify(text: string) {
  const fragment = document.createDocumentFragment(); let last = 0;
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'`]*[^\s<>"'`.,;:!?)\]]/g)) {
    const href = safeLink(match[0]); if (!href) continue;
    fragment.append(text.slice(last, match.index));
    const a = el('a', null, match[0]); a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer';
    fragment.append(a); last = match.index + match[0].length;
  }
  fragment.append(text.slice(last)); return fragment;
}

function notice(text: string) { $('notice').textContent = text; $('notice').hidden = !text; }
function setConnection(state: string, text: string) { $('connection').dataset.state = state; $('connection').textContent = text; }
function adeName() { return adeOptions().find(option => option.dataset.ade === backend)?.querySelector('.ade-name')?.textContent || backend; }
// The switch is built from the server's ADE list; the sliding thumb follows the checked index.
function markAde() {
  const options = adeOptions(), index = Math.max(0, options.findIndex(option => option.dataset.ade === backend));
  options.forEach((option, i) => { option.setAttribute('aria-checked', String(i === index)); option.tabIndex = i === index ? 0 : -1; });
  adeSwitch.style.setProperty('--ade-count', String(options.length)); adeSwitch.style.setProperty('--ade-index', String(index));
}
function adeOption(ade: { id: string; name: string }) {
  const option = el('button', 'ade-option'); option.type = 'button'; option.setAttribute('role', 'radio'); option.dataset.ade = ade.id;
  const logo = el('span', 'ade-logo'); logo.setAttribute('aria-hidden', 'true');
  if (document.getElementById(`i-logo-${ade.id}`)) logo.append(icon(`logo-${ade.id}`)); else logo.textContent = ade.name.slice(0, 1);
  option.append(logo, el('span', 'ade-name', ade.name)); return option;
}
function renderAdes(list: { id: string; name: string }[]) {
  const known = new Map(adeOptions().map(option => [option.dataset.ade, option]));
  adeSwitch.replaceChildren(...list.map(ade => known.get(ade.id) || adeOption(ade))); markAde();
}
// Palette and thumb only animate during an explicit switch, never on first paint.
function applyAde(animate: boolean) {
  const root = document.documentElement;
  clearTimeout(paletteTimer);
  if (animate && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    root.classList.add('ade-shift'); paletteTimer = setTimeout(() => root.classList.remove('ade-shift'), 700);
  } else root.classList.remove('ade-shift');
  root.dataset.ade = backend; markAde();
}
applyAde(false);
// Sticky panels size to the viewport from where the workspace actually starts, so a
// notice above it (such as Orca's limitation) cannot push their bottom edge off screen.
const workspaceTop = () => { const box = $('workspace'); if (box.hidden) return; document.documentElement.style.setProperty('--workspace-top', `${Math.round(box.getBoundingClientRect().top + scrollY)}px`); };
const layoutObserver = new ResizeObserver(workspaceTop); layoutObserver.observe($('notice')); layoutObserver.observe($('workspace'));
// Only ADEs that take requests from here say that they keep running.
function endedText() { return t(adeCapabilities.sendMessagesOnRequest ? 'runtime.requestsContinue' : 'runtime.agentsContinue', { ade: adeName() }); }
function showRuntime() {
  const text = t(runtimeState === 'loading' ? 'runtime.checking' : runtimeState === 'partial' ? 'runtime.partial' : runtimeReady ? 'runtime.connected' : 'runtime.offline', { ade: adeName() });
  setConnection(runtimeState === 'loading' || runtimeState === 'partial' ? 'wait' : runtimeReady ? 'ok' : 'offline', text);
}
function discovered(state: string) { runtimeState = state; runtimeReady = ['ready', 'partial'].includes(state); showRuntime(); }

function setCall(state: string, text?: string) {
  recordings.current?.event('call_state', { state });
  stage.dataset.state = state; $('call-state').textContent = callWord(state);
  if (text !== undefined) $('call-status').textContent = text;
  if ((state === 'live' || state === 'thinking') && !callStartedAt) startTimer();
  lockSettings();
}
function startTimer() {
  callStartedAt = Date.now(); $('call-timer').hidden = false;
  const tick = () => {
    const seconds = Math.floor((Date.now() - callStartedAt) / 1000);
    $('call-timer').textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  };
  tick(); clearInterval(callTimer); callTimer = setInterval(tick, 1000);
}
function setMuted(value: boolean) {
  recordings.current?.event('microphone_muted', { value });
  muted = value; stage.dataset.muted = String(value);
  $('mute').setAttribute('aria-pressed', String(value)); $('mute-label').textContent = t(value ? 'call.unmute' : 'call.mute');
}
function showLogin() {
  eventSource?.close(); cleanup();
  $('login').hidden = false; $('workspace').hidden = true; adeSwitch.hidden = true; setConnection('locked', t('connection.private'));
  if (!coarse.matches) requestAnimationFrame(() => $('access').focus());
}

type ApiResult<P extends string> = P extends '/api/browsers' ? { devices: PairedBrowser[]; currentId: string | null } : P extends '/api/browsers/pair' ? PairInvite : P extends '/api/status' ? StatusResponse
  : P extends `/api/calls${string}` ? CallsResponse : P extends '/api/live' ? LiveResponse
  : P extends '/api/context' ? Snapshot : P extends `/api/projects${string}` ? Overview & { pending?: boolean; generation?: string }
  : P extends `/api/settings/${string}` ? VoiceSettingsResponse
  : Record<string, unknown>;
async function api<P extends string>(path: P, data?: Record<string, unknown>, signal?: AbortSignal): Promise<ApiResult<P>> {
  const selected = backend, generation = viewGeneration;
  const url = path + (path.includes('?') ? '&' : '?') + 'backend=' + encodeURIComponent(String(data?.backend || selected));
  let response;
  try {
    response = await fetch(url, data === undefined ? { signal } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data), signal });
  } catch { throw new Error(t('api.unreachable')); }
  const result: Record<string, unknown> = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) showLogin();
    // `reason` lets a caller translate a known server refusal.
    throw Object.assign(new Error(String(result.error || t('api.httpError', { status: response.status }))), { reason: result.reason });
  }
  if (generation !== viewGeneration) throw new Error(t('api.viewChanged'));
  return result as ApiResult<P>;
}
interface ToolGroup { details: HTMLDetailsElement; summary: HTMLElement; count: number }
// stamped: the head shows the call's time (a tool run can open a call view
// before its first stored turn).
interface CallView { box: HTMLElement; head: HTMLElement; items: CallEvent[]; stamped: boolean }
// The "Conversation" panel shows the calls of this conversation and nothing
// else: what the user and the agent said (stored `transcript` events) and the
// tools the agent ran (`voice-tool`), each group right after the turn it
// followed. Rebuilt from /api/calls on boot and extended live from the event
// stream; every event is drawn once and only in its ADE and conversation.
// Items follow their position in the call (`order`, fixed when the provider
// created them), not the time they were stored: a user transcript completes
// after the answer it prompted. Only final transcripts are drawn: live
// transcript deltas never reach the panel, so it never shows words that are
// still being recognized, or text the provider streamed ahead of the audio.
const calls = new Map<string, CallView>();
const position = (event: CallEvent) => event.data.order;
const shownEvents = new Set<number>();
const toolStatus = (status: string) => { const key = `tool.${status}`; return isMessageKey(key) ? t(key) : status; };
const dateTime = (value: string | number) => new Date(value).toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' });
function inView(data: { backend: string; conversationId: string }) {
  return data.backend === backend && data.conversationId === conversationId;
}
function stamp(at: string | undefined, format: (value: string) => string) {
  const t = el('time', null, at ? format(at) : ''); if (at) t.dateTime = at; return t;
}
function resetCalls() {
  for (const { box } of calls.values()) box.remove();
  calls.clear(); shownEvents.clear(); $('calls-truncated').hidden = true;
}
function callView(id: string, at?: string) {
  let view = calls.get(id);
  if (!view) {
    const box = el('article', 'call-log'); box.dataset.call = id;
    const head = el('h3', 'call-head', t('conversation.call')); if (at) head.append(' · ', stamp(at, dateTime));
    box.append(head); $('messages').append(box);
    view = { box, head, items: [], stamped: !!at }; calls.set(id, view);
  } else if (at && !view.stamped) { view.head.append(' · ', stamp(at, dateTime)); view.stamped = true; }
  return view;
}
// Tool results already carry annotated text; parameters read as "clave: valor".
function readableTool(value: unknown): string {
  if (value && typeof value === 'object') {
    const content = (value as { content?: unknown }).content;
    if (Array.isArray(content) && content.every(part => part && typeof part.text === 'string')) return content.map(part => part.text).join('\n');
    if (!Array.isArray(value)) return Object.entries(value).map(([key, item]) => `${key}: ${typeof item === 'string' ? item : JSON.stringify(item)}`).join('\n') || '—';
  }
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}
function toolEntry(run: VoiceToolData) {
  const entry = el('details', 'tool-entry'); entry.dataset.call = run.callId; entry.dataset.key = `tool:${run.callId}`;
  entry.append(el('summary', null, `${run.name} · ${toolStatus(run.status)}`));
  for (const [part, title, value] of [['args', t('conversation.parameters'), run.args], ['result', t('conversation.result'), run.result], ['delivered', t('conversation.receipt'), run.delivered]] as const) {
    if (value === undefined) continue;
    entry.append(el('p', 'fine', title), el('pre', null, readableTool(value)));
    const raw = el('details', 'tool-raw'); raw.dataset.key = `raw:${run.callId}:${part}`; raw.append(el('summary', null, 'JSON'), el('pre', null, JSON.stringify(value, null, 2))); entry.append(raw);
  }
  return entry;
}
function receiveCallEvent(event: CallEvent) {
  if (shownEvents.has(event.id) || !inView(event.data)) return;
  shownEvents.add(event.id); emptyState.remove();
  const log = $('messages');
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 160;
  const view = event.type === 'transcript' ? callView(event.data.call, event.data.at) : callView(event.data.id);
  let i = view.items.length;
  while (i > 0 && position(view.items[i - 1]) > position(event)) i--;
  view.items.splice(i, 0, event);
  drawCall(view);
  if (nearBottom) log.scrollTop = log.scrollHeight;
}
// Redraws one call in order; tools between two turns share one group. What
// the user had open stays open.
function drawCall(view: CallView) {
  const open = new Set([...view.box.querySelectorAll<HTMLDetailsElement>('details[open]')].map(d => d.dataset.key));
  const nodes: HTMLElement[] = [view.head]; let group: ToolGroup | null = null;
  for (const item of view.items) {
    if (item.type === 'transcript') {
      const { role, text, at } = item.data;
      const message = el('div', `message ${role === 'user' ? 'user' : 'assistant'}`);
      const meta = el('small', null, t(role === 'user' ? 'conversation.you' : 'conversation.agent')); if (at) meta.append(stamp(at, time));
      message.append(meta, linkify(text));
      const turn = el('div', 'turn'); turn.append(message); nodes.push(turn);
      group = null; // Tools run after this turn go below it.
      continue;
    }
    if (!group) {
      const details = el('details', 'tool-details'), summary = el('summary'); details.dataset.key = `group:${item.data.callId}`;
      details.append(summary); nodes.push(details); group = { details, summary, count: 0 };
    }
    group.count++; group.summary.textContent = t('conversation.tools', { count: group.count });
    group.details.append(toolEntry(item.data));
  }
  view.box.replaceChildren(...nodes);
  for (const d of view.box.querySelectorAll<HTMLDetailsElement>('details')) if (open.has(d.dataset.key)) d.open = true;
}

function threadRow(href: string, title: string, status?: string) {
  const a = el('a', 'thread-link'); a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer';
  a.append(el('span', null, title));
  if (status) { const s = el('span', 'thread-status', threadStatus(status)); if (ACTIVE_THREAD.includes(status)) s.dataset.active = ''; a.append(s); }
  a.append(icon('out')); a.setAttribute('aria-label', t('projects.opensAde', { label: `${title}${status ? `, ${threadStatus(status)}` : ''}` }));
  return a;
}
let projectRequest = 0;
async function projects() {
  const generation = viewGeneration, request = ++projectRequest;
  const current = () => generation === viewGeneration && request === projectRequest;
  discovered('loading');
  $('projects-updated').textContent = t('projects.checking');
  const contextRead = refreshThreads(current);
  $('refresh').disabled = true; $('refresh').setAttribute('aria-busy', 'true');
  try {
    let result = await api('/api/projects?progressive=1') as Overview & { pending?: boolean; generation?: string };
    while (current()) {
      discovered(result.pending ? 'loading' : result.discovery?.complete === false ? 'partial' : 'ready');
      const partial = result.discovery?.complete === false;
      const latest = (spaces: Workspace[]) => Math.max(0, ...spaces.map(w => Date.parse(w.updated || '') || 0));
      const rows = result.projects.map(project => {
        const spaces = result.workspaces.filter(w => w.projectId === project.id);
        return { project, spaces, active: spaces.filter(w => w.activeTerminals), updated: latest(spaces) };
      }).sort((a, b) => (b.active.length - a.active.length) || (b.updated - a.updated));
      $('projects').replaceChildren(...rows.map(({ project, spaces, active }) => {
        const item = el('div', 'project'); if (active.length) item.dataset.active = '';
        const row = el('div', 'project-main');
        const count = partial ? (spaces.length ? t('projects.atLeast', { count: spaces.length }) : t('projects.toVerify')) : t(spaces.length === 1 ? 'projects.threadOne' : 'projects.threadMany', { count: spaces.length });
        // Idle projects show only their threads: running ones are already marked.
        const activity = active.length ? t('projects.running', { count: active.length }) : partial ? t('projects.activityUnverified') : '';
        const meta = activity ? `${count} · ${activity}` : count;
        row.append(el('span', 'project-name', project.name), el('span', 'project-meta', meta));
        item.append(row);
        const links = active.map(w => ({ w, href: safeLink(w.link) })).filter(x => x.href);
        if (links.length) {
          const list = el('ul', 'project-threads');
          for (const { w, href } of links.slice(0, 3)) { const li = el('li'); li.append(threadRow(href!, w.name || t('projects.untitled'), w.cardStatus)); list.append(li); }
          if (links.length > 3) list.append(el('li', 'project-more', t('projects.more', { count: links.length - 3 })));
          item.append(list);
        }
        return item;
      }));
      if (!rows.length) $('projects').append(el('p', 'list-empty', t(partial ? 'projects.incomplete' : 'projects.none')));
      $('projects-updated').textContent = result.pending ? t('projects.checkingActivity', { time: time(Date.now()) }) : partial ? t('projects.partialRead', { time: time(Date.now()) }) : time(Date.now());
      $('projects-updated').title = t('projects.lastRead');
      if (!result.pending) break;
      await new Promise(resolve => setTimeout(resolve, 500));
      if (!current()) return;
      result = await api(`/api/projects?progressive=1&generation=${encodeURIComponent(result.generation!)}`);
    }
  } catch (e) { if (current()) { discovered('unreachable'); notice(errorMessage(e)); $('projects-updated').textContent = t('projects.notUpdated'); } }
  finally { if (current()) { $('refresh').disabled = false; $('refresh').removeAttribute('aria-busy'); } }
  await contextRead;
}
async function refreshThreads(current: () => boolean) {
  try {
    const context = await api('/api/context') as Snapshot;
    if (!current()) return;
    if (context.status === 'stale') { notice(t('projects.contextStale')); return; }
    const rows = [];
    for (const thread of context.tracked || []) {
      const href = thread.link && safeLink(thread.link); if (!href) continue;
      rows.push(threadRow(href, thread.role === 'main' ? t('projects.main', { name: thread.project || thread.title || t('projects.noProject') }) : thread.project || thread.title || t('projects.noProject'), thread.terminalStatus || thread.status));
    }
    $('threads').replaceChildren(...rows); $('threads-title').hidden = !rows.length;
  } catch (e) { if (current()) notice(errorMessage(e)); }
}
// The stage names the server's voice settings (changed in Settings → Voice).
const REASONING = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const;
function renderModel(status: Pick<StatusResponse, 'voiceModel'>) {
  const m = status.voiceModel;
  $('voice-name').textContent = m.model ? modelName(m.model) : 'GPT Realtime';
  // Gemini Live and ElevenLabs Realtime have no reasoning setting.
  const level = m.provider !== 'realtime' ? undefined : REASONING.find(r => r === m.reasoning);
  $('voice-reasoning').textContent = level ? t('stage.reasoning', { level: t(`reasoning.${level}`) }) : '';
  $('voice-reasoning').hidden = !level;
  // The language the call speaks and transcribes: the one chosen in Settings,
  // or the browser's (then marked as such).
  const preference = storedPreference(localStorage), code = voiceLanguages(navigator, preference)[0]?.split('-')[0];
  const display = (() => { try { return code ? new Intl.DisplayNames([locale()], { type: 'language' }).of(code) || '' : ''; } catch { return code || ''; } })();
  const name = display.charAt(0).toLocaleUpperCase(locale()) + display.slice(1);
  $('voice-language').textContent = name && preference === 'auto' ? t('stage.languageBrowser', { language: name }) : name;
  $('voice-language').hidden = !name;
}
// The voice model, reasoning chip and call availability, from /api/status: on
// boot and after Settings changes the voice or the key.
function showVoice(status: StatusResponse) {
  renderModel(status);
  voiceReady = !!status.voiceReady; voiceProvider = status.voiceModel.provider || 'realtime';
  const direct = !!status.ades.find(ade => ade.id === backend)?.direct;
  if (callId || stream || restarting) return;
  $('call').disabled = !voiceReady;
  if (voiceReady) setCall('idle', ''); else setCall('unavailable', direct ? t(voiceProvider === 'gemini' ? 'call.configureGeminiKey' : voiceProvider === 'elevenlabs' ? 'call.configureElevenLabsKey' : 'call.configureKey') : t('call.voiceNotYet', { ade: adeName() }));
}
async function boot() {
  const generation = ++viewGeneration;
  try {
    const status = await api('/api/status') as StatusResponse;
    if (generation !== viewGeneration) return;
    notice(status.availability?.error || status.limitation || '');
    renderAdes(status.ades); adeSwitch.hidden = false;
    adeCapabilities = status.ades.find(ade => ade.id === backend)?.capabilities || {};
    conversationId = status.conversation.id;
    showVoice(status);
    $('session-status').textContent = status.lastCall?.endedAt && status.lastCall.conversationId === conversationId ? t('session.lastCall', { time: dateTime(status.lastCall.endedAt) }) : '';
    resetCalls(); $('messages').append(emptyState);
    $('login').hidden = true; $('workspace').hidden = false;
    discovered(status.runtime);
    // Stored up to the cursor; the stream sends everything after it. The
    // stream opens first and its events wait until the history is drawn: a
    // failed history read leaves the call live, never without updates.
    let held: MessageEvent[] | null = [];
    eventSource?.close(); eventSource = new EventSource('/api/events?after=' + status.eventCursor);
    eventSource.onmessage = message => { if (held) held.push(message); else live(message); };
    const live = ({ data, lastEventId }: MessageEvent) => {
      if (generation !== viewGeneration) return;
      sessionStorage.setItem('eventCursor', lastEventId);
      const event = JSON.parse(data);
      if (event.data.backend && event.data.backend !== backend) return;
      if (event.data.conversationId && event.data.conversationId !== conversationId && event.type !== 'conversation') return;
      // A restart reloads the page itself: a second, concurrent reload here would
      // race it and leave the restart in the old conversation.
      if (event.type === 'conversation' && event.data.backend === backend && event.data.id !== conversationId) { if (!restarting) { cleanup(); void boot(); } return; }
      if (event.type === 'voice' && event.data.backend === backend && event.data.conversationId === conversationId) $('session-status').textContent = t(event.data.status === 'connected' ? 'session.callStarted' : 'session.callEnded', { time: dateTime(event.data.at) });
      if (event.type === 'transcript' || event.type === 'voice-tool') receiveCallEvent(event);
      if (event.type === 'voice-tool' && event.data.id === callId) recordings.current?.event('voice_tool', { name: event.data.name, status: event.data.status });
      // An accepted delivery changes what the ADE shows.
      if (event.type === 'voice-tool' && event.data.delivered) void projects();
      if (event.type === 'notice') notice(event.data.text);
      if (event.type === 'voice' && event.data.id === callId) recordings.current?.event('server_voice', { status: event.data.status });
      if (event.type === 'voice' && event.data.id === callId && ['closed', 'closed_unconfirmed', 'disconnected'].includes(event.data.status)) {
        cleanup();
        if (event.data.status === 'closed') setCall('ended', endedText());
        else setCall('dropped', t('call.callAgain'));
      }
    };
    eventSource.onerror = () => {
      recordings.current?.event('server_events_disconnected');
      setConnection('wait', t('connection.reconnecting'));
      void api('/api/status').catch(() => { /* A revoked session returns to pairing through api(). */ });
    };
    eventSource.onopen = () => { recordings.current?.event('server_events_connected'); showRuntime(); };
    void projects();
    try {
      const stored = await api(`/api/calls?through=${status.eventCursor}`);
      if (generation !== viewGeneration) return;
      for (const event of stored.events) receiveCallEvent(event);
      $('calls-truncated').hidden = !stored.truncated;
    } catch (e) {
      if (generation === viewGeneration) notice(t('conversation.historyFailed', { error: errorMessage(e) }));
    } finally {
      const waiting = held || []; held = null;
      for (const message of waiting) live(message);
    }
  } catch (e) {
    if (generation !== viewGeneration) return;
    if (!$('login').hidden) setConnection('locked', t('connection.private'));
    else { notice(errorMessage(e)); if ($('workspace').hidden) setConnection('offline', t('connection.noServer')); }
  }
}
$('reveal').onclick = () => {
  const show = $('access').type === 'password'; $('access').type = show ? 'text' : 'password';
  $('reveal').setAttribute('aria-pressed', String(show)); $('reveal').textContent = t(show ? 'login.hide' : 'login.show');
};
$('login-form').onsubmit = async e => {
  e.preventDefault(); $('login-submit').disabled = true; $('login-submit').textContent = t('login.checking');
  try { await api('/api/pair', { code: $('access').value }); $('access').value = ''; $('access').type = 'password'; $('reveal').textContent = t('login.show'); $('reveal').setAttribute('aria-pressed', 'false'); notice(''); await boot(); }
  catch (error) { notice(errorMessage(error)); $('access').select(); }
  finally { $('login-submit').disabled = false; $('login-submit').textContent = t('login.submit'); }
};
$('refresh').onclick = projects;

async function selectAde(selected: string | undefined) {
  if (selected === backend || !adeOptions().some(option => option.dataset.ade === selected)) return;
  if (stream) {
    markAde(); if (adeSwitch.contains(document.activeElement)) adeOptions().find(option => option.tabIndex === 0)?.focus();
    notice(t('ade.switchDuringCall')); return;
  }
  viewGeneration++; eventSource?.close(); backend = selected!; localStorage.setItem('ade', backend);
  applyAde(true);
  $('projects').replaceChildren(); $('threads').replaceChildren();
  // The other ADE's calls never stay on screen, even if its status fails to load.
  resetCalls(); $('messages').append(emptyState);
  await boot();
}
adeSwitch.onclick = e => { const option = (e.target as HTMLElement).closest<HTMLElement>('[role="radio"]'); if (option) void selectAde(option.dataset.ade); };
adeSwitch.onkeydown = e => {
  const options = adeOptions(), current = options.indexOf(e.target as HTMLElement), step = ({ ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 } as Record<string, number>)[e.key];
  if (current < 0 || (!step && !['Home', 'End'].includes(e.key))) return;
  e.preventDefault();
  const next = options[e.key === 'Home' ? 0 : e.key === 'End' ? options.length - 1 : (current + step + options.length) % options.length];
  next.focus(); void selectAde(next.dataset.ade);
};
function cleanup() {
  recordings.current?.event('final_diagnostics', liveDiagnostics());
  recordings.stop('call_cleanup'); recordings.idle();
  callGeneration++; liveHealth?.close(); liveHealth = null; relay?.close(); relay = null; speechGate?.close(); speechGate = null; playback = null;
  $('new-session').disabled = false; $('restart-session').hidden = true; $('restart-session').disabled = false;
  wakeLock?.release(); wakeLock = null;
  clearInterval(heartbeat);
  stream?.getTracks().forEach(track => track.stop()); stream = null;
  const closing = channel; channel = null; closing?.close(); peer?.close(); peer = null; callId = null;
  $('audio').srcObject = null; $('audio').hidden = true;
  $('call').hidden = false; $('call').disabled = !voiceReady; $('hangup').hidden = true; $('mute').hidden = true;
  clearInterval(callTimer); callStartedAt = 0; $('call-timer').hidden = true; $('call-timer').textContent = '';
  setMuted(false); delete stage.dataset.voice; document.body.classList.remove('in-call');
  setCall('ended', '');
}
function liveDiagnostics() {
  const transport = liveHealth?.snapshot() || relay?.diagnostics();
  return transport ? { ...transport, ...speechGate?.diagnostics(), ...playback?.diagnostics(), localGateActive: !!speechGate?.speaking, pageHidden: document.hidden } : undefined;
}
// Every 10 s: the keepalive the server needs (45 s without one ends the call), with diagnostics.
function startHeartbeat(generation: number, liveId: string, health: LiveHealth | null) {
  let heartbeatPending = false, heartbeatFailures = 0;
  heartbeat = setInterval(() => {
    if (generation !== callGeneration || heartbeatPending) return;
    // Stats collection never delays the keepalive and never opens another call.
    if (health) void health.sample().then(() => { if (generation === callGeneration) recordings.current?.event('audio_health', liveDiagnostics()); });
    else recordings.current?.event('audio_health', liveDiagnostics());
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 5000);
    heartbeatPending = true;
    void api('/api/live/heartbeat', { id: liveId, diagnostics: liveDiagnostics() }, controller.signal).then(result => {
      if (generation !== callGeneration) return;
      heartbeatFailures = 0;
      if (result.active === false) void closeCall('server_session_missing');
    }).catch(() => {
      if (generation === callGeneration) recordings.current?.event('heartbeat_failed');
      if (generation === callGeneration && ++heartbeatFailures === 2) notice(t('call.serverUnconfirmed'));
    }).finally(() => { clearTimeout(deadline); heartbeatPending = false; });
  }, 10_000);
}
// The language fields of POST /api/live.
const callLanguages = () => ({ languages: voiceLanguages(navigator, storedPreference(localStorage)), ...(storedPreference(localStorage) !== 'auto' ? { language: storedPreference(localStorage) } : {}) });
// Gemini Live and ElevenLabs Realtime: the server opens the provider session
// first, then this page streams audio to it over a WebSocket. There is no WebRTC leg.
async function startRelayedCall(generation: number, acquired: MediaStream) {
  const result = await api('/api/live', { provider: voiceProvider, backend, conversationId, ...callLanguages() }) as LiveResponse;
  if (generation !== callGeneration) { await api('/api/live/close', { id: result.session.id }); return; }
  if (!result.transport.stream) throw new Error(t('call.prepareFailed'));
  const liveId = callId = result.session.id;
  recordings.current?.identify(liveId);
  const call = relay = new RelayedCall({ url: streamUrl(result.transport.stream, backend), stream: acquired, audio: $('audio'),
    isCurrent: () => generation === callGeneration,
    onLive: () => {
      play('connected'); listening(); $('hangup').disabled = false;
      void api('/api/live/ready', { id: liveId }).catch(() => { if (generation === callGeneration) notice(t('call.greetingUnconfirmed')); });
    },
    onClose: cause => { void closeCall(cause); },
    onEvent: event => { recordings.current?.event('provider_event', { type: event.type }); },
    onAutoplayBlocked: () => { recordings.current?.event('autoplay_blocked'); $('audio').hidden = false; notice(t('call.autoplayBlocked')); } });
  await call.start();
  if (generation !== callGeneration) return;
  const remote = call.remote();
  if (remote) { recordings.current?.remoteStream(remote); speechGate?.setRemote(remote); }
  startHeartbeat(generation, liveId, null);
  callControls();
}
async function closeCall(cause: LiveCloseCause = 'user_hangup') {
  const id = callId, diagnostics = liveDiagnostics();
  recordings.current?.event('call_closed', { cause });
  // Silence and release the microphone immediately, even with no network.
  try { if (channel?.readyState === 'open') channel.send(JSON.stringify({ type: 'session.close' })); } catch { /* Transport may have failed between the state check and send. */ }
  cleanup();
  if (cause === 'user_hangup' || cause === 'provider_closed') setCall('ended', endedText());
  else setCall('dropped', t('call.voiceClosed'));
  if (id) try { await api('/api/live/close', { id, cause, diagnostics }); }
  catch { notice(t('call.audioClosed')); }
  if (languageChanged) location.reload();
}
// Hangs up any call and waits for its close before asking for a new
// conversation: the server refuses while a call is active. Returns the new
// conversation id once the page shows it, or null after reporting the error.
async function newSession(afterHangUp?: () => void): Promise<string | null> {
  $('new-session').disabled = true;
  try {
    await closeCall(); $('new-session').disabled = true; afterHangUp?.();
    if (languageChanged) return null; // closeCall is reloading the page.
    const { conversation } = await api('/api/conversation/new', { backend, conversationId }) as { conversation: { id: string } };
    notice(t('session.started')); await boot();
    return conversation.id;
  } catch (error) { notice(errorMessage(error)); return null; }
  finally { $('new-session').disabled = false; }
}
$('new-session').onclick = () => { void newSession(); };
// In-call new session: hang up, open a fresh conversation, then call again so
// the voice starts with no memory of the previous session. Each step runs once;
// a failure stops the chain and leaves the page idle.
// No confirmation: one tap must be enough, even while driving. The session tone
// plays at the tap itself (browsers only allow sound inside the gesture) and the
// screen says the new session is starting until the new call connects.
async function restartSession() {
  if (!callId || restarting) return;
  restarting = true; play('session');
  $('restart-session').disabled = true;
  try {
    const id = await newSession(() => setCall('connecting', t('session.restarting')));
    // Another reload may have superseded ours before it read the new conversation.
    if (id && id !== conversationId && !languageChanged) await boot();
    // A stale page (boot failed) or a pending reload must not call into the old conversation.
    if (id && id === conversationId && voiceReady && !languageChanged && !stream) { restarting = false; await startCall(); return; }
    if (id && !languageChanged) { setCall(voiceReady ? 'idle' : 'unavailable', ''); notice(t('session.restartNoCall')); }
  } finally { restarting = false; $('restart-session').disabled = false; }
}
$('restart-session').onclick = () => { void restartSession(); };
const listening = () => setCall('live', t('call.listening'));
async function startCall() {
  const generation = ++callGeneration;
  $('call').disabled = true; $('new-session').disabled = true; notice(''); setCall('connecting', t('call.requestingMicrophone'));
  try {
    if (!navigator.mediaDevices) throw new Error(t('call.httpsRequired'));
    const acquiredStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    if (generation !== callGeneration) { acquiredStream.getTracks().forEach(t => t.stop()); return; }
    stream = acquiredStream;
    await recordings.start(stream, { provider: voiceProvider, backend, conversationId });
    if (generation !== callGeneration) return;
    setCall('connecting', t('call.opening'));
    playback = new PlaybackControl(speaking => {
      recordings.current?.event('local_speech', { speaking });
      if (speaking && !muted) stage.dataset.voice = 'user'; else delete stage.dataset.voice;
    });
    const currentPlayback = playback;
    let diagnosticVoice = false, diagnosticOutput = false, diagnosticMuted = false;
    speechGate = new SpeechGate({
      onStart: () => currentPlayback.automaticStart(), onEnd: () => currentPlayback.end(), onActivity: activity => {
        if (activity.voice !== diagnosticVoice || activity.output !== diagnosticOutput || $('audio').muted !== diagnosticMuted) {
          diagnosticVoice = activity.voice; diagnosticOutput = activity.output; diagnosticMuted = $('audio').muted;
          recordings.current?.event('audio_activity', { microphoneSpeech: diagnosticVoice, outputEnergy: diagnosticOutput, outputMuted: diagnosticMuted });
        }
      } });
    await speechGate.start(stream);
    if (generation !== callGeneration) return;
    const acquiredLock = await navigator.wakeLock?.request('screen').catch(() => null);
    if (generation !== callGeneration) { acquiredLock?.release(); return; }
    wakeLock = acquiredLock;
    if (voiceProvider !== 'realtime') { await startRelayedCall(generation, acquiredStream); return; }
    peer = new RTCPeerConnection();
    const health = new LiveHealth(peer, $('audio')); liveHealth = health;
    let connectionInterrupted = false;
    peer.ontrack = ({ track }) => { if (generation !== callGeneration) return; const remote = new MediaStream([track]); recordings.current?.remoteStream(remote); speechGate?.setRemote(remote); $('audio').srcObject = remote; $('audio').play().catch(() => { if (generation !== callGeneration) return; recordings.current?.event('autoplay_blocked'); $('audio').hidden = false; notice(t('call.autoplayBlocked')); }); };
    for (const track of stream.getAudioTracks()) peer.addTrack(track, stream);
    const currentPeer = peer;
    channel = peer.createDataChannel('oai-events');
    const liveEvents = bindLiveEvents({ channel, peer: currentPeer,
      isCurrent: () => generation === callGeneration,
      ready: id => api('/api/live/ready', { id }),
      onLive: () => { play('connected'); listening(); $('hangup').disabled = false; },
      onClose: cause => { void closeCall(cause); }, onError: notice,
      onConnectionState: state => {
        recordings.current?.event('connection_state', { state });
        health.connectionChanged(state);
        if (state === 'disconnected') { connectionInterrupted = true; setCall('connecting', t('call.recovering')); }
        else if (state === 'connected' && connectionInterrupted) { connectionInterrupted = false; listening(); }
      },
      onEvent: event => {
        recordings.current?.event('provider_event', { type: event.type, ...(event.type.includes('transcript') ? { text: event.delta } : {}), ...(event.error?.code ? { code: event.error.code } : {}) });
        if (event.type === 'error') notice(t('call.voiceReported', { code: event.error?.code || t('call.connectionError') }));
      }
    });
    await currentPeer.setLocalDescription(await currentPeer.createOffer());
    if (generation !== callGeneration) return;
    if (currentPeer.iceGatheringState !== 'complete') await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(t('call.prepareFailed'))), 12_000);
      currentPeer.addEventListener('icegatheringstatechange', function onState() {
        if (currentPeer.iceGatheringState === 'complete') { clearTimeout(timeout); currentPeer.removeEventListener('icegatheringstatechange', onState); resolve(); }
      });
    });
    if (generation !== callGeneration) return;
    const result = await api('/api/live', { provider: 'realtime', sdp: currentPeer.localDescription!.sdp, backend, conversationId, ...callLanguages() }) as LiveResponse;
    if (generation !== callGeneration) { await api('/api/live/close', { id: result.session.id }); return; }
    callId = result.session.id;
    recordings.current?.identify(callId!);
    liveEvents.setId(callId!);
    startHeartbeat(generation, callId!, health);
    await currentPeer.setRemoteDescription({ type: 'answer', sdp: result.transport.sdp || '' });
    void health.sample();
    if (generation !== callGeneration) return;
    callControls();
  } catch (error) {
    if (generation !== callGeneration) return;
    if (callId) await api('/api/live/close', { id: callId, cause: 'transport_failed', diagnostics: liveDiagnostics() }).catch(() => {});
    if (generation !== callGeneration) return;
    recordings.current?.event('call_failed', { name: error instanceof Error ? error.name : 'unknown' });
    cleanup(); notice(error instanceof Error && error.name === 'NotAllowedError' ? t('call.microphoneDenied') : errorMessage(error));
    setCall('error', '');
  }
}
// The call tone plays inside the tap, which also unlocks the connection tone.
$('call').onclick = () => { play('call'); void startCall(); };
function callControls() {
    $('restart-session').hidden = false; $('restart-session').disabled = false;
    setMuted(false); $('call').hidden = true; $('hangup').hidden = false; $('hangup').disabled = false; $('mute').hidden = false;
    document.body.classList.add('in-call');
}
$('hangup').onclick = () => { void closeCall(); };
$('mute').onclick = () => { setMuted(!muted); if (muted) delete stage.dataset.voice; stream?.getAudioTracks().forEach(track => { track.enabled = !muted; }); };
document.addEventListener('visibilitychange', () => recordings.current?.event('visibility', { hidden: document.hidden }));
window.addEventListener('pagehide', () => { recordings.stop('page_unloaded', true); if (callId) navigator.sendBeacon('/api/live/close?backend=' + encodeURIComponent(backend), new Blob([JSON.stringify({ id: callId, cause: 'page_unloaded', diagnostics: liveDiagnostics() })], { type: 'application/json' })); });
// Read the one-use pairing code from the fragment, then remove it immediately.
// Merely opening/scanning a link never authorizes a browser; require explicit submit.
const fragment = new URLSearchParams(location.hash.slice(1));
if (fragment.has('pair')) {
  const code = fragment.get('pair'); history.replaceState(null, '', location.pathname);
  if (code) $('access').value = code;
}
// Paired browsers in Settings. Rows are built by browser-list.ts from text only.
let browsersRequest = 0;
async function refreshBrowsers() {
  const list = $('browser-list'), button = $('refresh-browsers'), request = ++browsersRequest;
  if (!list.querySelector('.device')) list.replaceChildren(browserNote('browsers.loading'));
  button.setAttribute('aria-busy', 'true');
  try {
    const result = await api('/api/browsers');
    if (request !== browsersRequest) return;
    list.replaceChildren(...browserRows(result.devices, result.currentId, async device => {
      if (!confirm(t('browsers.confirmUnpair', { name: device.name }))) return;
      try { await api('/api/browsers/revoke', { id: device.id }); await refreshBrowsers(); } catch (error) { notice(errorMessage(error)); }
    }));
  } catch (error) {
    if (request === browsersRequest && !list.querySelector('.device')) list.replaceChildren(browserNote('browsers.loadFailed'));
    notice(errorMessage(error));
  } finally { if (request === browsersRequest) button.removeAttribute('aria-busy'); }
}
$('refresh-browsers').onclick = refreshBrowsers;
// "Pair another device": a one-use link for another browser, created by the server
// with its configured address. Closing Settings removes the code from the page.
const pairDevice = new PairDevice({
  create: name => api('/api/browsers/pair', { name }),
  devices: async () => (await api('/api/browsers')).devices,
  refreshList: () => { if ($('settings').open) void refreshBrowsers(); }
});
$('settings').addEventListener('close', () => pairDevice.dismiss());

// Server-wide voice settings and the OpenAI, Gemini and ElevenLabs keys. The server refuses changes while
// any call is active or connecting (409), so the form locks during this
// browser's call and when the server reports one; a call keeps what it began with.
const VOICE_SELECTS = { model: 'setting-model', reasoning: 'setting-reasoning', voice: 'setting-voice', eagerness: 'setting-eagerness', noiseReduction: 'setting-noise', transcriptionModel: 'setting-transcription', geminiVoice: 'setting-gemini-voice',
  elevenlabsVoice: 'setting-elevenlabs-voice' } as const;
let voiceSaved: VoiceSettingsResponse | null = null, settingsBusy = false, settingsRequest = 0;
const instructionsSync = new InstructionsSync();
// Each voice choice is saved as soon as it is made, one request at a time and in order.
const pendingVoice: Partial<VoiceValues> = {};
let voiceQueue: Promise<void> = Promise.resolve();
const settingRow = (field: VoiceSettingField) => $(VOICE_SELECTS[field]).closest<HTMLElement>('.setting')!;
function rowState(field: VoiceSettingField, state: 'saving' | 'saved' | 'error' | '') {
  const row = settingRow(field), mark = row.querySelector<HTMLElement>('.setting-saved')!;
  if (state) row.dataset.state = state; else delete row.dataset.state;
  mark.textContent = state === 'saving' ? t('settings.savingShort') : state === 'saved' ? t('settings.savedShort') : state === 'error' ? t('settings.errorShort') : '';
  clearTimeout(Number(row.dataset.timer || 0));
  if (state === 'saved') row.dataset.timer = String(setTimeout(() => rowState(field, ''), 2500));
}
// Only the settings of the chosen model's provider are shown; the others keep their values.
function showProviderRows(model: string) {
  const provider = modelProvider(model);
  for (const row of $('voice-form').querySelectorAll<HTMLElement>('.setting[data-provider]')) row.hidden = row.dataset.provider !== provider;
  for (const group of $('voice-form').querySelectorAll<HTMLElement>('.setting-group')) group.hidden = ![...group.querySelectorAll<HTMLElement>('.setting')].some(row => !row.hidden);
}
function saveVoiceField(field: VoiceSettingField, value: string) {
  if (field === 'model') showProviderRows(value);
  pendingVoice[field] = value; rowState(field, 'saving'); formStatus('voice-status', '');
  voiceQueue = voiceQueue.then(async () => {
    if (pendingVoice[field] !== value) return; // A later choice of the same field replaces this one.
    if (voiceSaved?.settings[field] === value) { delete pendingVoice[field]; rowState(field, 'saved'); return; }
    try {
      settingsRequest++;
      const result = await api('/api/settings/voice', { [field]: value }) as VoiceSettingsResponse;
      if (pendingVoice[field] === value) delete pendingVoice[field];
      showVoiceSettings(result); rowState(field, 'saved');
      void refreshVoice();
    } catch (error) {
      if (pendingVoice[field] === value) delete pendingVoice[field];
      rowState(field, 'error');
      formStatus('voice-status', errorMessage(error), 'error');
      if (voiceSaved) { $(VOICE_SELECTS[field]).value = voiceSaved.settings[field]; showProviderRows($('setting-model').value); }
      void loadVoiceSettings();
    }
  });
}
const localCall = () => !!(stream || callId || restarting) || stage.dataset.state === 'connecting';
type FormStatus = 'voice-status' | 'instructions-status' | 'key-status' | 'gemini-key-status' | 'elevenlabs-key-status';
type KeyButton = 'save-key' | 'remove-key' | 'save-gemini-key' | 'remove-gemini-key' | 'save-elevenlabs-key' | 'remove-elevenlabs-key' | 'save-instructions';
function formStatus(id: FormStatus, text: string, state: 'ok' | 'error' | '' = '') {
  const node = $(id); node.textContent = text; if (state) node.dataset.state = state; else delete node.dataset.state;
}
function lockSettings() {
  const locked = !voiceSaved || settingsBusy || localCall(), busy = (...ids: KeyButton[]) => ids.some(id => $(id).hasAttribute('aria-busy'));
  for (const id of Object.values(VOICE_SELECTS)) $(id).disabled = locked;
  for (const id of ['save-key', 'remove-key', 'openai-key'] as const) $(id).disabled = locked || busy('save-key', 'remove-key');
  for (const id of ['save-gemini-key', 'remove-gemini-key', 'gemini-key'] as const) $(id).disabled = locked || busy('save-gemini-key', 'remove-gemini-key');
  for (const id of ['save-elevenlabs-key', 'remove-elevenlabs-key', 'elevenlabs-key'] as const) $(id).disabled = locked || busy('save-elevenlabs-key', 'remove-elevenlabs-key');
  for (const id of ['save-instructions', 'custom-instructions'] as const) $(id).disabled = locked || busy('save-instructions');
  const note = locked && voiceSaved ? t('settings.inCall') : '';
  if (note || $('voice-status').textContent === t('settings.inCall')) formStatus('voice-status', note);
}
// The instructions textarea is filled only by loadVoiceSettings and by its own
// save, as InstructionsSync decides; other answers may be older than either.
function showVoiceSettings(result: VoiceSettingsResponse) {
  // This browser's own call locks the form by itself and unlocks it when it ends.
  voiceSaved = result; settingsBusy = result.busy && !localCall();
  for (const field of VOICE_FIELDS) {
    const select = $(VOICE_SELECTS[field]);
    select.replaceChildren(...result.options[field].map(value => { const option = el('option', null, optionLabel(field, value)); option.value = value; return option; }));
    // A choice still being saved keeps what the person picked.
    select.value = pendingVoice[field] ?? result.settings[field];
  }
  showProviderRows($('setting-model').value);
  const source = result.key.source || 'none';
  $('key-state').dataset.state = source;
  $('key-state').textContent = t(source === 'config' ? 'settings.keyConfigured' : source === 'env' ? 'settings.keyEnv' : 'settings.keyMissing');
  $('key-hint').textContent = t(source === 'config' ? 'settings.keyConfiguredHint' : source === 'env' ? 'settings.keyEnvHint' : 'settings.keyMissingHint');
  $('remove-key').hidden = source !== 'config';
  const gemini = result.geminiKey?.source || 'none';
  $('gemini-key-state').dataset.state = gemini;
  $('gemini-key-state').textContent = t(gemini === 'config' ? 'settings.keyConfigured' : gemini === 'env' ? 'settings.keyEnv' : 'settings.keyMissing');
  $('gemini-key-hint').textContent = t(gemini === 'config' ? 'settings.geminiKeyConfiguredHint' : gemini === 'env' ? 'settings.geminiKeyEnvHint' : 'settings.geminiKeyMissingHint');
  $('remove-gemini-key').hidden = gemini !== 'config';
  const eleven = result.elevenlabsKey?.source || 'none';
  $('elevenlabs-key-state').dataset.state = eleven;
  $('elevenlabs-key-state').textContent = t(eleven === 'config' ? 'settings.keyConfigured' : eleven === 'env' ? 'settings.keyEnv' : 'settings.keyMissing');
  $('elevenlabs-key-hint').textContent = t(eleven === 'config' ? 'settings.elevenlabsKeyConfiguredHint' : eleven === 'env' ? 'settings.elevenlabsKeyEnvHint' : 'settings.elevenlabsKeyMissingHint');
  $('remove-elevenlabs-key').hidden = eleven !== 'config';
  lockSettings();
}
async function loadVoiceSettings() {
  const request = ++settingsRequest, instructions = instructionsSync.loadStarted();
  if (!voiceSaved) formStatus('voice-status', t('settings.loading'));
  try {
    const result = await api('/api/settings/voice');
    if (instructionsSync.loadMayFill(instructions)) $('custom-instructions').value = result.instructions;
    if (request !== settingsRequest) return;
    formStatus('voice-status', ''); showVoiceSettings(result);
  } catch (error) { if (request === settingsRequest) formStatus('voice-status', t('settings.loadFailed') + ' ' + errorMessage(error), 'error'); }
}
// After a change the stage (model, reasoning, call button) follows /api/status.
async function refreshVoice() {
  try { showVoice(await api('/api/status')); } catch { /* The next boot or status poll shows it. */ }
}
async function saveSettings(button: KeyButton, status: FormStatus, path: '/api/settings/voice' | '/api/settings/key' | '/api/settings/instructions', data: Record<string, unknown>, done: string) {
  $(button).setAttribute('aria-busy', 'true'); lockSettings();
  formStatus(status, t('settings.saving'));
  try {
    settingsRequest++;
    const result = await api(path, data) as VoiceSettingsResponse;
    showVoiceSettings(result);
    formStatus(status, done, 'ok');
    void refreshVoice();
    return result;
  } catch (error) {
    formStatus(status, errorMessage(error), 'error');
    void loadVoiceSettings();
    return null;
  } finally { $(button).removeAttribute('aria-busy'); lockSettings(); }
}
$('voice-form').onsubmit = event => event.preventDefault();
for (const field of VOICE_FIELDS) $(VOICE_SELECTS[field]).onchange = () => saveVoiceField(field, $(VOICE_SELECTS[field]).value);
// Custom instructions: saved with their button; empty text removes them.
$('custom-instructions').oninput = () => { instructionsSync.input(); formStatus('instructions-status', ''); };
$('instructions-form').onsubmit = async event => {
  event.preventDefault();
  // Sent as typed: the server trims and validates it, and blank text removes it.
  // No maxlength on the textarea: it would cut pasted text before trimming,
  // so the limit is checked here on the trimmed text, as the server does.
  const instructions = $('custom-instructions').value, max = voiceSaved?.instructionsMax;
  if (max && instructions.trim().length > max) {
    formStatus('instructions-status', t('settings.instructionsTooLong', { max, count: instructions.trim().length }), 'error'); $('custom-instructions').focus(); return;
  }
  instructionsSync.saveStarted();
  const saved = await saveSettings('save-instructions', 'instructions-status', '/api/settings/instructions', { instructions }, t(instructions.trim() ? 'settings.instructionsSaved' : 'settings.instructionsCleared'));
  if (saved) { instructionsSync.saved(); $('custom-instructions').value = saved.instructions; }
};
function hideKey() { $('openai-key').type = 'password'; $('reveal-key').setAttribute('aria-pressed', 'false'); $('reveal-key').textContent = t('login.show'); }
$('reveal-key').onclick = () => {
  const show = $('openai-key').type === 'password';
  $('openai-key').type = show ? 'text' : 'password';
  $('reveal-key').setAttribute('aria-pressed', String(show)); $('reveal-key').textContent = t(show ? 'login.hide' : 'login.show');
};
// The typed key leaves the page only in this request and is cleared once saved.
$('key-form').onsubmit = async event => {
  event.preventDefault();
  const key = $('openai-key').value.trim();
  if (!key) { formStatus('key-status', t('settings.keyEmpty'), 'error'); $('openai-key').focus(); return; }
  if (await saveSettings('save-key', 'key-status', '/api/settings/key', { key }, t('settings.keySaved'))) { $('openai-key').value = ''; hideKey(); }
};
$('remove-key').onclick = () => {
  if (!confirm(t('settings.keyConfirmRemove'))) return;
  void saveSettings('remove-key', 'key-status', '/api/settings/key', { key: null }, t('settings.keyRemoved'));
};
// The Gemini API key, for Gemini Live models: the same rules as the OpenAI key.
function hideGeminiKey() { $('gemini-key').type = 'password'; $('reveal-gemini-key').setAttribute('aria-pressed', 'false'); $('reveal-gemini-key').textContent = t('login.show'); }
$('reveal-gemini-key').onclick = () => {
  const show = $('gemini-key').type === 'password';
  $('gemini-key').type = show ? 'text' : 'password';
  $('reveal-gemini-key').setAttribute('aria-pressed', String(show)); $('reveal-gemini-key').textContent = t(show ? 'login.hide' : 'login.show');
};
$('gemini-key-form').onsubmit = async event => {
  event.preventDefault();
  const key = $('gemini-key').value.trim();
  if (!key) { formStatus('gemini-key-status', t('settings.keyEmpty'), 'error'); $('gemini-key').focus(); return; }
  if (await saveSettings('save-gemini-key', 'gemini-key-status', '/api/settings/key', { provider: 'gemini', key }, t('settings.keySaved'))) { $('gemini-key').value = ''; hideGeminiKey(); }
};
$('remove-gemini-key').onclick = () => {
  if (!confirm(t('settings.geminiKeyConfirmRemove'))) return;
  void saveSettings('remove-gemini-key', 'gemini-key-status', '/api/settings/key', { provider: 'gemini', key: null }, t('settings.keyRemoved'));
};
// The ElevenLabs API key, for ElevenLabs Realtime: the same rules again.
function hideElevenLabsKey() { $('elevenlabs-key').type = 'password'; $('reveal-elevenlabs-key').setAttribute('aria-pressed', 'false'); $('reveal-elevenlabs-key').textContent = t('login.show'); }
$('reveal-elevenlabs-key').onclick = () => {
  const show = $('elevenlabs-key').type === 'password';
  $('elevenlabs-key').type = show ? 'text' : 'password';
  $('reveal-elevenlabs-key').setAttribute('aria-pressed', String(show)); $('reveal-elevenlabs-key').textContent = t(show ? 'login.hide' : 'login.show');
};
$('elevenlabs-key-form').onsubmit = async event => {
  event.preventDefault();
  const key = $('elevenlabs-key').value.trim();
  if (!key) { formStatus('elevenlabs-key-status', t('settings.keyEmpty'), 'error'); $('elevenlabs-key').focus(); return; }
  if (await saveSettings('save-elevenlabs-key', 'elevenlabs-key-status', '/api/settings/key', { provider: 'elevenlabs', key }, t('settings.keySaved'))) { $('elevenlabs-key').value = ''; hideElevenLabsKey(); }
};
$('remove-elevenlabs-key').onclick = () => {
  if (!confirm(t('settings.elevenlabsKeyConfirmRemove'))) return;
  void saveSettings('remove-elevenlabs-key', 'elevenlabs-key-status', '/api/settings/key', { provider: 'elevenlabs', key: null }, t('settings.keyRemoved'));
};

// Settings: language, voice, key, call recording and paired browsers. All but
// the language need a paired session, so they are hidden on the login screen.
$('ui-language').value = storedPreference(localStorage);
$('open-settings').onclick = () => {
  const signedIn = !$('workspace').hidden;
  $('settings').dataset.signedIn = String(signedIn);
  for (const block of $('settings').querySelectorAll<HTMLElement>('.settings-tabs, .settings-block[data-auth]')) block.hidden = !signedIn;
  showSettingsTab(signedIn ? settingsTab : 'general', false);
  formStatus('voice-status', ''); formStatus('instructions-status', ''); formStatus('key-status', ''); formStatus('gemini-key-status', ''); formStatus('elevenlabs-key-status', '');
  $('settings').showModal();
  if (signedIn) { void refreshBrowsers(); void loadVoiceSettings(); watchSettingsBusy(); }
};
// Closing forgets a typed key that was not saved.
$('settings').addEventListener('close', () => { $('openai-key').value = ''; hideKey(); $('gemini-key').value = ''; hideGeminiKey(); $('elevenlabs-key').value = ''; hideElevenLabsKey(); clearInterval(settingsBusyTimer); settingsBusyWatch++; });
// While Settings is open, a call another browser starts or ends locks or
// unlocks the form. Only the busy flag is refreshed: options and text being
// edited stay as they are.
// One poll at a time, and an answer from before the dialog was reopened or
// another settings request is dropped, so an old "busy" never locks it again.
let settingsBusyTimer = 0, settingsBusyWatch = 0, settingsBusyPolling = false;
function watchSettingsBusy() {
  clearInterval(settingsBusyTimer);
  const watch = ++settingsBusyWatch;
  settingsBusyTimer = window.setInterval(async () => {
    if (settingsBusyPolling || !$('settings').open || !voiceSaved) return;
    const request = settingsRequest;
    settingsBusyPolling = true;
    try {
      const { busy } = await api('/api/settings/voice') as VoiceSettingsResponse;
      if (watch !== settingsBusyWatch || request !== settingsRequest || !$('settings').open) return;
      settingsBusy = busy && !localCall(); lockSettings();
    } catch { /* The next tick or reopening Settings tries again. */ } finally { settingsBusyPolling = false; }
  }, 4000);
}
// Tabs: General (language, recording), Voice, API key and Devices. The last
// one chosen is reopened in this page; arrow keys move between tabs.
type SettingsTab = 'general' | 'voice' | 'key' | 'devices';
let settingsTab: SettingsTab = 'general';
const settingsTabs = () => [...$('settings').querySelectorAll<HTMLButtonElement>('[role="tab"]')];
function showSettingsTab(tab: SettingsTab, focus = true) {
  settingsTab = tab;
  for (const button of settingsTabs()) {
    const selected = button.dataset.tab === tab;
    button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1;
    if (selected && focus) button.focus();
  }
  for (const panel of $('settings').querySelectorAll<HTMLElement>('.settings-panel')) panel.hidden = panel.dataset.panel !== tab;
}
for (const button of settingsTabs()) {
  button.onclick = () => showSettingsTab(button.dataset.tab as SettingsTab, false);
  button.onkeydown = event => {
    const tabs = settingsTabs(), index = tabs.indexOf(button);
    const next = event.key === 'ArrowRight' ? index + 1 : event.key === 'ArrowLeft' ? index - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null;
    if (next === null) return;
    event.preventDefault(); showSettingsTab(tabs[(next + tabs.length) % tabs.length].dataset.tab as SettingsTab);
  };
}
$('close-settings').onclick = () => $('settings').close();
$('settings').addEventListener('click', event => { if (event.target === $('settings')) $('settings').close(); });
// The page is rebuilt in the new language by reloading it, never in the middle of a call.
$('ui-language').onchange = () => {
  storePreference($('ui-language').value, localStorage);
  if (stream || callId) { languageChanged = true; notice(t('settings.languageAfterCall')); } else location.reload();
};
$('logout').onclick = async () => {
  if (!confirm(t('browsers.confirmLogout'))) return;
  try { await api('/api/logout', {}); cleanup(); showLogin(); } catch (error) { notice(errorMessage(error)); }
};
// On narrow screens the transcript is not a scroll container (style.css), so a
// swipe always moves the page. Collapsed, it shows the latest turns and clips
// the older ones at the top; the toggle lets it grow with the page, keeping
// the toggle where the finger was.
const narrow = matchMedia('(max-width: 899px)');
const transcriptBox = () => $('messages').closest<HTMLElement>('.convo')!;
function fitTranscript() {
  const log = $('messages'), toggle = $('transcript-toggle');
  const expanded = transcriptBox().hasAttribute('data-expanded');
  if (!narrow.matches) { toggle.hidden = true; log.removeAttribute('data-clipped'); return; }
  // Older turns overflow above the top edge, where scrollHeight does not count them.
  const first = [...log.children].find(child => child.getClientRects().length);
  const clipped = !expanded && !!first && first.getBoundingClientRect().top < log.getBoundingClientRect().top - 1;
  log.toggleAttribute('data-clipped', clipped);
  toggle.hidden = !clipped && !expanded;
}
function expandTranscript(expanded: boolean) {
  const toggle = $('transcript-toggle'), before = toggle.getBoundingClientRect().top;
  transcriptBox().toggleAttribute('data-expanded', expanded);
  toggle.setAttribute('aria-expanded', String(expanded));
  fitTranscript();
  if (!toggle.hidden) window.scrollBy(0, toggle.getBoundingClientRect().top - before);
}
$('transcript-toggle').onclick = () => expandTranscript(!transcriptBox().hasAttribute('data-expanded'));
// Opening a tool inside the collapsed view would push it out of sight.
$('messages').addEventListener('toggle', event => {
  if (narrow.matches && (event.target as HTMLDetailsElement).open && !transcriptBox().hasAttribute('data-expanded')) expandTranscript(true);
  else fitTranscript();
}, true);
new MutationObserver(fitTranscript).observe($('messages'), { childList: true, subtree: true, characterData: true });
narrow.addEventListener('change', fitTranscript);
addEventListener('resize', fitTranscript);
await boot();
fitTranscript();
