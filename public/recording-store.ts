export interface RecordingEvent { ms: number; type: string; data?: Record<string, unknown> }
export interface RecordingInfo {
  id: string; startedAt: string; provider: string; backend: string; conversationId: string;
  callId?: string; mime: string; bytes: number; durationMs: number;
  status: 'recording' | 'complete' | 'incomplete'; reason?: string;
}
export const RECORDING_LIMIT = 64 * 1024 * 1024;
export const LIBRARY_LIMIT = 1024 * 1024 * 1024;
export const DURATION_LIMIT = 30 * 60 * 1000;

// Upload only to this installation. No browser persistence, download or provider upload.
export class RecordingStore {
  private constructor(private backend: string) {}
  static async open(backend = 't3') { return new RecordingStore(backend); }
  private async request(path: string, data?: unknown) {
    const controller = new AbortController(), deadline = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(`${path}?backend=${encodeURIComponent(this.backend)}`, {
        ...(data === undefined ? {} : { method: 'POST', body: JSON.stringify(data), headers: { 'Content-Type': 'application/json' } }), signal: controller.signal
      });
      if (!response.ok) throw new Error('The recording could not be saved on the server.');
      return await response.json();
    } finally { clearTimeout(deadline); }
  }
  async list(): Promise<RecordingInfo[]> { return (await this.request('/api/recordings')).recordings; }
  async save(info: RecordingInfo, sequence: number, audio: Blob, events: RecordingEvent[]) {
    const bytes = new Uint8Array(await audio.arrayBuffer());
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    await this.request('/api/recordings/part', { info, sequence, audio: btoa(binary), events });
  }
}
