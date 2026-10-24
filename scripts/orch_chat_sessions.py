#!/usr/bin/env python3
"""orch_chat_sessions.py — orch-chat multi-session registry (Phase C).

Operator directive 2026-10-23 §16-§17: true concurrent per-session comm with
legacy role inboxes intact. reviewer design review (consult 2026-10-23T02-37-35,
CONDITIONAL APPROVAL) set the delivery OWNERSHIP contract implemented here:

  - Explicit session addressing (`@role#ses-x`) delivers ONLY to that
    session's mailbox. Never a second independently actionable copy in the
    role inbox (correction #1).
  - Role-only addressing (`@role`) keeps ONE actionable destination: the role
    mailbox, exactly as today. Messages get `sessionHints` +, when the role
    has multiple active sessions, `ambiguous: AMBIGUOUS_TARGET` so senders
    know to address explicitly (never random selection).
  - Closed sessions are never rerouted: explicit delivery to a CLOSED session
    is deadlettered `target_closed` (no silent role fallback).
  - Session metadata lives HERE (sessions.json), never in state.json (reviewer
    correction #4). All writes take the SAME state.lock the relay/CLI use.

Storage layout (all under AGENTCHAT_STATE_DIR):
  sessions.json            registry + per-session read cursors (atomic)
  inbox-sessions/<sid>.jsonl   per-session durable mailboxes (apppend-only)

Registry record: {sid, role, parentRun, surface, createdAt, lastSeenAt, state}
 SID format: `ses-<base32 epoch>-<4 hex>` or caller-supplied `ses-[a-z0-9-]{4,48}`.
 States: ACTIVE (created/renewed), CLOSED (terminal — no reroute, no delivery).

Heartbeat: `touch()` calls on register/inbox/peek/send ops; presence fold
uses ACTIVE+freshest-lastSeen for display only. Delivery eligibility uses
state only (an idle-but-ACTIVE session mailbox keeps receiving mail, as the
directive requires: IDLE-but-resumable preserves messages until resumed).

This module must stay stdlib-only and importable by BOTH /usr/local/bin/
orch-chat and orch-chat-relay.py without executing a main()."""
from __future__ import annotations

import json
import os
import secrets
import time

# Env override exists for the offline synthetic suite; production is default.
STATE_DIR = os.environ.get("AGENTCHAT_STATE_DIR",
    os.path.join(os.path.expanduser("~"), ".local", "state", "orch-chat"))
SESSIONS_PATH = os.path.join(STATE_DIR, "sessions.json")
SESSION_INBOX_DIR = os.path.join(STATE_DIR, "inbox-sessions")

SSID_CHARS = "abcdefghijklmnopqrstuvwxyz234567"  # base32, no confusing chars

SID_RE = r"ses-[a-z0-9-]{4,48}"
SID_COMPILE = None  # compiled lazily via _sid_re()


def _sid_re():
    global SID_COMPILE
    if SID_COMPILE is None:
        import re
        SID_COMPILE = re.compile("^" + SID_RE + "$")
    return SID_COMPILE


def valid_sid(sid: str) -> bool:
    return bool(sid) and bool(_sid_re().match(sid))


def new_sid() -> str:
    """ses-<base32 wall clock, 7 chars, ~13.9yr span>-<4 hex entropy>."""
    now = int(time.time())
    t = ""
    for _ in range(7):
        t += SSID_CHARS[now % 32]
        now //= 32
    return "ses-%s-%s" % (t, secrets.token_hex(2))


class SessionsCorruptError(RuntimeError):
    """An EXISTING sessions.json cannot be read or parsed.

    A missing registry is a legitimate first run and is created on demand. An
    existing-but-unreadable one is NOT: callers such as `register` persist the
    dict they just loaded, so silently substituting an empty registry would
    overwrite durable session identity, delivery ownership and read cursors.
    The original bytes are never touched on this path.
    """


def load_sessions() -> dict:
    try:
        with open(SESSIONS_PATH, "r", encoding="utf-8") as fh:
            raw = fh.read()
    except FileNotFoundError:
        data = {}
    except OSError as exc:
        raise SessionsCorruptError(
            "cannot read %s (%s) - refusing to continue or overwrite; "
            "inspect the file, then repair it or move it aside" % (SESSIONS_PATH, exc))
    else:
        try:
            data = json.loads(raw)
        except ValueError as exc:
            raise SessionsCorruptError(
                "%s is not valid JSON (%s) - refusing to overwrite it; "
                "inspect the file, then repair it or move it aside"
                % (SESSIONS_PATH, exc))
        if not isinstance(data, dict):
            raise SessionsCorruptError(
                "%s does not contain a JSON object - refusing to overwrite it"
                % SESSIONS_PATH)
    data.setdefault("sessions", {})
    data.setdefault("cursors", {})
    return data


def save_sessions(data: dict) -> None:
    os.makedirs(STATE_DIR, exist_ok=True)
    tmp = SESSIONS_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=1, sort_keys=True)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, SESSIONS_PATH)


class SessionClosedError(ValueError):
    """Registering a CLOSED sid without an explicit resume is refused (P0
    §4.7): a closed session is terminal, so a stale writer/restarting harness
    can never silently reactivate it and start draining mail addressed there."""


def register(data: dict, role: str, sid: str | None = None,
             parent_run: str | None = None, surface: str | None = None,
             now: float | None = None, resume: bool = False) -> dict:
    """Create or renew a session binding. Caller holds the state flock.

    P0 §4.7: an existing CLOSED sid is terminal. `register` raises
    SessionClosedError unless the caller explicitly passes resume=True (the
    authorised `orch-chat register --resume` path), which records the reopen in
    the registry instead of silently flipping state back to ACTIVE.
    """
    now = now if now is not None else time.time()
    sessions = data.setdefault("sessions", {})
    sid = sid or new_sid()
    if not valid_sid(sid):
        raise ValueError("invalid sid '%s' (want %s)" % (sid, SID_RE))
    rec = sessions.get(sid) or {}
    if rec.get("state") == "CLOSED" and not resume:
        raise SessionClosedError(
            "session '%s' is CLOSED (closed %s) — re-register with --resume to reopen"
            % (sid, rec.get("closedAt") or "previously"))
    if rec.get("state") == "CLOSED" and resume:
        rec["resumedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now))
        rec["resumeCount"] = int(rec.get("resumeCount") or 0) + 1
    rec.update({
        "sid": sid,
        "role": role,
        "parentRun": parent_run if parent_run is not None else rec.get("parentRun"),
        "surface": surface if surface is not None else rec.get("surface"),
        "createdAt": rec.get("createdAt") or time.strftime(
            "%Y-%m-%dT%H:%M:%SZ", time.gmtime(now)),
        "lastSeenAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now)),
        "lastSeenEpoch": float(now),
        "state": "ACTIVE",
    })
    sessions[sid] = rec
    return dict(rec)


def get(sessions: dict, sid: str) -> dict | None:
    return sessions.get(sid)


def is_active(rec: dict | None) -> bool:
    """ACTIVE = deliverable + reply-eligible. CLOSED is terminal."""
    return bool(rec) and rec.get("state") == "ACTIVE"


def active_sessions_for_role(data: dict, role: str) -> list[str]:
    """ACTIVE session ids for a role (heartbeat freshness NOT required)."""
    return sorted(s.get("sid") for s in data.get("sessions", {}).values()
                  if s.get("role") == role and s.get("state") == "ACTIVE")


def close(data: dict, sid: str, now: float | None = None) -> bool:
    """Terminal close. Messages in a closed session's mailbox stay durable;
    it just stops receiving new mail (closed targets deadletter)."""
    rec = data.get("sessions", {}).get(sid)
    if not rec or rec.get("state") == "CLOSED":
        return False
    rec["state"] = "CLOSED"
    rec["closedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now))
    return True


def touch(data: dict, sid: str, now: float | None = None) -> None:
    rec = data.get("sessions", {}).get(sid)
    if rec and rec.get("state") == "ACTIVE":
        now = now if now is not None else time.time()
        rec["lastSeenAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now))
        rec["lastSeenEpoch"] = float(now)


# --- delivery (session mailboxes) -------------------------------------------

def session_inbox_path(sid: str) -> str:
    return os.path.join(SESSION_INBOX_DIR, sid + ".jsonl")


def deliver_to_session(sid: str, rec: dict) -> None:
    """Append one record to the session mailbox. Caller holds state.lock."""
    os.makedirs(SESSION_INBOX_DIR, exist_ok=True)
    with open(session_inbox_path(sid), "a", encoding="utf-8") as fh:
        fh.write(json.dumps(rec, sort_keys=True) + "\n")
        fh.flush()
        os.fsync(fh.fileno())


def session_records(sid: str) -> list[dict]:
    out = []
    try:
        with open(session_inbox_path(sid), "r", encoding="utf-8") as fh:
            for line in fh:
                s = line.strip()
                if s:
                    try:
                        out.append(json.loads(s))
                    except Exception:
                        continue
    except FileNotFoundError:
        pass
    return out


def session_unread(data: dict, sid: str) -> list[dict]:
    cursors = data.setdefault("cursors", {})
    try:
        last = int(cursors.get(sid) or 0)
    except Exception:
        last = 0
    return [r for r in session_records(sid) if int(r.get("id") or 0) > last]


def advance_cursor(data: dict, sid: str, last_id: int) -> None:
    cursors = data.setdefault("cursors", {})
    cursors[sid] = max(int(cursors.get(sid) or 0), int(last_id))


def unread_count_for_role(data: dict, role: str) -> dict:
    """{sid: unreadCount} — used by presence/registry listings."""
    out = {}
    for sid in active_sessions_for_role(data, role) + \
            sorted(s["sid"] for s in data.get("sessions", {}).values()
                   if s.get("role") == role and s.get("state") == "CLOSED"):
        out[sid] = len(session_unread(data, sid))
    return out


# --- conversation identity (correction #3: durable conversation ids) ----

def conv_key(from_role: str, tos: list[str],
             from_sid: str | None = None,
             to_sessions: dict[str, str | None] | None = None) -> str:
    """Direction-independent conversation key.

    Legacy conversations (no session identity anywhere) keep EXACTLY today's
    key: sorted participant role set — old threads/convs registry entries stay
    valid. Sessions create a distinct key: role set + '/' + sane-sorted sid
    set (own + explicit targets). buffy#s1<->claude and buffy#s2<->claude are
    separate threads (directive case E); reply re-derivation recomputes the
    same key from the record."""
    sids = set()
    if from_sid:
        sids.add(from_sid)
    to_sessions = to_sessions or {}
    for role, sid in to_sessions.items():
        if sid:
            sids.add(sid)
    if not sids:
        return ",".join(sorted(set([from_role] + list(tos))))
    return ",".join(sorted(set([from_role] + list(tos)))) + "/" + "/".join(sorted(sids))
