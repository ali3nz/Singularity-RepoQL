#!/usr/bin/env python3
"""Bounded session-close lesson capture (agent-run helper; zero model calls here).

Workflow (docs/memory-capture-promotion.md):
  1. after a completed session or review, distill ONE durable lesson
  2. propose:  python3 scripts/memory_turn_capture.py propose --lesson-file notes.md
  3. run the ONE bounded model pass to phrase it, then capture on one surface:
     `rql concept add ...` (code lessons) or
     `scripts/knowledge-promotion.py --propose ...` (operator decisions)
  4. confirm:  python3 scripts/memory_turn_capture.py confirm --file <pending path>

Caps: lesson input <= 8000 chars; at most 3 confirmed captures per rolling 24h;
one lesson per capture. Deferred candidates stay on disk or in the printed
output, never discarded. The memory plugin remains the only automatic capture
writer.

Exit codes: 0 ok, 2 usage, 3 input too large, 4 rql pre-check failed,
5 cap exceeded (deferred), 6 state error.
"""
import argparse
import json
import pathlib
import random
import string
import subprocess
import sys
import time

MAX_INPUT_CHARS = 8000
CAP_24H = 3
DAY = 24 * 3600


def load_state(path):
    if not path.exists():
        return {"confirmed": [], "lastRunTs": 0}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        print("state error in", path, ":", exc)
        sys.exit(6)


def save_state(path, state):
    state["lastRunTs"] = int(time.time())
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")


def latest_window(entries):
    cut = time.time() - DAY
    return [e for e in entries if e.get("ts", 0) >= cut]


def slugify(text):
    words = "".join(ch if ch.isalnum() else " " for ch in text.lower()).split()
    return ("-".join(words[:8]) or "lesson")[:64]


def print_deferral(reason, lesson):
    print("DEFERRED (" + reason + "): full skeleton below - keep it in the session transcript, nothing is discarded")
    print(lesson)


def cmd_propose(args):
    lesson = (
        sys.stdin.read()
        if args.lesson_file == "-"
        else pathlib.Path(args.lesson_file).read_text(encoding="utf-8", errors="replace")
    ).strip()
    if not lesson:
        print("empty lesson input; nothing to propose")
        sys.exit(2)
    if len(lesson) > MAX_INPUT_CHARS:
        print(
            "REFUSED: lesson input is",
            len(lesson),
            "chars; cap is",
            MAX_INPUT_CHARS,
            "(trim or split; zero model calls were spent)",
        )
        sys.exit(3)

    state_dir = pathlib.Path(args.state_dir)
    state_dir.mkdir(parents=True, exist_ok=True)
    state_path = state_dir / "state.json"
    state = load_state(state_path)

    pending = state_dir / "pending"
    if pending.exists():
        recent = [f for f in pending.glob("*.md") if time.time() - f.stat().st_mtime < DAY]
        if len(recent) >= CAP_24H:
            print_deferral(str(len(recent)) + " pending lessons queued in the last 24h", lesson)
            sys.exit(5)

    confirmed = latest_window(state.get("confirmed", []))
    if len(confirmed) >= CAP_24H:
        print_deferral(str(len(confirmed)) + " confirmed captures in the last 24h", lesson)
        sys.exit(5)

    if not args.skip_rql:
        try:
            probe = subprocess.run(
                ["rql", "explore", lesson[:120], "--uri-glob", "**", "--token-budget", "600"],
                capture_output=True,
                text=True,
                timeout=60,
            )
        except subprocess.TimeoutExpired:
            print(
                "REFUSED: rql pre-check did not finish within 60s (timeout). "
                "Nothing written; retry with --skip-rql and label the capture unverified-dedup."
            )
            sys.exit(4)
        if probe.returncode != 0:
            print(
                "REFUSED: rql pre-check failed (rc",
                probe.returncode,
                "). rql must be runnable - see docs/REPOQL-SETUP.md. Nothing written.",
            )
            sys.exit(4)
        top = "\n".join(probe.stdout.splitlines()[:12])
        print("DEDUP-PREVIEW (rql explore top hits):")
        print(top if top.strip() else "(no prior capsule matched)")
    else:
        print("SKIP-RQL: dedup preview unavailable this run; label the capture as unverified-dedup")

    ts = int(time.time())
    nonce = "".join(random.choice(string.ascii_lowercase) for _ in range(4))
    slug = slugify(lesson.splitlines()[0])
    pending.mkdir(parents=True, exist_ok=True)
    rel = pending / (str(ts) + "-" + nonce + "-" + slug + ".md")
    rel.write_text(
        "# pending lesson (self-learning loop; unconfirmed)\n"
        "- proposed at: " + time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts)) + "\n"
        "- capture surfaces: `rql concept add` (code lesson) or "
        "`scripts/knowledge-promotion.py --propose` (operator decision)\n"
        "- after capture run: python3 scripts/memory_turn_capture.py confirm --file "
        + str(rel)
        + "\n\n"
        + lesson
        + "\n",
        encoding="utf-8",
    )
    save_state(state_path, state)
    print("PENDING WRITTEN:", rel)
    print("NEXT: one bounded model pass, capture through one gated surface, then confirm")
    print("cap left this window:", CAP_24H - len(confirmed))
    sys.exit(0)


def cmd_confirm(args):
    target = pathlib.Path(args.file)
    if not target.is_file():
        print("unknown pending file:", target)
        sys.exit(2)
    state_dir = pathlib.Path(args.state_dir)
    state_path = state_dir / "state.json"
    state = load_state(state_path)
    confirmed = latest_window(state.get("confirmed", []))
    if len(confirmed) >= CAP_24H:
        print("DEFERRED (cap): the 24h window is full; the pending file stays in place (nothing discarded)")
        sys.exit(5)
    confirmed_dir = state_dir / "confirmed"
    confirmed_dir.mkdir(parents=True, exist_ok=True)
    final = confirmed_dir / target.name
    target.rename(final)
    state["confirmed"] = confirmed + [{"ts": int(time.time()), "file": final.as_posix()}]
    save_state(state_path, state)
    print("CONFIRMED:", final)
    print("cap left this window:", CAP_24H - len(latest_window(state["confirmed"])))
    sys.exit(0)


def cmd_status(args):
    state = load_state(pathlib.Path(args.state_dir) / "state.json")
    confirmed = latest_window(state.get("confirmed", []))
    print("confirmed captures in last 24h:", len(confirmed), "/", CAP_24H)
    for e in confirmed:
        print("  -", time.strftime("%H:%MZ", time.gmtime(e["ts"])), e["file"])
    sys.exit(0)


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("propose", help="check caps + dedup, write a pending scaffold")
    p.add_argument("--lesson-file", required=True, help="distilled lesson text; - reads stdin")
    p.add_argument("--state-dir", default="data/selflearn")
    p.add_argument(
        "--skip-rql", action="store_true",
        help="skip the RepoQL dedup preview (result is labelled unverified-dedup)",
    )

    c = sub.add_parser("confirm", help="record a captured lesson against the 24h cap")
    c.add_argument("--file", required=True)
    c.add_argument("--state-dir", default="data/selflearn")

    st = sub.add_parser("status", help="print this window's usage")
    st.add_argument("--state-dir", default="data/selflearn")

    args = ap.parse_args()
    if args.cmd == "propose":
        cmd_propose(args)
    elif args.cmd == "confirm":
        cmd_confirm(args)
    else:
        cmd_status(args)


if __name__ == "__main__":
    main()
