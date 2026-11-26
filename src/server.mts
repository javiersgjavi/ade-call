import type { StoredEvent, Publication, CallHistory, T3Response, VoiceSettingsResponse, VoiceProvider } from './shared/contracts.mjs';
import type { Ade } from './adapters/registry.mjs';
import { StatusError, errorMessage } from './shared/contracts.mjs';
import http from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { Recordings } from './voice/recordings.mjs';
import { Store } from './conversation/store.mjs';
import { clientCloseReason } from './voice/diagnostics.mjs';
import { REALTIME_DEFAULTS, RealtimeCalls } from './voice/realtime.mjs';
import { GEMINI_DEFAULTS, GeminiCalls, isGeminiModel, type Socket as AudioSocket } from './voice/gemini.mjs';
import { LOKUTOR_DEFAULTS, LokutorCalls, isLokutorModel } from './voice/lokutor.mjs';
import { WebSocketServer } from 'ws';
import type { Duplex } from 'node:stream';
import { CONFIG_FIELDS, INSTRUCTIONS_FIELD, MAX_INSTRUCTIONS, VOICE_FIELDS, readConfig, updateConfig, validateInstructions, validateKey, validateVoiceSettings, voiceOptions, type VoiceSettings } from './voice/settings.mjs';
import { ProjectContext } from './conversation/context.mjs';
import { ades, getAde } from './adapters/registry.mjs';
import { Discovery } from './adapters/discovery.mjs';
import { BrowserAccess, REMEMBER_SECONDS } from './access/browsers.mjs';
import { ThreadWatch } from './conversation/thread-watch.mjs';
import { redact } from './direct/text.mjs';

const compiledRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const state = process.env.ADE_CALL_STATE || join(homedir(), '.local/share/ade-call');
const configDir = process.env.ADE_CALL_CONFIG || join(homedir(), '.config/ade-call');
for (const path of [state, configDir]) mkdirSync(path, { recursive: true, mode: 0o700 });
const configPath = join(configDir, 'config.json');
const config = readConfig(configPath);
const text = (value: unknown) => typeof value === 'string' && value ? value : undefined;
// Settings can change the key and the voice settings while running (see
// /api/settings/*): a key saved in config.json takes priority over OPENAI_API_KEY.
let configKey = text(config.openaiKey);
const envKey = text(process.env.OPENAI_API_KEY);
const openaiKey = () => configKey || envKey;
// The same for Gemini Live: geminiKey in config.json, else GEMINI_API_KEY or GOOGLE_API_KEY.
let configGeminiKey = text(config.geminiKey);
const envGeminiKey = text(process.env.GEMINI_API_KEY) || text(process.env.GOOGLE_API_KEY);
const geminiKey = () => configGeminiKey || envGeminiKey;
// And for Lokutor: lokutorKey in config.json, else LOKUTOR_API_KEY.
let configLokutorKey = text(config.lokutorKey);
const envLokutorKey = text(process.env.LOKUTOR_API_KEY);
const lokutorKey = () => configLokutorKey || envLokutorKey;
const tokenPath = join(configDir, 'access-token');
if (!existsSync(tokenPath)) writeFileSync(tokenPath, randomBytes(32).toString('base64url'), { mode: 0o600 });
chmodSync(tokenPath, 0o600);
const accessToken = readFileSync(tokenPath, 'utf8').trim();
const hash = (text: unknown) => createHash('sha256').update(String(text || '')).digest();
const secretEqual = (text: unknown) => timingSafeEqual(hash(text), hash(accessToken));
const store = new Store(join(state, 'caller.sqlite'));
const recordings = new Recordings(join(state, 'recordings'));
const clients = new Set<http.ServerResponse>();
const browserAccess = new BrowserAccess(join(configDir, 'browser-access.sqlite'));
// Who created each call: a paired browser's id, or ADMINISTRATOR for the bearer token.
const liveOwners = new Map<string, { deviceId: string; backend: string }>();
const ADMINISTRATOR = 'administrator';
const accessStreams = new Map<http.ServerResponse, { deviceId: string; end: () => void }>();
const port = Number(process.env.PORT || 8787);
let shuttingDown = false;
// The voice settings of the next call, the same for every ADE.
const realtimeSettings: VoiceSettings = { ...REALTIME_DEFAULTS, geminiVoice: GEMINI_DEFAULTS.voice, lokutorVoice: LOKUTOR_DEFAULTS.voice };
for (const field of VOICE_FIELDS) realtimeSettings[field] = text(config[CONFIG_FIELDS[field]]) || realtimeSettings[field];
// The owner's custom instructions (Settings → Voice), appended to every call's prompt.
let customInstructions: string | undefined;
try { customInstructions = validateInstructions(config[INSTRUCTIONS_FIELD]); }
catch (error) { throw new Error(`config.json ${INSTRUCTIONS_FIELD}: ${errorMessage(error)}`, { cause: error }); }
// The provider of the next call: the configured model decides.
const provider = (): VoiceProvider => isGeminiModel(realtimeSettings.model) ? 'gemini' : isLokutorModel(realtimeSettings.model) ? 'lokutor' : 'realtime';
const geminiSettings = () => ({ model: realtimeSettings.model, voice: realtimeSettings.geminiVoice });
const lokutorSettings = () => ({ voice: realtimeSettings.lokutorVoice });
const providerKey = () => ({ gemini: geminiKey, lokutor: lokutorKey, realtime: openaiKey })[provider()]();
// Voice exists only for an ADE with direct tools (src/direct). Each ADE has
// one engine per provider; only the configured provider's starts calls.
interface Runtime { adapter: Ade; backend: string; context: ProjectContext; discovery: Discovery; realtime: RealtimeCalls | null; gemini: GeminiCalls | null; lokutor: LokutorCalls | null; watch: ThreadWatch | null }
type Engine = RealtimeCalls | GeminiCalls | LokutorCalls;
// The engines whose audio this server relays (/api/live/stream).
type Relayed = GeminiCalls | LokutorCalls;
const engines = (r: Runtime) => [r.realtime, r.gemini, r.lokutor].filter((e): e is Engine => !!e);
const activeEngine = (r: Runtime): Engine | null => ({ gemini: r.gemini, lokutor: r.lokutor, realtime: r.realtime })[provider()];
// The engine that holds a call, whichever provider is configured now.
const callEngine = (r: Runtime, id: string) => engines(r).find(e => e.sessions.has(id));
const inCall = (r: Runtime) => engines(r).some(e => e.sessions.size > 0);
const runtimes = new Map<string, Runtime>();
for (const adapter of Object.values(ades)) {
  const backend = adapter.id;
  const adeState = adapter.statePath(state);
  const previousCall = store.meta<CallHistory>(`call:${backend}`);
  if (previousCall && !previousCall.endedAt) store.callEnded(backend, previousCall.id, 'Service restarted');
  const scopedPublish = (type: string, data: Publication) => publish(type, { ...data, backend, conversationId: data.conversationId || store.conversation(backend).id });
  const discovery = new Discovery(adapter);
  const context = new ProjectContext({ state: adeState, store, publish: scopedPublish, backend,
    capabilities: adapter.capabilities, readCatalog: adapter.promptCatalog, readCatalogThreads: adapter.promptThreads, readOverview: () => discovery.read(), readThread: adapter.readThread });
  // Follows threads that accepted a delivery, only where the ADE can read
  // their messages. Notices go to the call of the same conversation.
  const readThread = adapter.readThread;
  const runtime: Runtime = { adapter, backend, context, discovery, realtime: null, gemini: null, lokutor: null, watch: null };
  runtime.watch = readThread && adapter.capabilities.readThreadMessages ? new ThreadWatch({
    read: threadId => readThread(['thread', 'show', threadId, '--messages', '4'], { timeout: 8000 }) as Promise<T3Response>,
    deliver: notice => notice.conversationId !== store.conversation(backend).id || engines(runtime).some(e => e.threadNotice(notice))
  }) : null;
  const ade = adapter.direct?.({ snapshot: () => context.snapshot });
  if (ade) {
    const delivered = (thread: { threadId: string; runId: string | null; link: string | null; project: string }, conversationId?: string) => runtime.watch?.add({ ...thread, conversationId });
    const read = (threadId: string) => runtime.watch?.markRead(threadId);
    runtime.realtime = new RealtimeCalls({ key: openaiKey(), ade, context, publish: scopedPublish, store, settings: realtimeSettings, instructions: customInstructions, delivered, read });
    runtime.gemini = new GeminiCalls({ key: geminiKey(), ade, context, publish: scopedPublish, store, settings: geminiSettings(), instructions: customInstructions, delivered, read });
    runtime.lokutor = new LokutorCalls({ key: lokutorKey(), ade, context, publish: scopedPublish, store, settings: lokutorSettings(), instructions: customInstructions, delivered, read });
  }
  runtimes.set(backend, runtime);
}
function runtime(id: string) {
  let adapter;
  try { adapter = getAde(id); } catch (error) { throw new StatusError(400, errorMessage(error)); }
  return runtimes.get(adapter.id)!;
}
function voiceBusy() { return [...runtimes.values()].some(r => engines(r).some(e => e.busy)); }
function toolsRunning() { return [...runtimes.values()].some(r => engines(r).some(e => e.working)); }
function voiceState(): VoiceSettingsResponse {
  return { settings: { ...realtimeSettings }, options: voiceOptions(realtimeSettings), busy: voiceBusy(), provider: provider(),
    key: { set: !!openaiKey(), source: configKey ? 'config' : envKey ? 'env' : null },
    geminiKey: { set: !!geminiKey(), source: configGeminiKey ? 'config' : envGeminiKey ? 'env' : null },
    lokutorKey: { set: !!lokutorKey(), source: configLokutorKey ? 'config' : envLokutorKey ? 'env' : null },
    instructions: customInstructions || '', instructionsMax: MAX_INSTRUCTIONS };
}
// Saved first, then applied to every ADE's next call; the callers have checked
// that no call is active or connecting, and nothing awaits in between.
function saveVoice(res: http.ServerResponse, changes: Record<string, string | undefined>, apply: () => void) {
  try { updateConfig(configPath, changes); } catch (error) { return json(res, 500, { error: errorMessage(error) }); }
  apply();
  for (const { realtime, gemini, lokutor } of runtimes.values()) {
    realtime?.configure({ settings: realtimeSettings, key: openaiKey() ?? null, instructions: customInstructions ?? null });
    gemini?.configure({ settings: geminiSettings(), key: geminiKey() ?? null, instructions: customInstructions ?? null });
    lokutor?.configure({ settings: lokutorSettings(), key: lokutorKey() ?? null, instructions: customInstructions ?? null });
  }
  return json(res, 200, voiceState());
}
function broadcast(event: StoredEvent) {
  for (const client of clients) client.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
}
function publish(type: string, data: Publication) {
  if (['transcript', 'voice'].includes(type)) {
    data.at = new Date().toISOString();
    if (type === 'voice' && data.status === 'connected') data.lifecycle = store.callStarted(data.backend!, data.id!);
    if (type === 'voice' && ['closed', 'disconnected', 'closed_unconfirmed'].includes(data.status || '')) data.lifecycle = store.callEnded(data.backend!, data.id!, data.reason || data.status || '');
  }
  const event = store.event(type, data);
  broadcast(event);
  return event;
}
// Followed threads are read more often while a call can speak their notices.
const watchTimer = setInterval(() => {
  for (const r of runtimes.values()) {
    const { backend, watch } = r;
    if (!watch?.watches.size) continue;
    watch.retain(store.conversation(backend).id);
    void watch.tick(inCall(r)).catch(() => { /* Reads are retried on the next tick. */ });
  }
}, 4000).unref();

function json(res: http.ServerResponse, status: number, data: unknown) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); }
async function body(req: http.IncomingMessage, limit = 100_000) {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); bytes += buffer.length;
    if (bytes > limit) throw new StatusError(400, 'Request too large.');
    chunks.push(buffer);
  }
  let data: unknown;
  try { data = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch (error) { throw new StatusError(400, errorMessage(error)); }
  // Every endpoint reads fields of an object: null, an array or a scalar is a bad request.
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new StatusError(400, 'The request body must be a JSON object.');
  return data as Record<string, unknown>;
}
// The call a page request names; anything but a string names no call.
function callId(data: Record<string, unknown>) { return typeof data.id === 'string' ? data.id : ''; }
function bearerAuthenticated(req: http.IncomingMessage) {
  return !!req.headers.authorization?.startsWith('Bearer ') && secretEqual(req.headers.authorization.slice(7));
}
function browserOrigin(req: http.IncomingMessage) {
  const configured = browserAccess.origin();
  if (configured) return req.headers.host === new URL(configured).host ? configured : null;
  // Before pairing is configured, browser login is restricted to local HTTP.
  try {
    const url = new URL('http://' + req.headers.host);
    return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
      ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress || '') ? url.origin : null;
  } catch { return null; }
}
function browserToken(req: http.IncomingMessage) {
  const name = browserAccess.origin()?.startsWith('https:') ? '__Host-ade_browser' : 'ade_browser';
  return (req.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith(name + '='))?.slice(name.length + 1);
}
function browserDevice(req: http.IncomingMessage) { return browserOrigin(req) ? browserAccess.authenticate(browserToken(req)) : null; }
function authenticated(req: http.IncomingMessage) { return bearerAuthenticated(req) || !!browserDevice(req); }
function sameOrigin(req: http.IncomingMessage) {
  if (!req.headers.origin) return true; // Bearer clients and same-origin GETs.
  return req.headers.origin === browserOrigin(req);
}
function browserCookie(token: string, seconds = REMEMBER_SECONDS) {
  const secure = browserAccess.origin()?.startsWith('https:');
  return `${secure ? '__Host-ade_browser' : 'ade_browser'}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${seconds}${secure ? '; Secure' : ''}`;
}
function sweepAccess() {
  for (const [stream, owner] of accessStreams) if (!browserAccess.active(owner.deviceId)) { owner.end(); accessStreams.delete(stream); }
  for (const [id, owner] of liveOwners) {
    const engine = callEngine(runtime(owner.backend), id);
    if (owner.deviceId !== ADMINISTRATOR && !browserAccess.active(owner.deviceId)) engine?.close(id);
    if (!callEngine(runtime(owner.backend), id)) liveOwners.delete(id);
  }
}
const accessTimer = setInterval(sweepAccess, 1000).unref();
const assets = new Map<string, [string, string]>([['/', ['index.html', 'text/html; charset=utf-8']], ['/style.css', ['style.css', 'text/css']]]);
for (const name of ['app', 'errors', 'live-health', 'live-events', 'speech-gate', 'playback-control', 'relayed-call', 'pcm-capture', 'call-recording', 'recording-store', 'recording-panel', 'sounds', 'browser-list', 'pair-device', 'voice-settings', 'tour', 'i18n'])
  assets.set(`/${name}.js`, [`${name}.js`, 'text/javascript']);
// The browser's preferred languages (navigator.languages): only well-formed BCP 47 tags, at most five.
const browserLanguages = (value: unknown) => Array.isArray(value)
  ? value.filter((tag): tag is string => typeof tag === 'string' && /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8}){0,3}$/.test(tag)).slice(0, 5) : [];
const unavailable = (adapter: Ade) => `Voice is not available yet with ${adapter.name}.`;
const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self' blob:; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    if (req.method === 'GET' && assets.has(url.pathname)) {
      const [name, mime] = assets.get(url.pathname)!; res.writeHead(200, { 'Content-Type': mime }); return res.end(readFileSync(join(compiledRoot, 'public', name)));
    }
    if (!sameOrigin(req)) return json(res, 403, { error: 'Origin not allowed.' });
    if (req.method === 'POST' && url.pathname === '/api/pair') {
      if (!browserOrigin(req) || req.headers.origin !== browserOrigin(req)) return json(res, 403, { error: 'Open this installation\'s link to pair the browser.' });
      if (!browserAccess.allowAttempt(req.socket.remoteAddress || 'unknown')) return json(res, 429, { error: 'Wait a minute before trying again.' });
      const data = await body(req);
      const paired = browserAccess.redeem(data.code);
      if (!paired) return json(res, 401, { error: 'Code invalid, expired or already used.' });
      // Relinking replaces only this browser's previous credential, not other devices.
      const previous = browserDevice(req); if (previous) browserAccess.revoke(previous.id);
      res.setHeader('Set-Cookie', browserCookie(paired.token));
      return json(res, 200, { ok: true, device: paired.device });
    }
    if (!authenticated(req)) return json(res, 401, { error: 'Pair this browser to access ADE Call.' });
    if (req.method !== 'GET' && !bearerAuthenticated(req) && req.headers.origin !== browserOrigin(req)) return json(res, 403, { error: 'Origin not allowed.' });
    if (req.method === 'GET' && url.pathname === '/api/browsers') return json(res, 200, { devices: browserAccess.list(), currentId: browserDevice(req)?.id || null });
    if (req.method === 'POST' && url.pathname === '/api/browsers/revoke') {
      const data = await body(req);
      if (typeof data.id !== 'string') return json(res, 400, { error: 'The browser is missing.' });
      const currentId = browserDevice(req)?.id;
      const revoked = browserAccess.revoke(data.id); sweepAccess();
      if (data.id === currentId) res.setHeader('Set-Cookie', browserCookie('', 0));
      return json(res, 200, { revoked });
    }
    // A pairing code for another device, from an already authorized browser or the
    // administrator token. The link uses only the origin configured on the server
    // (CLI pair --url or configure): never one derived from this request's Host.
    if (req.method === 'POST' && url.pathname === '/api/browsers/pair') {
      const data = await body(req, 10_000);
      if (!browserAccess.origin()) return json(res, 409, { error: 'This installation has no access URL yet. On the server, run once: npm run access -- pair --url URL --name NAME (or configure --url URL).', reason: 'origin_missing' });
      if (typeof data.name !== 'string') return json(res, 400, { error: 'Invalid browser name (1–80 characters).', reason: 'invalid_name' });
      let invite;
      try { invite = browserAccess.createCode(data.name); }
      catch (error) {
        const reason = /name/.test(errorMessage(error)) ? 'invalid_name' : /pending codes/.test(errorMessage(error)) ? 'too_many_codes' : null;
        if (!reason) throw error;
        return json(res, reason === 'too_many_codes' ? 429 : 400, { error: errorMessage(error), reason });
      }
      // The code is a credential: it is returned once and never logged.
      return json(res, 201, { ...invite, expiresAt: new Date(invite.expiresAt).toISOString(), expiresIn: Math.max(0, invite.expiresAt - Date.now()) });
    }
    if (req.method === 'POST' && url.pathname === '/api/logout') {
      const device = browserDevice(req); if (device) browserAccess.revoke(device.id);
      res.setHeader('Set-Cookie', browserCookie('', 0)); sweepAccess();
      return json(res, 200, { ok: true });
    }
    const requestDevice = browserDevice(req);
    const current = runtime(url.searchParams.get('backend') || 't3');
    const { adapter, backend, context, discovery } = current;
    // The engine of the next call, and the one that holds the call a request names.
    const voice = activeEngine(current);
    const of = (data: Record<string, unknown>) => callEngine(current, callId(data));
    if (req.method === 'GET' && url.pathname === '/api/recordings') {
      return json(res, 200, { recordings: await recordings.list(backend, requestDevice?.id || 'administrator') });
    }
    if (req.method === 'POST' && url.pathname === '/api/recordings/part') {
      const data = await body(req, 13 * 1024 * 1024);
      try { return json(res, 200, await recordings.save(data, backend, store.conversation(backend).id, requestDevice?.id || 'administrator')); }
      catch { return json(res, 400, { error: 'The diagnostic could not be saved: check identity, fragment order, limits and server space.' }); }
    }
    if (req.method === 'GET' && url.pathname === '/api/status') {
      const device = browserDevice(req);
      if (device) { browserAccess.remember(device.id); res.setHeader('Set-Cookie', browserCookie(browserToken(req)!)); }
      const status = discovery.status();
      return json(res, 200, { eventCursor: store.db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM events').get()!.id, backend,
        ades: Object.values(ades).map(({ id, name, theme, capabilities, limitation, direct }) => ({ id, name, theme, capabilities, limitation, direct: !!direct })),
        availability: status, limitation: adapter.limitation, conversation: store.conversation(backend), lastCall: store.meta<CallHistory>(`call:${backend}`),
        voiceReady: !!(providerKey() && voice), runtime: status?.state || 'unreachable',
        voiceModel: { provider: provider(), model: realtimeSettings.model, reasoning: realtimeSettings.reasoning, eagerness: realtimeSettings.eagerness, noiseReduction: realtimeSettings.noiseReduction,
          voice: ({ gemini: realtimeSettings.geminiVoice, lokutor: realtimeSettings.lokutorVoice, realtime: realtimeSettings.voice })[provider()] },
        voiceActive: engines(current).flatMap(e => [...e.sessions.keys()]),
        // Any ADE: a call active or connecting, or a tool still running. The
        // installer reads it before restarting the service (scripts/service-busy.mts).
        serviceBusy: voiceBusy() || toolsRunning() });
    }
    // Server-wide voice settings, custom instructions and API keys (Settings). Changes are refused
    // during a call or while one connects: the call keeps what it started with.
    if (req.method === 'GET' && url.pathname === '/api/settings/voice') return json(res, 200, voiceState());
    if (req.method === 'POST' && url.pathname === '/api/settings/voice') {
      const data = await body(req, 4096);
      if (voiceBusy()) return json(res, 409, { error: 'End the call before changing the voice settings.' });
      let next: VoiceSettings;
      try { next = validateVoiceSettings(data, realtimeSettings); } catch (error) { return json(res, 400, { error: errorMessage(error) }); }
      const changed = VOICE_FIELDS.filter(field => Object.hasOwn(data, field));
      return saveVoice(res, Object.fromEntries(changed.map(field => [CONFIG_FIELDS[field], next[field]])), () => Object.assign(realtimeSettings, next));
    }
    if (req.method === 'POST' && url.pathname === '/api/settings/instructions') {
      const data = await body(req, 64 * 1024);
      if (!Object.hasOwn(data, 'instructions') || Object.keys(data).length !== 1) return json(res, 400, { error: 'Send only the instructions field.' });
      if (voiceBusy()) return json(res, 409, { error: 'End the call before changing the instructions.' });
      let next: string | undefined;
      try { next = validateInstructions(data.instructions); } catch (error) { return json(res, 400, { error: errorMessage(error) }); }
      return saveVoice(res, { [INSTRUCTIONS_FIELD]: next }, () => { customInstructions = next; });
    }
    if (req.method === 'POST' && url.pathname === '/api/settings/key') {
      // Parse errors can quote the body: never echo them here.
      let data: { key?: unknown };
      try { data = await body(req, 4096); } catch { return json(res, 400, { error: 'Invalid request.' }); }
      if (!data || typeof data !== 'object') return json(res, 400, { error: 'Invalid request.' });
      if (voiceBusy()) return json(res, 409, { error: 'End the call before changing the API key.' });
      // provider: 'gemini' or 'lokutor' for those API keys; omitted or 'realtime' for the OpenAI key.
      const keyProvider = (data as { provider?: unknown }).provider ?? 'realtime';
      if (keyProvider !== 'realtime' && keyProvider !== 'gemini' && keyProvider !== 'lokutor') return json(res, 400, { error: 'Unknown key provider.' });
      let key: string | undefined;
      if (data.key !== null) try { key = validateKey(data.key); } catch (error) { return json(res, 400, { error: errorMessage(error) }); }
      if (keyProvider === 'gemini') return saveVoice(res, { geminiKey: key }, () => { configGeminiKey = key; });
      if (keyProvider === 'lokutor') return saveVoice(res, { lokutorKey: key }, () => { configLokutorKey = key; });
      return saveVoice(res, { openaiKey: key }, () => { configKey = key; });
    }
    // What the "Conversation" panel shows: transcript turns and voice tool runs
    // of the current conversation, up to the status cursor the page streams after.
    if (req.method === 'GET' && url.pathname === '/api/calls') {
      const through = Number(url.searchParams.get('through') ?? Number.MAX_SAFE_INTEGER);
      if (!Number.isSafeInteger(through) || through < 0) return json(res, 400, { error: 'Invalid event cursor.' });
      const conversation = store.conversation(backend);
      return json(res, 200, { backend, conversationId: conversation.id, ...store.callEvents(backend, conversation.id, through) });
    }
    if (req.method === 'GET' && url.pathname === '/api/context') { await context.refresh(); return json(res, 200, context.snapshot); }
    if (req.method === 'POST' && url.pathname === '/api/conversation/new') {
      const data = await body(req);
      if (data.backend !== backend || engines(current).some(e => e.busy))
        return json(res, 409, { error: 'End the call before starting another session.' });
      if (data.conversationId !== store.conversation(backend).id) return json(res, 409, { error: 'The session has already changed. Reload before trying.' });
      const conversation = store.newConversation(backend);
      publish('conversation', { backend, ...conversation });
      return json(res, 200, { conversation });
    }
    if (req.method === 'POST' && url.pathname === '/api/live/interrupt') {
      const data = await body(req); of(data)?.interrupt(callId(data));
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/projects') return json(res, 200, url.searchParams.has('progressive') ? await discovery.progressive(url.searchParams.get('generation')) : await discovery.read());
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      const after = Number(req.headers['last-event-id'] || url.searchParams.get('after') || 0);
      if (Number.isSafeInteger(after) && after >= 0) {
        let cursor = after, batch;
        do {
          batch = store.events(cursor);
          for (const event of batch) { res.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`); cursor = event.id; }
        } while (batch.length === 500);
      }
      clients.add(res);
      const device = browserDevice(req); if (device) accessStreams.set(res, { deviceId: device.id, end: () => res.end() });
      const heartbeat = setInterval(() => res.write(': keepalive\n\n'), 15_000);
      req.on('close', () => { clearInterval(heartbeat); clients.delete(res); accessStreams.delete(res); }); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/live') {
      const data = await body(req);
      // Chosen after the body arrives: Settings may have changed the provider meanwhile.
      const voice = activeEngine(current);
      if (!voice) return json(res, 409, { error: unavailable(adapter) });
      if (voiceBusy() || shuttingDown || (data.conversationId && data.conversationId !== store.conversation(backend).id) || (data.backend && data.backend !== backend)) return json(res, 409, { error: 'There is another call or the destination has changed. Reload the page.' });
      // The page names the provider it prepared audio for; a change in Settings since then needs a reload.
      if (data.provider !== undefined && data.provider !== voice.provider) return json(res, 409, { error: 'The voice model has changed. Reload the page.' });
      const relayed = voice instanceof GeminiCalls || voice instanceof LokutorCalls;
      if (!relayed && (typeof data.sdp !== 'string' || !data.sdp.startsWith('v='))) return json(res, 400, { error: 'The audio offer is missing.' });
      const device = requestDevice;
      if (device && !browserAccess.active(device.id)) return json(res, 401, { error: 'Pairing revoked.' });
      const options = { languages: browserLanguages(data.languages), language: browserLanguages([data.language])[0] };
      const result = relayed ? await voice.create(options) : await voice.create(data.sdp as string, options);
      // The audio socket of a relayed call accepts only this browser (or the administrator token).
      liveOwners.set(result.session.id, { deviceId: device?.id || ADMINISTRATOR, backend });
      if (device && !browserAccess.active(device.id)) { voice.close(result.session.id); return json(res, 401, { error: 'Pairing revoked.' }); }
      return json(res, 201, result);
    }
    if (req.method === 'POST' && url.pathname === '/api/live/ready') {
      const data = await body(req); of(data)?.ready(callId(data)); return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/live/heartbeat') {
      const data = await body(req); of(data)?.diagnostics(callId(data), data.diagnostics);
      return json(res, 200, { active: !!of(data)?.heartbeat(callId(data)) });
    }
    if (req.method === 'POST' && url.pathname === '/api/live/close') {
      const data = await body(req); const engine = of(data); engine?.diagnostics(callId(data), data.diagnostics, true);
      engine?.close(callId(data), clientCloseReason(data.cause)); return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: 'Not found.' });
  } catch (error) {
    // A bad request is a 400; a provider failure (502) or an unconfigured
    // server (503) carry their own status; anything else is an internal 500.
    // The message is redacted either way.
    const text = redact(String(errorMessage(error)));
    if (!res.headersSent) json(res, error instanceof StatusError ? error.status : 500, { error: text }); else res.end();
  }
});
// The audio socket of a relayed call (Gemini Live, Lokutor). The same authentication
// and origin rules as the API, and only the browser (or token) that created
// the call may attach, once. Browsers always send Origin on a WebSocket.
const audioSockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
server.on('upgrade', (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
  const refuse = (status: number, reason: string) => { socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); };
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname !== '/api/live/stream') return refuse(404, 'Not Found');
    if (shuttingDown) return refuse(503, 'Service Unavailable');
    if (!authenticated(req)) return refuse(401, 'Unauthorized');
    if (req.headers.origin ? req.headers.origin !== browserOrigin(req) : !bearerAuthenticated(req)) return refuse(403, 'Forbidden');
    const target = runtime(url.searchParams.get('backend') || 't3'), id = url.searchParams.get('id') || '';
    const engine = [target.gemini, target.lokutor].find((e): e is Relayed => !!e?.sessions.has(id)), owner = liveOwners.get(id), device = browserDevice(req);
    if (!engine || owner?.backend !== target.backend || owner.deviceId !== (device?.id || ADMINISTRATOR)) return refuse(404, 'Not Found');
    audioSockets.handleUpgrade(req, socket, head, ws => { engine.attach(id, ws as unknown as AudioSocket); });
  } catch { refuse(400, 'Bad Request'); }
});
server.requestTimeout = 60_000;
const host = process.env.ADE_CALL_HOST || '127.0.0.1';
server.listen(port, host, () => {
  console.log(`ADE Call ready on ${host}:${port}. Private access configured.`);
  for (const r of runtimes.values()) {
    const engine = activeEngine(r);
    const name = engine instanceof GeminiCalls ? 'Gemini Live' : engine instanceof LokutorCalls ? 'Lokutor' : 'GPT Realtime';
    const keyName = ({ gemini: 'geminiKey', lokutor: 'lokutorKey', realtime: 'openaiKey' })[provider()];
    console.log(`[${r.backend}] ${engine ? `voice: ${name} ${engine.model}${providerKey() ? '' : ` (${keyName} missing)`}` : 'no voice'}`);
  }
});
async function shutdown() {
  if (shuttingDown) return; shuttingDown = true;
  // A call, or a tool still running after a hang-up (a send that went out
  // keeps going), gets time to finish. A send cut off by the exit stays
  // pending: uncertain if the CLI was invoked, never resumed or repeated.
  const delay = voiceBusy() || toolsRunning() ? 16_000 : 200;
  clearInterval(watchTimer); clearInterval(accessTimer);
  for (const r of runtimes.values()) for (const engine of engines(r)) engine.shutdown();
  for (const client of clients) client.end();
  server.close();
  setTimeout(() => { store.close(); browserAccess.close(); process.exit(0); }, delay);
}
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
