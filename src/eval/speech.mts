import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// The synthetic user's audio: 24 kHz mono 16-bit PCM, what GPT Realtime takes.
// Words come from ElevenLabs text to speech and are cached by text, voice and
// model, so a scenario is paid for once and every later run hears the same audio.
export const RATE = 24_000;
export const BYTES_PER_MS = RATE * 2 / 1000;

export interface Voice { id: string; name?: string; model?: string; stability?: number; similarity?: number; style?: number; speed?: number }
type Fetch = (url: string, init: RequestInit) => Promise<Pick<Response, 'ok' | 'status' | 'text' | 'arrayBuffer'>>;

export class Speech {
  synthesized = 0; cached = 0; characters = 0;
  // One synthesis per cache key at a time: parallel runs share it.
  pending = new Map<string, Promise<Buffer>>();
  constructor(readonly options: { cacheDir: string; key?: string; model?: string; fetch?: Fetch }) {
    mkdirSync(options.cacheDir, { recursive: true, mode: 0o700 });
  }
  path(text: string, voice: Voice, language?: string) {
    // An explicit --tts-model overrides every speaker's model, for synthesis and the cache alike.
    const model = this.options.model || voice.model || 'eleven_multilingual_v2';
    const hash = createHash('sha256').update(JSON.stringify([text, voice.id, model, language || '', voice.stability, voice.similarity, voice.style, voice.speed])).digest('hex').slice(0, 32);
    return { file: join(this.options.cacheDir, `${hash}.pcm`), model };
  }
  private cachedAudio(file: string): Buffer | undefined {
    try {
      const audio = readFileSync(file);
      return audio.length >= BYTES_PER_MS * 100 && audio.length % 2 === 0 ? audio : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }
  has(text: string, voice: Voice, language?: string) { return this.cachedAudio(this.path(text, voice, language).file) !== undefined; }
  say(text: string, voice: Voice, language?: string): Promise<Buffer> {
    const { file, model } = this.path(text, voice, language);
    const cached = this.cachedAudio(file);
    if (cached) { this.cached++; return Promise.resolve(cached); }
    const running = this.pending.get(file);
    if (running) { this.cached++; return running; }
    const job = this.synthesize(text, voice, language, file, model).finally(() => this.pending.delete(file));
    this.pending.set(file, job);
    return job;
  }
  // Across processes too. Locks come in generations (<line>.lock.0, .1, …), each
  // published whole with an exclusive hard link and holding its owner's PID. The
  // owner is the holder of the first generation whose process is alive; when a
  // holder dies, waiters move on to the next generation, where only one can win.
  // Nobody ever removes a lock another live process holds.
  private async synthesize(text: string, voice: Voice, language: string | undefined, file: string, model: string): Promise<Buffer> {
    for (const deadline = Date.now() + 180_000; ;) {
      const cached = this.cachedAudio(file);
      if (cached) { this.cached++; return cached; }
      const held = claimLine(file);
      if (held !== null) {
        try {
          const cached = this.cachedAudio(file);
          if (cached) { this.cached++; return cached; }
          return await this.fetchAudio(text, voice, language, file, model);
        } finally { releaseLine(file, held, this.cachedAudio(file) !== undefined); }
      }
      if (Date.now() > deadline) throw new Error('Another process is synthesizing this line and has not finished.');
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  private async fetchAudio(text: string, voice: Voice, language: string | undefined, file: string, model: string): Promise<Buffer> {
    if (!this.options.key) throw new Error('The ElevenLabs key is missing (ELEVENLABS_API_KEY or elevenlabsKey in config.json).');
    const fetcher = this.options.fetch || ((url, init) => fetch(url, init));
    const response = await fetcher(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice.id)}?output_format=pcm_24000`, {
      method: 'POST', headers: { 'xi-api-key': this.options.key, 'content-type': 'application/json', accept: 'audio/pcm' },
      body: JSON.stringify({ text, model_id: model, ...(language && model !== 'eleven_multilingual_v2' ? { language_code: language.split('-')[0] } : {}),
        voice_settings: { stability: voice.stability ?? 0.45, similarity_boost: voice.similarity ?? 0.75, style: voice.style ?? 0.15, use_speaker_boost: true, ...(voice.speed ? { speed: voice.speed } : {}) } }),
      signal: AbortSignal.timeout(60_000)
    });
    if (!response.ok) throw new Error(`ElevenLabs answered ${response.status}${errorCode(await response.text())}.`);
    const audio = Buffer.from(await response.arrayBuffer());
    if (audio.length < BYTES_PER_MS * 100) throw new Error('ElevenLabs returned less than 100 ms of audio.');
    if (audio.length % 2 !== 0) throw new Error('ElevenLabs returned incomplete 16-bit PCM samples.');
    // Written aside and renamed: a reader never sees half a file.
    const partial = `${file}.${process.pid}.partial`;
    writeFileSync(partial, audio, { mode: 0o600 }); renameSync(partial, file);
    this.synthesized++; this.characters += text.length;
    return audio;
  }
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; } };
const lockOwner = (path: string) => { try { return Number(readFileSync(path, 'utf8')); } catch { return null; } };
// The generation this process now owns, or null when a live process owns the line.
function claimLine(file: string): number | null {
  for (let n = 0; n < 1000; n++) {
    const path = `${file}.lock.${n}`, mine = `${file}.${process.pid}.${randomUUID()}.pid`;
    writeFileSync(mine, String(process.pid), { mode: 0o600 });
    try { linkSync(mine, path); return n; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    finally { rmSync(mine, { force: true }); }
    const owner = lockOwner(path);
    if (owner === null) { n--; continue; }
    if (alive(owner)) return null;
  }
  throw new Error('Too many dead synthesis locks for one line.');
}
// The owner removes its own lock; the dead generations below it go only once
// the audio is published (until then they keep later waiters moving up).
function releaseLine(file: string, held: number, published: boolean) {
  for (let n = 0; published && n < held; n++) { const owner = lockOwner(`${file}.lock.${n}`); if (owner !== null && !alive(owner)) rmSync(`${file}.lock.${n}`, { force: true }); }
  rmSync(`${file}.lock.${held}`, { force: true });
}

// Low pink noise (or digital silence), as a phone picks up between phrases.
// Seeded, so a scenario always gets the same noise.
export function noise(kind: 'pink' | 'silence', ms: number, seed = 1, level = 0.004): Buffer {
  const samples = Math.round(ms * RATE / 1000), out = Buffer.alloc(samples * 2);
  if (kind === 'silence') return out;
  let x = seed >>> 0 || 1;
  const random = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 0xffffffff * 2 - 1; };
  let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < samples; i++) {
    const white = random();
    b0 = 0.99765 * b0 + white * 0.0990460; b1 = 0.96300 * b1 + white * 0.2965164; b2 = 0.57000 * b2 + white * 1.0526913;
    const pink = (b0 + b1 + b2 + white * 0.1848) * 0.25;
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(pink * level * 32767 * 8))), i * 2);
  }
  return out;
}

// A narrowband phone line: 300–3400 Hz at 8 kHz and back, with low pink noise
// under the words, as a phone's microphone picks up a room. Seeded.
export function phone(pcm: Buffer, seed = 1): Buffer {
  const narrow = execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 's16le', '-ar', String(RATE), '-ac', '1', '-i', '-',
    '-af', 'highpass=f=300,lowpass=f=3400,aresample=8000,aresample=24000', '-f', 's16le', '-ar', String(RATE), '-ac', '1', '-'], { input: pcm, maxBuffer: 1 << 30 });
  const room = noise('pink', narrow.length / BYTES_PER_MS, seed, 0.003), out = Buffer.alloc(narrow.length);
  for (let i = 0; i + 1 < narrow.length; i += 2) out.writeInt16LE(Math.max(-32768, Math.min(32767, narrow.readInt16LE(i) + (i + 1 < room.length ? room.readInt16LE(i) : 0))), i);
  return out;
}

// The words of a line without its ElevenLabs v3 audio tags ("[sighs] vale"):
// what the user says, for the judge and the console.
export const spokenWords = (text: string) => text.replace(/\[[a-z][a-z -]{0,30}\]\s*/gi, '').trim();

// Any file ffmpeg reads, as 24 kHz mono PCM (the left channel of a stereo recording).
export function audioFile(path: string): Buffer {
  return execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-i', path, '-af', 'pan=mono|c0=c0', '-ar', String(RATE), '-ac', '1', '-f', 's16le', '-'], { maxBuffer: 1 << 30 });
}

export function wav(pcm: Buffer, channels = 1) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); header.writeUInt16LE(channels, 22); header.writeUInt32LE(RATE, 24); header.writeUInt32LE(RATE * 2 * channels, 28);
  header.writeUInt16LE(2 * channels, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

// The machine-readable code of a provider error, never its message: messages
// can quote the rejected input, which may come from a private call.
export function errorCode(body: string) {
  try {
    const data = JSON.parse(body) as { detail?: { status?: unknown; code?: unknown }; error?: { code?: unknown; type?: unknown } };
    const code = data.detail?.status ?? data.detail?.code ?? data.error?.code ?? data.error?.type;
    return typeof code === 'string' && /^[a-z0-9_.-]{1,60}$/i.test(code) ? ` (${code})` : '';
  } catch { return ''; }
}
