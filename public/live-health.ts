// Keep only audio counters. Never send raw RTCStats (IP addresses, candidates,
// certificates, track identifiers or device information) to the application.
const counters = ['packetsReceived', 'packetsLost', 'packetsDiscarded', 'bytesReceived', 'concealedSamples', 'silentConcealedSamples', 'concealmentEvents', 'totalSamplesReceived'] as const;
type AudioMetrics = Partial<Record<typeof counters[number] | 'jitterMs' | 'roundTripTimeMs' | 'jitterBufferMeanMs', number>>;
export class LiveHealth {
  values: AudioMetrics = {}; sampling = false; closed = false; sampledAt?: number;
  disconnects = 0; lastConnectionState?: RTCPeerConnectionState;
  constructor(readonly peer: Pick<RTCPeerConnection, 'getStats' | 'connectionState' | 'iceConnectionState'>,
    readonly audio: Pick<HTMLAudioElement, 'muted' | 'paused' | 'readyState'>) {}
  connectionChanged(state: RTCPeerConnectionState) {
    if (this.closed) return;
    if (state === 'disconnected' && this.lastConnectionState !== state) this.disconnects++;
    this.lastConnectionState = state;
  }
  async sample() {
    if (this.closed || this.sampling) return;
    this.sampling = true;
    try {
      const report = await this.peer.getStats();
      if (this.closed) return;
      const values: AudioMetrics = {};
      let delay = 0, emitted = 0;
      for (const row of report.values()) {
        if (row.type === 'inbound-rtp' && row.kind === 'audio') {
          for (const key of counters) {
            if (typeof row[key] === 'number' && Number.isFinite(row[key])) values[key] = (values[key] || 0) + row[key];
          }
          if (typeof row.jitter === 'number' && Number.isFinite(row.jitter)) values.jitterMs = Math.max(values.jitterMs || 0, row.jitter * 1000);
          if (Number.isFinite(row.jitterBufferDelay) && Number.isFinite(row.jitterBufferEmittedCount)) {
            delay += row.jitterBufferDelay; emitted += row.jitterBufferEmittedCount;
          }
        }
        if (row.type === 'transport' && row.selectedCandidatePairId) {
          const pair = report.get(row.selectedCandidatePairId);
          if (typeof pair?.currentRoundTripTime === 'number' && Number.isFinite(pair.currentRoundTripTime)) values.roundTripTimeMs = pair.currentRoundTripTime * 1000;
        }
      }
      if (emitted > 0) values.jitterBufferMeanMs = delay / emitted * 1000;
      this.values = values; this.sampledAt = performance.now();
    } catch { /* Missing/unsupported stats must never stop audio or heartbeats. */ }
    finally { this.sampling = false; }
  }
  snapshot() {
    return { ...this.values, disconnects: this.disconnects, ...(this.sampledAt == null ? {} : { statsAgeMs: performance.now() - this.sampledAt }), connectionState: this.peer.connectionState, iceConnectionState: this.peer.iceConnectionState,
      outputMuted: this.audio.muted, outputPaused: this.audio.paused, outputReadyState: this.audio.readyState };
  }
  close() { this.closed = true; }
}
