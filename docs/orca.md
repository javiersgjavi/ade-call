# Orca adapter

The Orca adapter connects ADE Call to [Orca](https://github.com/stablyai/orca),
where agents run in terminals inside workspaces (git worktrees). The voice reads
terminal output, sends approved requests to connected agents and can start a new
agent in an existing workspace. It does not read Orca's structured chats.

Code: [`src/direct/orca.mts`](../src/direct/orca.mts) (voice layer) on top of
[`src/adapters/orca/`](../src/adapters/orca) (CLI, listings, journal, formats).
For the shared model see [adapters](adapters.md).

## CLI

Everything goes through Orca's CLI, `orca-ide` by default or `ORCA_BIN`. This is
not the `orca` binary found on many Linux desktops, which is the GNOME screen
reader. ADE Call has no access to Orca's database and uses no SSH.

Every call adds `--environment local --json` and expects
`{ "ok": true, "result": { … } }`; `ok: false` is reported as a rejection. Calls
time out after 20 s (60 s for `agent launch`) with an 8 MB output limit. Stderr is
never shown to the model.

| Command | Used for |
| --- | --- |
| `repo list` | Projects (`repos`: `id`, `displayName`, `path`). |
| `worktree ps` | Workspaces (`worktrees`: `worktreeId`, `repoId`, `displayName`, `workspaceStatus`, `comment`, `liveTerminalCount`, `lastActivityAt`). |
| `terminal list` | Live terminals (`terminals`: `handle`, `title`, `worktreeId`, `agentIdentity`, `connected`, `writable`, `orphaned`, `status`). |
| `terminal read --terminal H --limit N [--cursor C]` | Accumulated output, optionally from a line cursor. |
| `terminal read --terminal H --screen` | The rendered screen. |
| `terminal send --terminal H --text M --enter --wait-submit 1` | Send a message to an agent. |
| `agent launch --worktree id:W --agent A --surface terminal --prompt M [--model] [--effort]` | Start an agent in a workspace. |

If a listing lacks the expected array, the error says Orca answered in a format
this version does not read. It is never interpreted as "no projects".

## Tools

| Tool | Sends | What it does |
| --- | --- | --- |
| `orca_list_projects` | No | Projects, workspaces and terminals; with `query` (and up to five `variants`), searches project, workspace and terminal names with the same matcher as [`t3_find_threads`](t3.md#search-by-name). |
| `orca_read_terminal` | No | Terminal output or screen, with per-call memory. |
| `orca_read_document` | No | A page of a `.md` or `.txt` file in a listed project ([rules](adapters.md#capabilities-t3-and-orca)). |
| `orca_send_message` | Yes | Sends to the agent of an existing terminal. |
| `orca_start_agent` | Yes | Launches a new agent in an existing workspace with the request as its first message. |
| `orca_release_uncertain` | Yes, keeps authorisation | Unblocks a project after an uncertain send, by the user's decision. Sends nothing. |

### Catalog

The session catalog is a tree: each project with its documents, its workspaces
(name, board column, last activity, note) by recent activity, and under each
workspace its live terminals (title, agent or shell, anomalous state such as
disconnected or read-only). UUIDs get 8-character prefixes; other IDs, such as workspace IDs
(`repo::path`) and terminal handles, get `s…` aliases. Paths and
cursors are never shown. The catalog stops at 120 lines.

Orca has no cheap local read, so the catalog calls the three listings in parallel.
If they do not answer within 5 seconds, the catalog falls back to the project names
from the server's last observation and says that terminals are missing, not
absent.

### Reading a terminal

`orca_read_terminal` returns a header (terminal, agent or shell, workspace,
project, running or exited) and the latest 60 lines by default, up to 400 with
`lines`, within about 8000 characters. Trailing spaces and runs of blank lines are
removed. With `screen=true` it returns the rendered screen instead, which helps
when output arrives fragmented. Unsent text in Orca's input box is flagged as such,
never shown as output.

Within a call, the read remembers each terminal: the CLI's end cursor
(`latestCursor` or `nextCursor`), the status and a SHA-256 of the text. The memory
is held per call state and discarded with it.

The first read of a terminal returns the latest window. A re-read with a known
cursor asks Orca only for output after it (up to 1000 lines) and returns just
those lines, or `NO CHANGES` if there are none and the status is the same. When
Orca no longer holds the output since that cursor (`truncated`) or there is more
than fits (`limited`), it falls back to the latest window and says why it cannot
separate what is new. Terminals that give no cursors are compared by digest: same
text and status is `NO CHANGES`, anything else is the latest window. Screens are
always compared whole by digest. `latest=true` ignores the memory and repeats the
window.

### Cache

Terminal output is never cached: without access to Orca's database there is no
cheap, safe fingerprint, so every read calls the CLI. Only the three listings are
cached and shared by concurrent readers: `repo list` for 60 s, `worktree ps` and
`terminal list` for 10 s. A failed listing is not kept. The listings feed the
catalog, name search and finding the terminal a read targets; if the terminal is
not in the cached listing, a fresh one is requested before giving up. `prefetch`
warms the listings when a session opens. Sends and launches validate their target
against their own fresh listing and invalidate the workspace and terminal entries
afterwards.

## Sending and starting agents

Whether a send may run is decided by the engine's [send rule](delivery-safety.md).
Once it runs:

- **`orca_send_message`** goes only to a terminal whose agent is identified (not a
  shell), connected, writable and not orphaned. The CLI must answer with
  `send.accepted`, the same handle and a prompt request ID; anything else leaves the
  send uncertain.
- **`orca_start_agent`** needs an existing workspace of that project and the
  provider the user named (`codex`, `claude`, …, lowercase). `model` and `effort`
  are free text passed through only when the user asks; `effort` requires `model`.
  It does not create workspaces. The launch must return a terminal outcome with a
  handle; the receipt says whether Orca reports the request reached the agent.

Both write to `ades/orca/dispatch.sqlite` in ADE Call's state directory before
invoking the CLI, keyed by the server's request ID. An accepted receipt is reused
on repeat, and an uncertain operation blocks further sends to the project, as
described in [delivery safety](delivery-safety.md). The model's receipt is short:
`SENT: …` or `STARTED: … terminal s4b7e01c`, followed by "accepted does not mean
processed or finished".

The message goes to the agent exactly as approved, with no reference line: typed
into an agent's input, an extra line would change the request, and terminal output
(fragmented, possibly with unsent drafts) could not prove it arrived anyway. So
there is no confirmation by reading. An uncertain Orca send is cleared only by
`orca_release_uncertain` after the voice has read that terminal (or listed the
project, for a launch) in this call and the user decides, or automatically when the
row provably never reached the CLI.

Orca has no main thread, so there is nothing equivalent to T3's main-thread
replacement.

## Limits

- **No structured chats.** Orca's CLI does not expose its chat messages for
  reading or continuing; the voice works only with terminals and says so.
- **No notices.** Sends return no `delivered` result and `readThreadMessages` is
  false, so the server does not follow Orca agents. To know whether an agent
  finished, read its terminal again.
- **No stop.** The voice cannot stop, interrupt or close agents or terminals, nor
  create workspaces. That is done in Orca. Hanging up stops nothing.
- **Terminal text is evidence, not messages.** A running terminal does not prove
  an agent is working, and silence does not prove it finished.

Sends and launches are covered by tests against a simulated CLI; see
[testing](testing.md).
