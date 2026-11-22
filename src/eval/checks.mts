import type { Scenario } from './scenario.mjs';
import type { RunRecord } from './runner.mjs';
import { worldId } from './world.mjs';
import { isHintEcho } from '../conversation/hint-echo.mjs';

// Deterministic checks of one run: what was sent, to where, in which turn, and
// which tools ran. A failed critical check fails the run whatever the judge says.

export interface Check { id: string; pass: boolean; critical: boolean; detail: string }

const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
export function median(values: number[]) {
  if (!values.length) return null;
  const sorted = values.toSorted((a, b) => a - b), mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// The thread or project a tool call aimed at, as a world key: arguments carry
// short IDs, which are prefixes of the world's stable UUIDs.
function targets(args: unknown, scenario: Scenario, tool = '') {
  const a = (args || {}) as Record<string, unknown>;
  let ambiguous = false;
  const match = (value: unknown, kind: 'thread' | 'project', keys: string[]) => {
    // As the engine resolves them: surrounding spaces do not change the target.
    const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (v.length < 6) return null;
    const matches = keys.filter(k => worldId(kind, k).startsWith(v));
    if (matches.length > 1) ambiguous = true;
    return matches.length === 1 ? matches[0] : null;
  };
  // The world's threads and the main thread a send may create in each project (main:<project>).
  const projects = scenario.world.projects.map(p => p.key);
  const owners = new Map(scenario.world.projects.flatMap(p => [...(p.threads || []).map(t => [t.key, p.key] as const), [`main:${p.key}`, p.key] as const]));
  const project = tool === 't3_read_thread' ? null : match(a.projectId, 'project', projects);
  if (tool === 't3_find_threads' || tool === 't3_read_document' || tool.endsWith('_release_uncertain')) return { threads: [], projects: project ? [project] : [], ambiguous };
  // Listings consume both filters, even when a parent and its root are supplied together.
  const ids = tool === 't3_list_threads' ? [a.parentThreadId, a.rootThreadId] : [a.threadId];
  const threads = ids.map(id => match(id, 'thread', [...owners.keys()])).filter((id): id is string => id !== null);
  if (tool === 't3_send_message' && project && (a.threadId === undefined || a.threadId === null || a.threadId === '')) threads.push(`main:${project}`);
  const scoped = threads.map(id => owners.get(id)!);
  return { threads, ambiguous, projects: tool === 't3_list_threads' || tool === 't3_send_message' ? [...scoped, ...(project ? [project] : [])] : scoped };
}

export function checkRun(scenario: Scenario, run: RunRecord): Check[] {
  const checks: Check[] = [];
  const add = (id: string, pass: boolean, detail: string, critical = true) => checks.push({ id, pass, critical, detail });
  const expected = scenario.expect.sends;
  if (expected) {
    add('sends.count', run.sends.length === expected.length, `expected ${expected.length} send(s), got ${run.sends.length}${run.sends.length ? `: ${run.sends.map(s => `turn ${s.turn} → ${s.threadKey ?? 'new main thread'} "${s.message.slice(0, 80)}"`).join('; ')}` : ''}`);
    expected.forEach((e, i) => {
      const s = run.sends[i];
      if (!s) return;
      const name = `sends[${i + 1}]`;
      // Attempts still count above, but only accepted deliveries satisfy an expectation.
      // An uncertain receipt needs explicit simulator evidence (including a durable queue).
      const accepted = s.arrival === 'confirmed' || (!s.uncertain && s.arrival !== 'unknown' && !!s.projectKey);
      add(`${name}.accepted`, accepted, accepted ? 'the destination accepted the message' : 'no evidence that a destination accepted the attempted send');
      add(`${name}.turn`, s.turn === e.turn, `expected during turn ${e.turn}, happened during turn ${s.turn}`);
      if (e.project) add(`${name}.project`, s.projectKey === e.project, `expected project ${e.project}, got ${s.projectKey}`);
      if (e.thread !== undefined) add(`${name}.thread`, (e.thread ?? null) === (s.threadKey?.startsWith('main:') ? null : s.threadKey), `expected ${e.thread ?? 'a new main thread'}, got ${s.threadKey ?? 'a new main thread'}`);
      for (const part of e.includes || []) add(`${name}.includes`, fold(s.message).includes(fold(part)), `message ${fold(s.message).includes(fold(part)) ? 'contains' : 'lacks'} "${part}"`);
      for (const part of e.excludes || []) add(`${name}.excludes`, !fold(s.message).includes(fold(part)), `message ${fold(s.message).includes(fold(part)) ? 'contains' : 'does not contain'} "${part}"`);
    });
  }
  const tools = scenario.expect.tools;
  const scopedRules = [...tools?.required || [], ...(tools?.forbidden || []).filter(rule => typeof rule !== 'string')].filter(rule => rule.project || rule.thread);
  const scope = (t: RunRecord['tools'][number]) => targets(t.resolvedArgs === undefined ? t.args : { ...(t.args as Record<string, unknown>), ...t.resolvedArgs }, scenario, t.name);
  for (const [i, t] of run.tools.entries()) if (scopedRules.some(rule => rule.name === t.name) && scope(t).ambiguous)
    add(`tools.targets[${i + 1}]`, false, 'ambiguous target prefix without a unique saved resolution: run the scenario again');
  for (const need of tools?.required || []) {
    const sentAt = run.sends[0]?.ms;
    const found = run.tools.find(t => t.name === need.name && t.status === 'completed' && (need.byTurn === undefined || t.turn <= need.byTurn) && (!need.afterSend || (sentAt !== undefined && t.startedMs !== undefined && t.startedMs > sentAt)) &&
      (!need.thread || scope(t).threads.includes(need.thread)) && (!need.project || scope(t).projects.includes(need.project)));
    add(`tools.required.${need.name}${need.thread ? `:${need.thread}` : ''}`, !!found, found ? `ran during turn ${found.turn}` : `no completed ${need.name}${need.thread ? ` on ${need.thread}` : ''}${need.afterSend ? ` started after the first send${run.tools.some(t => t.name === need.name && t.startedMs === undefined) ? ' (this recording has no start times: run it again)' : ''}` : ''}${need.byTurn !== undefined ? ` by turn ${need.byTurn}` : ''}`, need.critical ?? false);
  }
  // Any call counts, whatever its status: trying the forbidden target is the failure.
  for (const rule of tools?.forbidden || []) {
    const f = typeof rule === 'string' ? { name: rule } : rule, on = f.thread || f.project;
    const used = run.tools.filter(t => t.name === f.name && (!f.thread || scope(t).threads.includes(f.thread)) && (!f.project || scope(t).projects.includes(f.project)));
    add(`tools.forbidden.${f.name}${on ? `:${on}` : ''}`, !used.length, used.length ? `called ${used.length} time(s)${on ? ` on ${on}` : ''}` : 'not called');
  }
  // A budget of zero says the turn needs no tool at all: that is its objective, and binding.
  if (tools?.maxCalls !== undefined) add('tools.maxCalls', run.tools.length <= tools.maxCalls, `${run.tools.length} tool call(s), limit ${tools.maxCalls}`, tools.maxCalls === 0);
  // A send the gate refused: the model tried to send without a new user turn
  // (other refusals, such as malformed arguments, are not the gate).
  const refused = run.tools.filter(t => t.name.endsWith('_send_message') && t.status === 'refused' && /\(no_user_turn\)/.test(t.result));
  if (refused.length) add('sends.refusedByGate', false, `${refused.length} send attempt(s) refused by the server gate`, false);
  // A scripted interruption that did not interrupt leaves the scenario untested: it cannot pass.
  // Driven by the script: a recording without the evidence (an older run) cannot show it either.
  scenario.turns.forEach((turn, i) => {
    if (turn.bargeInMs === undefined) return;
    const b = run.turns.find(t => t.index === i + 1)?.bargeIn;
    add(`turns[${i + 1}].bargeIn`, !!b && b.overVoice && b.cut && !b.preamble, !b ? 'no record of whether the interruption happened: run the scenario again'
      : b.preamble ? 'the voice was cut during a preamble before a tool call, not during its answer: the interruption was not exercised'
      : b.overVoice ? (b.cut ? 'the user spoke over the voice and its audio was cut' : 'the user spoke over the voice but no audio was cut') : 'the voice was not speaking when the user started: the interruption was not exercised');
  });
  // A transcription that recites the vocabulary given to speech recognition
  // (project and thread names) instead of the user's words: a recognition
  // problem worth seeing, since the server gate counts it as a user turn.
  // The hints the call was given (older recordings: the world's names and titles).
  // Judged as the server judges it.
  const vocabulary = run.vocabulary ?? scenario.world.projects.flatMap(p => [p.name, ...(p.threads || []).map(t => t.title)]);
  const echoes = run.transcript.filter(l => l.role === 'user' && isHintEcho(l.text, vocabulary));
  add('transcription.noVocabularyEcho', !echoes.length, echoes.length ? `turn(s) ${echoes.map(l => l.turn).join(', ')} transcribed as the vocabulary list` : 'none', false);
  // An agent reply owed to the user that never arrived or was never announced
  // aloud (-1): the user is left without the answer, so it fails the run.
  // Quiet and superseded notices are not owed and never record it.
  add('call.agentRepliesAnnounced', !run.timeouts.includes(-1), run.timeouts.includes(-1) ? 'an agent reply never arrived or was never announced with audio that played' : 'every owed agent reply was announced');
  add('call.noTimeouts', !run.timeouts.length, run.timeouts.length ? `the voice did not go quiet after ${run.timeouts.map(t => t > 0 ? `turn ${t}` : t === 0 ? 'the greeting' : 'an agent reply or its announcement').join(', ')}` : 'every turn settled', false);
  add('call.noProviderErrors', !run.providerErrors.length, run.providerErrors.map(e => e.code).join(', ') || 'none', false);
  // Words and recorded speech expect an answer, unless the turn says silent; noise does not.
  const answered = run.turns.filter(t => t.kind !== 'noise' && !scenario.turns[t.index - 1]?.silent);
  const silent = answered.filter(t => t.firstAnswerMs == null && !run.transcript.some(l => l.role === 'assistant' && !l.unheard && !l.notice && l.turn === t.index));
  // A turn marked silent must get no answer heard before the user speaks again.
  scenario.turns.forEach((turn, i) => {
    if (!turn.silent) return;
    const next = run.turns.find(t => t.index === i + 2)?.startMs ?? Infinity;
    const spoken = run.transcript.filter(l => l.role === 'assistant' && !l.unheard && !l.notice && l.turn === i + 1 && l.ms < next);
    const actual = run.turns.find(t => t.index === i + 1);
    const played = actual?.firstAnswerMs != null && actual.firstAnswerMs < next;
    const legacyAudio = actual?.firstAnswerMs === undefined;
    add(`turns[${i + 1}].silent`, !spoken.length && !played && !legacyAudio,
      spoken.length ? `the voice answered before the user went on: "${spoken[0].text.slice(0, 80)}"` : played ? 'answer audio played before the next turn'
        : legacyAudio ? 'playback evidence was not saved: run the scenario again' : 'the voice waited');
  });
  add('call.everyTurnAnswered', !silent.length, silent.length ? `no answer to turn(s) ${silent.map(t => t.index).join(', ')}` : 'every spoken turn got an answer', false);
  if (scenario.expect.maxMedianLatencyMs) {
    const m = median(run.turns.map(t => t.latencyMs).filter((v): v is number => v != null));
    // A latency budget the scenario sets is its objective: missing it fails the run.
    add('latency.median', m != null && m <= scenario.expect.maxMedianLatencyMs, `median ${m ?? 'n/a'} ms, budget ${scenario.expect.maxMedianLatencyMs} ms`);
  }
  return checks;
}

export function latencySummary(run: RunRecord) {
  const values = run.turns.map(t => t.latencyMs).filter((v): v is number => v != null);
  return { median: median(values), max: values.length ? Math.max(...values) : null, values };
}
