// Small text helpers shared by the direct ADEs (T3, Orca): plain, compact
// text for a model that speaks or writes it back to the user.

export const clean = (value: unknown) => String(value ?? '').replace(/\s+/g, ' ').trim();
// Keys (OpenAI sk-, ElevenLabs sk_, Google AIza), whole tokens only so that
// names such as disk-usage or task_queue stay, and the value of a token in a
// URL's query (a signed conversation URL).
export const redact = (text: string) => text.replace(/([?&](?:token|conversation_signature|key)=)[^\s"'&#<>]+/gi, '$1[credential omitted]')
  .replace(/(?<![\w-])(?:sk-[\w-]{10,}|sk_[A-Za-z0-9]{10,}|AIza[\w-]{10,})/g, '[credential omitted]');

const timeZone = () => process.env.ADE_CALL_TIME_ZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;
// A local "YYYY-MM-DD HH:MM", or '' for a missing or invalid date. Numbers are
// epoch milliseconds; zero means "never".
export function localDate(value?: string | number | null) {
  const date = typeof value === 'number' ? (value > 0 ? new Date(value) : null) : value ? new Date(value) : null;
  if (!date || !Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat('sv-SE', { timeZone: timeZone(), year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
}
export const ago = (ms: number) => ms < 90_000 ? `${Math.max(1, Math.round(ms / 1000))} s` : ms < 90 * 60_000 ? `${Math.round(ms / 60_000)} min`
  : ms < 36 * 3_600_000 ? `${Math.round(ms / 3_600_000)} h` : `${Math.round(ms / 86_400_000)} days`;

// The document tool answers JSON; the model gets its text without escaping.
export function documentText(json: string) {
  try {
    const { content, nextOffset } = JSON.parse(json) as { content: string; nextOffset: number | null };
    return `${content}\n\n[${nextOffset == null ? 'End of document.' : `Document cut: to continue, offset=${nextOffset}.`}]`;
  } catch { return json; }
}
