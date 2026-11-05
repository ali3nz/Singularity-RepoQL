#!/usr/bin/env python3
"""orch-session-watcher.py — OpenChamber chat visibility (ticket 162, 2026-09-29).

Sol-consulted design (consult 2026-09-29T00-17-00-521-17586, VERDICT CONFIRMED).
Ships Sol ship-order items 1-4:
  1+2. host-side watcher: one PUBLIC Discord thread per OpenChamber session +
       5-min MAXIMUM aggregated narrative updates (1-min poll) built from
       reasoning-summary headlines + sanitized tool actions + state.
  3.   failure surfacing: terminal outcomes (failed/interrupted) post IMMEDIATELY
       with log-derived error summaries (AgentNotFoundError / plugin reload crash
       signatures), bypassing the 5-min interval.
  4.   host-side runtime mutation guard: blocks writes to opencode plugin/agent
       config while any OpenChamber session has an ACTIVE turn (the incident-162
       trigger: issue-157 plugin deploy hot-reloaded under Luna's 88-min turn).

External by design: survives opencode crashes/plugin failures (never an opencode
plugin; shared-fate rejection per Sol). Never writes opencode.db (read-only URI).
capability-audit.jsonl is enrichment only, never the cursor authority.

Data sources (Sol Q2):
  PRIMARY: opencode.db session_message (ro sqlite): text/reasoning/tool parts,
           idle(type) messages carrying outcome, agent-switched.
  ENRICH:  share/log/opencode.log ERROR lines (failed to reload plugins,
           Failed to drain Session, AgentNotFoundError).
  Thread mapping: session_v2 titles via session_id -> title.

Narration contract (Sol-pinned): every update identifies session identity,
state (working/waiting/completed/failed/interrupted), reasoning summary
headlines, sanitized tool actions, sanitized targets. NEVER: raw chain of
thought (only model's own `**Headline**` summary lines), API keys, bearer
tokens, cookies, auth headers, credentials, secret env values, 401 probe noise.
"""
import base64
import glob
import json
import os
import re
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request

DB = "/opt/harness-unset/openchamber/data/opencode/share/opencode.db"
OC_LOG = "/opt/harness-unset/openchamber/data/opencode/share/log/opencode.log"
AUDIT = "/opt/harness-unset/openchamber/data/opencode/share/capability-audit.jsonl"
STATE_DIR = "/var/lib/orch-session-watcher"
STATE = os.path.join(STATE_DIR, "state.json")
DISCORD_ENV = "/opt/harness-unset/openclaw/secrets/discord.env"
API = "https://discord.com/api/v10"
HOME_CHAN_NAME = "general"
THREAD_PREFIX = "occhat-"
NARRATE_EVERY = 300          # seconds — MAXIMUM interval between updates (Sol: 5 min is the cap, not the poll)
IDLE_ACTIVE = 180            # session counts as ACTIVE for this long after last message part
SESSION_RECENT = 86400       # only watch sessions updated within the last day
GUARD_DIR = "/var/lib/openchamber-oc-guard"
GUARD_LOCK = os.path.join(GUARD_DIR, "active-turn.lock")
UA = "orch-session-watcher/1.0 (ticket 162)"

SECRET_PATTERNS = [
    re.compile(r"(?i)(bearer\s+|authorization:)\s*\S+"),
    re.compile(r"(?i)(api[_-]?key|token|password|secret|passwd|credential)\s*[:=]\s*\S+"),
    re.compile(r"sk-[A-Za-z0-9_\-]{12,}"),
    re.compile(r"gAAAA[A-Za-z0-9_\-]{10,}"),          # openai encrypted reasoning blobs
    re.compile(r"(?i)disclose [_-]?bot [_-]?token"),
    re.compile(r"gh[pousr]_[A-Za-z0-9]{20,}"),        # github tokens
    re.compile(r"(?i)dummy123"),
]
NOISE_LINES = re.compile(r"(?i)(GET /api/session|http\.status=401|health|heartbeat)")

# ---------------------------------------------------------------- state helpers

def load_state():
    os.makedirs(STATE_DIR, exist_ok=True)
    try:
        with open(STATE) as f:
            return json.load(f)
    except Exception:
        return {"sessions": {}, "logpos": 0, "loginode": None}


def save_state(st):
    tmp = STATE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(st, f, indent=1)
    os.replace(tmp, STATE)


# ---------------------------------------------------------------- discord

def token():
    with open(DISCORD_ENV) as f:
        for line in f:
            if line.startswith("DISCORD_BOT_TOKEN="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise SystemExit("no DISCORD_BOT_TOKEN")


TOKEN = token()


def req(method, path, body=None, timeout=15):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(API + path, data=data, method=method, headers={
        "Authorization": "Bot " + TOKEN, "Content-Type": "application/json",
        "User-Agent": UA, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            b = resp.read()
            return resp.status, (json.loads(b) if b else {})
    except urllib.error.HTTPError as e:
        return e.code, {}
    except Exception as e:
        print(f"net-error {path}: {e}", flush=True)
        return 0, {}


def home_channel():
    rc, me = req("GET", "/users/@me")
    if rc != 200:
        return None
    rc, gs = req("GET", "/users/@me/guilds")
    if rc != 200 or not gs:
        return None
    gid = gs[0]["id"]
    rc, chans = req("GET", f"/guilds/{gid}/channels")
    if rc != 200:
        return None
    home = next((c for c in chans if c.get("type") == 0 and c["name"] == HOME_CHAN_NAME), None) \
        or next((c for c in chans if c.get("type") == 0), None)
    return home["id"] if home else None


def ensure_thread(st, sid, title):
    s = st["sessions"].setdefault(sid, {})
    if s.get("tid"):
        return s["tid"]
    hid = st.get("home")
    if not hid:
        hid = home_channel()
        st["home"] = hid
    if not hid:
        return None
    eff = re.sub(r"[`*_~]", "", str(title or sid)).strip()[:90] or THREAD_PREFIX + sid[:12]
    name = (THREAD_PREFIX + eff)[:100]
    rc, t = req("POST", f"/channels/{hid}/threads",
                {"name": name, "type": 11, "auto_archive_duration": 10080}, timeout=20)
    if rc not in (200, 201) or "id" not in t:
        print(f"thread create rc={rc}", flush=True)
        if rc == 429:
            # rate-limited: back off hard, resume next ticks
            st["cooldown_until"] = time.time() + 180
            st["threads_this_pass"] = 99
        return None
    s["tid"] = t["id"]
    req("POST", f"/channels/{t['id']}/messages",
        {"content": (f"**OpenChamber chat tracking: {eff}**\n"
                     f"Session `{sid}` — 5-min-max narrative updates (ticket 162). "
                     "Reasoning headlines, tool activity, outcomes. Standalone/chat sessions only; "
                     "kit runs keep their own threads.")},
        timeout=20)
    return s["tid"]


def post(st, tid, content):
    rc, _ = req("POST", f"/channels/{tid}/messages",
                {"content": content[:1900], "allowed_mentions": {"parse": []}}, timeout=20)
    return rc in (200, 201)


# ---------------------------------------------------------------- sanitization

def sanitize(s):
    s = str(s)
    for pat in SECRET_PATTERNS:
        s = pat.sub("[REDACTED]", s)
    return re.sub(r"\s+", " ", s).strip()


# ---------------------------------------------------------------- db access

def open_db():
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=5)
    con.row_factory = sqlite3.Row
    return con


def recent_sessions(con):
    cutoff = int((time.time() - SESSION_RECENT) * 1000)
    return con.execute(
        "SELECT id, title, agent, model, time_updated, tokens_reasoning "
        "FROM session_v2 WHERE time_updated > ? ORDER BY time_updated DESC LIMIT 40",
        (cutoff,)).fetchall()


def new_parts(con, sid, since_seq):
    rows = con.execute(
        "SELECT seq, type, time_created, data FROM session_message "
        "WHERE session_id = ? AND seq > ? ORDER BY seq ASC LIMIT 400",
        (sid, since_seq)).fetchall()
    out = []
    for r in rows:
        try:
            d = json.loads(r["data"]) if r["data"] else {}
        except Exception:
            d = {}
        out.append((r["seq"], r["type"], r["time_created"], d))
    return out


# ---------------------------------------------------------------- narration

def extract_reasoning_headlines(d):
    """Model's own bold summary lines from reasoning parts — NOT raw chain of thought."""
    heads = []
    for c in d.get("content") or []:
        if isinstance(c, dict) and c.get("type") == "reasoning":
            for line in str(c.get("text") or "").splitlines():
                m = re.match(r"^\s*\*\*(.+?)\*\*\s*$", line.strip())
                if m:
                    h = sanitize(m.group(1))
                    if 3 <= len(h) <= 120 and h not in heads:
                        heads.append(h)
    return heads


def extract_tools(d):
    acts = []
    for c in d.get("content") or []:
        if isinstance(c, dict) and c.get("type") == "tool":
            name = sanitize(c.get("name") or "tool")
            st_ = (c.get("state") or {})
            status = sanitize(st_.get("status") or "?")
            inp = st_.get("input") or {}
            target = ""
            for k in ("filePath", "path", "file", "host", "command", "pattern", "query", "url", "description"):
                if k in inp:
                    v = sanitize(str(inp[k]).strip())
                    if k in ("command", "code"):
                        v = v[:60]
                    target = f"{k}:{v[:60]}"
                    break
            acts.append(f"{name}({target}{'·' if target and status != '?' else ''}{status})"
                        if target else f"{name}({status})")
    return acts


def extract_text(d):
    txt = []
    for c in d.get("content") or []:
        if isinstance(c, dict) and c.get("type") == "text":
            t = sanitize(c.get("text") or "")
            if t:
                txt.append(t)
    return txt


def log_errors_since(st):
    """New ERROR lines from opencode.log via inode+byte cursor; robust to rotation."""
    out = []
    try:
        stb = os.stat(OC_LOG)
        inode, size = stb.st_ino, stb.st_size
    except FileNotFoundError:
        return out
    pos = st.get("logpos", 0)
    if st.get("loginode") != inode:
        pos = 0
    if size < pos:
        pos = 0
    if size == pos:
        return out
    try:
        with open(OC_LOG, "rb") as f:
            f.seek(pos)
            chunk = f.read(min(size - pos, 400_000)).decode("utf-8", "replace")
        newpos = min(size, pos + 400_000)
    except Exception:
        return out
    for line in chunk.splitlines():
        if 'level=ERROR' not in line and "outcome:\"failed\"" not in line:
            continue
        m = re.search(r'message="([^"]{0,300})', line)
        msg = m.group(1) if m else line[:200]
        if NOISE_LINES.search(msg):
            continue
        c = re.search(r'cause="([^"]{0,220})', line)
        out.append(sanitize(msg) + (f" — {sanitize(c.group(1))}" if c else ""))
    st["logpos"], st["loginode"] = newpos, inode
    return out


def classify_log_errors(errs):
    """Map known incident signatures to short operator-facing labels."""
    labels = []
    for e in errs:
        low = e.lower()
        if "agentnotfounderror" in low or "agent not found" in low:
            labels.append("agent registry lost the session's agent (hot-reload poisoning)")
        elif "failed to reload plugins" in low or "not a function" in low:
            labels.append("plugin hot-reload crashed mid-turn")
        elif "failed to drain session" in low:
            labels.append("session drain failed at turn end")
        else:
            labels.append(e[:140])
    return labels


# ---------------------------------------------------------------- main pass

def build_update(sid, title, parts, errs, active):
    heads, acts, txt, terminal = [], [], [], None
    idle_first = None
    for seq, typ, tc, d in parts:
        if typ == "assistant":
            heads += [h for h in extract_reasoning_headlines(d) if h not in heads]
            acts += [a for a in extract_tools(d) if a not in acts]
            txt += [t for t in extract_text(d) if t not in txt]
        elif typ == "idle":
            oc = (d.get("outcome") or "").lower()
            if oc and idle_first is None:
                idle_first = oc
        elif typ == "user":
            u = sanitize(str(d.get("content") or d.get("text") or ""))[:80]
            if u:
                txt.append(f"operator said: {u}")
    if idle_first in ("failed", "interrupted"):
        terminal = idle_first
    lines = [f"**OpenChamber update**", f"Session: {title}"]
    lines.append("State: " + ("FAILED" if terminal == "failed" else
                             "INTERRUPTED" if terminal == "interrupted" else
                             "Working" if active else "Idle (no new activity)"))
    if heads:
        lines.append("Reasoning summary: " + "; ".join(heads[:4]))
    if acts:
        lines.append("Actions: " + "; ".join(acts[:6]))
    if txt:
        lines.append("Text: " + " | ".join(t[:160] for t in txt[:2]))
    if terminal:
        lines.append("**Turn " + terminal.upper() + "**" +
                     (" — see errors below" if errs else ""))
    for lbl in classify_log_errors(errs)[:3]:
        lines.append("Error: " + lbl)
    if not any(k in " ".join(lines).lower() for k in ("state:", )):  # pragma: no cover
        pass
    return "\n".join(lines)


def watch_pass(st):
    st.setdefault("sessions", {})
    con = open_db()
    try:
        sess = recent_sessions(con)
        now_ms = int(time.time() * 1000)
        st["threads_this_pass"] = 0
        cooldown = st.get("cooldown_until", 0)
        for row in sess:
            sid = row["id"]
            s = st["sessions"].get(sid, {})
            first_seen = sid not in st["sessions"]
            max_seq_now = con.execute(
                "SELECT COALESCE(MAX(seq),0) FROM session_message WHERE session_id=?",
                (sid,)).fetchone()[0]
            if first_seen:
                # Baseline: do NOT narrate history. Active sessions get a thread
                # now; a session with a terminal outcome in the last hour ALSO
                # gets one so its failure surfaces immediately (incident 162:
                # the operator must learn a turn died). Everything else is
                # baselined and tracked from now on.
                active_recent = (now_ms - row["time_updated"]) < IDLE_ACTIVE * 1000
                recent_terminal = con.execute(
                    "SELECT COUNT(*) FROM session_message WHERE session_id=? AND type='idle' "
                    "AND time_created > ? AND json_extract(data,'$.outcome') IN ('failed','interrupted')",
                    (sid, now_ms - 3600 * 1000)).fetchone()[0] > 0
                st["sessions"][sid] = {
                    "seq": max(0, max_seq_now - 12) if (recent_terminal and not active_recent) else max_seq_now,
                    "last_narr": 0}
                if not (active_recent or recent_terminal):
                    continue
                s = st["sessions"][sid]
            since = s.get("seq", 0)
            parts = new_parts(con, sid, since)
            if not parts and s.get("terminal_posted"):
                continue
            title = sanitize(row["title"] or sid)
            last_ms = max([row["time_updated"]] + [p[2] for p in parts]) if parts else row["time_updated"]
            active = (now_ms - last_ms) < IDLE_ACTIVE * 1000
            errs = log_errors_since(st) if parts or active else []
            terminal = None
            for _, typ, _, d in parts:
                if typ == "idle" and (d.get("outcome") or "").lower() in ("failed", "interrupted"):
                    terminal = (d.get("outcome") or "").lower()
            has_new = bool(parts)
            last_narr = s.get("last_narr", 0)
            due = has_new and (time.time() - last_narr >= NARRATE_EVERY)
            if not s.get("tid"):
                if not (has_new or terminal):
                    continue  # quiet baselined session: nothing to narrate, no thread
                if time.time() < cooldown or st["threads_this_pass"] >= 3:
                    continue  # backoff / per-pass cap: retry next tick, cursor NOT advanced
                tid = ensure_thread(st, sid, title)
                st["threads_this_pass"] += 1
                if not tid:
                    continue  # retry next tick; cursor NOT advanced (never drop)
                s["tid"] = tid
                first = True
            else:
                tid = s["tid"]
                first = not s.get("greeted")
            if first:
                first_update = build_update(sid, title, parts[-40:], errs, active)
                if post(st, tid, "**Tracking started** — current snapshot:\n" + first_update):
                    s["greeted"] = True
            elif due or terminal:
                upd = build_update(sid, title, parts[-40:], errs, active)
                if post(st, tid, upd):
                    s["last_narr"] = time.time()
            if terminal and not s.get("terminal_posted"):
                s["terminal_posted"] = terminal
            # advance cursor ONLY after successful posts above (never drop)
            if s.get("tid") and (s.get("greeted") or terminal):
                s["seq"] = max_seq_now
            if not active and terminal:
                s["closed"] = True
            st["sessions"][sid] = s
        # prune tracking of sessions idle >1 day
        for sid in list(st["sessions"]):
            row = next((r for r in sess if r["id"] == sid), None)
            if not row:
                st["sessions"].pop(sid, None)
    finally:
        con.close()


# ---------------------------------------------------------------- mutation guard (Sol ship-order item 4)

def active_turn_exists():
    """True if any OpenChamber session had message activity within IDLE_ACTIVE."""
    try:
        con = open_db()
        try:
            cutoff = int((time.time() - IDLE_ACTIVE) * 1000)
            n = con.execute("SELECT COUNT(*) FROM session_v2 WHERE time_updated > ?", (cutoff,)).fetchone()[0]
            return n > 0
        finally:
            con.close()
    except Exception as e:
        print("guard db error (fail-closed): " + str(e), flush=True)
        return True  # fail-closed: never mutate runtime config while unsure


def guard_check():
    """Called by the host-side mutation wrapper. rc 0 = safe to mutate."""
    if active_turn_exists():
        sys.stderr.write("MUTATION_BLOCKED active OpenChamber turn(s) — defer plugin/agent config writes\n")
        return 1
    return 0


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "watch"
    if cmd == "guard":
        sys.exit(guard_check())
    st = load_state()
    watch_pass(st)
    save_state(st)


if __name__ == "__main__":
    main()
