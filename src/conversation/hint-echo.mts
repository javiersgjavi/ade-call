// The transcription model gets the recognition hints as its prompt (see
// vocabularyHints). On a short or unclear utterance it sometimes returns that
// prompt instead of the words: "t3, ADE Call, Claude, Codex, README, ...".
// Such a transcript is kept for diagnostics but is not a user turn.

// Case, accents, hyphens and surrounding punctuation do not distinguish a hint.
function normalize(text: string) {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[-_]+/g, ' ').replace(/[^\p{L}\p{N}\s]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

// How many hints a part is made of, when it is only hints ("t3 ADE Call" is
// two); null when any word is not part of a hint. The last part of the
// transcript may end inside a hint (a cut prompt).
function hintCount(part: string, hints: Set<string>, prefixes: Set<string>, last: boolean) {
  const words = part.split(' ');
  const best: (number | null)[] = [0, ...words.map(() => null)];
  for (let end = 1; end <= words.length; end++)
    for (let start = 0; start < end; start++) {
      if (best[start] === null) continue;
      const phrase = words.slice(start, end).join(' ');
      // A cut hint is allowed but does not count towards the three.
      const gain = hints.has(phrase) ? 1 : last && end === words.length && prefixes.has(phrase) ? 0 : null;
      if (gain !== null) best[end] = Math.max(best[end] ?? 0, best[start]! + gain);
    }
  return best[words.length];
}

// True when the transcript only recites hints: at least three of them, and no
// other word anywhere. Speech with any word of its own ("send it to pagos-api
// and pagos-web", "sí") is never an echo; a bare list of three or more names is.
export function isHintEcho(transcript: string, hints: readonly string[]) {
  const known = new Set(hints.map(normalize).filter(Boolean));
  if (!known.size) return false;
  const prefixes = new Set<string>();
  for (const hint of known) for (let i = 3; i < hint.length; i++) prefixes.add(hint.slice(0, i).trim());
  const parts = transcript.split(/[,;\n、，]+/).map(normalize).filter(Boolean);
  let total = 0;
  for (const [i, part] of parts.entries()) {
    const count = hintCount(part, known, prefixes, i === parts.length - 1);
    if (count === null) return false;
    total += count;
  }
  return total >= 3;
}
