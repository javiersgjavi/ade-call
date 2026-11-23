import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateScenario } from '../src/eval/scenario.mjs';
import { worldId } from '../src/eval/world.mjs';
import { checkRun } from '../src/eval/checks.mjs';
import { Speech, BYTES_PER_MS } from '../src/eval/speech.mjs';
import { runElevenLabsScenario } from '../src/eval/elevenlabs-runner.mjs';
import type { Api } from '../src/voice/elevenlabs.mjs';

// An ElevenLabs conversation: it confirms the conversation, answers messages
// that ask for a reply, hears a burst of noise as the user's words, and, as
// the real service does, answers a tool result only after a while.
// 'send': the words are a yes and the LLM sends to thread t.
// 'read': the LLM reads thread t and answers 3.5 s after the result.
type Mode = 'send' | 'read';
class FakeElevenLabs extends EventEmitter {
  readyState = 1; sent: Record<string, unknown>[] = []; speaking = false; n = 0;
  constructor(readonly mode: Mode) { super(); setTimeout(() => this.emit('open'), 5); }
  message(m: unknown) { this.emit('message', Buffer.from(JSON.stringify(m))); }
  speak(text: string, ms = 200) {
    this.message({ type: 'audio', audio_event: { audio_base_64: Buffer.alloc(BYTES_PER_MS * ms, 0x10).toString('base64') } });
    this.message({ type: 'agent_response', agent_response_event: { agent_response: text, response_id: `r${++this.n}` } });
    setTimeout(() => this.message({ type: 'agent_response_complete' }), ms);
  }
  send(data: string) {
    const m = JSON.parse(data) as { type?: string; text?: string; user_audio_chunk?: string; tool_call_id?: string };
    this.sent.push(m);
    if (m.type === 'conversation_initiation_client_data') setTimeout(() => this.message({ type: 'conversation_initiation_metadata', conversation_initiation_metadata_event: { conversation_id: 'conv' } }), 5);
    if (m.type === 'user_message') setTimeout(() => this.speak(m.text!.includes('System notice:') ? 'The agent answered: done.' : 'Hola, te escucho.'), 20);
    if (m.type === 'client_tool_result') setTimeout(() => this.speak(this.mode === 'send' ? 'Enviado.' : 'El hilo va bien.'), this.mode === 'read' ? 3500 : 20);
    if (!m.user_audio_chunk) return;
    const loud = Buffer.from(m.user_audio_chunk, 'base64').some(byte => byte !== 0);
    if (loud) { this.speaking = true; return; }
    if (!this.speaking) return;
    this.speaking = false;
    this.message({ type: 'user_transcript', user_transcription_event: { user_transcript: this.mode === 'send' ? 'Sí, mándalo.' : '¿Cómo va el hilo?' } });
    const call = this.mode === 'send' ? { tool_name: 't3_send_message', parameters: sendTo('t') } : { tool_name: 't3_read_thread', parameters: { threadId: worldId('thread', 't').slice(0, 8) } };
    setTimeout(() => this.message({ type: 'client_tool_call', client_tool_call: { ...call, tool_call_id: `call_${this.mode}`, expects_response: true } }), 30);
  }
  close() { this.readyState = 3; this.emit('close', 1000, Buffer.alloc(0)); }
}
// The REST API: one agent and its tools, kept in the state the CLI saves.
const api: Api = async (path, init = {}) => {
  if (path === '/v1/convai/tools') return { status: 200, json: { id: `tool_${Math.random()}` } };
  if (path === '/v1/convai/agents/create') return { status: 200, json: { agent_id: 'agent_eval' } };
  if (init.method === 'PATCH') return { status: 200, json: {} };
  return { status: 200, json: { signed_url: 'wss://example.invalid/convai?token=secret' } };
};

const world = { projects: [{ key: 'p', name: 'proj', threads: [{ key: 't', title: 'Thread', messages: [{ role: 'assistant', text: 'Todo en orden.' }], onSend: { delayMs: 200, reply: ['Done.'] } }] }] };
const sendTo = (thread: string) => ({ projectId: worldId('project', 'p').slice(0, 8), project: 'proj', threadId: worldId('thread', thread).slice(0, 8), message: 'Hola' });
const options = (provider: (p: FakeElevenLabs) => void, mode: Mode, state: { value?: unknown }) => ({ key: 'elevenlabs-key', settings: { llm: 'claude-haiku-5-5', voice: 'George' },
  speech: new Speech({ cacheDir: mkdtempSync(join(tmpdir(), 'elevenlabs-eval-')) }), voices: { a: { id: 'v' } }, defaultVoice: 'a', noResponseMs: 500, turnTimeoutMs: 8000,
  agentState: { get: () => state.value, set: (value: unknown) => { state.value = value; } }, api: () => api,
  connect: () => { const p = new FakeElevenLabs(mode); provider(p); return p as never; } });

test('an ElevenLabs run records the overrides, the send of a yes, its result and the announced agent reply', { timeout: 60_000 }, async () => {
  const scenario = validateScenario({ id: 'el-send', description: 'd', world, language: 'es-ES', turns: [{ noise: 'pink', ms: 300 }], expect: { sends: [{ turn: 1, thread: 't' }] } });
  let provider: FakeElevenLabs | undefined;
  const state: { value?: unknown } = {};
  const run = await runElevenLabsScenario(scenario, options(p => provider = p, 'send', state));
  assert.equal(run.model, 'elevenlabs-agents:claude-haiku-5-5'); assert.equal(run.voice, 'George');
  assert.equal((state.value as { agentId: string }).agentId, 'agent_eval', 'the evaluations keep their agent');
  const initiation = provider!.sent.find(m => m.type === 'conversation_initiation_client_data') as { conversation_config_override: { asr: { keywords: string[] } } };
  assert.deepEqual(run.vocabulary, initiation.conversation_config_override.asr.keywords);
  assert.match(run.initialCatalog!, /^T3 CATALOG/);
  const chunk = provider!.sent.find(m => m.user_audio_chunk) as { user_audio_chunk: string };
  assert.equal(Buffer.from(chunk.user_audio_chunk, 'base64').length, 3200, '100 ms of 16 kHz PCM');
  assert.deepEqual(run.sends.map(s => [s.turn, s.threadKey]), [[1, 't']]);
  const send = run.tools.find(t => t.name === 't3_send_message')!;
  assert.equal(send.status, 'completed'); assert.equal(send.turn, 1);
  assert.ok(run.transcript.some(l => l.role === 'user' && l.text === 'Sí, mándalo.' && l.turn === 1));
  assert.ok(run.transcript.some(l => l.role === 'assistant' && l.text === 'Enviado.' && l.turn === 1 && !l.notice));
  assert.equal(run.notices.length, 1); assert.equal(run.notices[0].delivered, true);
  assert.ok(run.transcript.some(l => l.role === 'assistant' && l.notice && l.text === 'The agent answered: done.'));
  assert.deepEqual(run.timeouts, []);
  const checks = checkRun(scenario, run);
  for (const id of ['sends.count', 'call.agentRepliesAnnounced', 'call.noTimeouts', 'call.everyTurnAnswered']) {
    const check = checks.find(c => c.id === id);
    if (check) assert.equal(check.pass, true, `${id}: ${check.detail}`);
  }
  assert.doesNotMatch(JSON.stringify({ ...run, audio: undefined }), /elevenlabs-key|secret/);
});

test('an answer that comes 3.5 s after a tool result still answers the turn', { timeout: 60_000 }, async () => {
  const scenario = validateScenario({ id: 'el-read', description: 'd', world, language: 'es-ES', turns: [{ noise: 'pink', ms: 300 }], expect: { sends: [] } });
  const run = await runElevenLabsScenario(scenario, options(() => {}, 'read', {}));
  assert.ok(run.transcript.some(l => l.role === 'assistant' && l.text === 'El hilo va bien.' && l.turn === 1), JSON.stringify(run.transcript));
  assert.ok(run.turns[0].latencyMs != null && run.turns[0].latencyMs >= 3500);
  assert.equal(checkRun(scenario, run).find(c => c.id === 'call.everyTurnAnswered')!.pass, true);
});
