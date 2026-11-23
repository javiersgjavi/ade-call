import type { LiveResponse } from '../shared/contracts.mjs';
import { StatusError } from '../shared/contracts.mjs';
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { directInstructions, type CallLanguage } from '../direct/prompt.mjs';
import { voiceNoteText } from '../resources.mjs';
import { RealtimeCalls, type RealtimeCall, type RealtimeOptions, type RealtimeSession, type RealtimeSettings, type Socket } from './realtime.mjs';
import type { Socket as AudioSocket } from './gemini.mjs';

// ElevenLabs Realtime (eleven_realtime_v1_*): a speech-to-speech model that
// speaks OpenAI Realtime's protocol over a WebSocket. The events, the tools and
// the turn handling are those of RealtimeCalls, which this engine extends; what
// differs is the transport. There is no WebRTC leg, so the server holds the
// provider socket with the key and relays the page's audio, as with Gemini Live
// (/api/live/stream): the microphone goes up as input_audio_buffer.append and
// the answer's audio comes down from response.output_audio.delta.

export const ELEVEN_REALTIME_MODELS = ['eleven_realtime_v1_max', 'eleven_realtime_v1_mini'] as const;
export const isElevenRealtimeModel = (model: string) => model.startsWith('eleven_realtime');
// Default voices of the ElevenLabs library (multilingual), by the names the
// Realtime API accepts. A value configured by hand stays offered.
export const ELEVEN_REALTIME_VOICES = ['sarah', 'jessica', 'alice', 'lily', 'eric', 'brian', 'george', 'will'] as const;
export const ELEVEN_REALTIME_DEFAULTS = { model: ELEVEN_REALTIME_MODELS[0], voice: 'sarah' } as const;
export const ELEVEN_REALTIME_URL = 'wss://api.elevenlabs.io/v1/convai/realtime';
// PCM at 24 kHz both ways (the only PCM rate the provider takes); the page
// captures at 16 kHz, which the server resamples.
export const PAGE_RATE = 16_000, PROVIDER_RATE = 24_000;
// Browser frames: at most one second of 16 kHz mono PCM each.
const MAX_FRAME = PAGE_RATE * 2;
// The key goes in a header, never in the URL.
export const connectElevenRealtime = (key: string, model: string) =>
  new WebSocket(`${ELEVEN_REALTIME_URL}?model=${encodeURIComponent(model)}`, { headers: { 'xi-api-key': key }, handshakeTimeout: 15_000, maxPayload: 4 * 1024 * 1024 }) as unknown as Socket;

// 16 kHz page audio to the provider's 24 kHz, by linear interpolation.
export function toProviderRate(pcm: Buffer) {
  const samples = pcm.length >> 1, n = Math.floor(samples * PROVIDER_RATE / PAGE_RATE), out = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const x = i * PAGE_RATE / PROVIDER_RATE, j = Math.floor(x), f = x - j;
    const a = pcm.readInt16LE(j * 2), b = pcm.readInt16LE(Math.min(j + 1, samples - 1) * 2);
    out.writeInt16LE(Math.round(a + (b - a) * f), i * 2);
  }
  return out;
}
// Expressive audio tags ("[happy]") are for the speech, not the transcript.
export const plainTranscript = (text: string) => text.replace(/\[[a-z][a-z ]{0,30}\]\s*/gi, '').replace(/\s{2,}/g, ' ').trim();

export class ElevenRealtimeCalls extends RealtimeCalls {
  override readonly provider = 'elevenlabs';
  // The page's audio socket of each call.
  browsers = new Map<string, AudioSocket>();
  constructor(options: RealtimeOptions) {
    const self: { engine?: ElevenRealtimeCalls } = {};
    super({ ...options, connect: options.connect || (() => connectElevenRealtime(self.engine!.key!, self.engine!.model)) });
    self.engine = this;
  }
  override apply(settings: RealtimeSettings) {
    super.apply({ ...settings, model: settings.model || ELEVEN_REALTIME_DEFAULTS.model, voice: settings.voice || ELEVEN_REALTIME_DEFAULTS.voice });
  }
  // The session: OpenAI's shape, with the provider's audio format, its own
  // transcription (fixed to the call's language) and semantic turn detection.
  // Reasoning, noise reduction and the transcription model are OpenAI settings.
  override session(language?: CallLanguage): RealtimeSession {
    const code = (language?.tag || '').split('-')[0].toLowerCase();
    this.hints = [];
    return {
      type: 'realtime', model: this.model, output_modalities: ['audio'],
      instructions: directInstructions(this.ade, { callStart: this.context.timing?.(), capabilities: { backend: this.context.backend, capabilities: this.context.capabilities }, language, custom: this.instructions }),
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: PROVIDER_RATE },
          transcription: /^[a-z]{2}$/.test(code) ? { language: code } : null,
          turn_detection: { type: 'semantic_vad', eagerness: this.eagerness === 'auto' ? 'medium' : this.eagerness, create_response: true, interrupt_response: true }
        },
        output: { format: { type: 'audio/pcm', rate: PROVIDER_RATE }, voice: this.voice }
      },
      tools: this.ade.tools.map(({ name, description, parameters }) => ({ type: 'function', name, description, parameters })),
      tool_choice: 'auto'
    };
  }
  // Opens the provider session and returns where the page streams its audio.
  async createRelayed({ languages = [], language }: { languages?: string[]; language?: string } = {}): Promise<LiveResponse> {
    if (!this.key) throw new StatusError(503, 'The ElevenLabs key is missing on the server.');
    if (this.creating || this.sessions.size) throw new StatusError(409, 'There is already a call active or connecting.');
    if (this.stopping) throw new StatusError(503, 'The service is stopping.');
    this.creating = true;
    const id = `elr_${randomUUID()}`;
    let call: RealtimeCall | undefined;
    try {
      call = this.track(id);
      await this.start(call, { update: true, languages, language });
      return { session: { id }, transport: { stream: `/api/live/stream?id=${encodeURIComponent(id)}` } };
    } catch (error) {
      if (call && !call.closed) this.close(id, 'The voice service could not be connected.');
      this.sessions.delete(id);
      throw error instanceof StatusError ? error : new StatusError(502, 'ElevenLabs Realtime could not be connected.');
    } finally { this.creating = false; }
  }
  // The page's audio socket for a call this server created (server.mts checks
  // authentication, origin and the call's owner first).
  attach(id: string, browser: AudioSocket) {
    const call = this.sessions.get(id);
    if (!call || call.closed || this.browsers.has(id)) { browser.close(1008, 'no_call'); return false; }
    this.browsers.set(id, browser); call.seen = Date.now();
    browser.on('message', (data: Buffer, binary: boolean) => {
      try {
        if (!binary || call.closed || data.length > MAX_FRAME || data.length % 2) return;
        call.seen = Date.now();
        this.send(call, { type: 'input_audio_buffer.append', audio: toProviderRate(data).toString('base64') });
      } catch { /* Dropped. */ }
    });
    browser.on('close', () => { if (this.browsers.get(id) === browser && !call.closed) this.close(id, 'The connection with the phone was lost.'); });
    browser.on('error', () => {});
    this.toBrowser(id, { type: 'session.started', inputRate: PAGE_RATE, outputRate: PROVIDER_RATE });
    return true;
  }
  toBrowser(id: string, data: Buffer | Record<string, unknown>) {
    const browser = this.browsers.get(id);
    if (browser?.readyState !== WebSocket.OPEN) return;
    if (Buffer.isBuffer(data)) browser.send(data, { binary: true });
    else browser.send(JSON.stringify(data));
  }
  override event(call: RealtimeCall, event: Parameters<RealtimeCalls['event']>[1] & { delta?: string }) {
    if (call.closed) return;
    // The answer's audio goes to the page; the user speaking over it (barge-in
    // by the provider's VAD) or the end of the response tells the page.
    if (event.type === 'response.output_audio.delta' && event.delta) { this.toBrowser(call.id, Buffer.from(event.delta, 'base64')); call.greeted = true; }
    if (event.type === 'input_audio_buffer.speech_started' && call.responding) this.toBrowser(call.id, { type: 'interrupted' });
    if (event.type === 'response.done') this.toBrowser(call.id, { type: 'turn.done' });
    super.event(call, event);
  }
  override remember(call: RealtimeCall, role: 'user' | 'assistant', text: string, itemId?: string, echo = false) {
    const clean = role === 'assistant' ? plainTranscript(text) : text;
    if (clean) super.remember(call, role, clean, itemId, echo); else call.direct?.forget(itemId);
  }
  // ElevenLabs drops system messages, and a response requested with nothing new
  // turns the microphone's silence into a user turn ("Sí."). Server notes go as
  // user messages under the header that says they are not the user's words and
  // never authorize a send; only transcripts of the user's voice feed the send rule.
  override note(text: string) { return { type: 'message', role: 'user', content: [{ type: 'input_text', text: voiceNoteText('note', { text }) }] }; }
  // The explicit interrupt: cancel the response and empty the page's playback.
  override interrupt(id: string) {
    const call = this.sessions.get(id); if (!call || call.closed) return;
    call.greeted = true;
    this.toBrowser(id, { type: 'interrupted' });
    if (call.responding) this.send(call, { type: 'response.cancel' });
  }
  override finish(call: RealtimeCall) {
    super.finish(call);
    const browser = this.browsers.get(call.id);
    this.browsers.delete(call.id);
    try { browser?.close(1000, 'closed'); } catch { /* Already closed. */ }
  }
  // No call to hang up at the provider: closing the socket ends it.
  override hangup() {}
}
