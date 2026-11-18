// Diagnostic copies only: never modify the tool input or its response to the model.
export function toolDetails(value: unknown, secrets: (string | undefined)[] = []) {
  let budget = 24000;
  function redact(text: string) {
    for (const secret of secrets) if (typeof secret === 'string' && secret) text = text.split(secret).join('[credential]');
    return text.replace(/(?:sk-[\w-]+|AIza[\w-]+|Bearer\s+[\w.=/+-]+)/gi, '[credential]')
      .replace(/(\b(?:[\w-]{0,80}(?:token|secret|password|authorization|api[_-]?key|credential|access|refresh)[\w-]{0,80})(?:["']?)\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi, '$1"[credencial]"');
  }
  function visit(v: unknown, depth = 0): unknown {
    if (depth > 8 || budget <= 0) return '[detail omitted]';
    if (typeof v === 'string') {
      const safe = redact(v), limit = Math.min(12000, budget);
      budget -= Math.min(safe.length, limit);
      return safe.length > limit ? safe.slice(0, limit) + '… [abreviado]' : safe;
    }
    if (Array.isArray(v)) return v.slice(0, 100).map(item => visit(item, depth + 1));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).slice(0, 100).map(([k, item]) => [visit(k, depth + 1), /token|secret|password|authorization|api.?key|credential|^(?:access|refresh)$/i.test(k) ? '[credential]' : visit(item, depth + 1)]));
    return v;
  }
  return visit(value);
}
