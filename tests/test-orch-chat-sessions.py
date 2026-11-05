#!/usr/bin/env python3
"""Tests for orch_chat_sessions — the multi-session registry module.

Covers five scenarios:
  1. Registry lifecycle: register a session, persist, reload, verify.
  2. Delivery ownership: deliver a message and confirm it lands in the
     correct session mailbox only.
  3. Session addressing: valid_sid / new_sid round-trip.
  4. CLOSED deadletter: closed sessions cannot be re-registered without
     explicit resume, and are not eligible for delivery.
  5. Corrupt registry is fatal: an existing unparseable sessions.json is
     refused by `register` rather than replaced with an empty registry.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile

# Ensure AGENTCHAT_STATE_DIR is set to a temp dir BEFORE importing the module,
# because STATE_DIR is computed at import time.
_TMPDIR = tempfile.mkdtemp(prefix="orch-chat-test-")
os.environ["AGENTCHAT_STATE_DIR"] = _TMPDIR

# Make scripts/ importable
_SCRIPTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scripts")
sys.path.insert(0, os.path.abspath(_SCRIPTS))

import orch_chat_sessions as acs  # noqa: E402


def _fresh_data() -> dict:
    return {"sessions": {}, "cursors": {}}


def test_registry_lifecycle():
    """register -> save_sessions -> load_sessions round-trips a session."""
    data = _fresh_data()
    rec = acs.register(data, role="buffy", now=1700000000.0)
    assert rec["role"] == "buffy"
    assert rec["state"] == "ACTIVE"
    assert acs.valid_sid(rec["sid"])
    acs.save_sessions(data)
    loaded = acs.load_sessions()
    sid = rec["sid"]
    assert sid in loaded["sessions"]
    assert loaded["sessions"][sid]["role"] == "buffy"
    assert loaded["sessions"][sid]["state"] == "ACTIVE"
    print("  registry lifecycle: OK")


def test_delivery_ownership():
    """deliver_to_session writes to exactly one session mailbox."""
    data = _fresh_data()
    rec_a = acs.register(data, role="buffy", now=1700000000.0)
    rec_b = acs.register(data, role="buffy", now=1700000000.0)
    sid_a, sid_b = rec_a["sid"], rec_b["sid"]
    msg = {"id": 1, "from": "claude", "text": "ping"}
    acs.deliver_to_session(sid_a, msg)
    records_a = acs.session_records(sid_a)
    records_b = acs.session_records(sid_b)
    assert len(records_a) == 1
    assert len(records_b) == 0
    assert records_a[0]["from"] == "claude"
    assert records_a[0]["text"] == "ping"
    unread_a = acs.session_unread(data, sid_a)
    unread_b = acs.session_unread(data, sid_b)
    assert len(unread_a) == 1
    assert len(unread_b) == 0
    acs.advance_cursor(data, sid_a, 1)
    assert len(acs.session_unread(data, sid_a)) == 0
    print("  delivery ownership: OK")


def test_session_addressing():
    """valid_sid accepts the canonical format and rejects garbage."""
    sid = acs.new_sid()
    assert sid.startswith("ses-")
    assert acs.valid_sid(sid)
    assert acs.valid_sid("ses-aaaaaa-1234")
    assert not acs.valid_sid("ses-ab"), "suffix shorter than 4 chars is invalid"
    assert not acs.valid_sid("ses-" + "a" * 49), "suffix longer than 48 chars is invalid"
    assert not acs.valid_sid("ses-ABCDEF"), "uppercase is invalid"
    assert not acs.valid_sid("not-a-sid"), "prefix is mandatory"
    assert not acs.valid_sid("")
    print("  session addressing: OK")


def test_closed_deadletter():
    """A CLOSED session cannot be silently re-registered and is not active."""
    data = _fresh_data()
    rec = acs.register(data, role="buffy", now=1700000000.0)
    sid = rec["sid"]
    assert acs.is_active(rec) is True
    assert acs.close(data, sid, now=1700000001.0) is True
    closed_rec = acs.get(data["sessions"], sid)
    assert closed_rec["state"] == "CLOSED"
    assert acs.is_active(closed_rec) is False
    raised = False
    try:
        acs.register(data, role="buffy", sid=sid, now=1700000002.0)
    except acs.SessionClosedError:
        raised = True
    assert raised, "register on CLOSED sid must raise SessionClosedError"
    reopened = acs.register(data, role="buffy", sid=sid,
                            now=1700000003.0, resume=True)
    assert reopened["state"] == "ACTIVE"
    assert acs.is_active(acs.get(data["sessions"], sid)) is True
    # A reopened session is ACTIVE again, so it can be closed a second time;
    # closing an already-CLOSED session is a no-op.
    assert acs.close(data, sid, now=1700000004.0) is True
    assert acs.close(data, sid, now=1700000005.0) is False
    print("  CLOSED deadletter: OK")


def test_corrupt_registry_is_fatal():
    """A corrupt sessions.json must never be replaced by an empty registry.

    `register` loads the registry and then persists it, so a silent empty
    default would destroy durable session identity and read cursors.
    """
    cli = os.path.join(os.path.abspath(_SCRIPTS), "orch-chat")
    state_dir = tempfile.mkdtemp(prefix="orch-chat-registry-test-")
    try:
        path = os.path.join(state_dir, "sessions.json")
        original = b'{"sessions": {"ses-abc"'
        with open(path, "wb") as fh:
            fh.write(original)

        # In-process: the loader must distinguish corruption from first run.
        saved = acs.SESSIONS_PATH
        acs.SESSIONS_PATH = path
        try:
            raised = False
            try:
                acs.load_sessions()
            except acs.SessionsCorruptError:
                raised = True
            assert raised, "corrupt registry must raise SessionsCorruptError"
        finally:
            acs.SESSIONS_PATH = saved

        env = dict(os.environ)
        env["AGENTCHAT_STATE_DIR"] = state_dir
        env["AGENTCHAT_OFFICE_DISABLED"] = "1"
        env.pop("AGENTCHAT_DISCORD_ENV", None)
        env.pop("AGENTCHAT_SESSION", None)
        proc = subprocess.run([sys.executable, cli, "register", "--from", "buffy"],
                              capture_output=True, text=True, env=env, timeout=60)
        assert proc.returncode != 0, "register must fail on a corrupt registry"
        assert "not valid JSON" in proc.stderr, "failure must say why"

        with open(path, "rb") as fh:
            assert fh.read() == original, "corrupt bytes must be preserved verbatim"
        assert not os.path.exists(path + ".tmp"), "no replacement write may occur"
    finally:
        shutil.rmtree(state_dir, ignore_errors=True)
    print("  corrupt registry is fatal: OK")


def main():
    print("Running orch_chat_sessions tests...")
    test_registry_lifecycle()
    test_delivery_ownership()
    test_session_addressing()
    test_closed_deadletter()
    test_corrupt_registry_is_fatal()
    print("All orch_chat_sessions tests passed.")


if __name__ == "__main__":
    main()
