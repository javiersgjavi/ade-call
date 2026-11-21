import type { Scenario } from './scenario.mjs';
import type { RunRecord } from './runner.mjs';
import { render, resourceText } from '../resources.mjs';
import { errorCode, spokenWords } from './speech.mjs';
// Credentials in a world copied from a real thread never reach a judge: the diagnostics' redaction.
import { redactEvidence } from './redact.mjs';

// LLM judges: one or more models grade a run against the general rubric
// (resources/eval_judge.txt) and the scenario's own criteria. Each answers a
// strict JSON schema; a run passes the judge when every judge passes every
// critical and major criterion. Judges see only the log and the world.

export interface Verdict { id: string; pass: boolean; severity: 'critical' | 'major' | 'minor'; evidence: string }
export interface Judgement { model: string; reasoning?: string; criteria: Verdict[]; score: number; summary: string; error?: string; usage?: Record<string, number> }
type Fetch = (url: string, init: RequestInit) => Promise<Pick<Response, 'ok' | 'status' | 'text'>>;

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['criteria', 'score', 'summary'],
  properties: {
    criteria: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'pass', 'severity', 'evidence'],
      properties: { id: { type: 'string' }, pass: { type: 'boolean' }, severity: { type: 'string', enum: ['critical', 'major', 'minor'] }, evidence: { type: 'string' } } } },
    score: { type: 'integer', minimum: 1, maximum: 5 },
    summary: { type: 'string' }
  }
};

export function worldText(scenario: Scenario) {
  const lines: string[] = [];
  for (const p of scenario.world.projects) {
    lines.push(evalText('world_project', { name: p.name, key: p.key }));
    for (const t of p.threads || []) {
      lines.push(evalText('world_thread', { title: t.title, key: t.key, status: t.status || 'completed',
        subagent: t.parent ? evalText('world_subagent', { parent: t.parent }) : '', failing: (t.failReads ? evalText('world_failing') : '') + (t.archived ? evalText('world_archived') : '') }));
      for (const m of t.messages || []) lines.push(evalText('world_message', { role: m.role === 'assistant' ? 'agent' : 'user', text: m.text }));
      if (t.onSend?.uncertain) lines.push(evalText('world_on_send_uncertain'));
      else if (t.onSend) lines.push(evalText('world_on_send', { reply: (t.onSend.reply || []).join(' / ') || evalText('world_no_reply') }));
    }
  }
  return lines.join('\n');
}

// The call as one chronological log: user turns (intended and heard), voice
// answers (marked when the user cut them), tools, sends and notices.
export function callLog(scenario: Scenario, run: RunRecord) {
  const events: { ms: number; text: string }[] = [];
  const seconds = (ms: number) => (ms / 1000).toFixed(1);
  for (const t of run.turns) {
    // The words the judge reads: saved when the turn ran (older runs: tags stripped).
    const said = t.kind === 'say' ? evalText('log_said', { text: t.words ?? spokenWords(t.text || '') }) : t.kind === 'noise' ? evalText('log_noise', { kind: scenario.turns[t.index - 1].noise || '' }) : t.text !== undefined ? evalText('log_audio_said', { text: t.text }) : evalText('log_audio');
    events.push({ ms: t.startMs, text: evalText('log_turn', { turn: String(t.index), said, end: seconds(t.endMs) }) });
    if (t.firstAnswerMs != null) events.push({ ms: t.firstAnswerMs, text: evalText('log_voice_audio', { turn: String(t.index) }) });
  }
  for (const l of run.transcript) events.push({ ms: l.ms, text: l.role === 'user' ? evalText('log_heard', { turn: String(l.turn), text: l.text })
    : l.notice ? evalText('log_voice_notice', { text: l.text, state: l.unheard ? evalText('voice_state_unheard') : l.cut ? evalText('voice_state_cut', { heard: seconds(l.cut.heardMs), total: seconds(l.cut.totalMs) }) : '' }) : l.unheard ? evalText('log_voice_unheard', { turn: String(l.turn), text: l.text }) : l.cut ? evalText('log_voice_cut', { turn: String(l.turn), heard: seconds(l.cut.heardMs), total: seconds(l.cut.totalMs), text: l.text }) : evalText('log_voice', { turn: String(l.turn), text: l.text }) });
  // The request where the model made it, the result where it came back.
  for (const t of run.tools) {
    const result = t.result.replace(/\n/g, '\n  '), call = t.callId || '?';
    const args = JSON.stringify(redactEvidence(t.args)) + (t.resolvedArgs ? '\n  ' + evalText('log_resolved_targets', { args: JSON.stringify(redactEvidence(t.resolvedArgs)) }) : '');
    if (t.startedMs === undefined) events.push({ ms: t.ms, text: evalText('log_tool', { name: t.name, status: t.status, args, result }) });
    else {
      events.push({ ms: t.startedMs, text: evalText('log_tool_call', { name: t.name, call, args }) });
      events.push({ ms: t.ms, text: evalText('log_tool_result', { name: t.name, call, status: t.status, result }) });
    }
  }
  for (const s of run.sends) events.push({ ms: s.ms, text: evalText(s.uncertain ? s.arrival === 'confirmed' ? 'log_send_uncertain_arrived' : 'log_send_uncertain' : 'log_send', { thread: s.threadKey ?? evalText('log_new_thread'), project: s.projectKey || s.projectId || evalText('log_unknown_project'), turn: String(s.turn), message: s.message }) });
  for (const n of run.notices) events.push({ ms: n.ms, text: evalText(n.delivered === false ? 'log_notice_undelivered' : n.quiet ? 'log_notice_quiet' : 'log_notice', { thread: n.thread, outcome: evalText(`notice_${n.kind || 'finished'}`), text: n.given ?? n.text }) });
  return events.sort((a, b) => a.ms - b.ms).map(e => `[${seconds(e.ms)}s] ${e.text}`).join('\n');
}

// The texts of the evaluations (resources/eval_texts.json).
let texts: Record<string, string> | undefined;
export function evalText(key: string, vars: Record<string, string> = {}) {
  texts ??= JSON.parse(resourceText('eval_texts.json')) as Record<string, string>;
  if (texts[key] === undefined) throw new Error(`eval_texts.json: missing text ${key}.`);
  return render(texts[key], vars, `eval_texts.json ${key}`);
}

// Redacted field by field, never the formatted log: its quotes are presentation.
const safeEvidence = redactEvidence;

export function judgeInput(scenario: Scenario, run: RunRecord, secrets: string[] = []) {
  scenario = safeEvidence(scenario, secrets);
  run = safeEvidence({ ...run, audio: undefined }, secrets);
  const criteria = (scenario.expect.rubric || []).map((c, i) => `s${i + 1} ${c}`);
  return evalText('judge_input', { id: scenario.id, description: scenario.description, started: run.clock ? evalText('judge_clock', { utc: run.clock.now || run.startedAt, local: run.clock.localNow, zone: run.clock.timeZone }) : run.startedAt || evalText('judge_no_start'), language: scenario.expect.language ? evalText('judge_language', { language: scenario.expect.language }) : '',
    history: scenario.history ? evalText('judge_history', { history: scenario.history }) : '',
    world: worldText(scenario) + '\n\n' + (run.vocabulary === undefined ? evalText('judge_vocabulary_missing') : run.vocabulary.length ? evalText('judge_vocabulary', { hints: JSON.stringify(redactEvidence(run.vocabulary)) }) : evalText('judge_vocabulary_empty')), catalog: run.initialCatalog ? evalText('judge_catalog', { text: run.initialCatalog }) : evalText('judge_no_catalog'), log: callLog(scenario, run),
    criteria: criteria.length ? evalText('judge_criteria', { list: criteria.join('\n') }) : evalText('judge_no_criteria') });
}

export async function judge(scenario: Scenario, run: RunRecord, { model, key, reasoning = 'medium', fetch: fetcher = (url, init) => fetch(url, init) }:
  { model: string; key: string; reasoning?: string; fetch?: Fetch }): Promise<Judgement> {
  const body = { model, reasoning: { effort: reasoning },
    input: [{ role: 'system', content: resourceText('eval_judge.txt') }, { role: 'user', content: judgeInput(scenario, run, [key]).split(key).join('[credential]') }],
    text: { format: { type: 'json_schema', name: 'judgement', strict: true, schema: SCHEMA } } };
  let lastError = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetcher('https://api.openai.com/v1/responses', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(180_000) });
      const text = await response.text();
      if (!response.ok) { lastError = `HTTP ${response.status}${errorCode(text)}`; continue; }
      const data = JSON.parse(text) as { output?: { type: string; content?: { type: string; text?: string }[] }[]; usage?: Record<string, number> };
      const output = data.output?.flatMap(o => o.type === 'message' ? o.content || [] : []).find(c => c.type === 'output_text')?.text;
      if (!output) { lastError = 'no output text'; continue; }
      const parsed = JSON.parse(output) as Omit<Judgement, 'model'>;
      // Stored and graded by the canonical ID: " g1 " is g1.
      if (Array.isArray(parsed.criteria)) parsed.criteria = parsed.criteria.map(c => ({ ...c, id: String(c.id).trim() }));
      const problem = verdictProblem(parsed.criteria, expectedCriteria(scenario));
      if (problem) { lastError = problem; continue; }
      return { model, reasoning, ...parsed, usage: data.usage };
    } catch (error) { lastError = (error as Error)?.name === 'SyntaxError' ? 'the answer is not valid JSON' : (error as Error)?.name || 'request failed'; }
  }
  return { model, reasoning, criteria: [], score: 0, summary: '', error: lastError };
}

// g1–g8 from the general rubric and s1… from the scenario, each exactly once.
export function expectedCriteria(scenario: Scenario) {
  return [...Array.from({ length: 8 }, (_, i) => `g${i + 1}`), ...(scenario.expect.rubric || []).map((_, i) => `s${i + 1}`)];
}
export function verdictProblem(criteria: Verdict[], expected: string[]) {
  const ids = criteria.map(c => c.id.trim());
  const missing = expected.filter(id => !ids.includes(id)), extra = ids.filter(id => !expected.includes(id));
  const repeated = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (!missing.length && !extra.length && !repeated.length) return '';
  // Only IDs this harness defined are named: an invented ID may quote the call.
  const known = [...new Set(repeated.filter(id => expected.includes(id)))];
  return `incomplete verdict:${missing.length ? ` missing ${missing.join(', ')}` : ''}${extra.length ? ` ${extra.length} unexpected` : ''}${repeated.length ? ` repeated ${known.join(', ') || `${repeated.length} unexpected`}` : ''}`;
}

// A judgement passes when it ran and no critical or major criterion failed.
export function judgementPasses(j: Judgement) {
  return !j.error && j.criteria.length > 0 && j.criteria.every(c => c.pass || c.severity === 'minor');
}
