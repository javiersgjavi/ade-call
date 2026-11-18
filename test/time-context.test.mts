import { double } from './fixtures.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { timeContext } from '../src/conversation/time-context.mjs';
import { ProjectContext } from '../src/conversation/context.mjs';
test('local calendar yesterday is distinct from elapsed 24 hours, including DST', () => {
  const t = timeContext({ now: Date.parse('2026-10-25T23:30:00Z'), timeZone: 'Europe/Madrid', lastCall: { endedAt: '2026-10-25T22:30:00Z' } });
  assert.equal(t.localNow, '2026-10-26 00:30');
  assert.equal(t.previousCall!.calendarDaysAgo, 1);
  assert.equal(t.previousCall!.elapsedMinutes, 60);
});
test('time zone changes calendar context; active call preserves previous close', () => {
  const args = { now: Date.parse('2026-11-13T01:00:00Z'), lastCall: { endedAt: null, previousEndedAt: '2026-11-12T23:00:00Z' } };
  assert.equal(timeContext({ ...args, timeZone: 'Europe/Madrid' }).previousCall!.calendarDaysAgo, 0);
  assert.equal(timeContext({ ...args, timeZone: 'UTC' }).previousCall!.calendarDaysAgo, 1);
  assert.equal(timeContext({ now: args.now, timeZone: 'UTC', lastCall: { endedAt: 'invalid' } }).previousCall, null);
  assert.equal(timeContext({ now: args.now, timeZone: 'UTC', lastCall: { endedAt: '2099-01-01' } }).previousCall, null);
});
test('session time does not inherit another conversation call', () => {
  const c = new ProjectContext(double<ConstructorParameters<typeof ProjectContext>[0]>({ backend: 'orca', store: { conversation: () => ({ id: 'new' }), meta: () => ({ conversationId: 'old', endedAt: '2026-11-12T23:00:00Z' }) } }));
  assert.match(JSON.stringify(c.timing()), /localNow/);
  assert.equal(c.timing().previousCall, null);
});
