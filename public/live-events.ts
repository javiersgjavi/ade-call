import { t } from './i18n.js';
import type { LiveEvent } from '../src/shared/contracts.mjs';
export type LiveCloseCause = 'user_hangup' | 'transport_failed' | 'transport_closed' | 'data_channel_closed' | 'provider_closed' | 'server_session_missing';
// Realtime names its transcript events differently; the page reads one vocabulary.
const REALTIME_NAMES: Record<string, string> = {
  'conversation.item.input_audio_transcription.delta': 'session.input_transcript.delta',
  'response.output_audio_transcript.delta': 'session.output_transcript.delta',
  'session.created': 'session.started'
};
export function normalizeLiveEvent(event: LiveEvent): LiveEvent {
  const type = REALTIME_NAMES[event.type];
  return type ? { ...event, type } : event;
}
// Live events have top-level fields, unlike the application's SSE envelope.
export function bindLiveEvents({ channel, peer, isCurrent, ready, onLive, onEvent, onClose, onError, onConnectionState = () => {} }: {
  channel: Pick<RTCDataChannel, 'onopen' | 'onmessage' | 'onclose' | 'readyState'>;
  peer: Pick<RTCPeerConnection, 'onconnectionstatechange' | 'connectionState'>;
  isCurrent: () => boolean; ready: (id: string) => unknown; onLive: () => void;
  onEvent: (event: LiveEvent) => void; onClose: (cause: LiveCloseCause) => void; onError: (message: string) => void;
  onConnectionState?: (state: RTCPeerConnectionState) => void;
}) {
  let id: string | undefined; let signalled = false, notified = false, closed = false;
  const active = () => !closed && isCurrent();
  const signal = () => {
    if (!active()) return;
    signalled = true;
    if (!id || notified) return;
    notified = true;
    onLive();
    Promise.resolve().then(() => active() && ready(id!)).catch(() => {
      if (active()) onError(t('call.greetingUnconfirmed'));
    });
  };
  const close = (cause: LiveCloseCause) => { if (!active()) return; closed = true; onClose(cause); };
  channel.onopen = signal;
  channel.onmessage = ({ data }) => {
    if (!active()) return;
    let event;
    try { event = JSON.parse(data); } catch { return; }
    if (!event || typeof event.type !== 'string') return;
    event = normalizeLiveEvent(event);
    if (event.type === 'session.closed') { close('provider_closed'); return; }
    if (event.type === 'session.started') signal();
    onEvent(event);
  };
  channel.onclose = () => close('data_channel_closed');
  peer.onconnectionstatechange = () => {
    if (!active()) return;
    onConnectionState(peer.connectionState);
    if (peer.connectionState === 'connected') signal();
    if (peer.connectionState === 'failed') close('transport_failed');
    if (peer.connectionState === 'closed') close('transport_closed');
  };
  return { setId(value: string) { id = value; if (signalled || channel.readyState === 'open' || peer.connectionState === 'connected') signal(); } };
}
