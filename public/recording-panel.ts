import { t } from './i18n.js';
import { CallRecording } from './call-recording.js';
import { RecordingStore, type RecordingInfo } from './recording-store.js';

export class RecordingPanel {
  current: CallRecording | null = null;
  private generation = 0;
  private toggle = document.getElementById('record-call') as HTMLInputElement;
  private status = document.getElementById('recording-status')!;
  // Off on every page load, on purpose: a recording keeps private audio on the
  // server and nothing deletes it, so it is never resumed from an earlier visit
  // (nor from the browser's form restoration). It lasts while the page is open.
  constructor() {
    this.toggle.checked = false;
    this.toggle.onchange = () => { if (!this.toggle.checked) this.stop('disabled_by_user'); };
  }
  private message = (text: string) => { this.status.textContent = text; };
  async start(stream: MediaStream, context: Pick<RecordingInfo, 'provider' | 'backend' | 'conversationId'>) {
    const generation = ++this.generation;
    if (!this.toggle.checked) { this.toggle.disabled = true; return; }
    try {
      const store = await RecordingStore.open(context.backend);
      if (generation !== this.generation) return;
      const recording = new CallRecording(store, context, text => { if (this.current === recording) this.message(text); });
      this.current = recording;
      this.message(t('recording.active'));
      await recording.start(stream);
    } catch { this.message(t('recording.startFailed')); }
  }
  stop(reason: string, incomplete = false) {
    const generation = ++this.generation;
    const recording = this.current; this.current = null;
    this.toggle.disabled = true;
    if (!recording) return;
    this.message(t('recording.finishing'));
    void recording.stop(reason, incomplete).then(() => {
      if (generation !== this.generation) return;
      this.message(recording.info.status === 'complete'
        ? t('recording.saved', { id: recording.info.id })
        : t('recording.incomplete', { id: recording.info.id }));
    });
  }
  idle() { this.toggle.disabled = false; }
}
