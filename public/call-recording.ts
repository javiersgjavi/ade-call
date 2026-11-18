import { t } from './i18n.js';
import { RecordingStore, RECORDING_LIMIT, LIBRARY_LIMIT, DURATION_LIMIT, type RecordingEvent, type RecordingInfo } from './recording-store.js';

// A separate graph observes audio; it never feeds speakers or changes call tracks.
export class CallRecording {
  readonly info: RecordingInfo;
  private audio?: AudioContext;
  private merger?: ChannelMergerNode;
  private microphone?: MediaStreamAudioSourceNode;
  private remote?: MediaStreamAudioSourceNode;
  private recorder?: MediaRecorder;
  private destination?: MediaStreamAudioDestinationNode;
  private started = performance.now();
  private events: RecordingEvent[] = [];
  private sequence = 0;
  private queue = Promise.resolve();
  private queuedBytes = 0;
  private stopped = false;
  private failed = false;
  private timer?: ReturnType<typeof setTimeout>;
  private resolve!: () => void;
  private finished = new Promise<void>(resolve => { this.resolve = resolve; });
  constructor(private store: Pick<RecordingStore, 'save' | 'list'>,
    context: Pick<RecordingInfo, 'provider' | 'backend' | 'conversationId'>,
    private report: (message: string) => void) {
    this.info = { ...context, id: crypto.randomUUID(), startedAt: new Date().toISOString(), mime: '', bytes: 0, durationMs: 0, status: 'recording' };
  }
  async start(stream: MediaStream) {
    try {
      if (typeof MediaRecorder === 'undefined') throw new Error('unsupported');
      const used = (await this.store.list()).reduce((sum, item) => sum + item.bytes, 0);
      if (used + RECORDING_LIMIT > LIBRARY_LIMIT) throw new Error('library_full');
      if (this.stopped) return;
      this.audio = new AudioContext();
      await this.audio.resume();
      if (this.stopped) { void this.audio.close(); return; }
      this.destination = this.audio.createMediaStreamDestination();
      this.merger = this.audio.createChannelMerger(2); this.merger.connect(this.destination);
      this.microphone = this.audio.createMediaStreamSource(stream);
      const mono = this.audio.createGain(); mono.channelCount = 1; mono.channelCountMode = 'explicit';
      this.microphone.connect(mono); mono.connect(this.merger, 0, 0);
      const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'].find(type => MediaRecorder.isTypeSupported(type));
      this.recorder = new MediaRecorder(this.destination.stream, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: 128000 });
      this.info.mime = this.recorder.mimeType;
      this.started = performance.now(); this.info.startedAt = new Date().toISOString();
      this.recorder.ondataavailable = ({ data }) => this.persist(data);
      this.recorder.onerror = () => { void this.stop('recorder_error', true); this.report(t('recording.failed')); };
      this.recorder.onstop = () => { this.persist(new Blob(), true); this.release(); void this.queue.finally(() => this.resolve()); };
      this.audio.onstatechange = () => this.event('recording_audio_context', { state: this.audio!.state });
      this.event('recording_started', { channels: 'left=microphone,right=received', sampleRate: this.audio.sampleRate });
      this.persist(new Blob());
      this.recorder.start(1000);
      this.timer = setTimeout(() => { this.report(t('recording.durationLimit')); void this.stop('duration_limit', true); }, DURATION_LIMIT);
    } catch {
      this.report(t('recording.couldNotStart'));
      await this.stop('start_failed', true);
    }
  }
  event(type: string, data?: Record<string, unknown>) {
    if (this.stopped) return;
    // Bound transient memory even if a browser suspends MediaRecorder delivery.
    if (this.events.length >= 2000) { void this.stop('event_limit', true); this.report(t('recording.eventLimit')); return; }
    this.events.push({ ms: Math.round(performance.now() - this.started), type, ...(data ? { data } : {}) });
  }
  identify(id: string) { if (!this.stopped) { this.info.callId = id; this.event('call_identified', { id }); } }
  remoteStream(stream: MediaStream) {
    if (this.stopped || !this.audio || !this.merger) return;
    try {
      this.remote?.disconnect(); this.remote = this.audio.createMediaStreamSource(stream);
      const mono = this.audio.createGain(); mono.channelCount = 1; mono.channelCountMode = 'explicit';
      this.remote.connect(mono); mono.connect(this.merger, 0, 1);
      this.event('remote_track');
    } catch { this.report(t('recording.remoteFailed')); void this.stop('remote_capture_error', true); }
  }
  private persist(audio: Blob, final = false) {
    if (this.failed) return;
    if (this.info.bytes + audio.size > RECORDING_LIMIT || this.queuedBytes + audio.size > 8 * 1024 * 1024) {
      this.info.status = 'incomplete'; this.info.reason = 'storage_limit';
      this.report(t('recording.storageLimit'));
      void this.stop('storage_limit', true); return;
    }
    this.info.bytes += audio.size; this.info.durationMs = Math.round(performance.now() - this.started);
    const info = { ...this.info, status: final ? this.info.status : 'recording' as const }, events = this.events.splice(0), sequence = this.sequence++;
    this.queuedBytes += audio.size;
    this.queue = this.queue.then(async () => {
      if (!this.failed) await this.store.save(info, sequence, audio, events);
    }).catch(() => {
      this.failed = true; this.info.status = 'incomplete'; this.info.reason = 'storage_error';
      this.report(t('recording.storageError'));
      void this.stop('storage_error', true);
    }).finally(() => { this.queuedBytes -= audio.size; });
  }
  stop(reason = 'call_ended', incomplete = false): Promise<void> {
    if (this.stopped) return this.finished;
    this.events.push({ ms: Math.round(performance.now() - this.started), type: 'recording_stopped', data: { reason } });
    this.stopped = true; clearTimeout(this.timer);
    this.info.status = incomplete ? 'incomplete' : 'complete'; this.info.reason = reason;
    if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
    else { this.release(); this.resolve(); }
    return this.finished;
  }
  private release() {
    this.microphone?.disconnect(); this.remote?.disconnect(); this.merger?.disconnect();
    this.destination?.stream.getTracks().forEach(track => track.stop());
    if (this.audio && this.audio.state !== 'closed') void this.audio.close();
  }
}
