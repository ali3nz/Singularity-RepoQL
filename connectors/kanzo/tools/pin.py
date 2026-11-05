#!/usr/bin/env python3
"""Pin the files a run produced into the suite's expectations.

Run after `build_suite.py`, once the files have been read and judged by hand. It writes `pins.json`, and
`build_suite.py` merges it into the generations' `expect.paths`. A path is pinned by `sha256`, `origin` and
`modified`; the paths listed under TEXT are pinned by their whole text, which is how the suite proves that a
comment thread is complete and that a pasted credential was replaced.
"""
import json
import os
import pathlib
import shutil
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent
RQL = os.environ.get("SINGULARITY_RQL_EXE") or shutil.which("rql")

# generation index -> (generations to run, paths pinned by sha256, paths pinned by text, paths that must be absent)
SPEC = {
    0: (1, ["tasks/2.md", "tasks/141.md", "tasks/494.md", "tasks/495.md",
            "projects/fleet.md", "projects/bprobe.md", "overview.md"], [], []),
    1: (2, ["projects/fleet.md", "overview.md"], ["tasks/495.md", "tasks/496.md"], ["tasks/100.md"]),
    2: (3, ["tasks/2.md", "tasks/495.md"], [], ["tasks/494.md"]),
    7: (8, ["tasks/2.md"], ["projects/fleet.md"], []),
}


def build() -> None:
    """Write lifecycle.json from the fixtures and whatever pins.json holds now."""
    result = subprocess.run([sys.executable, str(HERE / "build_suite.py")], cwd=ROOT, capture_output=True, text=True)
    if result.returncode:
        sys.exit(f"build_suite.py failed:\n{result.stderr}")


def run(generations: int) -> dict:
    part = ROOT / f"lifecycle-part-{generations}.json"
    suite = json.loads((ROOT / "lifecycle.json").read_text())
    suite["generations"] = suite["generations"][:generations]
    part.write_text(json.dumps(suite, indent=2, ensure_ascii=False) + "\n")
    out = ROOT / f"pin-out-{generations}"
    if out.exists():
        shutil.rmtree(out)
    if not RQL:
        raise SystemExit("RepoQL rql executable not configured: set SINGULARITY_RQL_EXE")
    result = subprocess.run([RQL, "connector", "test", "connector.ts", "--fixtures", part.name,
                             "--workspace-out", out.name], cwd=ROOT, capture_output=True, text=True)
    part.unlink()
    if "FAILED" in result.stdout or result.returncode:
        sys.exit(f"the run to generation {generations} failed:\n{result.stdout[-4000:]}{result.stderr[-2000:]}")
    return {entry["path"]: entry for entry in json.loads((out / "workspace.json").read_text())["files"]}


def main() -> None:
    # Pin from a suite with no pins, so a pin this change made stale cannot stop the run it is renewed from.
    pins_file = ROOT / "pins.json"
    if pins_file.exists():
        pins_file.unlink()
    build()

    pins: dict[str, dict] = {}
    for generation, (count, hashed, verbatim, absent) in SPEC.items():
        files = run(count)
        paths: dict[str, dict] = {}
        for path in hashed:
            entry = files[path]
            paths[path] = {"sha256": entry["sha256"], "origin": entry["origin"], "modified": entry["modified"]}
        for path in verbatim:
            entry = files[path]
            paths[path] = {"text": (ROOT / f"pin-out-{count}" / "workspace" / path).read_text(),
                           "origin": entry["origin"], "modified": entry["modified"]}
        for path in absent:
            paths[path] = {"absent": True}
        pins[str(generation)] = paths
        print(f"generation {generation}: pinned {len(paths)} paths from the run to {count}")

    pins_file.write_text(json.dumps(pins, indent=2, ensure_ascii=False) + "\n")
    print("wrote pins.json")
    build()

    # The pinned texts are the proof, so the values that must not be there are checked here, once, and not by
    # accident: a secret that survived the scrubber fails this script rather than being pinned.
    text = pins["1"]["tasks/495.md"]["text"]
    for forbidden in ("Zx9Qw8Er7Ty6Ui5", "sk-live-0123456789abcdefXYZ", "ghp_0123456789abcdefghijABCDEFGHIJ012345"):
        if forbidden in text:
            sys.exit(f"tasks/495.md still holds {forbidden!r}")
    if "export KANZO_TOKEN=[redacted]" not in text or "Bearer [redacted]" not in text:
        sys.exit("tasks/495.md does not show the scrubbed credential lines")
    if "### super, 2026-10-28 11:00:00 UTC" not in text:
        sys.exit("tasks/495.md does not hold the second comment")
    print("the pinned comment text holds both comments, and no pasted credential")

    # And the suite, as finally written, must pass whole.
    if not RQL:
        raise SystemExit("RepoQL rql executable not configured: set SINGULARITY_RQL_EXE")
    result = subprocess.run([RQL, "connector", "test", "connector.ts", "--fixtures", "lifecycle.json"],
                            cwd=ROOT, capture_output=True, text=True)
    print(result.stdout.strip().splitlines()[-1] if result.stdout.strip() else result.stderr)
    if result.returncode or "Passed:" not in result.stdout:
        sys.exit(f"the suite with its pins did not pass:\n{result.stdout[-4000:][::-1]}")


if __name__ == "__main__":
    main()
