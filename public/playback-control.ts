export type PlaybackEventKind = 'local_speech_start' | 'local_speech_end';
type PlaybackRecord = { kind: PlaybackEventKind; at: number };
// Over WebRTC the provider's VAD cuts the voice when the user speaks and
// truncates what was not heard. Locally, microphone energy only drives the
// speech indicator and never mutes playback.
export class PlaybackControl {
  events: PlaybackRecord[] = [];
  constructor(readonly display: (speaking: boolean) => void) {}
  record(kind: PlaybackEventKind) {
    this.events.push({ kind, at: Date.now() });
    this.events = this.events.slice(-20);
  }
  automaticStart() { this.display(true); this.record('local_speech_start'); return false; }
  end() { this.display(false); this.record('local_speech_end'); }
  diagnostics() { return { playbackPolicy: 'provider', playbackEvents: this.events.map(e => ({ ...e })) }; }
}
