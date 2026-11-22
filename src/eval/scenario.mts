import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { WORKING } from '../conversation/thread-watch.mjs';
import { isSensitiveKey, looksLikeCredential } from './redact.mjs';
import { validateInstructions } from '../voice/settings.mjs';

// A scenario is one scripted call: the ADE world the voice sees, the user's
// turns (spoken by a synthetic voice, or noise), and what must and must not
// happen. See docs/evals.md for the format and its meaning.

export interface WorldMessage { role: 'user' | 'assistant'; text: string }
// What the simulated agent does after a send to its thread: the thread runs,
// then after delayMs it appends these messages and ends its turn.
// uncertain: the CLI fails after the message reached the thread, so the
// delivery is uncertain, as when T3 times out; the project's later sends are
// refused until the voice reads the thread and the user decides.
// afterTurn: the delay counts from the start of that user turn (or from the send,
// if later), so a reply can be made to arrive while the user talks about something else.
export interface OnSend { delayMs?: number; reply?: string[]; status?: string; uncertain?: boolean; afterTurn?: number }
export interface WorldThread {
  key: string; title: string; status?: string; updatedAt?: string; settled?: boolean; archived?: boolean;
  parent?: string; messages?: WorldMessage[]; onSend?: OnSend;
  // A read of this thread fails, as a broken CLI would.
  failReads?: boolean;
}
export interface WorldProject { key: string; name: string; threads?: WorldThread[] }
export interface World { projects: WorldProject[] }

export interface Turn {
  // Words the synthetic user speaks.
  say?: string;
  // Instead of words: low noise or silence of this length, to test that the
  // voice does not act on transcription artifacts.
  noise?: 'pink' | 'silence'; ms?: number;
  // A recorded clip (WAV/any format ffmpeg reads), relative to the scenario file.
  audio?: string;
  // What the clip says, for the judges (they cannot hear it).
  transcript?: string;
  // Pause before speaking, after the voice went quiet (default 800 ms).
  pauseMs?: number;
  // Start speaking this many ms after the voice starts its answer to the
  // previous turn, instead of waiting for it to finish (an interruption).
  bargeInMs?: number;
  // A different synthetic voice for this turn (key of voices.json).
  voice?: string;
  // A spoken or recorded turn that is not expected to get an answer.
  silent?: boolean;
  // The rest of the previous turn's sentence: spoken pauseMs after the previous
  // turn's audio ends, whether or not the voice answered (a hesitation, not a
  // new turn after the voice's answer).
  continues?: boolean;
}

export interface ExpectedSend {
  // The turn during which the send must happen (1 = first user turn).
  turn: number;
  // World keys of the destination; thread null means a new main thread.
  project?: string; thread?: string | null;
  // Case- and accent-insensitive fragments the message must (not) contain.
  includes?: string[]; excludes?: string[];
}
// afterSend: the call must come after the first send; critical: a missing call fails the run.
export interface ToolExpectation { name: string; thread?: string; project?: string; byTurn?: number; afterSend?: boolean; critical?: boolean }
// A tool that must not run at all (its name), or not on this thread or project.
export type ForbiddenTool = string | { name: string; thread?: string; project?: string };
export interface Expectations {
  // The exact list of sends, in order. [] means nothing may be sent.
  sends?: ExpectedSend[];
  tools?: { required?: ToolExpectation[]; forbidden?: ForbiddenTool[]; maxCalls?: number };
  // Every assistant answer after the first user turn must be in this language (judged).
  language?: string;
  // Median answer latency budget for this scenario.
  maxMedianLatencyMs?: number;
  // Scenario-specific criteria for the judge, besides the general rubric.
  rubric?: string[];
}
export interface Scenario {
  id: string; description: string; tags?: string[];
  // BCP 47 tag of the language chosen in the settings (fixes transcription), or absent.
  language?: string;
  // "phone": the user's audio goes through a narrowband phone line with low
  // background noise, closer to a real call than clean synthetic speech.
  channel?: 'clean' | 'phone';
  // What the voice remembers of earlier calls (the "historical conversation").
  history?: string;
  // The owner's custom instructions from Settings, appended to the prompt as in production.
  instructions?: string;
  world: World;
  turns: Turn[];
  expect: Expectations;
  // Path of the file it came from.
  file?: string;
}

const fail = (file: string, message: string): never => { throw new Error(`${file}: ${message}`); };

export function validateScenario(value: unknown, file = 'scenario'): Scenario {
  const s = value as Scenario;
  if (!s || typeof s !== 'object') fail(file, 'not an object');
  // Everything in a scenario reaches the voice's provider or the judges: no string,
  // anywhere in it, may look like a credential. Checked first, so no error repeats one.
  const sensitiveProperties = (v: unknown): boolean => !!v && typeof v === 'object' && Object.entries(v).some(([key, item]) => isSensitiveKey(key) || sensitiveProperties(item));
  const strings = (v: unknown): string[] => typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => [k, ...strings(x)]) : [];
  if (sensitiveProperties(s) || strings(s).some(looksLikeCredential)) fail(file, 'contains what looks like a credential (a key, token, password or authorization value): remove it');
  // A draft from extract has private words and no world or expectations yet: it never runs.
  if ((s as { draft?: unknown }).draft === true) fail(file, 'is a draft: give it a world and expectations, then remove "draft": true');
  if (typeof s.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{1,80}$/.test(s.id)) fail(file, 'id must be a lowercase slug');
  if (typeof s.description !== 'string' || !s.description) fail(file, 'description is missing');
  if (s.tags !== undefined && (!Array.isArray(s.tags) || s.tags.some(tag => typeof tag !== 'string' || !tag.trim()))) fail(file, 'tags must be a list of nonblank strings');
  if (!s.world || !Array.isArray(s.world.projects)) fail(file, 'world.projects is missing');
  const projects = new Set<string>(), threads = new Set<string>();
  for (const p of s.world.projects) {
    const text = (v: unknown) => typeof v === 'string' && !!v.trim();
    if (!p || !text(p.key) || !text(p.name)) fail(file, 'every project needs key and name as text');
    if (projects.has(p.key)) fail(file, `duplicate project key ${p.key}`);
    projects.add(p.key);
    for (const t of p.threads || []) {
      if (!t || !text(t.key) || !text(t.title)) fail(file, `every thread of ${p.key} needs key and title as text`);
      if (threads.has(t.key)) fail(file, `duplicate thread key ${t.key}`);
      // main:<project> names the main thread the simulator creates on a send without a thread.
      if (t.key.startsWith('main:')) fail(file, `thread ${t.key}: keys starting with main: are reserved`);
      threads.add(t.key);
      if (t.messages !== undefined && !Array.isArray(t.messages)) fail(file, `thread ${t.key}: messages must be a list`);
      for (const m of t.messages || []) if (!m || !['user', 'assistant'].includes(m.role) || typeof m.text !== 'string') fail(file, `thread ${t.key}: messages need role user|assistant and text`);
      for (const key of ['status', 'updatedAt', 'parent'] as const) if (t[key] !== undefined && typeof t[key] !== 'string') fail(file, `thread ${t.key}: ${key} must be text`);
      for (const key of ['settled', 'archived', 'failReads'] as const) if (t[key] !== undefined && typeof t[key] !== 'boolean') fail(file, `thread ${t.key}: ${key} must be true or false`);
      // onSend runs after a paid send: a wrong shape there would crash the run.
      const on = t.onSend;
      if (on !== undefined) {
        if (!on || typeof on !== 'object') fail(file, `thread ${t.key}: onSend must be an object`);
        if (on.delayMs !== undefined && !(Number.isFinite(on.delayMs) && on.delayMs >= 0)) fail(file, `thread ${t.key}: onSend.delayMs must be a number ≥ 0`);
        if (on.reply !== undefined && (!Array.isArray(on.reply) || on.reply.some(r => typeof r !== 'string'))) fail(file, `thread ${t.key}: onSend.reply must be a list of texts`);
        if (on.status !== undefined && typeof on.status !== 'string') fail(file, `thread ${t.key}: onSend.status must be text`);
        // The reply ends the agent's turn: a working status would contradict the final notice.
        if (on.status !== undefined && WORKING.has(on.status)) fail(file, `thread ${t.key}: onSend.status ${on.status} is a working status; the reply ends the turn (completed, failed, stopped…)`);
        if (on.uncertain !== undefined && typeof on.uncertain !== 'boolean') fail(file, `thread ${t.key}: onSend.uncertain must be true or false`);
        if (on.afterTurn !== undefined && !(Number.isInteger(on.afterTurn) && on.afterTurn >= 1)) fail(file, `thread ${t.key}: onSend.afterTurn must be a turn number`);
      }
    }
  }
  const parents = new Map(s.world.projects.flatMap(p => (p.threads || []).map(t => [t.key, t.parent] as const)));
  for (const p of s.world.projects) for (const t of p.threads || []) {
    if (t.parent && !threads.has(t.parent)) fail(file, `thread ${t.key}: unknown parent ${t.parent}`);
    // A cycle of parents would never reach a root thread.
    const seen = [t.key];
    for (let up = t.parent; up; up = parents.get(up)) {
      if (seen.includes(up)) fail(file, `thread ${t.key}: its parents form a cycle (${[...seen, up].join(' → ')})`);
      seen.push(up);
    }
  }
  if (!Array.isArray(s.turns) || !s.turns.length) fail(file, 'turns is empty');
  s.turns.forEach((t, i) => {
    const kinds = [t.say, t.noise, t.audio].filter(v => v !== undefined).length;
    if (kinds !== 1) fail(file, `turn ${i + 1}: exactly one of say, noise, audio`);
    if (t.noise !== undefined && !['pink', 'silence'].includes(t.noise)) fail(file, `turn ${i + 1}: noise is pink or silence`);
    // A turn without samples would leave no boundary for the turns after it.
    if (t.noise && t.ms !== undefined && Math.round(t.ms * 24) < 1) fail(file, `turn ${i + 1}: a noise turn needs ms > 0`);
  });
  s.turns.forEach((t, i) => {
    for (const key of ['ms', 'pauseMs', 'bargeInMs'] as const) if (t[key] !== undefined && !(Number.isFinite(t[key]) && t[key]! >= 0)) fail(file, `turn ${i + 1}: ${key} must be a number ≥ 0`);
    for (const key of ['say', 'audio', 'voice'] as const) if (t[key] !== undefined && typeof t[key] !== 'string') fail(file, `turn ${i + 1}: ${key} must be text`);
    if (t.silent !== undefined && typeof t.silent !== 'boolean') fail(file, `turn ${i + 1}: silent must be true or false`);
    if (t.say !== undefined && (typeof t.say !== 'string' || !t.say.trim())) fail(file, `turn ${i + 1}: say has no words`);
    if (t.transcript !== undefined && (typeof t.transcript !== 'string' || t.audio === undefined)) fail(file, `turn ${i + 1}: transcript is the text of an audio turn`);
    // The judges cannot hear a clip: without its words, a refusal and a yes look alike.
    if (t.audio !== undefined && !(typeof t.transcript === 'string' && t.transcript.trim())) fail(file, `turn ${i + 1}: an audio turn needs transcript, the words of the clip`);
    if (t.continues !== undefined && typeof t.continues !== 'boolean') fail(file, `turn ${i + 1}: continues must be true or false`);
    if (i === 0 && t.bargeInMs !== undefined) fail(file, 'turn 1: bargeInMs needs an answer to a previous turn to interrupt');
    if (t.continues && (i === 0 || t.bargeInMs !== undefined)) fail(file, `turn ${i + 1}: continues needs a previous turn and no bargeInMs`);
  });
  if (s.channel !== undefined && !['clean', 'phone'].includes(s.channel)) fail(file, 'channel is clean or phone');
  if (!s.expect || typeof s.expect !== 'object' || Array.isArray(s.expect)) fail(file, 'expect must be an object');
  const known = (value: object, allowed: string[], path: string) => {
    for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(file, `unknown field ${path}.${key}`);
  };
  known(s.expect, ['sends', 'tools', 'language', 'maxMedianLatencyMs', 'rubric'], 'expect');
  if (s.expect.sends !== undefined && (!Array.isArray(s.expect.sends) || s.expect.sends.some(e => !e || typeof e !== 'object' || Array.isArray(e)))) fail(file, 'expect.sends must be a list of objects');
  // A reply timed from a turn the script never reaches would arrive only at the end:
  // checked for the threads this scenario expects to send to.
  const sentTo = new Set((s.expect?.sends || []).flatMap(e => e.thread ? [e.thread] : []));
  for (const p of s.world.projects) for (const t of p.threads || []) if (sentTo.has(t.key) && t.onSend?.afterTurn && t.onSend.afterTurn > s.turns.length) fail(file, `thread ${t.key}: onSend.afterTurn ${t.onSend.afterTurn} is past the last turn`);
  if (s.history !== undefined && typeof s.history !== 'string') fail(file, 'history must be text');
  // The same rules as Settings: a scenario cannot give the voice what the page would refuse.
  if (s.instructions !== undefined) {
    let text: string | undefined;
    try { text = validateInstructions(s.instructions); } catch (error) { fail(file, `instructions: ${(error as Error).message}`); }
    if (!text) fail(file, 'instructions is blank: remove it');
    // Kept as Settings would save them, so the voice and the judges get production's text.
    s.instructions = text;
  }
  if (s.language !== undefined && (typeof s.language !== 'string' || !/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(s.language))) fail(file, 'language must be a BCP 47 tag');
  // Every shape the checks and the judges read, so a paid call never ends in a crash.
  const texts = (value: unknown, name: string) => { if (value !== undefined && (!Array.isArray(value) || value.some(v => typeof v !== 'string' || !v))) fail(file, `${name} must be a list of non-empty texts`); };
  texts(s.expect.rubric, 'expect.rubric');
  if (s.expect.sends !== undefined && !Array.isArray(s.expect.sends)) fail(file, 'expect.sends must be a list');
  for (const send of s.expect.sends || []) { known(send, ['turn', 'project', 'thread', 'includes', 'excludes'], 'expect.sends[]'); texts(send.includes, 'expect.sends[].includes'); texts(send.excludes, 'expect.sends[].excludes'); }
  const tools = s.expect.tools;
  if (tools !== undefined) {
    if (typeof tools !== 'object' || !tools || Array.isArray(tools)) fail(file, 'expect.tools must be an object');
    if (tools.required !== undefined && (!Array.isArray(tools.required) || tools.required.some(t => !t || typeof t.name !== 'string' || (t.byTurn !== undefined && !Number.isInteger(t.byTurn)) || (t.afterSend !== undefined && typeof t.afterSend !== 'boolean') || (t.critical !== undefined && typeof t.critical !== 'boolean')))) fail(file, 'expect.tools.required must be a list of {name, thread?, project?, byTurn?, afterSend?, critical?}');
    if (tools.forbidden !== undefined && (!Array.isArray(tools.forbidden) || tools.forbidden.some(f => typeof f === 'string' ? !f : !f || typeof f !== 'object' || typeof f.name !== 'string' || !f.name || (f.thread !== undefined && typeof f.thread !== 'string') || (f.project !== undefined && typeof f.project !== 'string')))) fail(file, 'expect.tools.forbidden must be a list of tool names or {name, thread?, project?}');
    known(tools, ['required', 'forbidden', 'maxCalls'], 'expect.tools');
    for (const rule of tools.required || []) known(rule, ['name', 'thread', 'project', 'byTurn', 'afterSend', 'critical'], 'expect.tools.required[]');
    for (const rule of tools.forbidden || []) if (typeof rule !== 'string') known(rule, ['name', 'thread', 'project'], 'expect.tools.forbidden[]');
    if (tools.maxCalls !== undefined && !(Number.isInteger(tools.maxCalls) && tools.maxCalls >= 0)) fail(file, 'expect.tools.maxCalls must be an integer ≥ 0');
  }
  if (s.expect.maxMedianLatencyMs !== undefined && !(Number.isFinite(s.expect.maxMedianLatencyMs) && s.expect.maxMedianLatencyMs > 0)) fail(file, 'expect.maxMedianLatencyMs must be a positive number');
  if (s.expect.language !== undefined && typeof s.expect.language !== 'string') fail(file, 'expect.language must be text');
  // Tool rules may also name the main thread a send creates in a project (main:<project>).
  const owner = new Map(s.world.projects.flatMap(p => [...(p.threads || []).map(t => [t.key, p.key] as const), [`main:${p.key}`, p.key] as const]));
  const destination = (rule: { project?: string; thread?: string | null }, name: string, allowNull = false) => {
    if (rule.project !== undefined) {
      if (typeof rule.project !== 'string' || !rule.project.trim()) fail(file, `${name}: project must be a nonempty string`);
      if (!projects.has(rule.project)) fail(file, `${name}: unknown project ${rule.project}`);
    }
    if (rule.thread !== undefined && !(allowNull && rule.thread === null)) {
      if (typeof rule.thread !== 'string' || !rule.thread.trim()) fail(file, `${name}: thread must be a nonempty string`);
      if (typeof rule.thread === 'string' && !owner.has(rule.thread)) fail(file, `${name}: unknown thread ${rule.thread}`);
    }
  };
  const owns = (project?: string, thread?: string | null) => !project || !thread || owner.get(thread) === project;
  for (const send of s.expect.sends || []) {
    destination(send, 'expected send', true);
    if (!owns(send.project, send.thread)) fail(file, `expected send: thread ${send.thread} is not in project ${send.project}`);
    if (!Number.isInteger(send.turn) || send.turn < 1 || send.turn > s.turns.length) fail(file, `expected send turn ${send.turn} is not a turn`);
    if (send.project && !projects.has(send.project)) fail(file, `expected send: unknown project ${send.project}`);
    if (send.thread && !threads.has(send.thread)) fail(file, `expected send: unknown thread ${send.thread}`);
  }
  for (const tool of s.expect.tools?.required || []) if (tool.byTurn !== undefined && (tool.byTurn < 1 || tool.byTurn > s.turns.length)) fail(file, `expected tool ${tool.name}: byTurn ${tool.byTurn} is not a turn of the script`);
  for (const tool of [...s.expect.tools?.required || [], ...(s.expect.tools?.forbidden || []).filter(f => typeof f !== 'string')]) {
    destination(tool, `expected tool ${tool.name}`);
    if (tool.thread && !owner.has(tool.thread)) fail(file, `expected tool ${tool.name}: unknown thread ${tool.thread}`);
    if (tool.thread && tool.project && owner.get(tool.thread) !== tool.project) fail(file, `expected tool ${tool.name}: thread ${tool.thread} is not in project ${tool.project}`);
    if (tool.project && !projects.has(tool.project)) fail(file, `expected tool ${tool.name}: unknown project ${tool.project}`);
  }
  return s;
}

// A scenario file holds one scenario or a list. "world" may name a JSON file
// next to it, so several scenarios share one world.
export function loadScenarios(file: string): Scenario[] {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  return (Array.isArray(raw) ? raw : [raw]).map((value, i) => {
    const s = value as Scenario & { world: World | string };
    if (typeof s.world === 'string') s.world = JSON.parse(readFileSync(resolve(dirname(file), s.world), 'utf8')) as World;
    return { ...validateScenario(s, Array.isArray(raw) ? `${file}[${i}]` : file), file };
  });
}
