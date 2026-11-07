"""Windowless Task Scheduler entrypoint for project-owned Python services.

Run this with the matching pythonw.exe, never python.exe. Explicit private file
logs keep errors observable even when no console stream exists. No shell or
network fallback is used. The task owner selects the real entrypoint and args.
"""
from __future__ import annotations

import os
from pathlib import Path
import runpy
import sys


def validate(log_name: str, script_name: str) -> tuple[Path, Path]:
    log, script = Path(log_name), Path(script_name)
    if not log.is_absolute() or not script.is_absolute():
        raise ValueError("SILENT_HOST_ABSOLUTE_PATHS_REQUIRED")
    local = os.environ.get("LOCALAPPDATA", "")
    if os.name == "nt" and (not local or not os.path.normcase(str(log.resolve(strict=False))).startswith(
            os.path.normcase(str((Path(local) / "Singularity").resolve(strict=False))) + os.sep)):
        raise ValueError("SILENT_HOST_PRIVATE_LOG_REQUIRED")
    if not log.parent.is_dir() or not script.is_file():
        raise ValueError("SILENT_HOST_DEPENDENCY_MISSING")
    if log.is_symlink() or script.is_symlink():
        raise ValueError("SILENT_HOST_SYMLINK_REFUSED")
    return log, script


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) < 4 or args[0] != "--log" or args[2] != "--":
        return 2
    try:
        log, script = validate(args[1], args[3])
    except (ValueError, OSError):
        return 2
    # Logs are private because the task registration has already restricted the
    # parent directory ACL. Bound the last-run log and preserve one older copy.
    try:
        if log.exists() and log.stat().st_size > 4 * 1024 * 1024:
            log.replace(log.with_suffix(log.suffix + ".previous"))
        with log.open("a", encoding="utf-8", buffering=1) as output:
            sys.stdout = sys.stderr = output
            sys.argv = [str(script), *args[4:]]
            sys.path.insert(0, str(script.parent))
            try:
                runpy.run_path(str(script), run_name="__main__")
            except SystemExit as exc:
                if exc.code is None:
                    return 0
                if isinstance(exc.code, int):
                    return exc.code
                print("SILENT_HOST_EXIT_ERROR")
                return 1
            except BaseException:
                # No pop-up or dialog on pythonw.exe; redact exception details
                # from the user-facing task status while keeping a traceback
                # in the existing private operational log.
                import traceback
                traceback.print_exc()
                return 1
        return 0
    except OSError:
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
