# Contributing to ADE Call

Thanks for your interest. Bug fixes, tests, documentation, accessibility work,
installation reports from platforms other than Linux, and new ADE adapters are all
welcome. You do not need to write code to help: a verified installation on a new
system or a fix to a confusing step in the docs is just as useful.

For anything larger than a focused fix (a new adapter, a change to how sends are
authorized or confirmed, a new dependency), open an issue first so we can agree on
the scope. Report security problems privately, as described in
[SECURITY.md](SECURITY.md).

## Development setup

You need:

- Node at the version in [.node-version](.node-version) (the product requires 24 or later).
- [uv 0.12.1](https://docs.astral.sh/uv/getting-started/installation/). It provides
  Python (version in [.python-version](.python-version)) and Ruff for the checks.
- Git and Bash. Linux is the validated platform; macOS and Windows are untested.

From the repository root:

```bash
npm ci
uv sync --locked
npm run check
```

`npm ci` installs Node dependencies from `package-lock.json`; `uv sync --locked`
creates `.venv` from `uv.lock`. Neither touches your Git configuration. The tests
use simulated providers and CLIs: no API key, T3 or Orca installation is needed.

To run the application itself, follow [docs/installation.md](docs/installation.md).
Use a separate configuration and state directory for development
(`ADE_CALL_CONFIG`, `ADE_CALL_STATE`, see
[docs/configuration.md](docs/configuration.md)), not the one of an installation you
rely on.

## Development loop

| Command | What it does |
| --- | --- |
| `npm run build` | Cleans `dist/`, compiles the server, scripts, tests and browser code, copies static assets. |
| `npm test` | Builds, then runs every compiled Node test (`dist/test/*.test.mjs`). |
| `npm run check:fast` | Type checks (Node and browser), ESLint, Ruff lint and format, `bash -n` on shell scripts and hooks, relative links and `json` code blocks in every Markdown file. No build, no tests. |
| `npm run check` | `check:fast`, then build, all Node tests, the Git hook tests and the Python project-sync test. This is what CI runs. |
| `npm run format` | Applies ESLint's automatic fixes. For Python: `uv run --locked ruff check --fix .` and `uv run --locked ruff format .`. |
| `npm start` | Builds and starts `dist/src/server.mjs`. |

`dist/` is not versioned. The tests run against the compiled output, so always go
through `npm test` or `npm run check` rather than running sources directly. What the
suite covers, and what it cannot prove, is described in
[docs/testing.md](docs/testing.md).

## Project layout

| Path | Contents |
| --- | --- |
| `src/server.mts` | HTTP server, authentication, configuration, lifecycle. |
| `src/voice/` | GPT Realtime call setup, sideband events, recordings, diagnostics. |
| `src/direct/` | The DirectAde contract, the send rule, prompt assembly, short IDs; one DirectAde per ADE. |
| `src/adapters/` | ADE registry and the CLI adapters (`t3/`, `orca/`). |
| `src/conversation/` | Context, persistence, thread watching, time context. |
| `src/access/` | Browser pairing and sessions. |
| `public/` | Browser UI and audio, TypeScript compiled to `dist/public/`. |
| `resources/` | Every text a model reads. See [resources/README.md](resources/README.md). |
| `scripts/`, `deploy/` | Build, checks, installer, access CLI, integration scripts, systemd and proxy examples. |
| `test/` | Node tests with simulated providers, plus one Python test. |

[docs/architecture.md](docs/architecture.md) explains how these pieces fit together.
Read [docs/adapters.md](docs/adapters.md) before adding or changing an ADE.

## Conventions

- **TypeScript, strict.** Node modules are `.mts` (emitted `.mjs`), browser modules
  are `.ts` (emitted `.js`). Relative imports name the emitted extension
  (`import ... from './store.mjs'`), so neither Node nor the browser needs a loader.
  Browser code is type checked without Node globals.
- **No `any`.** ESLint rejects explicit `any`. Narrow `unknown` instead, and validate
  data that comes from a CLI, SQLite or the network at runtime: static types do not
  check it.
- **No new runtime dependencies** unless Node's standard library cannot reasonably do
  the job. The only one today is `ws`.
- **Model-facing text lives in `resources/`**, not in code: voice instructions, tool
  descriptions, tool errors, the message delivered to T3. Tests fail if a key is
  missing or unused.
- **English everywhere** in code, comments, prompts, errors and docs. Never hard-code
  a conversation language; the voice follows the user. Interface strings go through
  `t('key')` with the English dictionary in `public/i18n.ts` as the source; another
  language is one more dictionary with the same keys. Tests may use utterances in
  other languages as fixtures.
- **Keep secrets out of errors.** CLI stderr, paths and keys must not reach the
  browser or the model; there are tests for this.

## Rules you must not break

These are the safety properties of the project. A change that weakens one will not
be merged, however convenient.

- Every API request needs a paired browser session (or the bearer access token),
  and browser requests that change state must come from the configured origin ([docs/access.md](docs/access.md)).
- The server never writes to T3's database. Reads may use it read-only; every change
  goes through the T3 CLI.
- A send to an agent runs only after a new transcribed user turn since the previous
  send, and that turn authorizes one send. The server enforces this mechanically;
  whether the turn accepts the assistant's proposal is judged by the model, which
  the prompt tells that asking, planning or reading never authorizes a send.
- One execution per function call. A send that may have happened is recorded as
  uncertain and is never retried automatically.
- Hanging up or closing the page does not cancel work in the ADE.
- The voice engine (`src/voice/realtime.mts` and `contract`, `session`, `prompt`,
  `state` in `src/direct/`) does not import code from a specific ADE.

[docs/delivery-safety.md](docs/delivery-safety.md) explains the send rule,
deduplication and uncertain deliveries in detail.

## Tests

Add or update tests for every behavior change. Tests live in `test/*.test.mts`, use
`node:test`, and simulate everything external: the Realtime provider, WebSockets,
the T3 and Orca CLIs, SQLite databases in temporary directories. Shared doubles are
in `test/fixtures.mts`. A test must never call a paid API, run a real ADE CLI, or
read the personal configuration and state directories.

Changes to `scripts/install-user.sh` are tested in `test/installer.test.mts` with
simulated `npm`, `systemctl`, ADE CLIs and running service. Changes to `scripts/sync-t3-projects.py` are
tested by `test/project-sync_test.py`.

## Commits and pull requests

1. Fork, create a branch, keep the change focused.
2. Write commit messages in English, in the imperative ("Keep the receipt when a
   read is interrupted"), explaining why when it is not obvious.
3. Update the docs if commands, configuration or behavior change.
4. Run `npm run check` and `git diff --check`.
5. Open the pull request with the template: what changes, why, and how you checked
   it. Say whether anything was verified against a real T3, Orca or voice call, or
   only with the simulated tests.

If you work with a coding agent, point it at [AGENTS.md](AGENTS.md) and review its
diff and tests before opening the pull request.

## Git hooks (optional)

The `.githooks/` directory has a `pre-commit` hook that runs `check:fast` on the
staged files (exported to a temporary directory, so unstaged edits neither hide nor
cause failures) and a `pre-push` hook that runs the full check on each outgoing
commit. Use them for one operation without changing any configuration:

```bash
git -c core.hooksPath=.githooks commit
git -c core.hooksPath=.githooks push
```

In a standalone clone (no linked worktrees, no custom `core.hooksPath`),
`npm run hooks:install` copies both hooks into `.git/hooks` and refuses to overwrite
hooks you already have. Hooks can be skipped with `--no-verify`; CI is the authority.

## Continuous integration

[.github/workflows/quality.yml](.github/workflows/quality.yml) runs `npm run check`
on every pull request and on pushes to `master`, `feat/**` and `fix/**`. It installs
from the lock files, uses actions pinned by commit SHA, has read-only permissions and
no secrets, and fails if the check leaves the tree modified. It does not run the
browser or paid voice tests.
