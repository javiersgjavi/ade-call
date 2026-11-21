// Credential masking for what the evaluations save and send to the judges.
// Deliberately simple: the real defense is that scenarios carry no secrets
// (validation refuses the recognizable ones). This only catches the obvious
// patterns; it does not try to parse every format a secret could hide in.

const KEY = /token|secret|password|passwd|authorization|api.?key|credential|cookie|^(?:access|refresh)$/i;
export const isSensitiveKey = (key: string) => KEY.test(key);

export function redactText(text: string, secrets: string[] = []) {
  for (const secret of secrets) if (typeof secret === 'string' && secret) text = text.split(secret).join('[credential]');
  return text
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[credential]')
    // A whole authorization value (Basic, Bearer, Digest with parameters) to the end of its line.
    .replace(/(\b[\w-]*authorization["']?\s*[:=]\s*)[^\n]+/gi, '$1[credential]')
    .replace(/\b(?:sk-[\w-]{6,}|AIza[\w-]{10,})|\bBearer\s+[\w.=/+~-]+/g, '[credential]')
    // A user:password in a URI.
    .replace(/(\/\/[^\s/:@]*:)[^\s/@]+@/g, '$1[credential]@')
    .replace(/(\b[\w-]{0,80}(?:token|secret|password|passwd|api[_-]?key|credential)[\w-]{0,80}["']?\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi, '$1[credential]');
}

export const looksLikeCredential = (text: string) => redactText(text) !== text;

// Every string of a value masked, and the value of every credential-named key.
export function redactEvidence<T>(value: T, secrets: string[] = []): T {
  const visit = (item: unknown): unknown => {
    if (typeof item === 'string') return redactText(item, secrets);
    if (Array.isArray(item)) return item.map(visit);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, isSensitiveKey(key) ? '[credential]' : visit(child)]));
    return item;
  };
  return visit(value) as T;
}
