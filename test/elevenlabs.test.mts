import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { DirectResult, DirectTool, DirectToolContext } from '../src/direct/contract.mjs';
import { ElevenLabsCalls, ELEVENLABS_VOICES, agentSpec, elevenlabsSchema, isElevenLabsModel, toolConfig, type Api } from '../src/voice/elevenlabs.mjs';
import { directInstructions } from '../src/direct/prompt.mjs';
import { StatusError } from '../src/shared/contracts.mjs';
import { double, fakeAde } from './fixtures.mjs';

// ElevenLabs Agents with an invented ADE, a simulated REST API and simulated
// sockets: nothing reaches ElevenLabs. The provider socket confirms the
// conversation like the real one.
type Message = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
class Upstream extends EventEmitter {
  readyState = 0; sent: Message[] = [];
  constructor(readonly refuse?: string) { super(); setImmediate(() => { this.readyState = 1; this.emit('open'); }); }
  send(raw: string | Buffer) {
    const message = JSON.parse(String(raw)); this.sent.push(message);
    if (message.type === 'conversation_initiation_client_data') setImmediate(() => this.refuse ? this.close(1008, this.refuse)
      : this.server({ type: 'conversation_initiation_metadata', conversation_initiation_metadata_event: { conversation_id: 'conv_1' } }));
  }
  close(code = 1000, reason = '') { if (this.readyState === 3) return; this.readyState = 3; this.emit('close', code, Buffer.from(reason)); }
  server(message: Message) { this.emit('message', Buffer.from(JSON.stringify(message))); }
}
class Browser extends EventEmitter {
  readyState = 1; frames: Buffer[] = []; events: Message[] = []; closed?: number;
  send(data: string | Buffer) { if (Buffer.isBuffer(data)) this.frames.push(data); else this.events.push(JSON.parse(data)); }
  close(code = 1000) { this.readyState = 3; this.closed = code; }
  audio(bytes: Buffer) { this.emit('message', bytes, true); }
}
// The provider's REST API: tools and the agent, as the real one answers them.
class Provider {
  requests: { method: string; path: string; body?: Message }[] = []; tools = new Map<string, Message>(); agents = new Map<string, Message>(); n = 0;
  api: Api = async (path, init = {}) => {
    const method = init.method || 'GET', body = init.body as Message | undefined;
    this.requests.push({ method, path, body });
    if (method === 'POST' && path === '/v1/convai/tools') { const id = `tool_${++this.n}`; this.tools.set(id, body!); return { status: 200, json: { id } }; }
    if (method === 'DELETE' && path.startsWith('/v1/convai/tools/')) { this.tools.delete(path.split('/').pop()!); return { status: 204, json: null }; }
    if (method === 'POST' && path === '/v1/convai/agents/create') { const id = `agent_${++this.n}`; this.agents.set(id, body!); return { status: 200, json: { agent_id: id } }; }
    if (method === 'PATCH' && path.startsWith('/v1/convai/agents/')) { const id = path.split('/').pop()!; if (!this.agents.has(id)) return { status: 404, json: { detail: 'not found' } }; this.agents.set(id, body!); return { status: 200, json: {} }; }
    if (method === 'GET' && path.startsWith('/v1/convai/conversation/get-signed-url')) {
      const id = new URLSearchParams(path.split('?')[1]).get('agent_id')!;
      return this.agents.has(id) ? { status: 200, json: { signed_url: `wss://example.invalid/convai?agent_id=${id}&token=secret-token` } } : { status: 404, json: { detail: { message: 'agent not found' } } };
    }
    return { status: 400, json: { detail: 'unexpected' } };
  };
}
type Execute = (params: Record<string, unknown>, context: DirectToolContext) => Promise<DirectResult>;
function fixture({ execute = async () => ({ text: 'ok' }), refuse, tools: extra = [], provider = new Provider(), meta = new Map<string, unknown>() }: { execute?: Execute; refuse?: string; tools?: DirectTool[]; provider?: Provider; meta?: Map<string, unknown> } = {}) {
  const sockets: Upstream[] = [], urls: string[] = [], keys: string[] = [];
  const published: { type: string; data: Record<string, unknown> }[] = [], runs: Record<string, unknown>[] = [];
  const tools: DirectTool[] = [
    { name: 'fake_send', description: 'Send', parameters: { type: 'object', properties: { message: { type: 'string', description: 'Text' } }, required: ['message'] }, sends: true, execute: async (params, context) => { runs.push(params); return execute(params, context); } },
    { name: 'fake_read', description: 'Read', parameters: { type: 'object' }, execute }, ...extra];
  const ade = fakeAde(tools, 'fake CATALOG · p1');
  const eleven = new ElevenLabsCalls(double<ConstructorParameters<typeof ElevenLabsCalls>[0]>({
    key: 'test-elevenlabs-key', ade, store: { meta(key: string, value?: unknown) { if (value === undefined) return meta.get(key); meta.set(key, structuredClone(value)); } },
    settings: { llm: 'claude-haiku-5-5', voice: 'George' }, publish: (type, data) => published.push({ type, data }),
    context: { conversation: () => ({ id: 'current' }), resume: () => 'Earlier history.', vocabulary: () => ['Faro', 'Codex', 'README'], rememberClose() {}, timing: () => ({}) },
    api: (key: string) => { keys.push(key); return provider.api; },
    connect: (url: string) => { urls.push(url); const socket = new Upstream(refuse); sockets.push(socket); return socket as never; }
  }));
  const upstream = () => sockets.at(-1)!;
  const browser = new Browser();
  return { eleven, ade, provider, meta, sockets, urls, keys, published, runs, browser, upstream,
    heard: (text: string) => upstream().server({ type: 'user_transcript', user_transcription_event: { user_transcript: text } }),
    call: (name: string, id: string, parameters = {}) => upstream().server({ type: 'client_tool_call', client_tool_call: { tool_name: name, tool_call_id: id, parameters, expects_response: true } }),
    results: () => upstream().sent.filter(m => m.type === 'client_tool_result'),
    async start() { const result = await eleven.create({ languages: ['es-ES'] }); eleven.attach(result.session.id, browser as never); return result; },
    close() { eleven.shutdown(); } };
}
const wait = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));

test('tool parameters become ElevenLabs schemas: objects, arrays and described literals', () => {
  assert.deepEqual(elevenlabsSchema({ type: 'object', additionalProperties: false, required: ['q', 'gone'], properties: {
    q: { type: 'string', description: 'Query', minLength: 1 }, n: { type: 'integer' }, kind: { type: 'string', enum: ['a', 'b'] },
    ids: { type: 'array', items: { type: 'string' }, description: 'IDs' }, maybe: { type: ['string', 'null'], description: 'Optional' },
    either: { anyOf: [{ type: 'null' }, { type: 'boolean', description: 'Flag' }] } } }), {
    type: 'object', description: '', required: ['q'], properties: {
      q: { type: 'string', description: 'Query' }, n: { type: 'integer', description: 'n' }, kind: { type: 'string', description: 'kind', enum: ['a', 'b'] },
      ids: { type: 'array', description: 'IDs', items: { type: 'string', description: 'ids' } }, maybe: { type: 'string', description: 'Optional' },
      either: { type: 'boolean', description: 'Flag' } } });
  assert.deepEqual(toolConfig({ name: 't', description: 'd', parameters: { type: 'object' } }), { type: 'client', name: 't', description: 'd', parameters: { type: 'object', description: '', properties: {}, required: [] }, expects_response: true, response_timeout_secs: 120, execution_mode: 'immediate' });
  assert.ok(isElevenLabsModel('elevenlabs-agents') && !isElevenLabsModel('gemini-3.8-live'));
});

test('the first call creates the tools and the agent; later calls only ask for a signed URL', async t => {
  const f = fixture(); t.after(() => f.close());
  const result = await f.start();
  assert.match(result.session.id, /^el_/);
  assert.equal(result.transport.stream, `/api/live/stream?id=${encodeURIComponent(result.session.id)}`);
  assert.deepEqual(f.keys, ['test-elevenlabs-key'], 'the server holds the key');
  assert.deepEqual(f.provider.requests.map(r => `${r.method} ${r.path.split('?')[0]}`), ['POST /v1/convai/tools', 'POST /v1/convai/tools', 'POST /v1/convai/agents/create', 'GET /v1/convai/conversation/get-signed-url']);
  const agent = [...f.provider.agents.values()][0];
  assert.deepEqual(agent, agentSpec(['tool_1', 'tool_2']));
  assert.equal(agent.conversation_config.agent.first_message, '', 'the engine asks for the greeting');
  assert.equal(agent.platform_settings.auth.enable_auth, true, 'only signed URLs open a conversation');
  assert.equal(f.urls[0], 'wss://example.invalid/convai?agent_id=agent_3&token=secret-token');
  // The overrides of this call.
  const initiation = f.upstream().sent[0];
  assert.equal(initiation.type, 'conversation_initiation_client_data');
  const override = initiation.conversation_config_override;
  assert.equal(override.agent.prompt.llm, 'claude-haiku-5-5');
  assert.equal(override.agent.language, 'es');
  assert.equal(override.tts.voice_id, ELEVENLABS_VOICES.George);
  assert.deepEqual(override.asr.keywords, ['Faro', 'Codex', 'README']);
  const prompt: string = override.agent.prompt.prompt;
  assert.ok(prompt.startsWith(directInstructions(f.ade, { provider: 'elevenlabs', language: { tag: 'es-ES', source: 'browser' } as never }).slice(0, 200)), 'the ADE instructions first');
  assert.match(prompt, /Earlier history\./); assert.match(prompt, /fake CATALOG · p1/);
  assert.deepEqual(f.browser.events[0], { type: 'session.started', inputRate: 16000, outputRate: 24000 });
  f.eleven.close(result.session.id);
  // Nothing changed: no tool or agent request, only a new signed URL.
  f.provider.requests = [];
  await f.start();
  assert.deepEqual(f.provider.requests.map(r => r.method + ' ' + r.path.split('?')[0]), ['GET /v1/convai/conversation/get-signed-url']);
  assert.doesNotMatch(JSON.stringify(f.published), /secret-token|test-elevenlabs-key/, 'neither the key nor the signed URL is published');
});

test('a changed tool is created again, the agent updated, and the old tool removed', async t => {
  const provider = new Provider(), meta = new Map<string, unknown>();
  const first = fixture({ provider, meta });
  const one = await first.start(); first.eleven.close(one.session.id); first.close();
  const extra: DirectTool = { name: 'fake_more', description: 'More', parameters: { type: 'object' }, execute: async () => ({ text: 'ok' }) };
  const f = fixture({ provider, meta, tools: [extra] }); t.after(() => f.close());
  provider.requests = [];
  await f.start();
  await wait();
  assert.deepEqual(provider.requests.map(r => `${r.method} ${r.path.split('?')[0]}`), ['POST /v1/convai/tools', 'PATCH /v1/convai/agents/agent_3', 'GET /v1/convai/conversation/get-signed-url']);
  assert.deepEqual(provider.agents.get('agent_3')!.conversation_config.agent.prompt.tool_ids, ['tool_1', 'tool_2', 'tool_4']);
  // The same name with a new description replaces its tool.
  const changed = fixture({ provider, meta, tools: [{ ...extra, description: 'Even more' }] }); t.after(() => changed.close());
  provider.requests = [];
  await changed.start(); await wait();
  assert.deepEqual(provider.requests.map(r => `${r.method} ${r.path.split('?')[0]}`), ['POST /v1/convai/tools', 'PATCH /v1/convai/agents/agent_3', 'DELETE /v1/convai/tools/tool_4', 'GET /v1/convai/conversation/get-signed-url']);
  assert.ok(!provider.tools.has('tool_4'));
});

test('an agent deleted in the dashboard is created again once, with its tools if they are gone too', async t => {
  const f = fixture(); t.after(() => f.close());
  const one = await f.start(); f.eleven.close(one.session.id);
  f.provider.agents.clear(); f.provider.requests = [];
  const two = await f.start(); f.eleven.close(two.session.id);
  assert.deepEqual(f.provider.requests.map(r => `${r.method} ${r.path.split('?')[0]}`), ['GET /v1/convai/conversation/get-signed-url', 'POST /v1/convai/agents/create', 'GET /v1/convai/conversation/get-signed-url'], 'the tools are kept');
  // Tools gone as well: the provider refuses the agent, and everything is created again.
  f.provider.agents.clear(); f.provider.tools.clear(); f.provider.requests = [];
  const create = f.provider.api;
  f.provider.api = async (path, init = {}) => {
    const body = init.body as Message | undefined;
    if (path === '/v1/convai/agents/create' && body?.conversation_config.agent.prompt.tool_ids.some((id: string) => !f.provider.tools.has(id))) return { status: 422, json: { detail: 'unknown tool' } };
    return create(path, init);
  };
  await f.start();
  assert.deepEqual(f.provider.requests.map(r => `${r.method} ${r.path.split('?')[0]}`), ['GET /v1/convai/conversation/get-signed-url', 'POST /v1/convai/tools', 'POST /v1/convai/tools', 'POST /v1/convai/agents/create', 'GET /v1/convai/conversation/get-signed-url']);
});

test('a refused conversation reports the provider\'s reason, never the signed URL', async t => {
  const f = fixture({ refuse: 'Override for field llm is not allowed by config.' }); t.after(() => f.close());
  await assert.rejects(f.start(), (error: StatusError) => error.status === 502 && /Override for field llm/.test(error.message) && !/token/.test(error.message));
  assert.equal(f.eleven.busy, false);
});

test('a send runs only after a new transcribed user turn, once per call ID; a recital of the hints is no turn', async t => {
  const f = fixture(); t.after(() => f.close());
  await f.start();
  f.eleven.ready([...f.eleven.sessions.keys()][0]);
  // The greeting is a note: never a user turn, even if the provider transcribed it back.
  const greeting = f.upstream().sent.find(m => m.type === 'user_message')!;
  assert.match(greeting.text, /never authorize a send/);
  f.heard(greeting.text);
  f.call('fake_send', 'call_1', { message: 'hola' });
  await wait(2800);
  assert.match(f.results().find(r => r.tool_call_id === 'call_1')!.result, /no_user_turn/);
  assert.deepEqual(f.runs, []);
  f.heard('Faro, Codex, README.');
  f.call('fake_send', 'call_2', { message: 'hola' });
  await wait(2800);
  assert.match(f.results().find(r => r.tool_call_id === 'call_2')!.result, /no_user_turn/, 'a recital of the hints');
  assert.equal(f.published.find(e => e.type === 'transcript' && e.data.text === 'Faro, Codex, README.')!.data.echo, true);
  f.heard('Sí, mándalo.');
  f.call('fake_send', 'call_3', { message: 'hola' });
  await wait(100);
  assert.deepEqual(f.runs, [{ message: 'hola' }]);
  assert.equal(f.results().find(r => r.tool_call_id === 'call_3')!.result, 'ok');
  // The same ID again gets the same result; nothing runs twice.
  f.call('fake_send', 'call_3', { message: 'hola' });
  await wait(50);
  assert.equal(f.runs.length, 1); assert.equal(f.results().filter(r => r.tool_call_id === 'call_3').length, 2);
  // A second send needs a new turn.
  f.call('fake_send', 'call_4', { message: 'otra' });
  await wait(2800);
  assert.equal(f.runs.length, 1);
  assert.ok(f.published.some(e => e.type === 'voice-tool' && e.data.callId === 'call_3'));
});

test('audio, interruptions, pings, responses and corrections are relayed', async t => {
  const f = fixture(); t.after(() => f.close());
  await f.start();
  f.browser.audio(Buffer.alloc(640, 1));
  assert.deepEqual(f.upstream().sent.at(-1), { user_audio_chunk: Buffer.alloc(640, 1).toString('base64') });
  f.browser.audio(Buffer.alloc(3)); // odd length: dropped
  assert.ok(!f.upstream().sent.at(-1)!.user_audio_chunk || f.upstream().sent.at(-1)!.user_audio_chunk.length !== 4);
  f.upstream().server({ type: 'ping', ping_event: { event_id: 7, ping_ms: 50 } });
  assert.deepEqual(f.upstream().sent.at(-1), { type: 'pong', event_id: 7 });
  f.upstream().server({ type: 'audio', audio_event: { audio_base_64: Buffer.alloc(480, 2).toString('base64'), event_id: 1 } });
  assert.deepEqual(f.browser.frames.at(-1), Buffer.alloc(480, 2));
  f.upstream().server({ type: 'agent_response', agent_response_event: { agent_response: 'Hola, [calm] tienes tres proyectos.', response_id: 'r1' } });
  const said = f.published.filter(e => e.type === 'transcript' && e.data.role === 'assistant');
  assert.equal(said[0].data.text, 'Hola, tienes tres proyectos.', 'expressive tags are not transcript');
  f.upstream().server({ type: 'interruption', interruption_event: { event_id: 2 } });
  assert.equal(f.browser.events.at(-1)!.type, 'interrupted');
  f.upstream().server({ type: 'agent_response_correction', agent_response_correction_event: { original_agent_response: 'x', corrected_agent_response: 'Hola, tienes', response_id: 'r1' } });
  const corrected = f.published.filter(e => e.type === 'transcript' && e.data.role === 'assistant').at(-1)!;
  assert.equal(corrected.data.text, 'Hola, tienes'); assert.equal(corrected.data.item, said[0].data.item, 'the same item, corrected');
});

test('a quiet notice is context; a notice to speak waits for the model and the user', async t => {
  const f = fixture(); t.after(() => f.close());
  await f.start();
  const id = [...f.eleven.sessions.keys()][0], call = f.eleven.sessions.get(id)!;
  call.greeted = true; call.lastUserAt = 0;
  assert.equal(f.eleven.threadNotice({ kind: 'final', threadId: 't1', title: 'T', project: 'p', conversationId: 'current', text: 'Done.', quiet: true } as never), true);
  assert.equal(f.upstream().sent.at(-1)!.type, 'contextual_update');
  call.responding = true;
  assert.equal(f.eleven.threadNotice({ kind: 'final', threadId: 't1', title: 'T', project: 'p', conversationId: 'current', text: 'Done.' } as never), false, 'not while the model speaks');
  f.upstream().server({ type: 'agent_response_complete' });
  assert.equal(f.eleven.threadNotice({ kind: 'final', threadId: 't1', title: 'T', project: 'p', conversationId: 'current', text: 'Done.' } as never), true);
  const message = f.upstream().sent.at(-1)!;
  assert.equal(message.type, 'user_message'); assert.match(message.text, /Done\./);
});

test('the provider closing the conversation ends the call; work sent keeps running', async t => {
  const f = fixture(); t.after(() => f.close());
  const result = await f.start();
  f.upstream().close(1000, 'max duration reached');
  assert.equal(f.eleven.sessions.has(result.session.id), false);
  const ended = f.published.find(e => e.type === 'voice' && e.data.status === 'disconnected')!;
  assert.match(String(ended.data.reason), /max duration reached/);
  assert.equal(f.browser.closed, 1000);
});

test('without a key no call starts', async () => {
  const eleven = new ElevenLabsCalls(double<ConstructorParameters<typeof ElevenLabsCalls>[0]>({ ade: fakeAde([], ''), store: { meta() {} }, publish() {}, context: { resume: () => '', vocabulary: () => [], rememberClose() {} } }));
  await assert.rejects(eleven.create(), (error: StatusError) => error.status === 503 && /ElevenLabs key is missing/.test(error.message));
  eleven.shutdown();
});
