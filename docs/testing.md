# Testing

The test suite runs offline. It simulates the OpenAI Realtime, Gemini Live and ElevenLabs Realtime APIs, the WebSockets,
the T3 and Orca CLIs and T3's SQLite database, so it needs no API key and no ADE
installed. It proves that the server enforces its rules; it cannot prove how a model
behaves in a real call, including whether it sends only after the user accepts
its proposal. A few separate scripts cover real browsers, real ADEs and
the real voice; they are never part of `npm run check`.

## Running the tests

```bash
npm test                                   # build + all Node tests
npm run check                              # what CI runs: static checks + all tests
npm run build && node --test dist/test/t3.test.mjs   # one file
npm run build && node --test --test-name-pattern "uncertain" dist/test/*.test.mjs
```

Tests run against the compiled output in `dist/`, so rebuild after editing sources.
`npm run check` adds the static checks (types, ESLint, Ruff, `bash -n`, Markdown
links and `json` blocks), the Git hook tests in `scripts/verify-hooks.mts` and the
Python test `test/project-sync_test.py`. Shared doubles live in `test/fixtures.mts`.
The few evaluation tests that decode the phone line or recorded clips need `ffmpeg`;
without it on `PATH` they are skipped, and the rest of the suite still runs.

## What the suite covers

| Area | Files | What is checked |
| --- | --- | --- |
| HTTP and access | `http`, `browser-http`, `browser-access` | Authentication on every route, origin and CSRF checks, single-use expiring pairing codes stored as hashes, session renewal and revocation, codes created from the page (`POST /api/browsers/pair`: authorization, Origin, names, no address taken from `Host`, single redemption, the pending cap), origin changes revoking old sessions, attempt throttling, MIME types and the page's CSP. |
| Settings | `settings-http`, `voice-settings`, `realtime` | Voice settings and key endpoints with bearer and cookie authentication and Origin, strict validation of every field and of the key format, values applied without a restart to `/api/status`, every ADE and the next call, refused while a call is active or connecting, `config.json` replaced atomically with mode `0600` keeping unknown fields and never overwritten when invalid, a saved key over `OPENAI_API_KEY`, and no key or key fragment in any response or log. |
| Gemini Live | `gemini`, `settings-http` | Setup with the ADE tools declared `BLOCKING`, history and catalog as client content first, the key only on the server, audio relayed both ways, interruptions, streamed transcripts, the send rule and one execution per call ID, a late yes, cancelled sends told to the model, session resumption on `goAway`, hang-up, and the audio socket's authentication and origin checks. Not a real call: see [gemini.md](gemini.md#what-has-been-verified). |
| ElevenLabs Realtime | `eleven-realtime`, `settings-http` | The session with the provider's audio format and voice, server notes as user messages that never count as turns, the send rule, the audio relay both ways with resampling, barge-in and interrupt, expressive tags, closing, a missing key, and key redaction. Not a real call: see [elevenlabs.md](elevenlabs.md#what-has-been-verified). |
| Voice engine | `realtime`, `live-events`, `call-lifecycle`, `interruptions`, `voice-result` | WebRTC session setup with an invented ADE, turn-taking settings, the send rule, one execution per call ID, waiting for the transcript that authorizes a send, interruptions before and after dispatch, oversized answers. Also checks the engine imports no T3 or Orca code. |
| Send authorization | `intent`, `tool-guidance`, `hint-echo` | Authorization comes only from the latest user turn; a transcript that only recites the recognition hints is not a turn; distinct call IDs give distinct request IDs; a reused request ID with other content is rejected. |
| Delivery safety | `t3`, `uncertain-delivery`, `tool-failure` | Deduplication across reconnects and restarts, a pending row blocking concurrent duplicates, uncertain deliveries never retried, verification by the reference line only in a user message of the right thread, release by user decision, replacing an archived main thread. |
| T3 adapter | `t3-tools`, `realtime-direct`, `t3-read-cache`, `t3-format`, `subagent-discovery`, `thread-index`, `read-interruptions` | No Bash in the tool surface, short IDs, compact catalog, per-call read memory, fingerprint cache, read-only subagent discovery from SQLite, title search of main threads before subagents, cancellation of CLI processes. |
| Orca adapter | `orca-direct`, `orca-tools`, `ades` | Catalog with short IDs, terminal re-reads with cursors, sends and launches deduplicated by request ID, preflight checks, unknown deliveries blocking retries, registry isolation between ADEs. |
| Discovery and catalog | `startup`, `progressive`, `project-catalog`, `context`, `spoken-match` | Status answering without waiting for the CLI, coalesced scans, progressive catalogs, honest partial results, transcription vocabulary from project names, fuzzy name matching. |
| Conversation and notices | `core`, `continuity`, `call-events`, `thread-watch`, `time-context`, `tool-details` | A conversation created on first use, resuming after restart without replaying old work, greeting language, stored call events per ADE and conversation, end-of-turn notices for followed threads, calendar and DST handling, secret redaction in stored tool records. |
| Browser code | `frontend`, `streaming`, `playback-control`, `speech-gate`, `call-recording`, `recordings` | The compiled UI run in a VM: element IDs, ADE switch, i18n dictionaries, New session ordering, WebRTC health stats, local speech detection, recording limits and recovery. |
| Resources | `resources` | Every placeholder filled, every error key used and defined, `tools.json` schemas and examples valid. |
| Evaluation harness | `eval`, `gemini-eval` | Scenario validation, the simulated T3 behind the production tools (catalog, search, reads, failing reads, sends, delayed replies), send and tool checks, the judge request and verdict parsing, the speech cache and noise, and closed-loop runs against simulated Realtime and Gemini Live providers (setup, 16 kHz microphone frames, sends, tool results, notices, interruptions). No model is graded here. |
| Installer and sync | `installer`, `project-sync_test.py` | `install-user.sh` with simulated `npm`, `systemctl`, T3, Orca and running service: fresh install, restart after waiting for the running service to be idle (asked at its own address, only when its main process owns the listening socket), the 2-minute wait on a simulated clock, Orca-only; the T3 project sync script. |
| Branch previews | `branch-preview` | `skills/branch-preview` on a temporary clone of this repository with an invented installed configuration and a background process instead of systemd: a real worktree, build and server; only the key, `realtime*` and `customInstructions` copied, mode `600`, never printed, never taken from the environment; the link's code pairing once; `link`, `list`, `logs`; an update to a new commit keeping port and pairings, with `--no-key` turning calls off; refusals for a taken name, a folder it did not create, bad ports and unknown refs; stop refused when the preview cannot be asked; a reused PID never treated as its own; `stop` removing process, worktree and files. Status parsing (idle only on an authenticated `serviceBusy: false`), systemd environment quoting and names are checked directly. |

File names are relative to `test/` and omit `.test.mts`.

## What the tests do not prove

- **Model behavior.** Whether the voice waits for a finished sentence, accepts a
  corrected name, keeps the user's language or proposes before sending depends on the
  model. The paid [conversation evaluations](evals.md) measure it with synthetic calls;
  only a real call proves it.
- **Real CLIs.** The simulated T3 and Orca CLIs follow the documented output. A new
  CLI version that changes its output is caught only against a real installation.
- **Real deliveries.** That a message actually reaches an agent and starts a run is
  not exercised. Orca terminal sends in particular are covered only by simulation.
- **Browsers and devices.** Audio capture, echo, autoplay and WebRTC are tested on
  compiled code in a VM, not in Safari, Firefox or on phones.
- **Platforms.** CI runs on Linux. macOS and Windows are untested.

## Integration and paid scripts

Build first (`npm run build`). The browser scripts need Playwright's Chromium
(`npx playwright install chromium`, or set `CHROME_BIN` for `smoke-browser`).

| Script | Uses | Cost |
| --- | --- | --- |
| `dist/scripts/verify-recording-browser.mjs` | Chromium with synthetic tones; intercepted HTTP; temporary archive. | Free, no provider, no personal state. |
| `dist/scripts/smoke-browser.mjs` | A running server, its access token, Chromium. Loads the UI and lists projects. | Free without `TEST_VOICE`. With `TEST_VOICE=1` it places a real call: paid. |
| `dist/scripts/eval.mjs` | Scripted conversations spoken by ElevenLabs voices, run against GPT Realtime, Gemini Live or ElevenLabs Realtime over a simulated T3, checked by code and graded by LLM judges ([evals](evals.md)). | Paid. |
| `dist/scripts/replay-realtime.mjs` | A diagnostic recording, `ffmpeg`, the configured `openaiKey`, real read-only T3 CLI. Sends are simulated. | Paid. |
| `dist/scripts/measure-startup.mjs` | An isolated server with a simulated CLI. `--real` reads the local T3. | Free. |
| `dist/scripts/measure-projects.mjs` | Adapter discovery timing. `--real` reads the local T3 and Orca; `--http` goes through an isolated server. | Free. |

### Browser smoke test

`smoke-browser` talks to whatever server `CALLER_URL` points at (default
`http://127.0.0.1:8787`) and reads the token from `ACCESS_TOKEN_FILE` (default: the
personal configuration). To keep it away from an installation you use, start a
separate instance with temporary directories and point the script at it:

```bash
export ADE_CALL_CONFIG=$(mktemp -d) ADE_CALL_STATE=$(mktemp -d) PORT=8790
node dist/src/server.mjs &
CALLER_URL=http://127.0.0.1:8790 ACCESS_TOKEN_FILE=$ADE_CALL_CONFIG/access-token \
  node dist/scripts/smoke-browser.mjs
```

That instance still reads the real T3 installation through its CLI, but only reads.
The voice options, all opt-in:

| Variable | Effect |
| --- | --- |
| `TEST_VOICE=1` | Starts a call, waits for "I'm listening", hangs up. Requires `openaiKey` in that configuration. |
| `TEST_GREETING=1` | Also waits for the spoken greeting. |
| `TEST_AUDIO_FILE=question.wav` | Plays a recorded question as the microphone and expects a spoken answer. |
| `EXPECTED_PROJECT=Name` | Requires that name in the answer. |
| `SCREENSHOT_FILE`, `CHROME_BIN`, `CHROME_NO_SANDBOX=1` | Screenshot path, browser binary, sandbox flag for containers. |

A recorded question can lead the model to propose a send, and a later user turn could
authorize it. Use a question that only asks for information.

### Replaying a recorded call

```bash
node dist/scripts/replay-realtime.mjs RECORDING_DIR OUT_DIR [--eagerness low] [--tail MS] [--no-prefetch]
```

It streams the microphone channel of a diagnostic recording (see
[troubleshooting](troubleshooting.md)) to GPT Realtime in real time and reports turn
taking and tool use. Reads run against the real T3 CLI; every send is simulated and
nothing is delivered. The replay is open loop: the user's words were spoken to a
different voice and do not react to this one. `OUT_DIR` receives transcripts and
audio; keep it private.

### Benchmarks

`measure-startup` starts an isolated server on a free port with temporary state, a
fake T3 database with one project and a read CLI delayed by 600 ms, then reports the
time to status, to projects and context, and the number of CLI invocations. Pass
another checkout's root as an argument to compare it (build it first). `--sequential`
reproduces requesting projects and context one after the other. `--real` uses the
local T3 (`T3_BIN`, `T3CODE_HOME`) for reads only.

`measure-projects` times each adapter's catalog and full discovery directly, with a
simulated 1 s delay by default. Times depend on the machine and the size of the
installation; there is no threshold in CI.
