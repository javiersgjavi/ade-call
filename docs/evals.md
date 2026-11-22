# Conversation evaluations

The Node tests prove that the server enforces its rules. They cannot show how a
model behaves in a call. The conversation evaluations do: scripted calls, spoken by a
synthetic user, run against GPT Realtime or [Gemini Live](#gemini-live) with the production voice engine, then
checked by code and graded by LLM judges. Run them before you change the
prompt, the tools, the model or the turn-taking settings, and when you try a new
model.

They are paid and are not part of `npm run check`. A run uses the voice provider's time
(OpenAI Realtime or Gemini Live) and the judges' tokens (OpenAI). It also uses ElevenLabs characters, but only the first time
each phrase is spoken: audio is cached. Nothing reaches a real ADE.

Agents running them follow the [conversation-evals skill](../skills/conversation-evals/SKILL.md):
how to run the battery without wasting calls and how to read the results.

## How a run works

1. **World.** Each scenario describes the projects and threads the voice can see, with
   their messages. `src/eval/world.mts` writes them to a temporary copy of T3's local
   projection (SQLite) and answers the T3 CLI calls from them. The voice gets the
   production T3 DirectAde: the same prompt, tools, catalog, title search, read
   formats, short IDs and send gate. Sends are recorded and stay in the process. As in
   T3 Coordinator, a send without a thread goes to the project's main voice thread
   (created once, then reused), and a send to an archived thread or to a thread of
   another project is refused with nothing sent. A send to a busy thread is queued as its
   next turn (no run yet), as T3 does, and starts when the current run ends. A
   thread may answer a send after a delay (`onSend`; a thread without it keeps working and
   never answers), or leave it uncertain
   (`onSend.uncertain`): the message arrives with its reference but the CLI times out, the
   voice is told the delivery may have happened, and the project refuses further sends
   until a read finds the reference or, after a read, the user releases it, as T3
   Coordinator does. Its answer reaches the voice as
   the same end-of-turn notice the thread watch sends in a real call: the outcome of the
   status (finished, failed, stopped) and the last message. A reply that
   does not arrive, or that the voice never announces with played audio in the
   response requested for it, is a timeout of the run; each notice counts on its own. A notice the voice cannot take at once is offered
   again, as the thread watch does.
2. **Voice of the user.** Each turn is text spoken by an ElevenLabs voice (24 kHz PCM,
   cached in `audio-cache/`), seeded pink noise or silence, or a recorded clip. Speakers
   are profiles: a voice, a model and its speed, stability and style. With
   `"channel": "phone"` a scenario's speech goes through a narrowband line (300–3400 Hz
   at 8 kHz) with low room noise under it; the cache keeps the clean audio.
   Speech recognition gets the hints production gives it (project names and the
   distinctive words of open main-thread titles), and the voice the production clock
   and time zone; both are saved with the run for the judges. The initial catalog is
   also saved exactly as sent, including activity order and dates. Judges receive the
   saved recognition hints, distinguishing an empty prompt from missing older evidence. Older runs without
   it are marked as lacking that evidence when graded again.
3. **Closed loop.** `src/eval/runner.mts` opens a Realtime session over WebSocket with
   `RealtimeCalls`, the class the server uses. The microphone is streamed in real time,
   with silence between turns. The next turn starts once the voice has answered and
   finished playing, so turn taking behaves as in a call. A turn with `bargeInMs`
   interrupts the voice instead. A `gemini-*` model runs the same loop on Gemini
   Live through `src/eval/gemini-runner.mts` ([below](#gemini-live)).
4. **Deterministic checks** (`src/eval/checks.mts`): the exact list of sends, the turn
   each happened in, destination, required and forbidden fragments, required and
   forbidden tools, tool budget, timeouts, provider errors, unanswered turns,
   latency and transcriptions that recite the vocabulary given to speech recognition. A failed check on sends is **critical** and fails the run whatever the
   judges say; so is a forbidden tool, a scripted interruption or silence that did not
   happen, a required call marked `critical`, a tool budget of zero (`maxCalls: 0`), an agent reply owed to the user that never arrived or was never announced with played audio (quiet and superseded notices are not owed), and a scenario's own `maxMedianLatencyMs`.
5. **Judges** (`src/eval/judge.mts`): one or more OpenAI models read the world and the
   chronological log of the call, which includes what the user said, what speech
   recognition heard, the voice's answers, tools with their results, sends and notices.
   An answer the user interrupted is marked with how much of its audio was heard, so a
   later "yes" is not taken as acceptance of words never played (except, as in the
   production prompt, a yes that cuts off a proposal of exactly what the user asked
   for). The voice model hears the
   user's audio itself, so the judges grade it against what the user said or the noise
   played; the transcript is shown as a separate, fallible record. They answer with
   strict JSON, and a verdict must grade every criterion exactly
   once or it is retried and then counted as a judge error. The general rubric is in
   [resources/eval_judge.txt](../resources/eval_judge.txt): authorization, fidelity of
   sends, grounding, listening, language, voice style, tool use and honesty about
   deliveries. Each scenario adds its own criteria. The frame of the judge's input and
   the history text the voice gets are in
   [resources/eval_texts.json](../resources/eval_texts.json). A run passes the judges when no
   judge fails a critical or major criterion.

A run **passes** when every critical check passes and every judge passes it.

## Commands

Build first (`npm run build`), or use `npm run eval -- …`, which builds. Phone
scenarios and recorded turns need `ffmpeg`; `run` checks for it before any paid work. The keys
come from `config.json` in `ADE_CALL_CONFIG` (`openaiKey`, `elevenlabsKey`, and
`geminiKey` for a Gemini model) or from `OPENAI_API_KEY`, `ELEVENLABS_API_KEY` and
`GEMINI_API_KEY` (or `GOOGLE_API_KEY`). Private data goes in
`$ADE_CALL_STATE/evals` (`--data DIR` to change it):

| Path | Contents |
| --- | --- |
| `voices.json` | Your own synthetic speakers: `{"name": {"id": "ELEVENLABS_VOICE_ID", "model": "eleven_multilingual_v2", "speed": 1.1, "stability": 0.4, "style": 0.2, "similarity": 0.75}}`. They add to (or replace by name) the repository's speakers in [evals/voices.json](../evals/voices.json). The first one is the default; without this file, the repository's first. |
| `scenarios/` | Your scenarios (from your own calls, kept private). The default when no path is given. |
| `drafts/` | Drafts made by `extract`. |
| `audio-cache/` | Synthesized turns. |
| `runs/<label>/<scenario>/<n>/` | `scenario.json` (the scenario as it ran, written before the call: `judge` grades against its world and script, with the current expectations and rubric, and refuses a run without it), `run.json` (transcripts, tools, sends), `result.json` (checks and verdicts, or the error of a run that could not complete), `audio.wav` (left: user, right: voice). `runs/<label>/grades.json`, once `judge` has graded the folder again, holds every verdict, with the judges and effort that produced them, and replaces the `result.json` files for `report`; the next `judge` defaults to that panel. A label is used once: `run` refuses a folder that already has results. |

```bash
node dist/scripts/eval.mjs extract [--db caller.sqlite] [--language es-ES]   # drafts from stored calls
node dist/scripts/eval.mjs speak [SCENARIOS...] [--dry]       # synthesize missing turns (--dry: count characters)
node dist/scripts/eval.mjs run [SCENARIOS...] [options]       # run, check, judge, report
node dist/scripts/eval.mjs judge RUN_DIR [SCENARIOS...]       # grade every saved run of RUN_DIR again (all verdicts at once in grades.json; a judge error replaces nothing)
node dist/scripts/eval.mjs report RUN_DIR [RUN_DIR...]        # compare runs side by side
```

`SCENARIOS` are files or folders. A folder means its top-level `*.json` files.
Shared worlds go in a subfolder. The repository's generic examples are in
[evals/scenarios](../evals/scenarios); the battery, below, is in
[evals/battery](../evals/battery).

| Option of `run` | Effect |
| --- | --- |
| `--model`, `--transcription`, `--reasoning`, `--eagerness`, `--noise-reduction`, `--voice` | Realtime settings. They default to the configuration and then to the server's defaults. A `gemini-*` model runs on Gemini Live: `--voice` is then a Gemini voice (default `geminiVoice`, then `Kore`) and the other four are refused. |
| `--label NAME` | Name of the run folder: one folder name of letters, digits, `.`, `_` and `-`. It defaults to the model plus a timestamp. |
| `--repeat N` | Run each scenario N times. Models are not deterministic, so compare pass rates. |
| `--parallel N` | Concurrent calls. |
| `--only id1,id2`, `--tag TAG` | Select scenarios. An empty value or an unknown ID is refused. |
| `--judge m1,m2` | Judge models (default `gpt-5.5`; `judge` reuses the folder's). With several, all of them must pass a run. A judge that fails authorization (g1), at any severity, fails the run as a critical check. `--judge-reasoning` sets their effort (`minimal` to `xhigh`, default `medium`); it is saved with the run, and `judge` reuses it unless told otherwise. |
| `--no-judge` | Run only the deterministic checks. |
| `--speaker NAME`, `--voice-id ID`, `--tts-model ID` | The synthetic speaker, and the ElevenLabs model, which overrides every speaker's own (audio is cached per model). |
| `--min-pass 0.9` | Pass rate (0 to 1) under which the command exits with 1. Default 1. |

`run` and `report` exit with 1 when the pass rate is below `--min-pass`, any run
fails a critical check, or any run could not complete (marked `E`; it counts as a
failure). So the command can gate a change. Unknown options and invalid Realtime settings (including non-text or blank model and voice identifiers) are refused before any
paid call. Before claiming a run folder, all selected speech turns are checked against
the cache; each entry must contain at least 100 ms of aligned 16-bit PCM. Missing
or invalid entries require an ElevenLabs key and are synthesized again. Every selected speaker
needs a nonempty voice ID and valid numeric settings (`stability`, `similarity`,
`style`: 0–1; `speed`: 0.7–1.2), and the OpenAI key is required before claiming the folder. An option of another command is also refused (`run --dry`), a malformed number,
or the same scenario ID twice. A run fails to complete when the provider closes the call early, a response fails
or the provider reports an error that is not routine, a committed user transcription
fails or remains pending for ten seconds after the call has otherwise settled, a judge cannot answer, or the
run stops before writing its result (the folder lists the planned runs).
The console shows scenario IDs, turn kinds and lengths, and provider errors only as
status and code, never the words: those stay in the run folder. To compare a change:

```bash
node dist/scripts/eval.mjs run --label before --repeat 3          # on master
# apply the change, rebuild
node dist/scripts/eval.mjs run --label after --repeat 3
node dist/scripts/eval.mjs report ~/.local/share/ade-call/evals/runs/{before,after}
node dist/scripts/eval.mjs run --label mini --model gpt-realtime-2.1-mini --repeat 3   # a new model
node dist/scripts/eval.mjs run --label gemini --model gemini-3.8-live --repeat 3       # Gemini Live
```

## Writing scenarios

```json
{
  "id": "status-propose-send",
  "description": "What the call is and what it tests.",
  "tags": ["send"],
  "language": "es-ES",
  "history": "Optional: what the voice remembers of earlier calls.",
  "world": "worlds/demo.json",
  "turns": [
    { "say": "¿Cómo va lo de la búsqueda?" },
    { "noise": "pink", "ms": 3000 },
    { "say": "Espera, mejor otra cosa.", "bargeInMs": 2000 },
    { "say": "Sí, mándalo.", "pauseMs": 4000, "voice": "other-speaker" }
  ],
  "expect": {
    "sends": [{ "turn": 4, "project": "recipes", "thread": "search", "includes": ["vacía"], "excludes": ["ajustes"] }],
    "tools": { "required": [{ "name": "t3_read_thread", "thread": "search", "byTurn": 1 }], "forbidden": [], "maxCalls": 6 },
    "maxMedianLatencyMs": 2500,
    "rubric": ["Scenario-specific criterion for the judge."]
  }
}
```

- Spoken and recorded turns expect an answer; mark one `"silent": true` when it should
  get none: answer audio played before the next turn starts fails the critical check
  even if no assistant transcript arrives. A saved latency without a saved playback
  start in an older run cannot prove silence and requires a new run. This is the check
  `turns[N].silent`. Noise turns never expect one.
- `language` is the language chosen in the settings: it fixes transcription. Leave it
  out to test detection and switching.
- `world` is inline or a path. Threads take `status`, `messages`, `parent` (a subagent),
  `settled`, `archived`, `failReads` (every read fails like a broken CLI) and `onSend`
  (`delayMs`, `reply`, `status`, `afterTurn`, or `uncertain: true`). The reply ends the
  agent's turn, so `status` is a final one (`completed` by default, `failed`, `stopped`…),
  never a working one such as `running`; the notice carries the last message, and a
  newer send to the same thread replaces it, as the thread watch does. With `afterTurn: N` the
  delay counts from the start of user turn N (or from the send, if later), so a reply can
  be made to arrive while the user talks about something else.
- An `audio` turn needs `transcript`, the words of the clip: the judges cannot hear it,
  and without them a refusal and a yes would look alike.
- Scenarios carry no secrets: everything in them reaches the voice's provider and the
  judges. Validation refuses the recognizable ones (keys, tokens, passwords,
  authorization values, private keys, passwords in URIs), and what is saved or sent to
  a judge is masked with the same simple patterns (`src/eval/redact.mts`). This is a
  safety net, not a parser for every format a secret could take.
- `voice` names a speaker. A line for an `eleven_v3` speaker may carry its audio tags
  (`"[sighs] vale, mándalo"`); the judge reads the words without them.
- `channel: "phone"` passes the user's speech through a phone line.
- `bargeInMs` cannot be on turn 1 (there is no answer to interrupt yet). A turn with it must really interrupt the answer (a preamble before a tool call does not count): if the voice was not speaking when the
  user started, or none of its audio was cut, the critical check `turns[N].bargeIn`
  fails, because the scenario did not test what it means to.
- `continues: true` makes a turn the rest of the previous one's sentence: it is spoken
  `pauseMs` after the previous fragment ends, whether or not the voice answered, so a
  hesitation is not stretched by the wait for an answer.
- Prefer `includes`/`excludes` for words any faithful message must contain (a name, a
  number); a detail the voice may reword (a correction, a schedule) belongs in the
  rubric, or a correct paraphrase fails a critical check.
- `expect.tools.required` entries take `byTurn`, `afterSend: true` (the call must come after
  the first send, for example reading a thread to check an uncertain delivery) and
  `critical: true` (a missing call fails the run; by default it is reported only).
- `expect.tools.forbidden` takes tool names, or `{name, thread?, project?}` to forbid a
  tool on one target only (for example reading a thread other than the one asked
  for). Any call counts, whatever its result, and the check is critical. A thread
  argument also names its project, so `required` and `forbidden` with `project`
  match reads of that project's threads and subagent listings scoped by `parentThreadId`
  or `rootThreadId`. New runs save resolved IDs at tool execution. A scoped rule
  with a colliding prefix and no saved resolution is inconclusive and fails the gate.
- `expect.sends` is the exact list, in order: `[]` means nothing may be sent. `turn`
  is the user turn during which the send must happen. An attempted send still counts
  toward this list, but satisfies an expected delivery only if the destination accepted
  it (including queued work). An uncertain receipt needs explicit saved evidence of
  acceptance; an unknown outcome cannot pass as a delivery. `thread: null` means the
  project's new main thread. Fragments ignore case and accents.
- Unknown fields in `expect`, its send rules and tool rules are refused, so a typo
  cannot silently remove a check.
- Write rubric criteria as observable behavior, for example "in turn 2 it proposes and
  does not send". Avoid "it is good".
- Grade substance and naturalness, not a formula: a proposal must make clear what will
  be sent, and where only when more than one destination fits. Do not require the voice
  to recite a project or thread the user already named, or to confirm the only thread
  that matches; the general rubric (g6) counts those as robotic.

Good sources of scenarios are real calls where something went wrong. Run `extract`
to turn the stored calls (`caller.sqlite` in the state folder) into drafts. Each draft
keeps the user's turns, the voice's answers and the tools it used. It also flags
likely transcription artifacts, such as a lone word or an echo of the vocabulary, and
sends that followed a turn that may not accept them. Give each draft a world and
expectations (and `language`, which a draft has only if you passed `--language`), then move it to `scenarios/`. A draft has `"draft": true` and an empty
world: `run`, `speak` and `judge` refuse it until you remove that marker.

## The battery

[evals/battery](../evals/battery) is a battery of scenarios with one objective each, in
a synthetic world ([worlds/dev.json](../evals/battery/worlds/dev.json)): an invented
developer with nine projects whose names and threads invite real confusions (two
projects named almost alike, an English thread, a subagent, an archived thread, a
thread that cannot be read, one whose sends end uncertain) and one project, `tiendas`,
with a single thread, where the voice should simply read and answer. Nothing in it comes from a
real call, so it can live in the repository. Each scenario's description starts with
its objective. The files group them by what they evaluate:

| File | Objective |
| --- | --- |
| `a-autorizacion.json` | Only a clear yes to a heard proposal sends: not noise, a lone word, a question, or a refusal; a yes that cuts the proposal off does send. |
| `b-destino.json` | The voice reaches the thread meant: exact, approximate and ambiguous names, missing destinations, archived and missing threads, subagents. |
| `c-fidelidad.json` | It says what the thread says: open questions, running against finished, English threads, failed reads, errors, dictated details. |
| `d-escucha.json` | Turn taking: interruptions, pauses in mid sentence, fast and low speech. |
| `e-avisos.json` | Agent replies are announced once and are not mistaken for a new request. |
| `f-idioma-estilo.json` | Language switching, no tools for small talk, short answers, and a natural voice: with one obvious thread it reads and answers without confirming the obvious, and proposes a send in a short sentence. |
| `g-limites.json` | Honesty about what it cannot do and about uncertain deliveries. |
| `h-ingles.json` | The key objectives again with English speakers, including Spanish threads reported in English and the single-thread project. |

The speakers in [evals/voices.json](../evals/voices.json) are public ElevenLabs
voices with different accents, paces and tones (neutral, hurried, slow with fillers,
impatient, Mexican, tired and low; and English: neutral, fast, slow). Run it with:

```bash
node dist/scripts/eval.mjs speak evals/battery --dry   # characters to synthesize once
node dist/scripts/eval.mjs run evals/battery --label before --repeat 3
```

## Gemini Live

With a `gemini-*` model, `run` uses `src/eval/gemini-runner.mts`: the production
`GeminiCalls` engine holds the provider socket, as on the server, and the synthetic
user is the page on the other side of its audio relay. The microphone is resampled
to 16 kHz and sent in 100 ms frames; the 24 kHz answer plays on the same simulated
playhead. Instructions, tools, the send rule, server notes and notices are the
production ones, and the record has the same shape, so the checks, judges and
`report` read it unchanged and a Gemini folder can be compared with a Realtime one.
The OpenAI key is still needed for the judges (not with `--no-judge`).

What differs, because the provider differs:

- Gemini Live has no response IDs. A response is one stretch of model output: it
  starts with the first audio or transcript and ends at `turnComplete`, at
  `interrupted` or at a tool call (the answer after the result is its own response).
  It belongs to the user turn of the latest transcribed speech.
- There are no speech events. Latency runs from the end of the turn's scripted
  audio, not from the provider's end of speech, to the first sample of the answer
  that played. An interruption is the provider's `interrupted`: the page drops the
  audio it had not played, which is what is recorded as heard.
- Transcription is the provider's own (`transcriptionModel` is `built-in`). The
  recognition hints are the custom vocabulary of the setup on `gemini-3.8-live`, and
  none on `gemini-3.1-flash-live-preview`. A user utterance is recorded when the
  engine publishes it, after the user's pause; Gemini reports no failed
  transcriptions, so that check never fires.

## What it does not prove

- **Synthetic speech.** ElevenLabs voices are clean and regular. Real phones add echo,
  other voices and codec noise. Use `audio` turns with recorded clips, or an ElevenLabs
  clone of the owner's voice, to get closer.
- **Scripted users.** The user's turns do not depend on what the voice says. If the voice
  asks something the script did not expect, the next turn may not fit. The judge sees
  the script and judges the voice against what the user really said.
- **The simulated T3.** Results come from the production formatting code, but the world
  is invented. CLI changes, real delays and real agents are not exercised.
- **Judges** make mistakes. Read the evidence of failed criteria. Use several judges or
  `--repeat` before you trust a small difference.

Saved answer playback timestamps also count as answers when transcription is absent.
The judge log reports the playback time without inventing the missing words.
Regrading a silent turn without saved playback evidence is inconclusive and fails
its critical check; an explicit null playback timestamp establishes no answer audio.
