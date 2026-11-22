# Guide for coding agents

ADE Call lets one person talk by voice, from a browser or phone, with the
coding agents of a local ADE (agentic development environment): T3 Code or Orca. A
Node server opens GPT Realtime calls over WebRTC (or Gemini Live calls whose audio it relays), gives the model tools to read
projects and threads through the ADE's CLI, and sends work to agents after the model
proposes it and hears the user's yes; the server requires a new user turn for each
send. Each installation has its own keys, state and projects;
keep the code free of personal names, machines, domains and networks.

## Read first

- [README.md](README.md): what the product does.
- [docs/architecture.md](docs/architecture.md): components, call lifecycle, tool flow.
- [docs/delivery-safety.md](docs/delivery-safety.md): send rule, deduplication, uncertain deliveries.
- [docs/adapters.md](docs/adapters.md), [docs/t3.md](docs/t3.md), [docs/orca.md](docs/orca.md): ADE adapters.
- [docs/access.md](docs/access.md): pairing, sessions, origin checks.
- [docs/gemini.md](docs/gemini.md): the Gemini Live provider.
- [CONTRIBUTING.md](CONTRIBUTING.md): setup, conventions, PR process.
- [docs/testing.md](docs/testing.md): what the tests prove and what they do not.
- [docs/evals.md](docs/evals.md): paid conversation evaluations of the voice model.

## Code map

| Path | Role |
| --- | --- |
| `src/server.mts` | HTTP, authentication, configuration, lifecycle. |
| `src/voice/realtime.mts` | GPT Realtime calls (WebRTC plus sideband WebSocket), tool dispatch, transcript and `voice-tool` events. |
| `src/voice/gemini.mts` | Gemini Live calls: provider WebSocket on the server, audio relayed to the page, the same tool dispatch and send rule ([docs/gemini.md](docs/gemini.md)). |
| `src/direct/contract.mts`, `session.mts`, `prompt.mts`, `state.mts` | ADE-agnostic engine: DirectAde contract, send rule, instructions, short IDs. |
| `src/direct/t3.mts`, `src/direct/orca.mts` | The DirectAde of each ADE. |
| `src/adapters/registry.mts` | Which ADEs exist and their capabilities. |
| `src/adapters/t3/` | T3 CLI client, discovery, read cache, delivery coordinator and journal. |
| `src/adapters/orca/` | Orca CLI client, terminal reads, sends and launches. |
| `src/conversation/` | Context, persistence (`store.mts`), thread watch, time context. |
| `src/access/browsers.mts` | Pairing codes and browser sessions. |
| `src/eval/`, `scripts/eval.mts`, `evals/` | Paid conversation evaluations: simulated T3 world, ElevenLabs speech, closed-loop Realtime runner, checks, LLM judges ([docs/evals.md](docs/evals.md)). |
| `src/resources.mts`, `resources/` | Model-facing text and its loader ([resources/README.md](resources/README.md)). |
| `public/` | Browser UI and audio (`relayed-call.ts` and `pcm-capture.ts` for Gemini); `public/i18n.ts` holds the interface dictionaries. |
| `scripts/`, `deploy/` | Build, checks, installer, access CLI, integration scripts, systemd units, proxy example. |
| `skills/` | Agent skills ([skills/README.md](skills/README.md)), such as running a branch as a separate preview. |
| `test/` | Node tests with simulated providers and CLIs; `test/project-sync_test.py`. |

## Commands

```bash
npm ci && uv sync --locked   # once, and after dependency changes
npm test                      # build + Node tests
npm run check:fast            # types, lint, Ruff, bash -n, doc links and JSON blocks
npm run check                 # everything CI runs; must pass before you hand over
git diff --check
```

Node version: [.node-version](.node-version) (24 or later). Tests never need keys or
a real ADE. Paid or real-system scripts are listed in [docs/testing.md](docs/testing.md);
do not run them unless the task asks for it.

## Trying a branch

To let the owner see or try a branch, PR or change before merging, use the
[branch-preview skill](skills/branch-preview/SKILL.md): it runs the branch next to
the installed service, on its own port, configuration and state, and opens it
already signed in. Never restart or reconfigure the installed service to show a
change.

## Hard rules

- Keep authentication and origin validation on every API route.
- Never write to T3's database. Read it read-only; mutate only through the T3 CLI.
- The server runs a send only after a new transcribed user turn since the previous
  send, once per turn (a transcript that only recites the recognition hints is not
  a turn); it does not check that the turn accepts a proposal. That
  judgment is the model's, guided by the prompt: asking, designing or reading does
  not authorize sending. Do not describe the server gate as a confirmation check
  ([docs/delivery-safety.md](docs/delivery-safety.md#the-send-rule)).
- One execution per function call ID. A delivery that may have happened stays
  uncertain and is never retried automatically.
- Hanging up does not cancel ADE work.
- The voice engine must not import ADE-specific code (a test enforces this). Keep
  each ADE's tools and sessions separate; never offer Bash or another ADE's tools as
  a substitute, and keep capability flags honest.
- Model-facing text goes in `resources/`, not in code.
- English for code, comments, prompts, errors and docs. Interface text goes through
  `t('key')` in `public/i18n.ts`. Never hard-code the conversation language.
- No new dependencies when the standard library suffices. Update docs when commands,
  variables or behavior change.

## Installing for a user

The owner may give you only this repository's link. Follow these steps in order;
[docs/installation.md](docs/installation.md) has the commands and checks.

1. Inspect the system first: OS, architecture, Node (24+), npm, user systemd, and
   which ADE CLIs (`t3`, `orca-ide`) and tools (`caddy`, `tailscale`) exist. Do not
   assume paths or service names; check each CLI's `--help`. macOS and Windows are
   not validated: do not promise them, and do not run the systemd installer there.
2. Then ask the owner, in one short grouped message, only what you could not check:
   - Which ADE they use (T3 Code or Orca), and whether it runs on this Linux machine.
     ADE Call must run on the same machine as the ADE.
   - Whether they want a permanent service that starts on its own, or only `npm start`.
   - Whether they will use it from their phone, and if so by which HTTPS route: Caddy
     with a public hostname (own domain or automatic DNS, ports 80/443 reachable)
     or Tailscale Serve (no domain or open ports; the phone joins their tailnet). The
     table in [docs/deployment.md](docs/deployment.md#phone-access) helps them choose.
   - Whether they already have an OpenAI API key on an account with billing and
     credit. Never ask them to paste the key into the chat.
3. Clone into a permanent folder (for example `~/ade-call`), not a temporary one: the
   systemd unit runs from the checkout. Run `npm ci` and `npm test`. This does not
   install T3 or Orca.
4. Have the owner store the key themselves, either with the no-echo terminal snippet
   in [docs/installation.md](docs/installation.md#3-store-the-openai-key) or later in
   **Settings → API keys** on the page. Both keep existing `config.json` fields and
   mode `600`. Never invent keys or model IDs; other settings are in
   [docs/configuration.md](docs/configuration.md).
5. Explain that the OpenAI key, the web access token and the ADE agents' own
   credentials are separate, and that every call uses paid API time.
6. Start with `npm start`, confirm access and that projects are listed, and do one
   read-only query. Never send work to an agent as an installation test. Make a real
   call only if the user asked for one.
7. For a permanent service, run `bash scripts/install-user.sh` after the key is
   configured, with `NODE_BIN`, `T3_BIN` and `T3CODE_HOME` (and `ORCA_BIN`) if not on
   the default paths; without T3 it installs for Orca only. It does not install or
   start T3. Run again while the service is running, it waits up to about 2 minutes
   for the service to report being idle and then restarts it, with a warning if it
   was still in use or could not be asked. For the phone, follow the route the owner
   chose in [docs/deployment.md](docs/deployment.md#phone-access), then pair the
   phone against the HTTPS address ([Pairing browsers](#pairing-browsers)).
   Remote access is supported: do not refuse it merely because it exposes an HTTPS
   page outside the LAN. Inspect existing proxies, including containers, before
   proposing a new one. If the owner has no domain, explain the automatic DNS
   option in the deployment guide; if incoming ports are unavailable, offer Serve.
   Changing DNS, the router, firewall, Caddy's configuration or the tailnet's
   settings is the owner's decision. Prepare the exact changes and ask only for
   authorization that is still missing; an explicit earlier approval of those
   changes remains valid. If you cannot access a required control panel, give the
   owner precise steps and continue independent work. Name concrete blockers
   instead of ending with a generic warning about Internet exposure. The Tailscale
   route is not yet validated end to end; say so.
8. Report the access URL, where the token is, how to start and stop the service,
   and which checks were real and which simulated. Follow the deployment guide's
   outside-access check: the owner opens the page over mobile data (with Tailscale
   connected for Serve), pairs and checks projects. A pairing link or a successful
   local request does not prove outside access. Report it as unverified until tested.

## Secrets and personal data

Configuration lives outside the checkout (default `~/.config/ade-call`, state
in `~/.local/share/ade-call`). Never put keys, tokens, pairing codes, databases,
recordings or transcripts in commits, logs, prompts or public answers. Use a secure
input for credentials when your environment has one. When diagnosing, say whether a
key is set, never its value. Do not overwrite a personal configuration or rotate
credentials unless the task requires it. Before restarting a running service, check
that no call is in progress. Do not change a personal deployment to test a repository
edit.

## Pairing browsers

See [docs/access.md](docs/access.md). On installation, or when the owner asks, generate
a code on the server machine with the service's `ADE_CALL_CONFIG` and the built
artifact:

```bash
npm run access -- pair --url https://your-server.example --name "Phone"
```

Give the code and link only to the owner; it is single-use and expires in ten
minutes. Never paste codes into commits, shared logs or the voice's context. Do not
generate codes against a personal configuration as a test: use a temporary
`ADE_CALL_CONFIG`. Do not change the configured URL, TLS, network or proxy just
to produce another code. If the owner wants a different domain, explain that
`access configure` revokes all existing pairings.
