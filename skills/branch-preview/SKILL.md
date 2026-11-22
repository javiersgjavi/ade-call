---
name: branch-preview
description: Deploy a branch, PR or commit of ADE Call as a separate preview next to the installed service, without stopping or changing it, and open it already signed in so the owner can look at and try a change (UI or behavior) before merging. Use when the owner asks to see, try, test or preview a branch, a PR or a change; also to update, list or stop previews.
---

# Branch preview

A preview is one branch or commit of this repository in its own Git worktree, built
and run on `localhost` with its own configuration and state. The installed service
keeps running untouched: different process, port, configuration, state and
pairings. Everything is done by [preview.sh](preview.sh), which runs
[preview.mts](preview.mts) with Node 24 and lets one command that changes previews
run at a time.

**Only preview code you trust.** Building and starting a preview runs that branch's
build scripts and server as the owner, with the owner's ADE CLIs and, by default, a
copy of the OpenAI key. Previews are for the owner's own branches and PRs; read
anyone else's changes before previewing them.

## Start or update

```bash
skills/branch-preview/preview.sh start BRANCH          # a branch, tag or commit
skills/branch-preview/preview.sh start pr/42           # GitHub pull request 42, from origin
skills/branch-preview/preview.sh start BRANCH --no-key # page only, no calls
```

A branch resolves to the local one, or to `origin`'s when that one is newer or the
only one, counted only when it was fetched in that run; `origin/BRANCH` is origin's
branch as fetched now, and fails if origin cannot be reached; `pr/N` fetches
`refs/pull/N/head` and pins the commit fetched; commits and expressions such as
`HEAD~1` are resolved locally, always in the checkout the preview came from. It builds
it, starts it on the first free port from 18800 (never the installed service's or
another preview's) and prints its name, address and an opening link
`http://localhost:PORT/#pair=CODE`. If anything fails on the first start, nothing
is left behind.

Running `start` again with the same ref moves the preview to that ref's newest
commit, rebuilds and restarts it on the same port, keeping its settings and paired
browsers. It restarts only when the preview answers that it is idle: with a call or
a tool running, or when it cannot be asked, it refuses unless `--force` is given,
which ends that call. Two refs that give the same name (`feat/x`, `feat-x`) cannot
both have a preview; stop the other first.

## Open it for the owner, already signed in

The link carries a single-use pairing code valid for 10 minutes. The page never
pairs just because a link was opened (link scanners would spend the code), so
someone has to press **Pair browser** once. Do it for the owner:

1. In T3 Code, open a preview tab in the owner's profile on the preview's port with
   the link's path and fragment (`preview_open` with
   `target: {kind: "environment-port", port: PORT, path: "/#pair=CODE"}`).
   Elsewhere, open the link in the browser the owner is looking at.
2. Click **Pair browser** (`#login-submit`) and check that the workspace appears.
3. Show the tab to the owner, and take screenshots if they asked for them.

That browser stays paired with this preview, including after updates. A new link:
`preview.sh link NAME`. Cookies on `localhost` are shared by every port, so one
browser profile is paired with one preview at a time: after pairing another
preview, or the owner's `http://localhost` installation, get a new link and pair
again when going back. Give links only to the owner: never put them in commits,
PRs, shared logs or a voice call's context.

The preview listens only on `127.0.0.1`. It is meant for the T3 Code browser on this
machine; it is not reachable from a phone. Do not change DNS, Caddy, Tailscale or
the firewall to expose it.

## Calls cost money and reach real agents

By default the preview copies only these fields of the installed service's
`config.json` into its own (mode `600`): `openaiKey`, the `realtime*` voice settings
and `customInstructions`; it never takes a key from the environment. On later
starts it keeps what it has, unless `--no-key` removes the key or `--key` copies the
installed one again. With the key, calls work: each one is paid, and a call can
send work to the owner's real T3 or Orca agents once the owner accepts by voice,
exactly as in the installed service. The preview uses the installed service's ADE
CLIs, `T3CODE_HOME` and `PATH`, so it lists the same projects. Never place a call or
send work from a preview yourself; that is the owner's decision. Use `--no-key` when
only the page matters.

## Other commands

```bash
skills/branch-preview/preview.sh list           # name, running or stopped, address, branch and commit
skills/branch-preview/preview.sh logs NAME      # the last 80 lines of its server log
skills/branch-preview/preview.sh link NAME      # a new opening link
skills/branch-preview/preview.sh stop NAME      # stop it and delete its worktree, key copy, state and pairings
```

`stop` refuses while a call or a tool is running or when the preview cannot be
asked, like `start`; `--force` overrides. Without systemd, the script signals a
recorded process only after checking that its boot, start time and working directory
are the preview's, so a reused PID is never touched.
Stop previews the owner no longer needs: each one keeps a process and a copy of the
key.

## Rules

- Never stop, restart or reconfigure the installed service, and never point a
  preview at its configuration or state directories. The script refuses the
  service's port.
- Do not edit files inside a preview's checkout: change the branch, commit, and run
  `start` again. A checkout with local changes refuses to update.
- A preview shares the repository's `node_modules` when its lock file is the same,
  and installs its own otherwise.
- Report what was checked in the preview and what was not (for example, no real call).

## Requirements and settings

Linux with Git and Node 24 or later (`NODE_BIN`, the `node` on `PATH`, or the
installed service's). With user systemd each preview runs as a transient unit
`ade-call-preview-NAME-XXXXXXXX.service` (8 hex digits from the preview's folder, as
`list`'s NAME plus that suffix); without it, as a background process with a PID file.

| Variable | Default | Purpose |
| --- | --- | --- |
| `ADE_CALL_PREVIEW_ROOT` | `~/.local/state/ade-call-previews` | Where previews live, one folder per preview. Must be outside the repository. |
| `ADE_CALL_SERVICE` | `ade-call.service` | The installed service whose key, settings, ADE CLIs and `PATH` are reused. |
| `ADE_CALL_SOURCE_CONFIG` | that service's `ADE_CALL_CONFIG`, else `~/.config/ade-call` | Directory of the `config.json` to copy from. |
| `ADE_CALL_PREVIEW_FIRST_PORT`, `ADE_CALL_PREVIEW_LAST_PORT` | `18800`, `18899` | Port range for new previews. |
| `ADE_CALL_PREVIEW_SUPERVISOR` | systemd when available | `nohup` forces a background process. |
| `ADE_CALL_PREVIEW_REPO` | the repository holding the script | The repository whose branches are previewed. |
