import type { LiveCloseCause } from './live-events.js';

// The audio of a call the server relays (Gemini Live): the microphone goes up
// as 16 kHz PCM frames over the server's WebSocket (/api/live/stream) and the
// model's 24 kHz PCM comes back on it. The server holds the provider socket,
// the key and the tools; this page only carries sound. Playback goes through
// a MediaStream on the <audio> element, so echo cancellation, the speech gate
// and recordings see it as they see a WebRTC track.
export interface RelayedEvent { type: string; inputRate?: number; outputRate?: number }
export interface RelayedOptions {
  url: string; stream: MediaStream; audio: HTMLAudioElement;
  isCurrent: () => boolean; onLive: () => void; onClose: (cause: LiveCloseCause) => void; onEvent?: (event: RelayedEvent) => void;
  onAutoplayBlocked?: () => void;
}
// The page's WebSocket URL for a server path, on the page's own origin.
export function streamUrl(path: string, backend: string, origin: Pick<Location, 'protocol' | 'host'> = location) {
  const url = new URL(path, `${origin.protocol}//${origin.host}`);
  url.protocol = origin.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('backend', backend);
  return url.toString();
}
// Little-endian 16-bit PCM to the floats an AudioBuffer holds.
export function pcmToFloat(data: ArrayBuffer) {
  const view = new DataView(data), samples = new Float32Array(data.byteLength >> 1);
  for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 0x8000;
  return samples;
}

export class RelayedCall {
  socket?: WebSocket; context?: AudioContext; capture?: AudioWorkletNode; output?: MediaStreamAudioDestinationNode;
  sources = new Set<AudioBufferSourceNode>(); playhead = 0; outputRate = 24_000;
  closed = false; live = false; sentEnd = false;
  framesSent = 0; framesReceived = 0; interruptions = 0;
  constructor(readonly options: RelayedOptions) {}
  async start() {
    const { stream, audio } = this.options;
    const context = this.context = new AudioContext({ latencyHint: 'interactive' });
    await context.audioWorklet.addModule('/pcm-capture.js');
    if (this.closed) return;
    const capture = this.capture = new AudioWorkletNode(context, 'pcm-capture', { numberOfInputs: 1, numberOfOutputs: 0 });
    context.createMediaStreamSource(stream).connect(capture);
    this.output = context.createMediaStreamDestination();
    audio.srcObject = this.output.stream;
    audio.play().catch(() => { if (this.active()) this.options.onAutoplayBlocked?.(); });
    if (context.state === 'suspended') await context.resume().catch(() => {});
    const socket = this.socket = new WebSocket(this.options.url);
    socket.binaryType = 'arraybuffer';
    capture.port.onmessage = ({ data }: MessageEvent<ArrayBuffer>) => this.sendFrame(data);
    socket.onmessage = ({ data }) => {
      if (!this.active()) return;
      if (data instanceof ArrayBuffer) { this.play(data); return; }
      let event: RelayedEvent;
      try { event = JSON.parse(String(data)); } catch { return; }
      if (!event || typeof event.type !== 'string') return;
      if (event.type === 'session.started') {
        if (event.outputRate) this.outputRate = event.outputRate;
        if (!this.live) { this.live = true; this.options.onLive(); }
      }
      if (event.type === 'interrupted') this.flush();
      this.options.onEvent?.(event);
    };
    // The server closes with 1000 when the call ends there (hang-up elsewhere,
    // provider gone); anything else is the connection failing.
    socket.onclose = ({ code }) => { if (this.active()) { this.closed = true; this.options.onClose(code === 1000 ? 'provider_closed' : this.live ? 'transport_closed' : 'transport_failed'); } };
  }
  active() { return !this.closed && this.options.isCurrent(); }
  remote() { return this.output?.stream || null; }
  // Muted (track disabled): no frames go up, and the provider is told the
  // stream paused so it flushes what it cached.
  sendFrame(frame: ArrayBuffer) {
    if (this.socket?.readyState !== WebSocket.OPEN || !this.live) return;
    const enabled = this.options.stream.getAudioTracks().some(track => track.enabled);
    if (!enabled) { if (!this.sentEnd) { this.sentEnd = true; this.socket.send(JSON.stringify({ type: 'audio.end' })); } return; }
    this.sentEnd = false; this.framesSent++;
    this.socket.send(frame);
  }
  // Chunks play back to back; a short lead absorbs network jitter.
  play(data: ArrayBuffer) {
    const context = this.context, output = this.output;
    if (!context || !output || data.byteLength < 2) return;
    this.framesReceived++;
    const samples = pcmToFloat(data);
    const buffer = context.createBuffer(1, samples.length, this.outputRate);
    buffer.copyToChannel(samples, 0);
    const source = context.createBufferSource();
    source.buffer = buffer; source.connect(output);
    const start = Math.max(this.playhead, context.currentTime + 0.05);
    source.start(start); this.playhead = start + buffer.duration;
    this.sources.add(source); source.onended = () => this.sources.delete(source);
  }
  // The provider cut its answer (the user spoke): drop what is still queued.
  flush() {
    this.interruptions++;
    for (const source of this.sources) try { source.stop(); } catch { /* Already ended. */ }
    this.sources.clear(); this.playhead = 0;
  }
  diagnostics() {
    return { relayFramesSent: this.framesSent, relayFramesReceived: this.framesReceived, relayInterruptions: this.interruptions,
      relaySocketState: this.socket?.readyState ?? -1, relayQueuedMs: this.context ? Math.max(0, Math.round((this.playhead - this.context.currentTime) * 1000)) : 0 };
  }
  close() {
    this.closed = true; this.flush();
    try { this.socket?.close(1000); } catch { /* Already closed. */ }
    if (this.capture) this.capture.port.onmessage = null;
    void this.context?.close().catch(() => {});
  }
}
