// Discovery helpers for names that arrive through speech recognition. They
// rank candidates for the model to verify; they never select a destination.
const NUMERALS: Record<string, string> = {
  cero: '0', zero: '0', uno: '1', una: '1', one: '1', dos: '2', two: '2', tres: '3', three: '3',
  cuatro: '4', four: '4', cinco: '5', five: '5', seis: '6', six: '6', siete: '7', seven: '7',
  ocho: '8', eight: '8', nueve: '9', nine: '9', diez: '10', ten: '10',
};
// Function words carry almost no identity: "whisper en el nas" ≈ "Whisper NAS".
// The lists cover Spanish and English, the languages the tests exercise.
const STOPWORDS = new Set(['a', 'al', 'de', 'del', 'el', 'la', 'las', 'lo', 'los', 'en', 'y', 'e', 'o', 'u', 'que', 'un', 'una', 'unos', 'para', 'por', 'con', 'sin', 'su', 'mi', 'se', 'eso', 'ese', 'esa', 'esto', 'este', 'esta',
  'the', 'of', 'to', 'and', 'in', 'on', 'for', 'an', 'at', 'with', 'my',
  // Words about the request rather than the name: "el proyecto de ence" ≈ "ence".
  'proyecto', 'proyectos', 'hilo', 'hilos', 'tema', 'temas', 'asunto', 'cosa', 'cosas', 'conversacion', 'chat',
  'project', 'projects', 'thread', 'threads', 'topic', 'stuff']);
// Letter names as spoken before a digit in names like T3, K8s or V2.
const LETTERS: Record<string, string> = { be: 'b', ce: 'c', de: 'd', ka: 'k', pe: 'p', ese: 's', te: 't', uve: 'v', equis: 'x',
  bee: 'b', cee: 'c', dee: 'd', kay: 'k', pee: 'p', es: 's', tee: 't', ti: 't', vee: 'v', ex: 'x' };

// Accent, case and punctuation insensitive words; spoken digits become digits
// and a spoken letter joins a following digit ("te tres" → t3). Longer spelled
// acronyms ("uve ele" → vl) are left to the model's written variants.
export function spokenWords(text: string) {
  const words = text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean).map(word => NUMERALS[word] || word);
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const letter = LETTERS[words[i]] || (/^[a-z]$/.test(words[i]) ? words[i] : '');
    if (letter && /^\d+$/.test(words[i + 1] || '')) out.push(letter + words[++i]);
    else out.push(words[i]);
  }
  return out;
}

// Smallest edit distance between `needle` and any substring of `haystack`.
function substringDistance(needle: string, haystack: string) {
  let previous = new Array<number>(haystack.length + 1).fill(0);
  for (let i = 1; i <= needle.length; i++) {
    const current = [i];
    for (let j = 1; j <= haystack.length; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (needle[i - 1] === haystack[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return Math.min(...previous);
}

// Similarity of one query word to a name: 1 written, then at most one edit
// every four characters from five letters. Shorter words must be written.
// Pronunciation is left to the model: it knows that "guisper" is Whisper
// in any language and passes the written form as a variant.
function wordSimilarity(word: string, target: string[], joined: string) {
  // Inside a compound only from four letters ("socket" in "websocket", not "tal" in "catalogo").
  if (target.some(t => t === word || (word.length === 3 && t.startsWith(word)) || (word.length >= 4 && t.includes(word)))) return 1;
  if (word.length < 5) return 0;
  const similarity = 1 - substringDistance(word, joined) / word.length;
  return similarity >= 0.75 ? similarity : 0;
}

export type SpokenMatch = { kind: 'words' | 'approximate'; score: number; variant: string };
export type NameIndex = { weight(word: string): number };

// Rarer words identify a name: their weight follows inverse document frequency
// over the compared names. Function words weigh almost nothing.
export function nameIndex(names: string[]): NameIndex {
  const frequency = new Map<string, number>();
  for (const name of names) for (const word of new Set(spokenWords(name))) frequency.set(word, (frequency.get(word) || 0) + 1);
  return { weight(word) {
    if (STOPWORDS.has(word)) return 0.1;
    if (word.length <= 2 && !/\d/.test(word)) return 0.3;
    return 1 + Math.log((names.length + 1) / ((frequency.get(word) || 0) + 1));
  } };
}

function scoreWords(words: string[], name: string, index: NameIndex, context?: string) {
  const target = spokenWords(name), extra = context ? spokenWords(context) : [];
  if (!words.length || !target.length) return null;
  const all = [...target, ...extra], joined = all.join(''), titleJoined = target.join('');
  // Consecutive words can be one written word: "light house", "a tarazana", "eleven labs".
  const spoken = words.join('');
  if (spoken.length >= 5 && titleJoined.includes(spoken)) return { kind: 'words' as const, score: 1 };
  let total = 0, earned = 0, written = true, inTitle = false;
  for (const word of words) {
    const weight = index.weight(word);
    const similarity = wordSimilarity(word, all, joined);
    // Function words only count when present: absent ones neither help nor hurt.
    if (!STOPWORDS.has(word) || similarity > 0) { total += weight; earned += weight * similarity; }
    if (similarity < 1 && !STOPWORDS.has(word)) written = false;
    // The project name may complete a title, but cannot match a thread alone.
    if (!STOPWORDS.has(word) && similarity > 0 && wordSimilarity(word, target, titleJoined) > 0) inTitle = true;
  }
  if (!inTitle) return null;
  const score = Math.round(earned / total * 100) / 100;
  if (written && score >= 0.9) return { kind: 'words' as const, score };
  if (score >= 0.75) return { kind: 'approximate' as const, score };
  return null;
}

// Best match over the spoken query and any written variants proposed by the
// model (a spelled acronym, an English term). `variant` reports which matched.
export function spokenMatch(queries: string | string[], name: string, index: NameIndex = nameIndex([name]), context?: string): SpokenMatch | null {
  let best: SpokenMatch | null = null;
  for (const query of Array.isArray(queries) ? queries : [queries]) {
    const found = scoreWords(spokenWords(query), name, index, context);
    if (found && (!best || found.kind === 'words' && best.kind !== 'words' || found.kind === best.kind && found.score > best.score)) best = { ...found, variant: query };
  }
  return best;
}
