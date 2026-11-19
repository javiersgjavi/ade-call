#!/usr/bin/env bash
set -euo pipefail
if [[ "$(uname -s)" != Linux ]] || ! command -v systemctl >/dev/null; then
  printf 'This installer requires Linux with user systemd. Use npm start to start it manually.\n' >&2
  exit 1
fi
systemctl --user show-environment >/dev/null
export NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
if [[ -z "$NODE_BIN" ]] || ! command -v "$NODE_BIN" >/dev/null; then
  printf 'Install Node 24+, or set NODE_BIN.\n' >&2
  exit 1
fi
export NODE_BIN="$(command -v "$NODE_BIN")"
# At least one ADE CLI: T3 (t3), Orca (orca-ide), or both. The unit pins the
# ones found; without T3 the service runs for Orca only.
T3_BIN="${T3_BIN:-$(command -v t3 || true)}"
if [[ -z "$T3_BIN" && -x "$HOME/.local/bin/t3" ]]; then T3_BIN="$HOME/.local/bin/t3"; fi
if [[ -n "$T3_BIN" ]] && command -v "$T3_BIN" >/dev/null; then
  export T3_BIN="$(command -v "$T3_BIN")"
elif ORCA_BIN="${ORCA_BIN:-$(command -v orca-ide || true)}"; [[ -n "$ORCA_BIN" ]] && command -v "$ORCA_BIN" >/dev/null; then
  if [[ -n "$T3_BIN" ]]; then
    printf 'T3_BIN=%s was not found.\n' "$T3_BIN" >&2
    exit 1
  fi
  export ORCA_BIN="$(command -v "$ORCA_BIN")"
  unset T3_BIN
  printf 'The T3 CLI was not found: installing for Orca only (ORCA_BIN=%s). T3 will show as unavailable; to add it later, install it or set T3_BIN and run this installer again.\n' "$ORCA_BIN"
else
  printf 'Install an ADE CLI: T3 (t3) or Orca (orca-ide). Set T3_BIN to the T3 CLI, or ORCA_BIN to orca-ide for an Orca-only installation.\n' >&2
  exit 1
fi
export ADE_CALL_STATE="${ADE_CALL_STATE:-$HOME/.local/share/ade-call}"
export ADE_CALL_CONFIG="${ADE_CALL_CONFIG:-$HOME/.config/ade-call}"
export T3CODE_HOME="${T3CODE_HOME:-$HOME/.t3}"
"$NODE_BIN" -e 'if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("Node 24+ required")'
mkdir -p "$ADE_CALL_STATE" "$ADE_CALL_CONFIG" "$HOME/.config/systemd/user"
chmod 700 "$ADE_CALL_STATE" "$ADE_CALL_CONFIG"
# Not through $(pwd): command substitution drops trailing line breaks, which
# could name another folder.
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
npm ci --include=dev --no-audit --no-fund
npm run build
"$NODE_BIN" dist/scripts/write-service.mjs
systemctl --user daemon-reload
service=ade-call.service
if systemctl --user is-active --quiet "$service"; then
  # enable --now does not restart a running service, so the new unit and
  # build would wait for the next restart. A restart ends any call, so first
  # wait, up to 2 minutes, for the service to say it is idle. It asks the
  # process that is running, at its own address and with its own token, not
  # the values exported for this installation. It is restarted anyway if it is
  # still in use then or cannot be asked: accepted risks, see
  # docs/deployment.md.
  systemctl --user enable "$service"
  busy=0
  "$NODE_BIN" dist/scripts/service-busy.mjs "$service" || busy=$?
  systemctl --user restart "$service"
  if [[ "$busy" == 0 ]]; then
    printf 'The running service was restarted with the new installation.\n'
  elif [[ "$busy" == 1 ]]; then
    printf 'Warning: the service was still in use after 2 minutes. It was restarted anyway with the new installation, which ends any call in progress and can leave a running tool without a confirmed result.\n' >&2
  else
    printf 'Warning: it is not known whether the service was in use. It was restarted anyway with the new installation, which ends any call in progress and can leave a running tool without a confirmed result.\n' >&2
  fi
else
  systemctl --user enable --now "$service"
fi
printf 'ADE Call installed. Private configuration in %s\n' "$ADE_CALL_CONFIG"
printf 'Pair your browser with: npm run access -- pair --url URL_OF_THIS_INSTALLATION --name "My browser"\n'
printf 'Use the same ADE_CALL_CONFIG as the service. See docs/access.md.\n'
