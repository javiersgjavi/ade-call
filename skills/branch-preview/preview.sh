#!/usr/bin/env bash
# Branch previews of ADE Call: see SKILL.md, or run `preview.sh help`.
# This wrapper finds Node 24 or later and runs preview.mts with it, one
# command that changes previews at a time.
set -euo pipefail
export CDPATH=''
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
service=${ADE_CALL_SERVICE:-ade-call.service}

node_ok() { [[ -n "$1" && -x "$1" ]] && "$1" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' 2>/dev/null; }
installed_node() {
  # ExecStart's path=..., which may contain spaces, up to " ; argv[]=".
  command -v systemctl >/dev/null || return 0
  systemctl --user show "$service" -p ExecStart --value 2>/dev/null | sed -n 's/^{ path=\(.*\) ; argv\[\]=.*/\1/p' | head -n 1
}
node=''
for candidate in "${NODE_BIN:-}" "$(command -v node || true)" "$(installed_node)"; do
  if node_ok "$candidate"; then node=$candidate; break; fi
done
[[ -n "$node" ]] || { printf 'preview: Node 24 or later was not found. Set NODE_BIN.\n' >&2; exit 1; }

case "${1:-}" in
  start | stop | link)
    # Held by flock while the command runs; -o keeps it out of the processes
    # the command starts, such as a preview's server.
    root=${ADE_CALL_PREVIEW_ROOT:-${XDG_STATE_HOME:-$HOME/.local/state}/ade-call-previews}
    mkdir -p -m 700 "$root"
    exec flock -o -w 600 -E 75 "$root/.lock" "$node" "$here/preview.mts" "$@"
    ;;
esac
exec "$node" "$here/preview.mts" "$@"
