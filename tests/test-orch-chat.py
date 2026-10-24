#!/usr/bin/env python3
"""Tests for the orch-chat CLI — the Discord-free local communication path.

Five scenarios:
  1. Discord fail-open: with no bot credential configured, every Discord
     helper is inert and nothing reaches the network.
  2. State lifecycle: a cold start in an empty state directory works, and a
     local delivery is durable, id-addressed and survives the state merge.
  3. Roster integrity: the addressable role list is unique, lowercase and
     carries the documented local identities.
  4. Corrupt state is fatal: an existing unparseable state file is refused
     rather than silently replaced, and its bytes are never rewritten.
  5. Concurrent senders: parallel processes allocate unique ids, deliver every
     message and leave valid JSON behind.
  6. Dispatch gating: `dispatch-sol` validates its launcher template before any
     state is written, never marks a message launched on a dry run or a failed
     launch, and stays retryable in every failure path.
  7. At-most-once dispatch: concurrent `dispatch-sol --launch` processes for the
     same message launch it exactly once.

Run from the repository root:  python3 tests/test-orch-chat.py
"""
from __future__ import annotations

import importlib.machinery
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile

_HERE = os.path.dirname(os.path.abspath(__file__))
_SCRIPTS = os.path.abspath(os.path.join(_HERE, "..", "scripts"))
_CLI_PATH = os.path.join(_SCRIPTS, "orch-chat")

_TMP = tempfile.mkdtemp(prefix="orch-chat-cli-test-")
# The CLI and its imported modules resolve their paths at import time, so the
# overrides must be in the environment BEFORE the module is loaded.
os.environ["AGENTCHAT_STATE_DIR"] = os.path.join(_TMP, "state")
os.environ["AGENTCHAT_OFFICE_DISABLED"] = "1"
os.environ.pop("AGENTCHAT_DISCORD_ENV", None)
os.environ.pop("AGENTCHAT_SESSION", None)
os.environ.pop("AGENTCHAT_AGENT", None)

sys.path.insert(0, _SCRIPTS)


def _load_cli():
    """Import the extension-less CLI script as a module."""
    loader = importlib.machinery.SourceFileLoader("orch_chat_cli", _CLI_PATH)
    spec = importlib.util.spec_from_loader("orch_chat_cli", loader)
    module = importlib.util.module_from_spec(spec)
    sys.modules["orch_chat_cli"] = module
    loader.exec_module(module)
    return module


cli = _load_cli()


def test_discord_is_opt_in():
    """No credential file -> every Discord helper is inert, zero network."""
    assert cli.discord_enabled() is False
    assert cli.token() is None
    assert cli.api("GET", "/users/@me") == (0, {})
    assert cli.webhook_post("buffy", "must not be posted") is None

    attempted = []

    def _no_network(*args, **kwargs):
        attempted.append(args)
        raise AssertionError("network reached while Discord delivery was off")

    original = cli.urllib.request.urlopen
    cli.urllib.request.urlopen = _no_network
    try:
        assert cli.api("POST", "/channels/123/messages",
                       body={"content": "x"}) == (0, {})
    finally:
        cli.urllib.request.urlopen = original
    assert attempted == [], "no HTTP attempt expected with Discord off"
    print("  discord opt-in fail-open: OK")


def test_cold_start_and_local_delivery():
    """Empty state directory is a valid starting point for every command."""
    state_dir = os.environ["AGENTCHAT_STATE_DIR"]
    assert not os.path.exists(os.path.join(state_dir, "state.json"))

    st = cli.load_state()
    assert st["nextId"] == 1, "cold start allocates id 1"
    assert set(cli.AGENTS).issubset(set(st["agents"])), "every role starts empty"

    # main() normally creates this; the module function assumes it exists.
    os.makedirs(cli.INBOX_DIR, exist_ok=True)
    rec = cli.deliver_local(st, "buffy", None, [("claude", None)],
                            "hello from the public build", None, "agent")
    assert rec["id"] == 1
    assert rec["from"] == "buffy"
    cli.merge_save(st)

    inbox = os.path.join(cli.INBOX_DIR, "claude.jsonl")
    assert os.path.exists(inbox), "local delivery must persist to the role inbox"
    with open(inbox, "r", encoding="utf-8") as fh:
        lines = [json.loads(line) for line in fh if line.strip()]
    assert len(lines) == 1
    assert lines[0]["to"] == ["claude"]
    assert lines[0]["text"] == "hello from the public build"

    reloaded = cli.load_state()
    assert reloaded["nextId"] == 2, "allocated id must survive the merge"
    assert reloaded["agents"]["claude"]["lastDeliveredId"] == 1
    print("  cold start + local delivery: OK")


def test_roster_integrity():
    """The roster is the addressing contract; keep it clean and unique."""
    roster = cli.AGENTS
    assert roster, "roster must not be empty"
    assert len(roster) == len(set(roster)), "duplicate role in roster"
    for role in roster:
        assert isinstance(role, str) and role, "role must be a non-empty string"
        assert role == role.strip(), "role must not carry surrounding space"
        assert role == role.lower(), "roles are lowercase"
        assert "_" not in role, "roles are hyphenated single tokens"
    for required in ("buffy", "claude", "sol", "openchamber",
                     "openchamber-ws", "reviewer", "codex"):
        assert required in roster, "%s missing from roster" % required
    print("  roster integrity: OK")


def _run_cli(args, state_dir: str, extra_env=None):
    """Run the CLI as a real subprocess against an isolated state dir."""
    env = dict(os.environ)
    env["AGENTCHAT_STATE_DIR"] = state_dir
    env["AGENTCHAT_OFFICE_DISABLED"] = "1"
    env.pop("AGENTCHAT_DISCORD_ENV", None)
    env.pop("AGENTCHAT_SESSION", None)
    env.pop("AGENTCHAT_DISPATCH_CMD", None)
    for k, v in (extra_env or {}).items():
        env[k] = v
    return subprocess.run([sys.executable, _CLI_PATH] + list(args),
                          capture_output=True, text=True, env=env, timeout=60)


def test_corrupt_state_is_fatal():
    """An existing unparseable state file is refused, never replaced."""
    state_dir = os.path.join(_TMP, "corrupt-state")
    os.makedirs(state_dir, exist_ok=True)
    path = os.path.join(state_dir, "state.json")
    original = b'{"nextId": 1, "agents": {'
    with open(path, "wb") as fh:
        fh.write(original)

    # In-process: the loader must distinguish corruption from a cold start.
    saved = cli.STATE_PATH
    cli.STATE_PATH = path
    try:
        raised = False
        try:
            cli.load_state()
        except cli.StateCorruptError:
            raised = True
        assert raised, "corrupt state must raise StateCorruptError"
    finally:
        cli.STATE_PATH = saved

    # Read path refuses.
    status = _run_cli(["status"], state_dir)
    assert status.returncode != 0, "status must fail on corrupt state"
    assert "not valid JSON" in status.stderr, "failure must say why"

    # Write path refuses too: no default state may be written after a failed load.
    send = _run_cli(["send", "--from", "buffy", "@claude", "must not send"],
                    state_dir)
    assert send.returncode != 0, "send must fail on corrupt state"

    with open(path, "rb") as fh:
        assert fh.read() == original, "corrupt bytes must be preserved verbatim"
    leftovers = sorted(os.listdir(state_dir))
    assert "state.json.tmp.cli" not in leftovers, "no temp state may be left behind"
    assert "inbox" not in leftovers or not os.listdir(os.path.join(state_dir, "inbox")), \
        "a refused command must not deliver anything"
    print("  corrupt state is fatal: OK")


def test_concurrent_senders():
    """Parallel processes must not lose messages or reuse ids."""
    state_dir = os.path.join(_TMP, "concurrent-state")
    os.makedirs(state_dir, exist_ok=True)
    roles = ["buffy", "claude", "codex", "openchamber",
             "ghost", "super", "duo", "standalone"]
    env = dict(os.environ)
    env["AGENTCHAT_STATE_DIR"] = state_dir
    env["AGENTCHAT_OFFICE_DISABLED"] = "1"
    env.pop("AGENTCHAT_DISCORD_ENV", None)

    procs = [subprocess.Popen(
        [sys.executable, _CLI_PATH, "send", "--from", role, "@reviewer",
         "concurrent-%d" % i],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
        for i, role in enumerate(roles)]
    results = [p.communicate(timeout=120) for p in procs]
    for i, (proc, (_out, err)) in enumerate(zip(procs, results)):
        assert proc.returncode == 0, "sender %d failed: %s" % (i, err.strip())

    inbox = os.path.join(state_dir, "inbox", "reviewer.jsonl")
    assert os.path.exists(inbox), "every concurrent send must be delivered"
    with open(inbox, "r", encoding="utf-8") as fh:
        lines = [line for line in fh if line.strip()]
    records = []
    for line in lines:
        records.append(json.loads(line))  # every line must be valid JSON
    assert len(records) == len(roles), \
        "expected %d deliveries, got %d" % (len(roles), len(records))
    ids = [r["id"] for r in records]
    assert len(ids) == len(set(ids)), "ids must be unique under concurrency"
    texts = {r["text"] for r in records}
    assert len(texts) == len(roles), "no message may be lost or duplicated"

    with open(os.path.join(state_dir, "state.json"), "r", encoding="utf-8") as fh:
        state = json.load(fh)  # the merged state must still be valid JSON
    assert state["nextId"] > max(ids), "nextId must clear the highest allocated id"
    print("  concurrent senders: OK")


def _newest_id(state_dir: str, role: str = "sol") -> int:
    path = os.path.join(state_dir, "inbox", role + ".jsonl")
    with open(path, "r", encoding="utf-8") as fh:
        lines = [line for line in fh if line.strip()]
    return json.loads(lines[-1])["id"]


def _dispatch_status(state_dir: str, mid: int):
    with open(os.path.join(state_dir, "state.json"), "r", encoding="utf-8") as fh:
        st = json.load(fh)
    return (st.get("solDispatch") or {}).get(str(mid), {}).get("status")


def test_dispatch_gating():
    """dispatch-sol must not burn a message when it cannot launch it."""
    state_dir = os.path.join(_TMP, "dispatch-state")
    os.makedirs(state_dir, exist_ok=True)
    sent = _run_cli(["send", "--from", "buffy", "@sol", "is the lane free?"], state_dir)
    assert sent.returncode == 0, sent.stderr
    mid = _newest_id(state_dir)

    # 1. Unconfigured: exit 4, and the message is untouched.
    off = _run_cli(["dispatch-sol", str(mid)], state_dir,
                   {"AGENTCHAT_DISPATCH_CMD": ""})
    assert off.returncode == 4, "unconfigured dispatch must exit 4, got %d" % off.returncode
    assert "not configured" in off.stderr, off.stderr
    assert _dispatch_status(state_dir, mid) is None, \
        "an unconfigured dispatch must not record state"

    # 2. Template missing a placeholder: exit 4, still untouched.
    bad = _run_cli(["dispatch-sol", str(mid)], state_dir,
                   {"AGENTCHAT_DISPATCH_CMD": "true {case}"})
    assert bad.returncode == 4, "incomplete template must exit 4, got %d" % bad.returncode
    assert "{id}" in bad.stderr, bad.stderr
    assert _dispatch_status(state_dir, mid) is None, \
        "an invalid template must not record state"

    # 3. Dry run with a valid template: exit 0, prints the command, no mutation.
    dry = _run_cli(["dispatch-sol", str(mid)], state_dir,
                   {"AGENTCHAT_DISPATCH_CMD": "true {case} {id}"})
    assert dry.returncode == 0, dry.stderr
    assert "Launch with" in dry.stdout, dry.stdout
    assert _dispatch_status(state_dir, mid) is None, \
        "a dry run must not mark the message launched"

    # 4. Failed launcher: nonzero, and the message stays retryable.
    failed = _run_cli(["dispatch-sol", str(mid), "--launch"], state_dir,
                      {"AGENTCHAT_DISPATCH_CMD": "false {case} {id}"})
    assert failed.returncode != 0, "a failed launch must report failure"
    assert _dispatch_status(state_dir, mid) is None, \
        "a failed launch must leave the message retryable"

    # 5. Retry with a working launcher succeeds and records the launch.
    ok = _run_cli(["dispatch-sol", str(mid), "--launch"], state_dir,
                  {"AGENTCHAT_DISPATCH_CMD": "true {case} {id}"})
    assert ok.returncode == 0, ok.stderr
    assert _dispatch_status(state_dir, mid) == "launched", \
        "a successful launch must be recorded"

    # 6. Second launch is a no-op, not a duplicate dispatch.
    again = _run_cli(["dispatch-sol", str(mid), "--launch"], state_dir,
                     {"AGENTCHAT_DISPATCH_CMD": "true {case} {id}"})
    assert again.returncode == 0, again.stderr
    assert "already launched" in again.stdout, again.stdout
    print("  dispatch gating: OK")


def test_dispatch_is_at_most_once():
    """Concurrent dispatchers must launch one message exactly once."""
    state_dir = os.path.join(_TMP, "at-most-once")
    os.makedirs(state_dir, exist_ok=True)
    sent = _run_cli(["send", "--from", "buffy", "@sol", "dispatch me once"], state_dir)
    assert sent.returncode == 0, sent.stderr
    mid = _newest_id(state_dir)

    marker = os.path.join(state_dir, "launches.txt")
    # The launcher records every execution. The {case}/{id} placeholders are
    # required by the contract; appended after `sh -c '...'` they become $0/$1
    # and are harmless.
    template = "sh -c 'echo launched >> %s; sleep 0.4' {case} {id}" % marker
    env = dict(os.environ)
    env["AGENTCHAT_STATE_DIR"] = state_dir
    env["AGENTCHAT_OFFICE_DISABLED"] = "1"
    env["AGENTCHAT_DISPATCH_CMD"] = template
    env.pop("AGENTCHAT_DISCORD_ENV", None)
    env.pop("AGENTCHAT_SESSION", None)

    procs = [
        subprocess.Popen(
            [sys.executable, _CLI_PATH, "dispatch-sol", str(mid), "--launch"],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
        for _ in range(8)
    ]
    results = [p.communicate(timeout=120) for p in procs]
    codes = [p.returncode for p in procs]

    launches = [line for line in open(marker).read().splitlines() if line.strip()] if os.path.exists(marker) else []
    assert len(launches) == 1, "expected exactly one launch, saw %d (rc=%s)" % (len(launches), codes)
    for proc, (out, err) in zip(procs, results):
        assert proc.returncode in (0, 23), "unexpected rc %d: %s%s" % (proc.returncode, out, err)
    assert _dispatch_status(state_dir, mid) == "launched"
    print("  at-most-once dispatch: OK")


def main() -> int:
    tests = [test_discord_is_opt_in,
             test_cold_start_and_local_delivery,
             test_roster_integrity,
             test_corrupt_state_is_fatal,
             test_concurrent_senders,
             test_dispatch_gating,
             test_dispatch_is_at_most_once]
    failures = 0
    try:
        for test in tests:
            print(test.__name__)
            try:
                test()
            except Exception as exc:  # noqa: BLE001 - test runner reporting
                failures += 1
                print("    FAIL: %s: %s" % (type(exc).__name__, exc))
    finally:
        shutil.rmtree(_TMP, ignore_errors=True)
    if failures:
        print("%d test(s) failed" % failures)
        return 1
    print("all orch-chat CLI tests passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
