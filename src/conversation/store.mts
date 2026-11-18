import type { Conversation, CallHistory, CallEvent } from '../shared/contracts.mjs';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

// Owner and conversation of a call event. Shared by events_calls and callEvents().
const CALL_OWNER = "json_extract(payload, '$.backend')";
const CALL_CONVERSATION = "json_extract(payload, '$.conversationId')";

export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, payload TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_type ON events(type, id);
      CREATE INDEX IF NOT EXISTS events_calls ON events(${CALL_OWNER}, ${CALL_CONVERSATION}, id) WHERE type IN ('transcript','voice-tool');
    `);
  }
  event<T>(type: string, data: T) {
    const result = this.db.prepare('INSERT INTO events(type,payload,created) VALUES (?,?,?)').run(type, JSON.stringify(data), Date.now());
    return { id: Number(result.lastInsertRowid), type, data };
  }
  events(after = 0) {
    return this.db.prepare('SELECT * FROM events WHERE id>? ORDER BY id LIMIT 500').all(after)
      .map(e => ({ id: Number(e.id), type: String(e.type), data: JSON.parse(e.payload as string) as unknown }));
  }
  // The calls of one conversation as stored: transcript turns and voice tool
  // runs, oldest first, the last `limit` up to event `through`.
  callEvents(backend: string, conversationId: string, through = Number.MAX_SAFE_INTEGER, limit = 400) {
    // Same expressions as the partial index events_calls: the read stops after
    // limit + 1 rows of this conversation, however long the history is.
    const rows = this.db.prepare(`SELECT id, type, payload FROM events WHERE type IN ('transcript','voice-tool')
      AND ${CALL_OWNER}=? AND ${CALL_CONVERSATION}=? AND id<=? ORDER BY id DESC LIMIT ?`).all(backend, conversationId, through, limit + 1);
    return { truncated: rows.length > limit, events: rows.slice(0, limit).reverse()
      .map(e => ({ id: Number(e.id), type: String(e.type), data: JSON.parse(e.payload as string) }) as CallEvent) };
  }
  meta<T = unknown>(key: string, value?: T): T | null {
    if (value !== undefined) this.db.prepare('INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
    const row = this.db.prepare('SELECT value FROM meta WHERE key=?').get(key);
    return row ? JSON.parse(row.value as string) as T : null;
  }
  // The current conversation of an ADE; the first use starts one.
  conversation(backend: string): Conversation {
    return this.meta<Conversation>(`conversation:${backend}`) || this.newConversation(backend);
  }
  newConversation(backend: string): Conversation {
    const value = { id: randomUUID(), createdAt: new Date().toISOString() };
    this.meta<Conversation>(`conversation:${backend}`, value); return value;
  }
  callStarted(backend: string, id: string) {
    const now = new Date().toISOString();
    const previous = this.meta<CallHistory>(`call:${backend}`);
    const call = { id, conversationId: this.conversation(backend).id, startedAt: now, endedAt: null,
      previousEndedAt: previous?.conversationId === this.conversation(backend).id ? previous.endedAt : null, status: 'connected' };
    this.meta<CallHistory>(`call:${backend}`, call); return call;
  }
  callEnded(backend: string, id: string, reason: string) {
    const call = this.meta<CallHistory>(`call:${backend}`);
    if (!call || call.id !== id || call.endedAt) return null;
    const ended = { ...call, endedAt: new Date().toISOString(), status: 'closed', reason };
    this.meta<CallHistory>(`call:${backend}`, ended); return ended;
  }
  close() { this.db.close(); }
}
