// The transcription model gets the recognition hints as its prompt (see
// vocabularyHints). On a short or unclear utterance it sometimes returns that
// prompt instead of the words: "t3, ADE Call, Claude, Codex, README, ...".
// Such a transcript is kept for diagnostics but is not a user turn.

// Case, accents, hyphens and surrounding punctuation do not distinguish a hint.
function normalize(text: string) {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[-_]+/g, ' ').replace(/[^\p{L}\p{N}\s]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

// The hints a part is made of, when it is only hints ("t3 ADE Call" is two);
// null when any word is not part of a hint. The last part of the transcript
// may end inside a hint (a cut prompt). Spans are bounded by the longest hint.
function hintsIn(part: string, hints: Set<string>, prefixes: Set<string>, longest: number, last: boolean) {
  const words = part.split(' ');
  const best: (string[] | null)[] = [[], ...words.map(() => null)];
  for (let end = 1; end <= words.length; end++)
    for (let start = Math.max(0, end - longest); start < end; start++) {
      const before = best[start];
      if (!before) continue;
      const phrase = words.slice(start, end).join(' ');
      // A cut hint is allowed but does not count towards the three.
      const found = hints.has(phrase) ? [...before, phrase] : last && end === words.length && prefixes.has(phrase) ? before : null;
      if (found && found.length >= (best[end]?.length ?? -1)) best[end] = found;
    }
  return best[words.length];
}

// The separators the hints are joined with in the transcription prompt.
const SEPARATORS = /[,;\n、，]+/;

// True when the transcript only recites hints: at least three different ones,
// and no other word anywhere. Speech with any word of its own ("send it to
// pagos-api and pagos-web", "sí") is never an echo, nor is one name repeated
// ("yes, yes, yes" with a project named Yes); a bare list of names is.
// open: the utterance is still being transcribed, so a recital may not have
// reached its third hint yet; any text made only of hints counts.
export function isHintEcho(transcript: string, hints: readonly string[], { open = false } = {}) {
  // A hint with a comma in it reaches the transcriber as several.
  const known = new Set(hints.flatMap(h => h.split(SEPARATORS)).map(normalize).filter(Boolean));
  if (!known.size) return false;
  const prefixes = new Set<string>();
  for (const hint of known) for (let i = 3; i < hint.length; i++) prefixes.add(hint.slice(0, i).trim());
  const longest = Math.max(...[...known].map(h => h.split(' ').length));
  const parts = transcript.split(SEPARATORS).map(normalize).filter(Boolean);
  if (!parts.length) return false;
  const recited = new Set<string>();
  for (const [i, part] of parts.entries()) {
    const found = hintsIn(part, known, prefixes, longest, i === parts.length - 1);
    if (!found) return false;
    for (const hint of found) recited.add(hint);
    // A hint made of other hints ("Claude Codex") still counts as itself.
    if (known.has(part)) recited.add(part);
  }
  return open || recited.size >= 3;
}
