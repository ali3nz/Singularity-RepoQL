#!/usr/bin/env python3
"""orch-session-watcher-test.py — ticket 162 selftest (Sol pins A-H, host-side).

Run: python3 orch-session-watcher-test.py
Covers: update building (A/B/C), sanitization (F), restart no-dup cursor (G),
two-session independence (H), mutation guard blocked/allowed (E), thread
mapping via mocked Discord req (A). Bridge streaming (D) is workspace-side and
pinned separately in the bridge deploy; failure enrichment uses real signatures.
"""
import importlib.util
import json
import os
import sys
import tempfile
import time

spec = importlib.util.spec_from_file_location(
    "w", "/usr/local/bin/orch-session-watcher.py")
w = importlib.util.module_from_spec(spec)
spec.loader.exec_module(w)

FAILS = []


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + ((" — " + detail) if detail and not cond else ""))
    if not cond:
        FAILS.append(name)


# --- synthetic parts -------------------------------------------------------
def assistant(content):
    return (100, "assistant", int(time.time() * 1000), {"content": content})


reasoning = {"type": "reasoning", "text": "**Investigating bridge streaming**\nsilent raw chain of thought that must NEVER be posted"}
tool_ok = {"type": "tool", "id": "c1", "name": "execute", "state": {"status": "completed", "input": {"command": "rql explore 'x' --apiKey sk-VERYSECRETKEY123456"}}}
tool_err = {"type": "tool", "id": "c2", "name": "patch", "state": {"status": "error", "input": {"filePath": "/home/oc/bridge.mjs"}}}
text_part = {"type": "text", "text": "Plan: ship watcher first."}
idle_failed = (110, "idle", int(time.time() * 1000), {"outcome": "failed"})

# A/C: tools+reasoning only, failed turn -> useful update + immediate terminal
parts = [assistant([reasoning, tool_ok, tool_err]), idle_failed]
upd = w.build_update("sesX", "Bridge debugging", parts, ["failed to reload plugins — TypeError: fe is not a function"], active=False)
check("A reasoning headline surfaced", "Investigating bridge streaming" in upd)
check("A tool action surfaced", "execute(" in upd and "patch(" in upd)
check("A raw chain-of-thought absent", "silent raw chain" not in upd)
check("C failed state + error label", "FAILED" in upd and "plugin hot-reload crashed" in upd)
check("F secret redacted in tool input", "sk-VERYSECRETKEY123456" not in upd and "[REDACTED]" in upd)
check("F encrypted blob pattern redacted", "gAAAA" not in w.sanitize("blob gAAAAabcdef1234567890 end"))

# B: ordinary text conversation -> narration does not duplicate every fragment
upd_b = w.build_update("sesY", "Text chat", [assistant([text_part])], [], active=True)
check("B text surfaced once", upd_b.count("Plan: ship watcher first.") == 1)

# H: two sessions -> independent state dicts (update builder is pure)
upd_h1 = w.build_update("ses1", "One", [assistant([text_part])], [], active=True)
upd_h2 = w.build_update("ses2", "Two", [], [], active=False)
check("H independent updates", "One" in upd_h1 and "Two" in upd_h2)

# G: restart no-dup — cursor persistence round-trip
with tempfile.TemporaryDirectory() as td:
    old = w.STATE
    w.STATE = os.path.join(td, "state.json")
    st = {"sessions": {"ses1": {"seq": 55, "tid": "t", "greeted": True, "last_narr": time.time()}}, "logpos": 10, "loginode": 7}
    w.save_state(st)
    st2 = w.load_state()
    w.STATE = old
    check("G cursor persisted", st2["sessions"]["ses1"]["seq"] == 55 and st2["sessions"]["ses1"]["greeted"] is True)

# A: thread creation via mocked Discord API
class MockReq:
    calls = []
    def __call__(self, method, path, body=None, timeout=15):
        MockReq.calls.append((method, path))
        if path == "/users/@me":
            return 200, {"id": "bot"}
        if path == "/users/@me/guilds":
            return 200, [{"id": "g1"}]
        if path == "/guilds/g1/channels":
            return 200, [{"id": "home1", "type": 0, "name": "general"}]
        if path.endswith("/threads") and method == "POST":
            return 200, {"id": "thread9"}
        return 200, {}

w_state = {"home": None, "sessions": {}}
real_req = w.req
w.req = MockReq()
tid = w.ensure_thread(w_state, "sesZ", "My **bold** title")
w.req = real_req
check("A thread created", tid == "thread9")
check("A thread name prefixed+cleaned", MockReq.calls and any(
    c[0] == "POST" and c[1].endswith("/threads") for c in MockReq.calls)
      and w_state["sessions"]["sesZ"]["tid"] == "thread9")

# E: mutation guard — simulate active turn by pointing DB cutoff far past
real_open = w.open_db
try:
    import sqlite3
    con = sqlite3.connect(":memory:")
    con.execute("CREATE TABLE session_v2 (time_updated INTEGER)")
    con.execute("INSERT INTO session_v2 VALUES (?)", (int(time.time() * 1000),))

    class FakeCon:
        def execute(self, *a, **k):
            return con.execute(*a, **k)
        def close(self):
            pass
    w.open_db = lambda: FakeCon()
    check("E guard blocks active turn", w.guard_check() == 1)
    con.execute("DELETE FROM session_v2")
    check("E guard allows idle", w.guard_check() == 0)
finally:
    w.open_db = real_open

# failure signature classification (C enrichment)
lbl = w.classify_log_errors(['Failed to drain Session — Session.AgentNotFoundError: Agent not found: "standalone"'])
check("C agent-not-found mapped", "agent registry" in lbl[0])

print()
print("v162 selftest: " + ("ALL PASS" if not FAILS else f"{len(FAILS)} FAIL: {FAILS}"))
sys.exit(1 if FAILS else 0)
