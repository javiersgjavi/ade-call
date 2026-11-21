// The browser is untrusted. Persist only bounded counters/states, never arbitrary
// RTCStats, SDP, error messages, audio or conversation content.
export function audioDiagnostics(input: unknown) {
  const result: Record<string, unknown> = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return result;
  const data = input as Record<string, unknown>;
  for (const key of ['packetsReceived', 'packetsLost', 'packetsDiscarded', 'bytesReceived', 'concealedSamples', 'silentConcealedSamples', 'concealmentEvents', 'totalSamplesReceived', 'jitterMs', 'roundTripTimeMs', 'jitterBufferMeanMs', 'outputReadyState', 'statsAgeMs', 'disconnects', 'localGateActivations', 'localGateActiveMs', 'localGateTimeouts',
    // A call the server relays (Gemini Live): frames each way, cut answers, queued playback.
    'relayFramesSent', 'relayFramesReceived', 'relayInterruptions', 'relaySocketState', 'relayQueuedMs']) {
    const value = data[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= (key === 'packetsLost' ? -1e9 : 0) && value <= 1e12) result[key] = value;
  }
  for (const key of ['connectionState', 'iceConnectionState']) {
    const value = data[key];
    if (typeof value === 'string' && ['new', 'connecting', 'checking', 'connected', 'completed', 'disconnected', 'failed', 'closed'].includes(value)) result[key] = value;
  }
  for (const key of ['outputMuted', 'outputPaused', 'localGateActive', 'pageHidden']) if (typeof data[key] === 'boolean') result[key] = data[key];
  if (data.playbackPolicy === 'provider') result.playbackPolicy = data.playbackPolicy;
  const kinds = ['local_speech_start', 'local_speech_end'];
  if (Array.isArray(data.playbackEvents)) result.playbackEvents = data.playbackEvents.slice(-20).flatMap(event =>
    event && typeof event === 'object' && kinds.includes(event.kind) && Number.isFinite(event.at) && event.at >= 0 && event.at <= 1e13 ? [{ kind: event.kind, at: event.at }] : []);
  return result;
}

export function clientCloseReason(cause: unknown) {
  const reasons: Record<string, string> = {
    user_hangup: 'the user hung up.',
    transport_failed: 'The audio connection (WebRTC or the server relay) failed.',
    transport_closed: 'The audio connection (WebRTC or the server relay) closed.',
    data_channel_closed: 'The voice data channel closed.',
    provider_closed: 'The provider closed the voice session.',
    server_session_missing: 'The server no longer recognizes the voice session.',
    page_unloaded: 'The call page was closed or left.'
  };
  return typeof cause === 'string' && Object.hasOwn(reasons, cause) ? reasons[cause] : reasons.user_hangup;
}
