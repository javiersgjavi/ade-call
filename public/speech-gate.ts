// Local speech indicator. Energy alone must not control
// playback: the consumer needs independent confirmation of user speech.
export interface SpeechActivity { voice: boolean; output: boolean; now: number; micLevel?: number; threshold?: number }
export class SpeechGate {
  onStart: () => boolean | void; onEnd: () => void; speaking: boolean;
  onActivity?: (activity: SpeechActivity) => void;
  loudSince?: number | null;
  armed = true; quietSince?: number | null; automaticSince?: number;
  activations = 0; activeMs = 0; timeouts = 0;
  recentOutput: { at: number; level: number }[] = [];
  lastVoice = 0; lastOutput?: number; waitForOutput?: boolean;
  audio!: AudioContext; input?: MediaStreamAudioSourceNode; mic?: AnalyserNode;
  remoteInput?: MediaStreamAudioSourceNode; remote?: AnalyserNode;
  samples = new Float32Array(1024); remoteSamples = new Float32Array(1024); timer?: ReturnType<typeof setInterval>;
  constructor({ onStart, onEnd, onActivity }: { onStart: () => boolean | void; onEnd: () => void; onActivity?: (activity: SpeechActivity) => void }) {
    this.onStart = onStart; this.onEnd = onEnd; this.onActivity = onActivity; this.speaking = false;
  }
  finishAutomatic(now: number) {
    if (this.automaticSince == null) return;
    this.activeMs += Math.max(0, now - this.automaticSince); this.automaticSince = undefined;
  }
  diagnostics(now = performance.now()) {
    return { localGateActivations: this.activations, localGateActiveMs: this.activeMs + (this.automaticSince == null ? 0 : Math.max(0, now - this.automaticSince)), localGateTimeouts: this.timeouts };
  }
  sample(mic: number, output: number, now = performance.now()) {
    // Keep an output reference across short pauses, where delayed echo can
    // still reach the microphone. The WebRTC stream supplies actual playback.
    this.recentOutput = this.recentOutput.filter(point => now - point.at <= 300);
    this.recentOutput.push({ at: now, level: output });
    const threshold = Math.max(0.025, ...this.recentOutput.map(point => point.level * 0.6));
    if (mic <= 0.025) this.quietSince ??= now;
    else this.quietSince = null;
    // A continuous noise floor cannot repeatedly rearm the speech indicator.
    // Use the absolute mic floor, not the playback-relative detection threshold.
    if (!this.speaking && this.quietSince != null && now - this.quietSince >= 350) this.armed = true;
    if (mic > threshold) {
      this.loudSince ??= now;
      if (now - this.loudSince >= 120) {
        this.lastVoice = now;
        if (!this.speaking && this.armed) {
          this.speaking = true; this.armed = false; this.automaticSince = now; this.activations++;
          this.waitForOutput = this.onStart() !== false;
        }
      }
    } else this.loudSince = null;
    if (output > 0.012) this.lastOutput = now;
    this.onActivity?.({ voice: this.loudSince != null && now - this.loudSince >= 120, output: output > 0.012, now, micLevel: mic, threshold });
    // Bound the whole automatic activation, even if noise keeps lastVoice fresh.
    const expired = this.automaticSince != null && now - this.automaticSince >= 1200;
    const quiet = now - this.lastVoice > 650 && (!this.waitForOutput || now - (this.lastOutput ?? -Infinity) > 350);
    if (this.speaking && (expired || quiet)) {
      if (expired) this.timeouts++;
      this.finishAutomatic(now); this.loudSince = null;
      this.speaking = false; this.onEnd();
    }
  }
  async start(stream: MediaStream) {
    this.audio = new AudioContext(); await this.audio.resume();
    this.input = this.audio.createMediaStreamSource(stream);
    this.mic = this.audio.createAnalyser(); this.mic.fftSize = 1024; this.input.connect(this.mic);
    this.samples = new Float32Array(1024); this.remoteSamples = new Float32Array(1024);
    const energy = (analyser: AnalyserNode | undefined, data: Float32Array<ArrayBuffer>) => {
      if (!analyser) return 0;
      analyser.getFloatTimeDomainData(data);
      return Math.sqrt(data.reduce((sum, x) => sum + x * x, 0) / data.length);
    };
    this.timer = setInterval(() => this.sample(energy(this.mic, this.samples), energy(this.remote, this.remoteSamples)), 40);
  }
  setRemote(stream: MediaStream) {
    this.remoteInput = this.audio.createMediaStreamSource(stream);
    this.remote = this.audio.createAnalyser(); this.remote.fftSize = 1024; this.remoteInput.connect(this.remote);
  }
  close() { clearInterval(this.timer); this.input?.disconnect(); this.remoteInput?.disconnect(); this.audio?.close(); }
}
