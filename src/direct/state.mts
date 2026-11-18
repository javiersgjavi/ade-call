import { createHash } from 'node:crypto';
import { errorText } from '../resources.mjs';

// Per-session state of the direct tools, ADE-agnostic: the IDs the model has
// been shown (with short forms it can say and pass back) and what it already
// read. One per call; discarded when it ends.
const FULL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// IDs inside links stay intact: only standalone IDs are shortened. A UUID that is
// part of a longer ID ("thread:provider:codex:native-thread:<uuid>") is not one:
// cutting it out would leave the long ID truncated and its alias unreadable.
const ID_IN_TEXT = /(?<![\w/:-])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\w:-])/gi;
// Other long IDs (T3 names some subagents after their provider thread) after
// the labels the formats use: "id X", "parent X", "root X", "Thread: X". A
// comma, semicolon or full stop right after one ends a sentence or a list, so
// it is never taken as part of the ID.
const LONG_ID_IN_TEXT = /(?<=(?:^|[\s(])(?:id|parent|root|Thread:) )(?!https?:)[^\s·()]{23,}[^\s·(),;.]/g;
const LONG_ID = /^[^\s-]\S*$/;
const SHORT = 8, MIN_PREFIX = 6;

export interface ReadMemory { at: number; status?: string; keys: string[]; lastLength: number; count: number; start: boolean }

export class DirectCallState {
  ids = new Set<string>(); names = new Map<string, string>(); reads = new Map<string, ReadMemory>();
  // When this session last read each thread or terminal, in any mode.
  checked = new Map<string, number>();
  // Alias → ID for IDs that are not UUIDs; they share long prefixes.
  aliases = new Map<string, string>();
  constructor(public now: () => number = Date.now) {}
  remember(id: string, name?: string) { if (id) { this.ids.add(id); if (name) this.names.set(id, name); } }
  // UUIDs: shortest prefix (8 characters or more) that no other known ID shares.
  // Other IDs: an 8-character alias from their hash, resolved by exact match.
  short(id: string) {
    this.remember(id);
    if (!FULL_ID.test(id) && id.length > SHORT) return this.alias(id);
    const lower = id.toLowerCase();
    let n = Math.min(SHORT, id.length);
    while (n < id.length && [...this.ids].some(other => other !== id && other.toLowerCase().startsWith(lower.slice(0, n)))) n++;
    return id.slice(0, n);
  }
  alias(id: string) {
    const hash = createHash('sha256').update(id).digest('hex');
    for (let n = SHORT - 1; n <= hash.length; n++) {
      const alias = 's' + hash.slice(0, n), owner = this.aliases.get(alias);
      if (!owner || owner === id) { this.aliases.set(alias, id); return alias; }
    }
    return id;
  }
  shorten(text: string) {
    // Register every ID first so two IDs of one text never share a prefix.
    for (const id of [...text.match(ID_IN_TEXT) || [], ...text.match(LONG_ID_IN_TEXT) || []]) this.remember(id);
    return text.replace(ID_IN_TEXT, id => this.short(id)).replace(LONG_ID_IN_TEXT, id => this.short(id));
  }
  // Every ID shown in this session that appears in a text (e.g. an error that
  // names a terminal), as "name" · short ID. Longest first: no ID is cut by another.
  shortenKnown(text: string) {
    for (const id of [...this.ids].filter(id => id.length > SHORT).sort((a, b) => b.length - a.length)) {
      if (!text.includes(id)) continue;
      const name = this.names.get(id);
      text = text.split(id).join(name ? `"${name}" · ${this.short(id)}` : this.short(id));
    }
    return text;
  }
  // A short ID resolves only to a single ID shown in this session; anything else
  // fails before the tool runs, so a prefix can never reach another thread.
  resolve(value: unknown, field: string) {
    if (value === undefined || value === null || value === '') return value;
    if (typeof value !== 'string') throw new Error(errorText('ids.not_text', { field }));
    const text = value.trim(), lower = text.toLowerCase();
    const exact = this.aliases.get(lower) || [...this.ids].find(id => id.toLowerCase() === lower);
    if (exact) return exact;
    // A full ID not shown yet still works; the tool itself validates it. A long
    // one must look like an ID: no spaces, and never a leading "-", which a CLI
    // would read as an option.
    if (FULL_ID.test(text) || (text.length >= 24 && !/^[0-9a-f-]+$/i.test(text) && LONG_ID.test(text))) { this.remember(text); return text; }
    if (text.length < MIN_PREFIX) throw new Error(errorText('ids.too_short', { field, value: text, length: SHORT }));
    const matches = [...this.ids].filter(id => FULL_ID.test(id) && id.toLowerCase().startsWith(lower));
    if (matches.length === 1) return matches[0];
    if (!matches.length) throw new Error(errorText('ids.unknown', { field, value: text }));
    throw new Error(errorText('ids.ambiguous', { field, value: text, matches: matches.map(id => this.short(id)).join(', ') }));
  }
}
