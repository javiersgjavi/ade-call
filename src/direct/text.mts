// Small text helpers shared by the direct ADEs (T3, Orca): plain, compact
// text for a model that speaks or writes it back to the user.

export const clean = (value: unknown) => String(value ?? '').replace(/\s+/g, ' ').trim();
export const redact = (text: string) => text.replace(/(?:sk-[\w-]+|AIza[\w-]+)/g, '[credential omitted]');

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
