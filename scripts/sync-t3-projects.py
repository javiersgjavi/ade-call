#!/usr/bin/env python3
"""Register immediate project folders through T3's CLI; never edit its database."""

import fcntl
import os
import shutil
import sqlite3
import subprocess
from pathlib import Path


def missing_projects(root, database):
    # Include archived/deleted registrations: an explicit removal must not be undone.
    with sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True, timeout=5) as db:
        known = {
            Path(row[0]).resolve()
            for row in db.execute("SELECT workspace_root FROM projection_projects")
            if row[0]
        }
    return sorted(
        p
        for p in root.iterdir()
        if not p.name.startswith(".")
        and not p.is_symlink()
        and p.is_dir()
        and p.resolve() not in known
    )


def sync(root, base, binary, run=subprocess.run):
    failures = 0
    for path in missing_projects(root, base / "userdata/statev2.sqlite"):
        try:
            result = run(
                [
                    str(binary),
                    "project",
                    "add",
                    str(path.resolve()),
                    "--title",
                    path.name,
                    "--base-dir",
                    str(base),
                ],
                capture_output=True,
                text=True,
                timeout=60,
            )
            if result.returncode:
                print(
                    f"Could not register {path.name!r} (exit {result.returncode}); retry next scan.",
                    flush=True,
                )
                failures += 1
            else:
                print(f"Registered {path.name!r}", flush=True)
        except (OSError, subprocess.TimeoutExpired) as exc:
            print(
                f"Could not register {path.name!r}: {type(exc).__name__}; retry next scan.",
                flush=True,
            )
            failures += 1
    return failures


def main():
    home = Path.home()
    root = Path(os.environ.get("T3_PROJECTS_ROOT", str(home / "Projects"))).expanduser().resolve()
    base = Path(os.environ.get("T3CODE_HOME", str(home / ".t3"))).expanduser().resolve()
    binary = Path(
        os.environ.get(
            "T3_BIN",
            str(home / ".local/bin/t3")
            if (home / ".local/bin/t3").exists()
            else (shutil.which("t3") or "t3"),
        )
    ).expanduser()
    state = home / ".local/state/t3-project-sync"
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (state / "lock").open("w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 0
        return 1 if sync(root, base, binary) else 0


if __name__ == "__main__":
    raise SystemExit(main())
