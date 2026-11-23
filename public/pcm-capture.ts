// AudioWorklet that turns the microphone into 16 kHz mono 16-bit PCM for a
// relayed call (Gemini Live). It runs at the context's own rate and
// downsamples with a box filter: browsers differ on contexts at 16 kHz with a
// microphone source, so the rate is converted here. Posts 100 ms frames.
export {};
declare class AudioWorkletProcessor { readonly port: MessagePort; }
declare function registerProcessor(name: string, processor: unknown): void;
declare const sampleRate: number;

const TARGET = 16_000, FRAME = TARGET / 10;
class PcmCapture extends AudioWorkletProcessor {
  ratio = sampleRate / TARGET; weight = 0; sum = 0; count = 0;
  frame = new Int16Array(FRAME); filled = 0;
  process(inputs: Float32Array[][]) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    for (const sample of channel) {
      this.sum += sample; this.count++; this.weight++;
      if (this.weight < this.ratio) continue;
      this.weight -= this.ratio;
      const value = Math.max(-1, Math.min(1, this.sum / this.count));
      this.sum = 0; this.count = 0;
      this.frame[this.filled++] = value < 0 ? value * 0x8000 : value * 0x7fff;
      if (this.filled === FRAME) {
        this.port.postMessage(this.frame.buffer, [this.frame.buffer]);
        this.frame = new Int16Array(FRAME); this.filled = 0;
      }
    }
    return true;
  }
}
registerProcessor('pcm-capture', PcmCapture);
