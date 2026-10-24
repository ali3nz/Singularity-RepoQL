#!/usr/bin/env python3
"""orch_chat_office.py — pixel-office pulse emitter + label builder.

Shared by: orch-chat CLI and relay daemon. Lives next to those scripts
or is imported by tests via explicit path.

design (consult 2026-09-26T20-58-24, VERDICT CONTRADICTED→fixed):

- Label: "<Name> R<NNN> - \"<topic>\"" only when a REAL run association
  exists (explicit message metadata / originating run); "<Name> CHAT -
  \"<topic>\"" otherwise. NEVER infer the number from the ledger tail — a
  recency correlation is fabricated causality (the contradiction).
- Format reconciles the operator's "Buffy245 - \"ChatTopic\"" example with
  the live floor convention ("Buffy R014"): R prefix, 3-digit
  zero pad, ASCII hyphen. Truncation applies AFTER the prefix is built so
  the identity/run portion is never cut; the office fold caps at 40 chars.
- Pulses: one tool_start per agent per batch/cycle; session_start lazily on
  first pulse and re-primed after >30 min inactivity (the office sweeps
  characters, so a literal start-once-forever flag goes stale); no
  artificial tool_end (the office self-demotes at ~300s).
- Dedupe on discordMessageId; presentation throttle ~5s per agent; office
  state lives in its OWN file (office-state.json), fully separate from
  orch-chat delivery state; every failure is fail-open and must never
  affect message delivery.
"""
from __future__ import annotations

import json
import os
import re
import time

# Env overrides exist for the offline test battery; production uses defaults.
OFFICE_FEED = os.environ.get(
    "AGENTCHAT_OFFICE_FEED", "")
OFFICE_STATE_PATH = os.environ.get(
    "AGENTCHAT_OFFICE_STATE", "")  # resolved against STATE_DIR by callers
OFFICE_DISABLED = os.environ.get("AGENTCHAT_OFFICE_DISABLED", "") == "1"

# orch-chat identity -> pixel-agent display name.
NAMES = {
    "buffy": "Buffy",
    "claude": "Claude",
    "openchamber": "OpenChamber",
    "codex": "Codex",
}

SESSION_REPRIME_S = 1800   # re-emit session_start after 30 min without pulses
PULSE_THROTTLE_S = 5       # min seconds between pulses for the same agent
MAX_LABEL = 40             # office fold cap
SEEN_CAP = 200             # dedupe window (discord message ids)

# Optional run context on the Discord text: trailing " #r<digits>" (also
# embedded by `orch-chat send --run N`). Stripped from the delivered text.
RUN_TOKEN_RE = re.compile(r"\s*#r(\d{1,6})\s*$")

# "[orch] alpha — run 2026-09-24T01-30-17" style chat titles carry their run
# dir id; the ledger maps caseId -> runNumber.
RUN_DIR_RE = re.compile(r"\brun[ _-](\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})\b",
                        re.IGNORECASE)

# Thread starter names are "ac-<n> <topic>"; the number is the
# conversation's Discord thread id (the number the operator sees in Discord).
THREAD_NAME_RE = re.compile(r"^ac-(\d{1,6})\b")

_LEDGER_CACHE = {"path": None, "mtime": None, "map": {}}

# ---- persistent gateway characters + walks --------------------------------
# Persistent seats are OPTIONAL and configured via AGENTCHAT_OFFICE_SEATS
# (JSON list of {"sid", "label", "host"}). Default is empty: the office is
# presentational only and never blocks delivery. Each configured seat is
# always on the floor; green (working) only while an occupancy lock for its
# host is HELD in AGENTCHAT_SVC_LOCK_DIR, otherwise idle white. Every OTHER
# transient character
# (engine consult seats) is removed by the relay each poll.
def _seat_config() -> list:
    """Parse AGENTCHAT_OFFICE_SEATS defensively (fail-open: malformed -> [])."""
    raw = os.environ.get("AGENTCHAT_OFFICE_SEATS", "")
    if not raw.strip():
        return []
    try:
        seats = json.loads(raw)
    except Exception:
        return []
    if not isinstance(seats, list):
        return []
    return [s for s in seats if isinstance(s, dict) and s.get("sid")]


PERSISTENT_SOLS = _seat_config()
SVC_LOCK_DIR = os.environ.get(
    "AGENTCHAT_SVC_LOCK_DIR", "")
KEEPALIVE_S = 240  # < office 300s auto-demote; persistent chars never vanish


def sol_seat_status(host: str, now: float | None = None) -> str:
    """Green iff a gateway occupancy lock is CURRENTLY held for that host.

    Returns (status, holder): the holder is the agent/task that owns the lock,
    used for the seat's context detail. Bounded read; never raises.
    """
    now = time.time() if now is None else now
    try:
        for f in os.listdir(SVC_LOCK_DIR):
            if not f.startswith("gateway@") or not f.endswith(".json"):
                continue
            lock = json.load(open(os.path.join(SVC_LOCK_DIR, f)))
            if str(lock.get("host", "")).lower() != host:
                continue
            ttl = float(lock.get("ttl", 0) or 0)
            ts = float(lock.get("ts", 0) or 0)
            if ttl and ts and (now - ts) < ttl:
                return "working", str(lock.get("agent") or "consult")
    except Exception:
        pass
    return "idle", ""


def walk_to(from_agent: str, to_agent: str, run_number: int | None = None,
            state_dir: str | None = None, now: float | None = None) -> bool:
    """Best-effort: make one character walk to another.

    Emitted on message delivery (sender walks to the addressee) and on
    gateway resolve (agent walks to the reviewer seat it is consulting). The
    visual fold reads walk_from/walk_to and drives the sprite; unknown
    seats are ignored client-side. NEVER raises; never blocks delivery.
    """
    if OFFICE_DISABLED:
        return False
    try:
        now = time.time() if now is None else now
        feed = OFFICE_FEED
        # A bare "sol" addressee maps to whichever persistent
        # gateway seat currently holds the gateway lock (local seat if
        # neither/both), so @sol walks land on a real seat on the floor.
        if to_agent == "sol":
            dh_st, _h = sol_seat_status("local", now)
            ws_st, _h2 = sol_seat_status("ws", now)
            to_agent = "sol-local" if dh_st == "working" \
                else ("sol-ws" if ws_st == "working"
                      else "sol-local")
        ev = {"session_id": "orch-chat-%s" % from_agent, "platform": "cli",
              "ts": now, "event": "walk_to", "walk_to": "orch-chat-%s" % to_agent,
              "label": office_label(from_agent, run_number, "")}  # carries thread metadata
        with open(feed, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(ev, separators=(",", ":")) + "\n")
        return True
    except Exception:
        return False


def heartbeat_persistent_sols(state_dir: str | None = None,
                              feed_path: str | None = None,
                              now: float | None = None) -> int:
    """Emit keepalives for the two persistent gateway Sols + prune transient
    reviewer characters. Called once per relay poll; returns events written.

    Also emits walk_to from orch-chat seats currently marked as paired? No —
    walks are event-driven (see walk_to); this only maintains seats/status.
    """
    if OFFICE_DISABLED:
        return 0
    now = time.time() if now is None else now
    written = 0
    try:
        feed = feed_path or OFFICE_FEED
        sdir = state_dir or os.environ.get("AGENTCHAT_STATE_DIR",
                                           os.path.join(os.path.expanduser("~"),
                                                        ".local", "state", "orch-chat"))
        st_path = OFFICE_STATE_PATH or os.path.join(sdir, "office-state.json")
        st = _load_office_state(st_path)
        ps = st.setdefault("persistentSols", {})
        with open(feed, "a", encoding="utf-8") as fh:
            for seat in PERSISTENT_SOLS:
                status, holder = sol_seat_status(seat["host"], now)
                prev = ps.get(seat["sid"], {})
                if prev.get("status") == status and \
                        (now - float(prev.get("ts") or 0)) < KEEPALIVE_S:
                    continue
                ev = {"session_id": seat["sid"], "platform": "cli",
                      "ts": now,
                      "event": "tool_start" if status == "working" else "tool_end",
                      "tool_name": "gateway",
                      "activity": "working" if status == "working" else "idle",
                      "label": seat["label"],
                      # Who is consulting this gateway right now
                      # (surfaces in the office inspector/detail line).
                      "detail": ("in use by %s" % holder) if status == "working"
                                else "available",
                      "preview": seat["label"]}
                if not prev:
                    fh.write(json.dumps({"session_id": seat["sid"],
                                         "platform": "cli", "ts": now,
                                         "event": "session_start",
                                         "label": seat["label"]},
                                        separators=(",", ":")) + "\n")
                    written += 1
                fh.write(json.dumps(ev, separators=(",", ":")) + "\n")
                ps[seat["sid"]] = {"status": status, "ts": now}
                written += 1
        # NOTE: transient consult seats are banned FOLD-SIDE (engine-aware
        # session_start filter) — no polling race, works for every producer,
        # and codex seats (engine=codex) survive.
        st["persistentSols"] = ps
        tmp = st_path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(st, fh)
        os.replace(tmp, st_path)
    except Exception:
        return written  # fail-open
    return written


def _cli() -> int:  # pragma: no cover - operator/debug entry point
    """python3 agentchat_office.py walk <from> <to> [--run N]
    python3 agentchat_office.py heartbeat   # persistent reviewer seats"""
    import sys
    args = sys.argv[1:]
    if args and args[0] == "walk" and len(args) >= 3:
        run = None
        if "--run" in args:
            i = args.index("--run")
            run = int(args[i + 1])
        ok = walk_to(args[1], args[2], run_number=run)
        print("walk emitted" if ok else "walk suppressed")
        return 0
    if args and args[0] == "heartbeat":
        print("heartbeat events:", heartbeat_persistent_sols())
        return 0
    print(__doc__)
    return 2


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(_cli())


def extract_run(text: str) -> tuple[str, int | None]:
    """Split a trailing #r<NNN> run token off message text."""
    m = RUN_TOKEN_RE.search(text or "")
    if not m:
        return text, None
    return text[: m.start()].rstrip(), int(m.group(1))


def extract_thread(text: str) -> tuple[str, int | None]:
    """Split a leading #t<NNN> thread token off message text.

    Emitters that already know the conversation thread prepend "#t<n> " to
    the delivered text; the relay/CLI strip it and carry it as metadata so
    the floor label can show the real Discord thread number."""
    m = re.match(r"^#t(\d{1,6})\s+", text or "")
    if not m:
        return text, None
    return text[m.end():], int(m.group(1))


def office_label(name: str, run_number: int | None, topic: str,
                 thread_number: int | None = None) -> str:
    """Build the floor label. Identity+run prefix is never truncated.

    Precedence: explicit #r<NNN> run context wins ("Buffy R070"),
    else the conversation's Discord thread number ("Buffy T001"), else the
    honest CHAT fallback (thread creation failed / legacy messages)."""
    who = NAMES.get(name, name.capitalize())
    if run_number:
        slot = "R%03d" % run_number
    elif thread_number:
        slot = "T%03d" % thread_number
    else:
        slot = "CHAT"
    prefix = '%s %s - ' % (who, slot)
    body = '"%s"' % (str(topic or "").strip().replace("\n", " ") or "chat")
    room = MAX_LABEL - len(prefix)
    if room < len('"…"'):
        return prefix[:MAX_LABEL]
    if len(body) > room:
        # Keep the closing quote inside the cap: cut the text, not the quotes.
        body = body[: room - 2].rstrip() + "…\""
    return prefix + body


def ledger_run_map(ledger_path: str) -> dict:
    """caseId -> runNumber from run-ledger.jsonl run_allocated records
    (mtime-cached; the ledger is small and append-only)."""
    try:
        mt = os.path.getmtime(ledger_path)
    except OSError:
        return {}
    if (_LEDGER_CACHE["path"] == ledger_path
            and _LEDGER_CACHE["mtime"] == mt):
        return _LEDGER_CACHE["map"]
    out: dict = {}
    try:
        with open(ledger_path, "r", encoding="utf-8") as fh:
            for line in fh:
                try:
                    rec = json.loads(line)
                except Exception:
                    continue  # torn tail: skip, never fabricate
                if rec.get("event") == "run_allocated":
                    cid, n = rec.get("caseId"), rec.get("runNumber")
                    if cid is not None and isinstance(n, int):
                        out[str(cid)] = n
    except OSError:
        return {}
    _LEDGER_CACHE.update(path=ledger_path, mtime=mt, map=out)
    return out


def run_number_for_case(case_id: str, ledger_path: str) -> int | None:
    return ledger_run_map(ledger_path).get(str(case_id))


def chat_label(name: str, topic: str, ledger_path: str | None = None) -> str:
    """Label for a chat character: real run association via the run-dir id in
    the title, else honest CHAT (no fabricated number)."""
    run = None
    if ledger_path:
        m = RUN_DIR_RE.search(topic or "")
        if m:
            run = run_number_for_case(m.group(1), ledger_path)
    return office_label(name, run, topic)


def _load_office_state(path: str) -> dict:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return {"agents": {}}


def _save_office_state(path: str, st: dict) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(st, fh)
    os.replace(tmp, path)


def pulse(agent: str, topic: str, run_number: int | None = None,
          dedupe_id: str | None = None, state_dir: str | None = None,
          feed_path: str | None = None, now: float | None = None,
          thread_number: int | None = None) -> bool:
    """Emit one best-effort office pulse for an orch-chat identity.

    One call == at most one tool_start (callers deliver in batches and call
    once per agent). Returns True when a pulse was written; NEVER raises.
    """
    if OFFICE_DISABLED:
        return False
    try:
        now = time.time() if now is None else now
        feed = feed_path or OFFICE_FEED
        sdir = state_dir or os.environ.get("AGENTCHAT_STATE_DIR",
                                           os.path.join(os.path.expanduser("~"),
                                                        ".local", "state", "orch-chat"))
        st_path = OFFICE_STATE_PATH or os.path.join(sdir, "office-state.json")
        st = _load_office_state(st_path)
        a = st["agents"].setdefault(
            agent, {"lastPulse": 0.0, "lastSessionStart": 0.0, "seenIds": []})
        if dedupe_id:
            if dedupe_id in a["seenIds"]:
                return False
            a["seenIds"] = (a["seenIds"] + [dedupe_id])[-SEEN_CAP:]
        if now - float(a.get("lastPulse") or 0) < PULSE_THROTTLE_S:
            _save_office_state(st_path, st)
            return False
        # Idle ad-hoc chats do NOT get characters.
        # Only pulse when there is real recent activity (the caller passes a
        # topic from a live delivery/turn); quiet chats stay off the floor.
        # (The fold sweeps untouched chars after 300s; no idle keepalive.)
        ts = now
        sid = "orch-chat-%s" % agent
        label = office_label(agent, run_number, topic,
                             thread_number=thread_number)
        lines = []
        last_ss = float(a.get("lastSessionStart") or 0)
        if not last_ss or now - last_ss > SESSION_REPRIME_S:  # first pulse always primes
            lines.append({"session_id": sid, "platform": "cli", "ts": ts,
                          "event": "session_start", "label": label})
            a["lastSessionStart"] = now
        lines.append({"session_id": sid, "platform": "cli", "ts": ts,
                      "event": "tool_start", "tool_name": "chat",
                      "activity": "working", "label": label,
                      "preview": label})
        with open(feed, "a", encoding="utf-8") as fh:
            for ev in lines:
                fh.write(json.dumps(ev, separators=(",", ":")) + "\n")
        a["lastPulse"] = now
        _save_office_state(st_path, st)
        return True
    except Exception:
        return False  # fail-open: office is presentation, delivery is truth
