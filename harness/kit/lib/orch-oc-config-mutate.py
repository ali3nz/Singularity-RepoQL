#!/usr/bin/env python3
"""orch-oc-config-mutate — guarded writer for OpenChamber opencode runtime config
(plugin/*, agents/* — the hot-reload-sensitive surfaces from incident 162).

Usage: echo/pipe new content | orch-oc-config-mutate <dest-file>

Behaviour:
  - If ANY OpenChamber session has an active turn (message activity within the
    last 3 min): stage the content under /var/lib/openchamber-oc-guard/pending/
    and exit 2 (deferred — NEVER hot-applied mid-turn). The pending file is
    applied by a later invocation once turns are idle (operator or the editing
    agent re-runs the same command; self-heals).
  - Otherwise: atomic write (tmp+rename, mode 0644) and exit 0.
Fail-closed: if the activity check errors, treat as active and defer.
"""
import importlib.util
import os
import sys

_spec = importlib.util.spec_from_file_location(
    "orch_session_watcher", "/usr/local/bin/orch-session-watcher.py")
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)
active_turn_exists = _mod.active_turn_exists

PENDING = "/var/lib/openchamber-oc-guard/pending"


def main():
    if len(sys.argv) != 2:
        print("usage: orch-oc-config-mutate <dest-file>", file=sys.stderr)
        return 64
    dest = os.path.abspath(sys.argv[1])
    data = sys.stdin.read()
    if active_turn_exists():
        os.makedirs(PENDING, exist_ok=True)
        staging = os.path.join(PENDING, dest.strip("/").replace("/", "__"))
        with open(staging, "w") as f:
            f.write(data)
        print(f"DEFERRED: active OpenChamber turn in progress; staged {staging} "
              f"(re-run this command once the conversation is idle to apply)", file=sys.stderr)
        return 2
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    tmp = dest + ".tmp-guarded"
    with open(tmp, "w") as f:
        f.write(data)
    os.chmod(tmp, 0o644)
    os.replace(tmp, dest)
    print(f"APPLIED {dest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
