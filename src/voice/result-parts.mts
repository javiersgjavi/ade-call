// Shapes long text (a tool result, a notice) for a voice model. Budgets are UTF-8 bytes: a byte
// count never underestimates tokens, so it is a safe bound for token limits.
const bytes = (text: string) => Buffer.byteLength(text);
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
// Neutral wording: the stored copy is bounded too, so "complete elsewhere" would not hold.
const OMITTED = ' […middle part omitted for length…] ';

// Prefer whole graphemes. An exceptionally long cluster must be split at code
// points instead of dropping user content or exceeding the byte limit.
function prefix(text: string, limit: number) {
  let end = 0, used = 0;
  for (const { segment } of graphemes.segment(text)) {
    used += bytes(segment);
    if (used > limit) {
      if (!end) {
        let size = 0;
        for (const char of segment) { size += bytes(char); if (size > limit) break; end += char.length; }
      }
      break;
    }
    end += segment.length;
  }
  return text.slice(0, end);
}
function suffix(text: string, limit: number) {
  const segments = Array.from(graphemes.segment(text), s => s.segment);
  let start = text.length, used = 0;
  for (let i = segments.length - 1; i >= 0; i--) {
    used += bytes(segments[i]); if (used > limit) break;
    start -= segments[i].length;
  }
  return text.slice(start);
}
// Prefer ending on a sentence, then on a word, unless that discards over half.
function breakAt(piece: string, next = '') {
  let sentence = -1, space = /^\s/.test(next) ? piece.length : -1;
  for (const match of piece.matchAll(/[.!?…:;]["»)]?\s+|\n+/g)) sentence = match.index + match[0].length;
  if (space < 0) for (const match of piece.matchAll(/\s+/g)) space = match.index + match[0].length;
  const minimum = piece.length / 2;
  return sentence >= minimum ? sentence : space >= minimum ? space : piece.length;
}

// Keeps the beginning and the end: answers usually close with the caveat or
// the question the user must hear. The omission is stated, never silent.
export function boundedResult(output: string, maxBytes: number) {
  const text = output.trim();
  if (bytes(text) <= maxBytes) return { text, truncated: false };
  let tail = suffix(text, Math.floor(maxBytes / 4));
  const start = /[.!?…]["»)]?\s+|\n+/.exec(tail);
  if (start && start.index + start[0].length <= tail.length / 2) tail = tail.slice(start.index + start[0].length);
  else tail = tail.replace(/^\S*\s+/, '');
  const room = prefix(text, Math.max(0, maxBytes - bytes(OMITTED) - bytes(tail)));
  return { text: room.slice(0, breakAt(room)).trimEnd() + OMITTED + tail, truncated: true };
}
