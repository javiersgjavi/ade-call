import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

export const REMEMBER_SECONDS = 180 * 86400;
export const PAIRING_MS = 10 * 60_000;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export interface BrowserDevice { id: string; name: string; createdAt: number; lastSeen: number; expiresAt: number; revokedAt: number | null }
interface Session extends BrowserDevice { tokenHash: string }
export function publicOrigin(value: string) {
  const url = new URL(value);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))))
    throw new Error('Use an HTTPS URL without a path or credentials; HTTP is only accepted on localhost.');
  return url.origin;
}
// This database belongs to ADE Call, never to an ADE. CLI and HTTP redeem
// concurrently through SQLite; codes and browser credentials are stored as hashes.
export class BrowserAccess {
  db: DatabaseSync;
  constructor(path: string, private now = Date.now) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, '', { flag: 'a', mode: 0o600 }); chmodSync(path, 0o600);
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS access_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pairing_codes (hash TEXT PRIMARY KEY, name TEXT NOT NULL, expiresAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS browsers (id TEXT PRIMARY KEY, tokenHash TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
        createdAt INTEGER NOT NULL, lastSeen INTEGER NOT NULL, expiresAt INTEGER NOT NULL, revokedAt INTEGER);
      CREATE TABLE IF NOT EXISTS access_attempts (peer TEXT PRIMARY KEY, startedAt INTEGER NOT NULL, count INTEGER NOT NULL);`);
  }
  origin() { return (this.db.prepare("SELECT value FROM access_settings WHERE key='origin'").get() as { value: string } | undefined)?.value; }
  configure(value: string) {
    const origin = publicOrigin(value);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.origin() && this.origin() !== origin) {
        this.db.exec('DELETE FROM pairing_codes');
        this.db.prepare('UPDATE browsers SET revokedAt=? WHERE revokedAt IS NULL').run(this.now());
      }
      this.db.prepare("INSERT OR REPLACE INTO access_settings VALUES ('origin',?)").run(origin);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return origin;
  }
  createCode(name: string, url?: string) {
    name = this.name(name);
    if (url) {
      const origin = publicOrigin(url);
      if (this.origin() && this.origin() !== origin) throw new Error('The URL differs from the configured one. Use configure explicitly; it will revoke the earlier pairings.');
      if (!this.origin()) this.configure(origin);
    }
    const origin = this.origin();
    if (!origin) throw new Error('Pass --url with the HTTPS address of this installation.');
    const now = this.now();
    this.db.prepare('DELETE FROM pairing_codes WHERE expiresAt<=?').run(now);
    const count = this.db.prepare('SELECT COUNT(*) AS n FROM pairing_codes').get()!.n as number;
    if (count >= 20) throw new Error('There are 20 pending codes. Revoke them with cancel-codes or wait for them to expire.');
    const raw = randomBytes(12).toString('hex').toUpperCase();
    const code = raw.match(/.{6}/g)!.join('-');
    const expiresAt = now + PAIRING_MS;
    this.db.prepare('INSERT INTO pairing_codes VALUES (?,?,?)').run(digest(raw), name, expiresAt);
    // Fragment stays out of HTTP requests, access logs and Referer headers.
    return { code, link: `${origin}/#pair=${code}`, expiresAt, name };
  }
  name(value: string) {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 80 || [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) throw new Error('Invalid browser name (1–80 characters).');
    return value.trim();
  }
  redeem(code: unknown) {
    if (typeof code !== 'string' || code.length > 64) return null;
    const normalized = code.replace(/[\s-]/g, '').toUpperCase();
    if (!/^[A-F0-9]{24}$/.test(normalized)) return null;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('DELETE FROM pairing_codes WHERE hash=? AND expiresAt>? RETURNING name').get(digest(normalized), this.now()) as { name: string } | undefined;
      const result = row ? this.issue(row.name) : null;
      this.db.exec('COMMIT'); return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  issue(name: string, seconds = REMEMBER_SECONDS) {
    const now = this.now();
    this.db.prepare('DELETE FROM browsers WHERE expiresAt<=? OR revokedAt<?').run(now, now - 30 * 86400_000);
    if ((this.db.prepare('SELECT COUNT(*) AS n FROM browsers WHERE revokedAt IS NULL').get()!.n as number) >= 100) throw new Error('Too many paired browsers. Revoke one before adding another.');
    const token = randomBytes(32).toString('base64url');
    const device = { id: randomUUID(), name: this.name(name), createdAt: now, lastSeen: now, expiresAt: now + seconds * 1000, revokedAt: null };
    this.db.prepare('INSERT INTO browsers VALUES (?,?,?,?,?,?,NULL)').run(device.id, digest(token), device.name, now, now, device.expiresAt);
    return { token, device };
  }
  authenticate(token?: string) {
    if (!token || !/^[\w-]{43}$/.test(token)) return null;
    const row = this.db.prepare('SELECT * FROM browsers WHERE tokenHash=? AND revokedAt IS NULL AND expiresAt>?').get(digest(token), this.now()) as Session | undefined;
    if (!row) return null;
    const { tokenHash: _hash, ...device } = row; return device;
  }
  remember(id: string) {
    // Only authenticated HTTP status reads refresh the persistent cookie and lease.
    const now = this.now();
    this.db.prepare('UPDATE browsers SET lastSeen=?,expiresAt=? WHERE id=? AND revokedAt IS NULL AND expiresAt>?').run(now, now + REMEMBER_SECONDS * 1000, id, now);
  }
  active(id: string) { return !!this.db.prepare('SELECT id FROM browsers WHERE id=? AND revokedAt IS NULL AND expiresAt>?').get(id, this.now()); }
  list() { return this.db.prepare('SELECT id,name,createdAt,lastSeen,expiresAt,revokedAt FROM browsers ORDER BY createdAt DESC').all() as unknown as BrowserDevice[]; }
  revoke(id: string) { return this.db.prepare('UPDATE browsers SET revokedAt=? WHERE id=? AND revokedAt IS NULL').run(this.now(), id).changes > 0; }
  cancelCodes() { this.db.exec('DELETE FROM pairing_codes'); }
  allowAttempt(peer: string) {
    const now = this.now();
    this.db.prepare('DELETE FROM access_attempts WHERE startedAt<=?').run(now - 60_000);
    if ((this.db.prepare('SELECT COUNT(*) AS n FROM access_attempts').get()!.n as number) >= 1024) return false;
    this.db.prepare('INSERT INTO access_attempts VALUES (?,?,1) ON CONFLICT(peer) DO UPDATE SET count=count+1').run(peer, now);
    return (this.db.prepare('SELECT count FROM access_attempts WHERE peer=?').get(peer)!.count as number) <= 20;
  }
  close() { this.db.close(); }
}
