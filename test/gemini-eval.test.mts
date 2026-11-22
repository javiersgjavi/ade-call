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
import { runGeminiScenario, toInputRate } from '../src/eval/gemini-runner.mjs';

// A Gemini Live provider: it confirms the setup, greets when asked, hears a
// burst of noise as the user's words, and answers notes that ask for a reply.
// 'send': the user's words are a yes and the model sends to thread t.
// 'talk': the model answers the first turn at length; the second turn
// speaks over it and the provider interrupts the model.
type Mode = 'send' | 'talk';
class FakeGemini extends EventEmitter {
  readyState = 1; sent: Record<string, unknown>[] = []; speaking = false; turns = 0;
  constructor(readonly mode: Mode) { super(); setTimeout(() => this.emit('open'), 5); }
  message(m: unknown) { this.emit('message', Buffer.from(JSON.stringify(m))); }
  speak(text: string, ms = 200) {
    this.message({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: Buffer.alloc(BYTES_PER_MS * ms, 0x10).toString('base64') } }] } } });
    this.message({ serverContent: { outputTranscription: { text } } });
    this.message({ serverContent: { turnComplete: true } });
  }
  send(data: string) {
    const m = JSON.parse(data) as { setup?: unknown; clientContent?: { turns: { parts: { text: string }[] }[]; turnComplete?: boolean }; toolResponse?: unknown; realtimeInput?: { audio?: { data: string } } };
    this.sent.push(m);
    if (m.setup) setTimeout(() => this.message({ setupComplete: {} }), 5);
    if (m.clientContent?.turnComplete) {
      const text = m.clientContent.turns.flatMap(t => t.parts.map(p => p.text)).join('\n');
      if (text.includes('System notice:')) setTimeout(() => this.speak('The agent answered: done.'), 20);
      else if (text.includes('Greet now')) setTimeout(() => this.speak('Hola, te escucho.'), 20);
    }
    if (m.toolResponse) setTimeout(() => this.speak('Enviado.'), 20);
    const audio = m.realtimeInput?.audio;
    if (!audio) return;
    const loud = Buffer.from(audio.data, 'base64').some(byte => byte !== 0);
    if (loud) {
      if (!this.speaking && this.mode === 'talk' && this.turns === 1) this.message({ serverContent: { interrupted: true } });
      this.speaking = true; return;
    }
    if (!this.speaking) return;
    this.speaking = false;
    const n = ++this.turns;
    if (this.mode === 'send') {
      this.message({ serverContent: { inputTranscription: { text: 'Sí, mándalo.' } } });
      setTimeout(() => this.message({ toolCall: { functionCalls: [{ id: `call_send${n}`, name: 't3_send_message', args: sendTo('t') }] } }), 30);
      return;
    }
    this.message({ serverContent: { inputTranscription: { text: n === 1 ? 'Cuéntame algo.' : 'Vale, para.' } } });
    setTimeout(() => this.speak(n === 1 ? 'Te cuento una cosa bastante larga.' : 'Vale.', n === 1 ? 3000 : 200), 30);
  }
  close() { this.readyState = 3; this.emit('close', 1000, Buffer.alloc(0)); }
}

const world = { projects: [{ key: 'p', name: 'proj', threads: [{ key: 't', title: 'Thread', onSend: { delayMs: 200, reply: ['Done.'] } }] }] };
const sendTo = (thread: string) => ({ projectId: worldId('project', 'p').slice(0, 8), project: 'proj', threadId: worldId('thread', thread).slice(0, 8), message: 'Hola' });
const options = (provider: (p: FakeGemini) => void, mode: Mode) => ({ key: 'gemini-key', settings: { model: 'gemini-3.8-live' }, speech: new Speech({ cacheDir: mkdtempSync(join(tmpdir(), 'gemini-eval-')) }),
  voices: { a: { id: 'v' } }, defaultVoice: 'a', noResponseMs: 500, turnTimeoutMs: 8000, utteranceGapMs: 200,
  connect: () => { const p = new FakeGemini(mode); provider(p); return p as never; } });

test('speech goes to Gemini at 16 kHz, at the same pace', () => {
  const pcm = Buffer.alloc(2400 * 2);
  for (let i = 0; i < 2400; i++) pcm.writeInt16LE(i, i * 2);
  const out = toInputRate(pcm);
  assert.equal(out.length, 1600 * 2);
  assert.equal(out.readInt16LE(2), 2); assert.equal(out.readInt16LE(4), 3); assert.equal(out.readInt16LE(3198), 2399);
});

test('a Gemini run records the setup, the send of a yes, its result and the announced agent reply', { timeout: 60_000 }, async () => {
  const scenario = validateScenario({ id: 'gemini-send', description: 'd', world, language: 'es-ES', turns: [{ noise: 'pink', ms: 300 }], expect: { sends: [{ turn: 1, thread: 't' }] } });
  let provider: FakeGemini | undefined;
  const run = await runGeminiScenario(scenario, options(p => provider = p, 'send'));
  assert.equal(run.model, 'gemini-3.8-live'); assert.equal(run.voice, 'Kore');
  // The vocabulary is what the setup gave transcription; the catalog the first history.
  const setup = provider!.sent.find(m => m.setup) as { setup: { inputAudioTranscription: { customVocabulary: string[] } } };
  assert.deepEqual(run.vocabulary, setup.setup.inputAudioTranscription.customVocabulary);
  assert.ok(run.vocabulary!.includes('proj'));
  // The production tools in the subset of JSON Schema Gemini accepts: an
  // unknown keyword such as additionalProperties makes it refuse the setup.
  const declarations = (setup.setup as unknown as { tools: { functionDeclarations: { name: string; parameters: { properties: Record<string, unknown> } }[] }[] }).tools[0].functionDeclarations;
  assert.doesNotMatch(JSON.stringify(declarations), /additionalProperties/);
  assert.ok(declarations.find(d => d.name === 't3_send_message')!.parameters.properties.message);
  assert.match(run.initialCatalog!, /^T3 CATALOG/);
  // The microphone reaches the provider as the page sends it: 100 ms of 16 kHz PCM.
  const frame = provider!.sent.find(m => (m as { realtimeInput?: { audio?: unknown } }).realtimeInput?.audio) as { realtimeInput: { audio: { data: string; mimeType: string } } };
  assert.equal(frame.realtimeInput.audio.mimeType, 'audio/pcm;rate=16000');
  assert.equal(Buffer.from(frame.realtimeInput.audio.data, 'base64').length, 3200);
  assert.deepEqual(run.sends.map(s => [s.turn, s.threadKey]), [[1, 't']]);
  const send = run.tools.find(t => t.name === 't3_send_message')!;
  assert.equal(send.status, 'completed'); assert.equal(send.turn, 1);
  const response = provider!.sent.find(m => m.toolResponse) as { toolResponse: { functionResponses: { response: { output: string } }[] } };
  assert.equal(send.result, response.toolResponse.functionResponses[0].response.output);
  assert.ok(run.transcript.some(l => l.role === 'user' && l.text === 'Sí, mándalo.' && l.turn === 1));
  assert.ok(run.transcript.some(l => l.role === 'assistant' && l.text === 'Enviado.' && l.turn === 1 && !l.notice));
  assert.ok(run.transcript.some(l => l.role === 'assistant' && l.text === 'Hola, te escucho.' && l.turn === 0));
  // The agent's reply reached the voice as a note asking for a reply, and was spoken.
  assert.equal(run.notices.length, 1); assert.equal(run.notices[0].delivered, true); assert.match(run.notices[0].given!, /System notice:/);
  assert.ok(run.transcript.some(l => l.role === 'assistant' && l.notice && l.text === 'The agent answered: done.'));
  assert.deepEqual(run.timeouts, []);
  assert.equal(run.turns[0].latencyMs != null && run.turns[0].latencyMs >= 0, true);
  const checks = checkRun(scenario, run);
  for (const id of ['sends.count', 'call.agentRepliesAnnounced', 'call.noTimeouts']) {
    const check = checks.find(c => c.id === id);
    if (check) assert.equal(check.pass, true, `${id}: ${check.detail}`);
  }
  assert.ok(run.audio && run.audio.length > 0);
  // The key never reaches the record.
  assert.doesNotMatch(JSON.stringify({ ...run, audio: undefined }), /gemini-key/);
});

test('a Gemini interruption cuts the answer playing, and the record says how much was heard', { timeout: 60_000 }, async () => {
  const scenario = validateScenario({ id: 'gemini-cut', description: 'd', world, language: 'es-ES',
    turns: [{ noise: 'pink', ms: 300 }, { noise: 'pink', ms: 300, bargeInMs: 400 }], expect: { sends: [] } });
  const run = await runGeminiScenario(scenario, options(() => {}, 'talk'));
  assert.equal(run.bargeIns, 1);
  assert.deepEqual(run.turns[1].bargeIn, { overVoice: true, cut: true });
  const long = run.transcript.find(l => l.text === 'Te cuento una cosa bastante larga.')!;
  assert.equal(long.turn, 1);
  assert.ok(long.cut && long.cut.heardMs >= 400 && long.cut.heardMs < 3000 && long.cut.totalMs === 3000, JSON.stringify(long.cut));
  assert.ok(run.transcript.some(l => l.role === 'assistant' && l.text === 'Vale.' && l.turn === 2));
  assert.equal(checkRun(scenario, run).find(c => c.id === 'turns[2].bargeIn')!.pass, true);
});
