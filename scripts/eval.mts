// Conversation evaluations of the voice: scripted calls spoken by a synthetic
// user (ElevenLabs), run closed loop against GPT Realtime, Gemini Live (a
// gemini-* --model) or ElevenLabs Agents (--model elevenlabs-agents [--llm L])
// with the production engine over a simulated T3, checked
// deterministically and graded by LLM judges. Paid (the voice provider, the
// OpenAI judges, ElevenLabs the first time a phrase is spoken). Nothing reaches a real ADE. See docs/evals.md.
//
//   node dist/scripts/eval.mjs extract [--db caller.sqlite] [--out DIR]
//   node dist/scripts/eval.mjs speak SCENARIOS... [--dry]
//   node dist/scripts/eval.mjs run SCENARIOS... [--label NAME] [--model M] [--repeat N] [--judge M1,M2] ...
//   node dist/scripts/eval.mjs judge RUN_DIR [--judge M1,M2]
//   node dist/scripts/eval.mjs report RUN_DIR [RUN_DIR...] [--min-pass 0.9]
//
// Runs and drafts contain transcripts: they live in the private state
// directory by default; keep them out of commits.
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { loadScenarios, validateScenario, type Scenario } from '../src/eval/scenario.mjs';
import { Speech, audioFile, spokenWords, wav, type Voice } from '../src/eval/speech.mjs';
import { runScenario, type RunRecord } from '../src/eval/runner.mjs';
import { runGeminiScenario } from '../src/eval/gemini-runner.mjs';
import { GEMINI_VOICES, isGeminiModel } from '../src/voice/gemini.mjs';
import { runElevenLabsScenario } from '../src/eval/elevenlabs-runner.mjs';
import { ELEVENLABS_DEFAULTS, ELEVENLABS_VOICES, isElevenLabsModel } from '../src/voice/elevenlabs.mjs';
import { ENUMS, pick } from '../src/voice/realtime.mjs';
import { checkRun, latencySummary, median, type Check } from '../src/eval/checks.mjs';
import { judge, judgementPasses, type Judgement } from '../src/eval/judge.mjs';
import { redactEvidence, redactText } from '../src/eval/redact.mjs';

const [command, ...rest] = process.argv.slice(2);
// The options of each command. Switches never take the next argument, so
// `--no-judge file.json` keeps file.json a scenario; an option another command
// owns (`run --dry`) is refused before any paid work.
const SWITCHES = new Set(['dry', 'no-judge']);
const SELECT = ['data', 'only', 'tag'], SPEAKER = ['speaker', 'voice-id', 'tts-model'];
const OPTIONS: Record<string, string[]> = {
  extract: ['data', 'db', 'out', 'language'],
  speak: [...SELECT, ...SPEAKER, 'dry'],
  run: [...SELECT, ...SPEAKER, 'out', 'model', 'llm', 'voice', 'reasoning', 'eagerness', 'noise-reduction', 'transcription', 'label', 'repeat', 'parallel', 'judge', 'judge-reasoning', 'no-judge', 'min-pass'],
  judge: [...SELECT, 'judge', 'judge-reasoning', 'min-pass'],
  report: ['min-pass']
};
const allowed = new Set(OPTIONS[command] || []);
const flags = new Map<string, string>(), positional: string[] = [];
for (let i = 0; i < rest.length; i++) {
  const arg = rest[i];
  if (!arg.startsWith('--')) { positional.push(arg); continue; }
  const eq = arg.indexOf('='), name = arg.slice(2, eq < 0 ? undefined : eq);
  if (!allowed.has(name)) fail(`Unknown option --${name} for ${command || 'no command'} (see docs/evals.md).`);
  if (SWITCHES.has(name)) { if (eq >= 0) fail(`--${name} takes no value.`); flags.set(name, 'true'); continue; }
  const value = eq >= 0 ? arg.slice(eq + 1) : rest[++i];
  if (value === undefined || (eq < 0 && value.startsWith('--'))) fail(`--${name} needs a value.`);
  flags.set(name, value);
}
// Numbers are checked before anything runs: a typo never disables a gate.
// A blank value (an empty CI variable) is not zero.
const number = (name: string, fallback: string) => { const v = flag(name, fallback)!; return v.trim() === '' ? NaN : Number(v); };
function count(name: string, fallback: string) {
  const n = number(name, fallback);
  if (!Number.isInteger(n) || n < 1 || n > 100) fail(`--${name} must be an integer from 1 to 100.`);
  return n;
}
function minPass() {
  const n = number('min-pass', '1');
  if (!Number.isFinite(n) || n < 0 || n > 1) fail('--min-pass must be a number from 0 to 1.');
  return n;
}
const flag = (name: string, fallback?: string) => flags.get(name) ?? fallback;

const stateDir = process.env.ADE_CALL_STATE || join(homedir(), '.local/share/ade-call');
const configDir = process.env.ADE_CALL_CONFIG || join(homedir(), '.config/ade-call');
const dataDir = resolve(flag('data', join(stateDir, 'evals'))!);
const config = (() => { try { return JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf8')) as Record<string, string>; } catch { return {} as Record<string, string>; } })();
const cleanKey = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;
const openaiKey = () => cleanKey(config.openaiKey || process.env.OPENAI_API_KEY) || fail('The OpenAI key is missing (openaiKey in config.json or OPENAI_API_KEY).');
const elevenKey = () => cleanKey(config.elevenlabsKey || process.env.ELEVENLABS_API_KEY);
// As the server reads it: geminiKey in config.json, else GEMINI_API_KEY or GOOGLE_API_KEY.
const geminiKey = () => cleanKey(config.geminiKey) || cleanKey(process.env.GEMINI_API_KEY) || cleanKey(process.env.GOOGLE_API_KEY);
// What is saved or printed is masked as the judges' copy is: transcripts, sends
// and provider messages can repeat a credential the call came across.
const secrets = () => [cleanKey(config.openaiKey || process.env.OPENAI_API_KEY), elevenKey(), geminiKey()].filter((k): k is string => !!k);
function fail(message: string): never { console.error(message); process.exit(2); }
// Written aside and renamed into place: a reader never sees half a file, even if the process stops.
const write = (file: string, data: unknown) => {
  const partial = `${file}.${process.pid}.partial`;
  writeFileSync(partial, typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(partial, file);
};
const ensure = (dir: string) => { mkdirSync(dir, { recursive: true, mode: 0o700 }); return dir; };

// Scenario files and directories (their top-level *.json; worlds go in subfolders).
function scenarios(paths: string[]): Scenario[] {
  if (!paths.length) paths = [join(dataDir, 'scenarios')];
  const files = paths.flatMap(p => statSync(p).isDirectory() ? readdirSync(p).filter(f => f.endsWith('.json')).sort().map(f => join(p, f)) : [p]);
  const all = files.flatMap(f => loadScenarios(f));
  // One ID, one folder of results: the same scenario twice is a mistake.
  const seen = new Map<string, string>();
  for (const sc of all) {
    const other = seen.get(sc.id);
    if (other) fail(`Scenario ${sc.id} appears twice: ${other} and ${sc.file}.`);
    seen.set(sc.id, sc.file || '');
  }
  // An empty --only (an unset variable) or an unknown ID is refused: it would
  // run everything, or silently skip what was asked for.
  const only = flags.has('only') ? flag('only', '')!.split(',').map(id => id.trim()) : null, tag = flags.has('tag') ? flag('tag', '')!.trim() : null;
  if (only && (!only.length || only.some(id => !id))) fail('--only needs scenario IDs separated by commas.');
  if (tag === '') fail('--tag needs a tag.');
  const unknown = (only || []).filter(id => !all.some(s => s.id === id));
  if (unknown.length) fail(`--only: no scenario ${unknown.join(', ')} in the files given.`);
  const chosen = all.filter(s => (!only || only.includes(s.id)) && (!tag || (s.tags || []).includes(tag)));
  if ((only || tag) && !chosen.length) fail('No scenario matches --only and --tag.');
  return chosen;
}
// Synthetic speakers: <data>/voices.json maps a name to an ElevenLabs voice.
// Only scenarios with spoken words need one: recordings and noise run without.
function voices(list: Scenario[]): { all: Record<string, Voice>; default: string } {
  if (flags.has('tts-model') && !flag('tts-model')?.trim()) fail('--tts-model must be a nonblank string.');
  if (!list.some(sc => sc.turns.some(t => t.say !== undefined))) return { all: {}, default: '' };
  // The repository's speakers (public ElevenLabs voices, evals/voices.json) are
  // always there; the private voices.json adds or replaces speakers by name.
  const file = join(dataDir, 'voices.json'), shared = resolve(import.meta.dirname, '../../evals/voices.json');
  const own = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as Record<string, Voice> : {};
  const all: Record<string, Voice> = { ...(existsSync(shared) ? JSON.parse(readFileSync(shared, 'utf8')) as Record<string, Voice> : {}), ...own };
  if (flag('voice-id')) all.cli = { id: flag('voice-id')! };
  const name = flag('speaker') || (flag('voice-id') ? 'cli' : Object.keys(own)[0] || Object.keys(all)[0]);
  if (!name || !all[name]) fail(`No synthetic speaker: create ${file} ({"name": {"id": "ELEVENLABS_VOICE_ID"}}) or pass --voice-id.`);
  for (const sc of list) for (const [i, t] of sc.turns.entries()) if (t.say !== undefined && t.voice && !all[t.voice]) fail(`${sc.id}, turn ${i + 1}: speaker ${t.voice} is not in ${file} or evals/voices.json.`);
  // The words each line speaks with its speaker's model (v3 audio tags are not words):
  // a line with none is refused before anything is synthesized.
  for (const sc of list) for (const [i, t] of sc.turns.entries()) if (t.say !== undefined) {
    const profile = all[t.voice || name];
    if (!profile || typeof profile !== 'object' || Array.isArray(profile) || typeof profile.id !== 'string' || !profile.id.trim())
      fail(`${sc.id}, turn ${i + 1}: speaker ${t.voice || name} needs a nonempty string id.`);
    if (profile.model !== undefined && (typeof profile.model !== 'string' || !profile.model.trim())) fail(`${sc.id}, turn ${i + 1}: speaker model must be nonempty text.`);
    for (const field of ['stability', 'similarity', 'style', 'speed'] as const) {
      const value = profile[field], min = field === 'speed' ? 0.7 : 0, max = field === 'speed' ? 1.2 : 1;
      if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max))
        fail(`${sc.id}, turn ${i + 1}: speaker ${field} must be a number from ${min} to ${max}.`);
    }
    const model = flag('tts-model') || profile.model || 'eleven_multilingual_v2';
    if (!(model.startsWith('eleven_v3') ? spokenWords(t.say) : t.say).trim()) fail(`${sc.id}, turn ${i + 1}: the line has no words to speak, only audio tags.`);
  }
  return { all, default: name };
}
const speech = () => new Speech({ cacheDir: ensure(join(dataDir, 'audio-cache')), key: elevenKey(), model: flag('tts-model') });

// --- extract: draft scenarios from stored calls -------------------------------
// Each call becomes a draft with the user's turns, the voice's answers and the
// tools it used, plus flags for moments worth a test. Drafts are not runnable:
// a person (or an agent) gives them a world and expectations.
function extract() {
  const db = new DatabaseSync(flag('db', join(stateDir, 'caller.sqlite'))!, { readOnly: true });
  const out = ensure(flag('out', join(dataDir, 'drafts'))!);
  const rows = db.prepare("SELECT type, payload, created FROM events WHERE type IN ('transcript','voice-tool') ORDER BY id").all() as { type: string; payload: string; created: number }[];
  db.close();
  // Lines in the order the provider created their items (stored `order`): a user
  // transcript can be stored after the answer it prompted. Older events: stored order.
  type Line = { role: string; text: string; order?: number; seq?: number };
  const calls = new Map<string, { at: number; lines: Line[]; tools: { name: string; status: string; args: unknown; result?: string }[] }>();
  let seq = 0;
  for (const row of rows) {
    const p = JSON.parse(row.payload) as Record<string, unknown>;
    const id = String(row.type === 'transcript' ? p.call : p.id);
    const call = calls.get(id) || { at: row.created, lines: [], tools: [] };
    calls.set(id, call);
    const order = typeof p.order === 'number' ? p.order : undefined;
    if (row.type === 'transcript') call.lines.push({ role: String(p.role), text: String(p.text), order, seq: seq++ });
    else { call.tools.push({ name: String(p.name), status: String(p.status), args: p.args, result: String(p.result ?? '').slice(0, 3000) }); call.lines.push({ role: 'tool', text: `${p.name} ${p.status} ${JSON.stringify(p.args)}`, order, seq: seq++ }); }
  }
  for (const call of calls.values()) {
    call.lines.sort((a, b) => a.order !== undefined && b.order !== undefined ? a.order - b.order : a.seq! - b.seq!);
    for (const line of call.lines) { delete line.order; delete line.seq; }
  }
  let written = 0, skipped = 0;
  for (const [id, call] of calls) {
    const users = call.lines.filter(l => l.role === 'user');
    if (!users.length) continue;
    const flagsFound: string[] = [];
    users.forEach(u => {
      const words = u.text.trim().split(/\s+/);
      if (/:\s*$/.test(u.text) || words.length <= 2 && /^[\p{L}\d-]+,?$/u.test(u.text.trim()) || (u.text.match(/,/g) || []).length > 6)
        flagsFound.push(`possible transcription artifact (noise or prompt echo): "${u.text.slice(0, 80)}"`);
    });
    // The user line just before each send: the turn that authorized it.
    call.lines.forEach((l, i) => {
      if (l.role !== 'tool' || !l.text.includes('_send_message')) return;
      const before = call.lines.slice(0, i).filter(x => x.role === 'user').at(-1)?.text || '';
      if (!/\b(s[ií]|vale|dale|m[aá]nda|env[ií]a|d[ií]selo|yes|ok|send)/i.test(before)) flagsFound.push(`send after a turn that may not accept it: "${before.slice(0, 80)}"`);
    });
    const date = new Date(call.at).toISOString().slice(0, 10);
    const draft = { id: `draft-${date}-${id.replace(/[^a-z0-9]/gi, '').slice(-8).toLowerCase()}`, draft: true, description: 'TODO', ...(flag('language') ? { language: flag('language') } : {}),
      world: { projects: [] }, turns: users.map(u => ({ say: u.text })), expect: { rubric: [] }, flags: flagsFound, observed: { lines: call.lines, tools: call.tools } };
    // A draft already there may have been edited: it is never overwritten.
    try { writeFileSync(join(out, `${draft.id}.json`), JSON.stringify(draft, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); written++; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') skipped++; else throw error; }
  }
  console.log(`${written} draft(s) in ${out}${skipped ? `, ${skipped} already there and left as they were` : ''}. They contain transcripts and thread content: keep them private.`);
}

// --- speak: synthesize every turn once ---------------------------------------
async function speak() {
  const list = scenarios(positional), v = voices(list), s = speech();
  const turns = list.flatMap(sc => sc.turns.map((t, i) => ({ sc, t, i }))).filter(x => x.t.say !== undefined);
  // Missing phrases once per cache entry: a repeated phrase is synthesized once.
  const missing = [...new Map(turns.filter(x => !s.has(x.t.say!, v.all[x.t.voice || v.default], x.sc.language))
    .map(x => [s.path(x.t.say!, v.all[x.t.voice || v.default], x.sc.language).file, x])).values()];
  const characters = missing.reduce((n, x) => n + x.t.say!.length, 0);
  console.log(`${list.length} scenario(s), ${turns.length} spoken turn(s), ${missing.length} not cached (${characters} characters to synthesize).`);
  if (flag('dry')) return;
  // Only the clean speech goes in the cache: the phone line is applied per run.
  for (const x of missing) { await s.say(x.t.say!, v.all[x.t.voice || v.default], x.sc.language); process.stdout.write('.'); }
  console.log(`\nSynthesized ${s.synthesized} (${s.characters} characters).`);
}

// The judge models, checked before any paid call: an empty list never skips
// grading in silence (--no-judge is the explicit way).
// The judges' reasoning effort, checked before any paid call. A regrade keeps
// the one the folder was graded with unless --judge-reasoning says otherwise.
const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'];
let savedReasoning: string | undefined, savedJudges: string[] | undefined;
function judgeReasoning() {
  const value = flags.has('judge-reasoning') ? flag('judge-reasoning', '')!.trim() : savedReasoning || 'medium';
  // Checked even with --no-judge: a typo is never ignored.
  if (!EFFORTS.includes(value)) fail(`--judge-reasoning is one of ${EFFORTS.join(', ')}.`);
  return value;
}
function judgeModels() {
  if (flag('no-judge')) return [];
  // A regrade keeps the folder's panel of judges unless --judge names another.
  const list = (flags.has('judge') ? flag('judge', '')! : savedJudges?.length ? savedJudges.join(',') : 'gpt-5.5').split(',').map(m => m.trim());
  if (list.some(m => !m)) fail('--judge needs model names separated by commas; use --no-judge to skip the judges.');
  return list;
}

// --- run ------------------------------------------------------------------------
// error: the run could not be completed; it counts as a failure.
interface RunResult { error?: string; scenario: string; repeat: number; checks: Check[]; judgements: Judgement[]; pass: boolean; checksPass: boolean; judgePass: boolean | null; score: number | null; latency: { median: number | null; max: number | null; values?: number[] }; usage: Record<string, number>; durationMs: number }

async function judgeAll(sc: Scenario, run: RunRecord, models: string[]) {
  return Promise.all(models.map(model => judge(sc, run, { model, key: openaiKey(), reasoning: judgeReasoning() })));
}
function result(sc: Scenario, repeat: number, run: RunRecord, judgements: Judgement[]): RunResult {
  const checks = checkRun(sc, run);
  // A judge that finds an unauthorized send fails the run, whatever severity it gave:
  // it counts as a critical failure, so the gate fails whatever the pass rate.
  const unauthorized = judgements.flatMap(j => j.criteria.filter(c => c.id === 'g1' && !c.pass).map(c => `${j.model}: ${c.evidence}`));
  if (unauthorized.length) checks.push({ id: 'judge.authorization', pass: false, critical: true, detail: unauthorized.join(' | ').slice(0, 600) });
  const checksPass = checks.every(c => c.pass || !c.critical);
  const judgePass = judgements.length ? judgements.every(judgementPasses) : null;
  const scores = judgements.filter(j => !j.error).map(j => j.score);
  // A judge that could not answer leaves the run ungraded: it did not complete.
  const judgeErrors = judgements.filter(j => j.error).map(j => `judge ${j.model}: ${j.error}`);
  return { ...(judgeErrors.length ? { error: judgeErrors.join('; ') } : {}), scenario: sc.id, repeat, checks, judgements, checksPass, judgePass, pass: checksPass && judgePass !== false, score: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
    latency: latencySummary(run), usage: run.usage, durationMs: run.durationMs };
}

async function run() {
  const list = scenarios(positional);
  if (!list.length) fail('No scenarios.');
  const judges = judgeModels(), effort = judgeReasoning(), judgeEffort = judges.length ? effort : undefined;
  // The model chooses the provider, as in the server: a gemini-* model runs on
  // Gemini Live with its own voice, and the Realtime settings do not apply.
  const model = flag('model', config.realtimeModel);
  if (model !== undefined && (typeof model !== 'string' || !model.trim())) fail('model must be a nonblank string.');
  const gemini = !!model && isGeminiModel(model), eleven = !!model && isElevenLabsModel(model);
  const relayed = gemini ? 'Gemini Live' : eleven ? 'ElevenLabs Agents' : '';
  if (relayed) for (const option of ['reasoning', 'eagerness', 'noise-reduction', 'transcription']) if (flags.has(option)) fail(`--${option} is a GPT Realtime setting; ${relayed} has no such setting.`);
  if (flags.has('llm') && !eleven) fail('--llm chooses the LLM of ElevenLabs Agents (--model elevenlabs-agents).');
  const llm = eleven ? flag('llm', config.elevenlabsLlm) || ELEVENLABS_DEFAULTS.llm : undefined;
  if (llm !== undefined && (typeof llm !== 'string' || !/^[\w.@-]+$/.test(llm))) fail('--llm must be an ElevenLabs LLM ID.');
  const settings: { model?: string; voice?: string; reasoning?: string; eagerness?: string; noiseReduction?: string; transcriptionModel?: string } = gemini
    ? { model, voice: flag('voice', config.geminiVoice) }
    : eleven ? { model, voice: flag('voice', config.elevenlabsVoice) }
    : { model, voice: flag('voice', config.realtimeVoice), reasoning: flag('reasoning', config.realtimeReasoning),
      eagerness: flag('eagerness', config.realtimeEagerness), noiseReduction: flag('noise-reduction', config.realtimeNoiseReduction), transcriptionModel: flag('transcription', config.realtimeTranscriptionModel) };
  for (const field of ['voice', 'transcriptionModel'] as const) {
    const value = settings[field];
    if (value !== undefined && (typeof value !== 'string' || !value.trim())) fail(`${field} must be a nonblank string.`);
  }
  if (gemini && settings.voice !== undefined && !(GEMINI_VOICES as readonly string[]).includes(settings.voice)) fail(`${settings.voice} is not a Gemini voice (${GEMINI_VOICES.join(', ')}).`);
  if (eleven && settings.voice !== undefined && !(settings.voice in ELEVENLABS_VOICES)) fail(`${settings.voice} is not an ElevenLabs voice here (${Object.keys(ELEVENLABS_VOICES).join(', ')}).`);
  // Checked as the server checks them, before anything is synthesized or called.
  if (!relayed) try { pick(settings.reasoning, ENUMS.reasoning, '', 'reasoning'); pick(settings.eagerness, ENUMS.eagerness, '', 'eagerness'); pick(settings.noiseReduction, ENUMS.noiseReduction, '', 'noise reduction'); }
  catch (error) { fail((error as Error).message); }
  // The phone line and recorded clips need ffmpeg: missing, nothing is paid for first.
  if (list.some(sc => sc.channel === 'phone' || sc.turns.some(t => t.audio !== undefined)) && spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status !== 0)
    fail('ffmpeg is needed by phone scenarios and recorded turns: install it first.');
  // Every recording must decode to audio before anything is synthesized or called.
  for (const sc of list) for (const [i, t] of sc.turns.entries()) if (t.audio !== undefined) {
    let pcm: Buffer | undefined;
    try { pcm = audioFile(resolve(dirname(sc.file || '.'), t.audio)); } catch { /* reported below */ }
    if (!pcm || pcm.length < 2) fail(`${sc.id}, turn ${i + 1}: ${t.audio} does not decode to audio.`);
  }
  const v = voices(list), s = speech();
  const repeat = count('repeat', '1'), parallel = count('parallel', '1'), gate = minPass();
  const label = flag('label', `${settings.model || 'default'}${llm ? `-${llm}` : ''}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23)}`)!;
  // One folder inside runs/: no separators, no "." or "..".
  if (!/^[\w.-]+$/.test(label) || /^\.+$/.test(label)) fail(`--label must be a single folder name (letters, digits, ".", "_", "-"): ${JSON.stringify(label)}.`);
  const target = resolve(flag('out', join(dataDir, 'runs', label))!);
  // All selected phrases must be possible before any job can incur API charges.
  if (!s.options.key && list.some(sc => sc.turns.some(t => t.say !== undefined && !s.has(t.say, v.all[t.voice || v.default], sc.language))))
    fail('The ElevenLabs key is missing and selected speech is not cached (ELEVENLABS_API_KEY or elevenlabsKey in config.json).');
  // The voice provider's key; the judges always use OpenAI's.
  const key = gemini ? geminiKey() || fail('The Gemini key is missing (geminiKey in config.json, GEMINI_API_KEY or GOOGLE_API_KEY).')
    : eleven ? elevenKey() || fail('The ElevenLabs key is missing (elevenlabsKey in config.json or ELEVENLABS_API_KEY).') : openaiKey();
  // The agent and tools the evaluations keep in the ElevenLabs account, apart from the service's.
  const agentFile = join(dataDir, 'elevenlabs-agent.json');
  const agentState = { get: () => { try { return JSON.parse(readFileSync(agentFile, 'utf8')); } catch { return undefined; } }, set: (value: unknown) => { ensure(dataDir); write(agentFile, value); } };
  if (judges.length) openaiKey();
  // A run folder holds one invocation: old results never fill in for failed runs.
  if (existsSync(target) && readdirSync(target).length) fail(`${target} already has results: choose another --label or --out.`);
  const out = ensure(target);
  // An exclusive claim: of two invocations on one folder, only one runs.
  // The claim lists every job, so a report sees the ones that never finished.
  const planned = list.flatMap(sc => Array.from({ length: repeat }, (_, r) => ({ scenario: sc.id, repeat: r + 1 })));
  // Written whole aside, then published with an exclusive hard link: a reader
  // never sees half of it, and only one invocation can claim the folder.
  const claim = join(out, `settings.${process.pid}.partial`);
  writeFileSync(claim, JSON.stringify({ label, startedAt: new Date().toISOString(), jobs: planned, judges, judgeReasoning: judgeEffort }), { mode: 0o600 });
  try { linkSync(claim, join(out, 'settings.json')); }
  catch { rmSync(claim, { force: true }); fail(`${target} is being used by another run: choose another --label or --out.`); }
  rmSync(claim, { force: true });
  const jobs = list.flatMap(sc => Array.from({ length: repeat }, (_, r) => ({ sc, r: r + 1 })));
  console.log(`${jobs.length} run(s) of ${list.length} scenario(s) → ${out}`);
  const results: RunResult[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, parallel) }, async () => {
    while (next < jobs.length) {
      const { sc, r } = jobs[next++];
      const dir = ensure(join(out, sc.id, String(r)));
      console.log(`▶ ${sc.id} #${r}`);
      // The scenario as it runs (world, script, history), written before the
      // recording: grading again uses it, never a later edit of the file.
      write(join(dir, 'scenario.json'), { ...sc, file: undefined });
      // Anything that fails in a job, from the call to the judges, is a failed run with a result.
      try {
        const common = { key, speech: s, voices: v.all, defaultVoice: v.default, log: parallel > 1 ? undefined : (line: string) => console.log(line) };
        const { audio, ...raw } = gemini ? await runGeminiScenario(sc, { ...common, settings: { model: settings.model, voice: settings.voice } })
          : eleven ? await runElevenLabsScenario(sc, { ...common, settings: { llm, voice: settings.voice }, agentState })
          : await runScenario(sc, { ...common, settings });
        // Checked and judged as saved, so grading again sees the same record.
        const plain = redactEvidence(raw, secrets());
        write(join(dir, 'run.json'), plain);
        if (audio) write(join(dir, 'audio.wav'), wav(audio, 2));
        const res = redactEvidence(result(sc, r, plain, await judgeAll(sc, plain, judges)), secrets());
        write(join(dir, 'result.json'), res);
        results.push(res);
        const failed = [...res.checks.filter(c => !c.pass).map(c => `${c.critical ? '!' : ''}${c.id}`), ...res.judgements.flatMap(j => j.error ? [`${j.model}: ${j.error}`] : j.criteria.filter(c => !c.pass).map(c => `${j.model}:${c.id}(${c.severity})`))];
        console.log(`  ${res.pass ? '✓' : '✗'} ${sc.id} #${r} · score ${res.score?.toFixed(1) ?? 'n/a'} · median latency ${res.latency.median ?? 'n/a'} ms${failed.length ? ` · failed: ${failed.join(', ')}` : ''}`);
      } catch (error) {
        const message = redactText(String((error as Error)?.message || error), secrets()).slice(0, 300);
        console.log(`  ✗ ${sc.id} #${r}: the run failed: ${message}`);
        const failed: RunResult = { error: message, scenario: sc.id, repeat: r, checks: [], judgements: [], pass: false, checksPass: true, judgePass: null, score: null, latency: { median: null, max: null }, usage: {}, durationMs: 0 };
        write(join(dir, 'result.json'), failed); results.push(failed);
      }
    }
  }));
  write(join(out, 'settings.json'), { label, jobs: planned, settings: { ...settings, model: settings.model || 'default' }, judges, judgeReasoning: judgeEffort, repeat, scenarios: list.map(sc => sc.id), speaker: v.default, finishedAt: new Date().toISOString() });
  process.exit(report([out], gate));
}

// --- judge: grade saved runs again (other judges, a changed rubric) ----------
async function rejudge() {
  const dir = resolve(positional[0] || fail('Usage: judge RUN_DIR'));
  const gate = minPass();
  // The effort the folder was graded with, unless --judge-reasoning overrides it.
  // The panel of the grades in force: the last regrade's, else the run's.
  for (const file of ['settings.json', 'grades.json']) {
    try { const saved = JSON.parse(readFileSync(join(dir, file), 'utf8')) as { judgeReasoning?: string; judges?: string[] }; if (saved.judges) ({ judgeReasoning: savedReasoning, judges: savedJudges } = saved); } catch { /* none: the defaults */ }
  }
  const judges = judgeModels();
  judgeReasoning();
  const byId = new Map(scenarios(positional.slice(1)).map(sc => [sc.id, sc]));
  // Every scenario of the folder is graded again, or none: old verdicts never
  // stand in for the judges asked for.
  const ids = readdirSync(dir).filter(f => statSync(join(dir, f)).isDirectory());
  const missing = ids.filter(id => !byId.has(id));
  if (!ids.length) fail(`${dir} has no runs.`);
  if (missing.length) fail(`Scenarios not found for ${missing.join(', ')}: pass the files or folders they came from.`);
  // Every run is checked before any is graded: the current expectations must
  // fit the world each one ran with (scenario.json), or nothing is graded.
  const runs: { id: string; r: string; record: RunRecord; graded: Scenario }[] = [];
  const current = published(dir);
  // A batch still running (or stopped) has planned repeats without a result:
  // a regrade now would publish a set that hides the ones still to come.
  const planned = existsSync(join(dir, 'settings.json')) ? (JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) as { jobs?: { scenario: string; repeat: number }[] }).jobs || [] : [];
  // Each planned job needs its own result.json; a grade published earlier never stands in for it.
  const unfinished = planned.filter(job => !existsSync(join(dir, job.scenario, String(job.repeat), 'result.json')));
  if (unfinished.length) fail(`${unfinished.map(j => `${j.scenario} #${j.repeat}`).join(', ')} has no result yet (still running, or stopped): grade again once the run has finished.`);
  // A published verdict whose repeat is gone from disk could only be carried over stale.
  for (const old of current) if ((old.checks?.length || old.judgements?.length || old.score != null) && !existsSync(join(dir, old.scenario, String(old.repeat), 'run.json')))
    fail(`${old.scenario} #${old.repeat}: result.json has a verdict but run.json is missing; it cannot be graded again.`);
  for (const id of ids) {
    const sc = byId.get(id)!;
    for (const r of readdirSync(join(dir, id))) {
      const file = join(dir, id, r, 'run.json');
      if (!existsSync(file)) {
        // A run that failed to execute stays a failed repeat; a graded result
        // without its recording could only be stale.
        const old = current.find(x => x.scenario === id && String(x.repeat) === r) ?? null;
        // Any check or judgement means the call ran; only a run that never got that far has neither.
        if (old && (old.checks?.length || old.judgements?.length || old.score != null)) fail(`${id} #${r}: result.json has a verdict but run.json is missing; it cannot be graded again.`);
        continue;
      }
      const record = JSON.parse(readFileSync(file, 'utf8')) as RunRecord;
      // The call is graded against the world and script it ran with; only the
      // expectations and rubric come from the current file.
      const savedFile = join(dir, id, r, 'scenario.json');
      if (!existsSync(savedFile)) fail(`${id} #${r}: scenario.json is missing, so the world and script it ran with are unknown; run it again.`);
      let graded: Scenario;
      try { graded = validateScenario({ ...JSON.parse(readFileSync(savedFile, 'utf8')) as Scenario, expect: sc.expect }, savedFile); }
      catch (error) { fail(`${id} #${r}: the current expectations do not fit the world it ran with (${(error as Error).message}).`); }
      runs.push({ id, r, record, graded: graded! });
    }
  }
  // The new verdicts replace the old ones all at once, in one file renamed into
  // place, and only if every run was graded: a judge that fails, or a stop half
  // way, leaves the previous verdicts as they were.
  // Only runs that never executed keep their old result; every other is graded now.
  const graded: RunResult[] = [...current.filter(x => !runs.some(j => j.id === x.scenario && j.r === String(x.repeat)))];
  for (const { id, r, record, graded: sc } of runs) {
    const res = result(sc, Number(r), record, await judgeAll(sc, record, judges));
    if (res.error) fail(`${id} #${r}: ${redactText(res.error, secrets())}. Nothing was replaced; grade again later.`);
    graded.push(res);
    console.log(`${res.pass ? '✓' : '✗'} ${id} #${r} · score ${res.score?.toFixed(1) ?? 'n/a'}`);
  }
  // The panel and effort travel with the grades they produced: the next regrade defaults to them.
  const staged = join(dir, `grades.${process.pid}.${Date.now()}.partial`);
  writeFileSync(staged, JSON.stringify(redactEvidence({ judges, judgeReasoning: judgeReasoning(), results: graded }, secrets()), null, 2), { mode: 0o600 });
  renameSync(staged, join(dir, 'grades.json'));
  process.exit(report([dir], gate));
}

// --- report: one table per run directory, side by side ------------------------
// The verdicts in force: those of the last complete regrade (grades.json), or
// the ones the run wrote (result.json of each repeat).
function published(dir: string): RunResult[] {
  const grades = join(dir, 'grades.json');
  if (existsSync(grades)) { const saved = JSON.parse(readFileSync(grades, 'utf8')) as RunResult[] | { results: RunResult[] }; return Array.isArray(saved) ? saved : saved.results; }
  const results: RunResult[] = [];
  for (const id of readdirSync(dir).filter(f => statSync(join(dir, f)).isDirectory()))
    for (const r of readdirSync(join(dir, id))) { const f = join(dir, id, r, 'result.json'); if (existsSync(f)) results.push(JSON.parse(readFileSync(f, 'utf8')) as RunResult); }
  return results;
}
function load(dir: string) {
  const results = published(dir);
  const settings = existsSync(join(dir, 'settings.json')) ? JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) as { label?: string; jobs?: { scenario: string; repeat: number }[] } : {};
  // A planned job without a result (an interrupted run) is a run that did not complete.
  for (const job of settings.jobs || []) if (!results.some(r => r.scenario === job.scenario && r.repeat === job.repeat))
    results.push({ error: 'no result: the run did not finish', scenario: job.scenario, repeat: job.repeat, checks: [], judgements: [], pass: false, checksPass: true, judgePass: null, score: null, latency: { median: null, max: null }, usage: {}, durationMs: 0 });
  return { label: settings.label || basename(dir), results };
}
function report(dirs: string[], gate = minPass()) {
  const sets = dirs.map(load);
  const ids = [...new Set(sets.flatMap(s => s.results.map(r => r.scenario)))].sort();
  const cell = (rs: RunResult[]) => rs.length ? `${rs.filter(r => r.pass).length}/${rs.length}${rs.some(r => r.error) ? ' E' : ''}${rs.some(r => r.score != null) ? ` ★${(rs.reduce((a, r) => a + (r.score ?? 0), 0) / rs.filter(r => r.score != null).length).toFixed(1)}` : ''}${rs.some(r => !r.checksPass) ? ' !' : ''}` : '—';
  const width = Math.max(10, ...ids.map(i => i.length));
  console.log(`\n${'scenario'.padEnd(width)}  ${sets.map(s => s.label.slice(0, 28).padEnd(28)).join('  ')}`);
  for (const id of ids) console.log(`${id.padEnd(width)}  ${sets.map(s => cell(s.results.filter(r => r.scenario === id)).padEnd(28)).join('  ')}`);
  let code = 0;
  console.log('');
  for (const s of sets) {
    const passRate = s.results.length ? s.results.filter(r => r.pass).length / s.results.length : 0;
    const critical = s.results.filter(r => !r.checksPass);
    const errors = s.results.filter(r => r.error);
    // The median over every measured answer; older results without them weigh each run's median once.
    const all = s.results.every(r => r.latency.values || r.latency.median == null);
    const lat = all ? median(s.results.flatMap(r => r.latency.values || [])) : median(s.results.map(r => r.latency.median).filter((v): v is number => v != null));
    const tokens = s.results.reduce((n, r) => n + (r.usage.total_tokens || 0), 0);
    console.log(`${s.label}: pass ${(passRate * 100).toFixed(0)}% (${s.results.filter(r => r.pass).length}/${s.results.length}) · critical check failures ${critical.length} · runs that failed to complete ${errors.length} · ${all ? 'median latency' : 'median of run medians'} ${lat ?? 'n/a'} ms · realtime tokens ${tokens}`);
    if (passRate < gate || critical.length || errors.length) code = 1;
  }
  const regraded = dirs.some(d => existsSync(join(d, 'grades.json')));
  console.log(`\n"!" marks a failed critical check (a wrong, missing or unauthorized send); "E" a run that failed to complete. Details: ${regraded ? '<run>/grades.json (by scenario and repeat) for a folder graded again, else ' : ''}<run>/<scenario>/<n>/result.json; recordings in <run>/<scenario>/<n>/audio.wav.`);
  return code;
}

switch (command) {
  case 'extract': extract(); break;
  case 'speak': await speak(); break;
  case 'run': await run(); break;
  case 'judge': await rejudge(); break;
  case 'report': if (!positional.length) fail('Usage: report RUN_DIR [RUN_DIR...]'); process.exit(report(positional.map(p => resolve(p)))); break;
  default: fail('Usage: node dist/scripts/eval.mjs extract|speak|run|judge|report … (see docs/evals.md)');
}
