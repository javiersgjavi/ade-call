import type { CallHistory } from '../shared/contracts.mjs';
export function timeContext({ now = Date.now(), timeZone = process.env.ADE_CALL_TIME_ZONE || Intl.DateTimeFormat().resolvedOptions().timeZone, lastCall = null }: { now?: number; timeZone?: string; lastCall?: Partial<CallHistory> | null } = {}) {
  const current = new Date(now);
  const local = (date: Date) => new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
  const previousEndedAt = lastCall?.endedAt || lastCall?.previousEndedAt || null;
  const previous = previousEndedAt ? new Date(previousEndedAt) : null;
  const valid = previous && Number.isFinite(previous.getTime()) && previous <= current;
  const day = (date: Date) => Date.parse(local(date).slice(0, 10) + 'T00:00:00Z');
  return { now: current.toISOString(), localNow: local(current), timeZone, lastCall,
    previousCall: valid ? { endedAt: previous.toISOString(), localEndedAt: local(previous),
      elapsedMinutes: Math.floor((current.getTime() - previous.getTime()) / 60000), calendarDaysAgo: Math.round((day(current) - day(previous)) / 86400000) } : null };
}
