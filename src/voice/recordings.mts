import { mkdir, readFile, writeFile, rename, readdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { RecordingEvent, RecordingInfo } from '../../public/recording-store.js';
import { RECORDING_LIMIT, LIBRARY_LIMIT, DURATION_LIMIT } from '../../public/recording-store.js';

interface Manifest extends RecordingInfo { owner: string; sequence: number; eventBytes: number; updatedAt: string; finalized: boolean }
interface Part { info: RecordingInfo; sequence: number; audio: string; events: RecordingEvent[] }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const mimeTypes = new Set(['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/mp4;codecs=mp4a.40.2', 'audio/ogg;codecs=opus']);
const validText = (value: unknown, length = 200): value is string => typeof value === 'string' && value.length > 0 && value.length <= length;
const extension = (mime: string) => mime.includes('mp4') ? 'm4a' : mime.includes('ogg') ? 'ogg' : 'webm';

export class Recordings {
  private queue = Promise.resolve();
  constructor(readonly root: string) {}
  private async manifests(): Promise<Manifest[]> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const result: Manifest[] = [];
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !uuid.test(entry.name)) continue;
      try { result.push(JSON.parse(await readFile(join(this.root, entry.name, 'manifest.json'), 'utf8'))); }
      catch { /* An interrupted creation has no committed manifest yet. */ }
    }
    return result;
  }
  async list(backend: string, owner: string) {
    return (await this.manifests()).filter(info => info.backend === backend && info.owner === owner).map(({ owner: _owner, ...info }) => info);
  }
  save(data: unknown, backend: string, conversationId: string, owner: string) {
    const task = this.queue.then(() => this.savePart(data, backend, conversationId, owner));
    this.queue = task.then(() => {}, () => {});
    return task;
  }
  private async savePart(data: unknown, backend: string, conversationId: string, owner: string) {
    const part = data as Part, info = part?.info;
    if (!info || !uuid.test(info.id) || info.backend !== backend || !validText(info.conversationId)
      || info.provider !== 'realtime' || !mimeTypes.has(info.mime)
      || !validText(info.startedAt) || !Number.isFinite(Date.parse(info.startedAt))
      || !Number.isSafeInteger(part.sequence) || part.sequence < 0 || part.sequence > 5000
      || !Number.isSafeInteger(info.durationMs) || info.durationMs < 0 || info.durationMs > DURATION_LIMIT + 60000
      || !['recording', 'complete', 'incomplete'].includes(info.status)
      || (info.callId !== undefined && !validText(info.callId)) || (info.reason !== undefined && !validText(info.reason))
      || typeof part.audio !== 'string' || part.audio.length > 12 * 1024 * 1024
      || !Array.isArray(part.events) || part.events.length > 2001) throw new Error('Invalid diagnostic fragment.');
    const audio = Buffer.from(part.audio, 'base64');
    if (audio.toString('base64') !== part.audio || audio.length > 8 * 1024 * 1024) throw new Error('Invalid diagnostic audio.');
    for (const event of part.events) {
      if (!event || !Number.isSafeInteger(event.ms) || event.ms < 0 || event.ms > DURATION_LIMIT + 60000
        || !validText(event.type, 100) || (event.data !== undefined && (!event.data || typeof event.data !== 'object' || Array.isArray(event.data)))) throw new Error('Invalid diagnostic event.');
    }
    const eventsText = part.events.map(event => JSON.stringify(event) + '\n').join('');
    const eventBytes = Buffer.byteLength(eventsText);
    if (eventBytes > 1024 * 1024) throw new Error('Too many diagnostic events.');
    const folder = join(this.root, info.id), manifests = await this.manifests();
    const previous = manifests.find(item => item.id === info.id);
    if (previous && (previous.owner !== owner || previous.backend !== backend || previous.conversationId !== info.conversationId || previous.provider !== info.provider || previous.mime !== info.mime)) throw new Error('The recording belongs to another session.');
    if (!previous && (part.sequence !== 0 || info.conversationId !== conversationId)) throw new Error('The conversation changed; the recording was not started.');
    // Completed fragments are immutable. Retrying an identical upload is harmless.
    const partPath = join(folder, 'parts', `${String(part.sequence).padStart(6, '0')}.json`);
    const serialized = JSON.stringify(part);
    if (previous && part.sequence <= previous.sequence) {
      const stored = await readFile(partPath, 'utf8');
      if (createHash('sha256').update(stored).digest('hex') !== createHash('sha256').update(serialized).digest('hex')) throw new Error('The fragment already exists with other content.');
      if (!previous.finalized && info.status !== 'recording') {
        await this.assemble(folder, previous);
        previous.status = info.status; previous.finalized = true;
        await this.atomic(join(folder, 'manifest.json'), JSON.stringify(previous, null, 2));
      }
      return { ok: true, id: info.id };
    }
    if (previous?.finalized || (previous && part.sequence !== previous.sequence + 1)) throw new Error('The recording is closed or a fragment is missing.');
    const bytes = (previous?.bytes || 0) + audio.length, totalEvents = (previous?.eventBytes || 0) + eventBytes;
    if (bytes > RECORDING_LIMIT || totalEvents > 16 * 1024 * 1024) throw new Error('Recording size limit reached.');
    // Count temporary base64 parts and assembled output conservatively (3x).
    const usage = manifests.reduce((sum, item) => sum + 3 * (item.bytes + item.eventBytes), 0);
    if (usage + 3 * (audio.length + eventBytes) > LIBRARY_LIMIT || (!previous && manifests.length >= 128)) throw new Error('Diagnostics archive full. Free up space locally.');
    await mkdir(join(folder, 'parts'), { recursive: true, mode: 0o700 });
    await this.atomic(partPath, serialized);
    const manifest: Manifest = { id: info.id, startedAt: info.startedAt, provider: info.provider, backend, conversationId: info.conversationId,
      ...(info.callId ? { callId: info.callId } : {}), mime: info.mime, bytes, durationMs: info.durationMs,
      status: 'incomplete', reason: info.reason || 'awaiting_more_audio', owner, sequence: part.sequence,
      eventBytes: totalEvents, updatedAt: new Date().toISOString(), finalized: false };
    // The persisted default is incomplete, including a service restart or lost tab.
    await this.atomic(join(folder, 'manifest.json'), JSON.stringify(manifest, null, 2));
    if (info.status !== 'recording') {
      await this.assemble(folder, manifest);
      manifest.status = info.status; manifest.finalized = true;
      await this.atomic(join(folder, 'manifest.json'), JSON.stringify(manifest, null, 2));
    }
    return { ok: true, id: info.id };
  }
  private async atomic(path: string, contents: string) {
    await writeFile(path + '.tmp', contents, { mode: 0o600 }); await rename(path + '.tmp', path);
  }
  private async assemble(folder: string, info: Manifest) {
    const audioPath = join(folder, `audio.${extension(info.mime)}`), eventsPath = join(folder, 'timeline.jsonl');
    const audio = await open(audioPath + '.tmp', 'w', 0o600);
    const events = await open(eventsPath + '.tmp', 'w', 0o600);
    try {
      for (let sequence = 0; sequence <= info.sequence; sequence++) {
        const part: Part = JSON.parse(await readFile(join(folder, 'parts', `${String(sequence).padStart(6, '0')}.json`), 'utf8'));
        await audio.writeFile(Buffer.from(part.audio, 'base64'));
        for (const event of part.events) await events.writeFile(JSON.stringify(event) + '\n');
      }
    } finally { await audio.close(); await events.close(); }
    await rename(audioPath + '.tmp', audioPath); await rename(eventsPath + '.tmp', eventsPath);
  }
  // Offline recovery/export: no provider calls, no modification of source parts.
  async recover(id: string) {
    if (!uuid.test(id)) throw new Error('Invalid identifier.');
    const info = (await this.manifests()).find(item => item.id === id);
    if (!info) throw new Error('Recording not found.');
    await this.assemble(join(this.root, id), info);
    return { id, status: info.status, directory: join(this.root, id) };
  }
}
