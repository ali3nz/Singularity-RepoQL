#!/usr/bin/env python3
"""Harness Control Center telemetry for the RepoQL dashboard (ticket 789).

Read-only ingestion of EXISTING harness ledgers into one compact SQLite store:

  * kit run directories + state/run-ledger.jsonl  -> run / stage / agent events
  * kit run.log                                  -> stage and agent activity, errors
  * kit runs/engine-usage.jsonl                  -> model calls, tokens, latency
  * kit runs/session-consult-*.json + transcript -> Sol review lifecycle/verdict
  * kit runs/nanny-alerts.jsonl                  -> operator alerts
  * documentation/.state/closeout-receipts/*.json -> closeout results
  * openchamber capability-audit.jsonl           -> tool decisions, gate events

Design constraints (operator directive 2026-10-24):
  - telemetry MUST never block or fail a harness operation: this collector only
    reads files after the fact, runs from its own timer, and always exits 0;
  - no prompts, model responses, tool output bodies, credentials or transcripts
    are stored; every payload is a bounded, scrubbed label;
  - bounded growth: 14 d detail, 90 d aggregates, 256 MiB physical budget
    including WAL/journal files, enforced on every ingest;
  - unknown costs stay unknown (only provider-reported cost is stored);
  - no new observability stack: one SQLite file next to the dashboard state.

CLI:
  python3 harness_telemetry.py collect   # one bounded ingest + maintenance
  python3 harness_telemetry.py health    # JSON health snapshot
  python3 harness_telemetry.py selftest  # offline schema/retention check
"""
from __future__ import annotations

import argparse
import contextlib
import datetime as dt
from file_lock import fcntl
import glob
import hashlib
import json
import os
import re
import sqlite3
import sys
import time
from pathlib import Path

def default_telemetry_state_dir(*, platform=None, env=None, home=None):
    """Match the dashboard's per-user state root without guessing Linux paths on Windows."""
    platform = os.name if platform is None else platform
    env = os.environ if env is None else env
    home = Path.home() if home is None else Path(home)
    override = env.get("SINGULARITY_STATE_DIR") or env.get("RQLDASH_STATE_DIR")
    if override:
        return Path(override)
    if platform == "nt":
        return Path(env.get("LOCALAPPDATA") or home / "AppData" / "Local") / "Singularity" / "Dashboard"
    return home / ".local" / "state" / "singularity-dashboard"

STATE = default_telemetry_state_dir()
# Harness inputs are user-owned runtime data configured OUTSIDE the shipped tree.
# When a path is not configured the panel reports an empty, truthful dataset.
HARNESS_DATA = Path(os.environ.get("SINGULARITY_HARNESS_DATA_DIR") or STATE / "harness")
RUNS = Path(os.environ.get("HARNESS_RUNS_DIR") or HARNESS_DATA / "runs")
HUB = Path(os.environ.get("HARNESS_HUB_DIR") or HARNESS_DATA / "hub")
AUDIT = Path(os.environ.get("HARNESS_AUDIT_LOG") or HARNESS_DATA / "capability-audit.jsonl")
# Freebuff Desktop keeps one SQLite store per project under its bind-mounted
# config. Only bounded session metadata is read from it (never titles, prompts
# or message bodies), read-only, and only when a session was active recently.
DESKTOP_DB_GLOB = os.environ.get(
    "HARNESS_DESKTOP_DB_GLOB",
    str(HARNESS_DATA / "projects" / "*" / "desktop-v2.db"))

DEFAULTS = {
    "telemetry_enabled": ("true", "bool"),
    "detail_days": ("14", "int:1:30"),
    "aggregate_days": ("90", "int:7:365"),
    "storage_budget_mb": ("256", "int:32:1024"),
    "debug_verbosity": ("false", "bool"),
    "sampling_tools": ("0.10", "float:0:1"),
    "dashboard_refresh_seconds": ("30", "int:10:300"),
}
SETTING_LABELS = {
    "telemetry_enabled": "Telemetry collection",
    "detail_days": "Detailed event retention (days)",
    "aggregate_days": "Historical aggregate retention (days)",
    "storage_budget_mb": "Telemetry storage budget (MiB)",
    "debug_verbosity": "Detailed diagnostics",
    "sampling_tools": "Tool event sampling (0-1)",
    "dashboard_refresh_seconds": "Dashboard refresh (seconds)",
}
MUTABLE = set(DEFAULTS)

SCHEMA = """
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL, category TEXT NOT NULL, kind TEXT NOT NULL,
  severity TEXT, status TEXT,
  run_id TEXT, session_id TEXT, agent TEXT, model TEXT, provider TEXT, mode TEXT,
  tool TEXT, stage TEXT, error_category TEXT,
  duration_ms INTEGER, ok INTEGER,
  tokens_in INTEGER, tokens_out INTEGER,
  cost_usd REAL, cost_kind TEXT,
  detail TEXT, source TEXT NOT NULL,
  dedup_key TEXT UNIQUE,
  occurrences INTEGER NOT NULL DEFAULT 1,
  first_ts TEXT, last_ts TEXT
);
CREATE INDEX IF NOT EXISTS ev_ts ON events(ts);
CREATE INDEX IF NOT EXISTS ev_cat_ts ON events(category, ts);
CREATE INDEX IF NOT EXISTS ev_run ON events(run_id);
CREATE INDEX IF NOT EXISTS ev_kind ON events(kind, ts);
CREATE TABLE IF NOT EXISTS runs(
  run_id TEXT PRIMARY KEY, kind TEXT, title TEXT, mode TEXT, roster TEXT,
  coordinator TEXT, stage TEXT, state TEXT, status TEXT,
  started_at TEXT, ended_at TEXT, updated_at TEXT,
  issue_number INTEGER, workers INTEGER, source TEXT,
  failed INTEGER, completed INTEGER
);
CREATE INDEX IF NOT EXISTS runs_started ON runs(started_at);
CREATE TABLE IF NOT EXISTS ingest_files(
  path TEXT PRIMARY KEY, offset INTEGER NOT NULL DEFAULT 0,
  inode INTEGER, mtime REAL, lines INTEGER NOT NULL DEFAULT 0,
  last_ok TEXT, last_error TEXT
);
CREATE TABLE IF NOT EXISTS daily(
  day TEXT NOT NULL, metric TEXT NOT NULL, value REAL NOT NULL DEFAULT 0,
  PRIMARY KEY(day, metric)
);
CREATE TABLE IF NOT EXISTS counters(name TEXT PRIMARY KEY, value INTEGER NOT NULL DEFAULT 0, updated_at TEXT);
CREATE TABLE IF NOT EXISTS settings(
  key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS settings_audit(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, key TEXT NOT NULL,
  old_value TEXT, new_value TEXT, actor TEXT, effective TEXT
);
CREATE TABLE IF NOT EXISTS seen(
  dedup_key TEXT PRIMARY KEY, first_ts TEXT NOT NULL, category TEXT
);
CREATE TABLE IF NOT EXISTS sessions(
  session_id TEXT PRIMARY KEY, surface TEXT NOT NULL, harness TEXT, model TEXT,
  agent_mode TEXT, execution_mode TEXT, status TEXT, state TEXT,
  started_at TEXT, last_activity TEXT, last_turn_outcome TEXT,
  queue_paused INTEGER, messages INTEGER, live INTEGER NOT NULL DEFAULT 0,
  source TEXT, updated_at TEXT
);
CREATE INDEX IF NOT EXISTS sessions_activity ON sessions(last_activity);
CREATE TABLE IF NOT EXISTS nanny_events(
  name TEXT PRIMARY KEY, last_decision TEXT, last_ts TEXT, detail TEXT
);
"""

ERROR_RX = re.compile(r"(?i)\b(error|failed|failure|denied|timeout|refused|exception)\b")
SECRET_RX = re.compile(r"(?i)\b(api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd)\b\s*[:=]\s*\S+")
LONG_BLOB_RX = re.compile(r"\b[A-Za-z0-9_\-+/=]{48,}\b")
VERDICTS = [
    ("PASS WITH LIMITATION", re.compile(r"PASS WITH LIMITATION")),
    ("APPROVE WITH LIMITATIONS", re.compile(r"APPROVE WITH LIMITATIONS")),
    ("APPROVE WITH NON-BLOCKING", re.compile(r"APPROVE WITH NON-BLOCKING")),
    ("APPROVE", re.compile(r"\bAPPROVE\b")),
    ("ACCEPTED", re.compile(r"\bACCEPT(?:ED|ANCE)?\b")),
    ("BLOCKER", re.compile(r"\bBLOCKER\b")),
    ("HOLD", re.compile(r"\bHOLD\b")),
    ("REJECT", re.compile(r"\bREJECT\b")),
    ("UNCERTAIN", re.compile(r"\bUNCERTAIN\b")),
    ("FAIL", re.compile(r"\bFAIL\b")),
    ("PASS", re.compile(r"\bPASS\b")),
]
REVISION_VERDICTS = {"BLOCKER", "HOLD", "REJECT", "FAIL"}
REVIEW_ERROR_STATES = {"FAILED", "ERROR", "FAIL"}


def now_iso(ts: float | None = None) -> str:
    return dt.datetime.fromtimestamp(ts or time.time(), dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def to_iso(value) -> str | None:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        # kit state uses epoch milliseconds
        seconds = float(value) / (1000.0 if float(value) > 10_000_000_000 else 1.0)
        return now_iso(seconds)
    text = str(value).strip()
    if not text:
        return None
    try:
        parsed = dt.datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return parsed.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(value: str | None) -> dt.datetime | None:
    if not value:
        return None
    try:
        return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def scrub(text, limit: int = 200) -> str:
    value = SECRET_RX.sub(lambda m: f"{m.group(1)}=<redacted>", str(text or ""))
    value = LONG_BLOB_RX.sub("<redacted>", value)
    value = re.sub(r"[\x00-\x1f\x7f]+", " ", value)
    value = re.sub(r"\s+", " ", value).strip()
    return value[:limit]


def metered_outbound_fields(row):
    """Return measured sending-end tokens/cost without charging for a Sol reply.

    Sol consultations may use ChatGPT subscription processing. Ordinary
    inputTokens/outputTokens and costUsd for openai-sol do not establish an
    outbound API invoice. Only explicitly transport-scoped fields are counted.
    """
    engine = str(row.get("engine") or "").lower()
    model = str(row.get("model") or "").lower()
    sol = engine in {"openai-sol", "chatgpt", "chatgpt-sol"} or model.startswith("chatgpt/")
    if not sol:
        cost = row.get("costUsd")
        return (row.get("inputTokens"), row.get("outputTokens"),
                float(cost) if type(cost) in (int, float) and 0 <= cost < 1e9 else None)
    # No inference from an LLM response size, completion receipt or guessed
    # API-equivalent cost. Sending telemetry must label itself as transport.
    if row.get("usageScope") not in {"outbound_request", "transport", "sender"}:
        return (None, None, None)
    def measured(key):
        value = row.get(key)
        return int(value) if type(value) in (int, float) and 0 <= value < 1e15 else None
    cost = row.get("sendCostUsd")
    return (measured("sendInputTokens"), measured("sendOutputTokens"),
            float(cost) if type(cost) in (int, float) and 0 <= cost < 1e9 else None)


def provider_of(engine, model) -> str | None:
    model = str(model or "")
    engine = str(engine or "")
    if "/" in model:
        return model.split("/", 1)[0].lower()
    if engine.startswith("openai"):
        return "openai"
    if engine.startswith("opencode"):
        return "opencode"
    if engine.startswith("freebuff"):
        return "freebuff"
    if engine.startswith("claude"):
        return "claude"
    return engine.lower() or None


def percentile(values, pct: float):
    if not values:
        return None
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    rank = (len(ordered) - 1) * pct
    lower = int(rank)
    upper = min(lower + 1, len(ordered) - 1)
    weight = rank - lower
    return ordered[lower] * (1 - weight) + ordered[upper] * weight


def median(values):
    return percentile(values, 0.5)



class Store:
    def __init__(self, db_path: Path):
        self.path = Path(db_path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        # The dashboard serves each request on its own thread; Python's sqlite3
        # module is serialized (threadsafety 3), so one connection can be shared
        # safely as long as the thread check is disabled. The collector runs in a
        # separate process, never on this connection.
        self.conn = sqlite3.connect(str(self.path), timeout=10, isolation_level=None,
                                    check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA busy_timeout=5000")
        self.conn.execute("PRAGMA synchronous=NORMAL")
        self.conn.executescript(SCHEMA)
        self._seed_settings()

    # -- settings -----------------------------------------------------
    def _seed_settings(self):
        now = now_iso()
        for key, (value, _kind) in DEFAULTS.items():
            self.conn.execute(
                "INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO NOTHING",
                (key, value, now))

    def setting(self, key: str) -> str:
        row = self.conn.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
        if row:
            return str(row["value"])
        return DEFAULTS.get(key, ("", ""))[0]

    def settings(self) -> dict:
        rows = self.conn.execute("SELECT key,value,updated_at FROM settings ORDER BY key").fetchall()
        out = {}
        for row in rows:
            key = row["key"]
            out[key] = {
                "key": key,
                "label": SETTING_LABELS.get(key, key),
                "value": row["value"],
                "default": DEFAULTS.get(key, ("", ""))[0],
                "kind": DEFAULTS.get(key, ("", "string"))[1],
                "updated_at": row["updated_at"],
                "mutable": key in MUTABLE,
            }
        return out

    def update_setting(self, key: str, value: str, actor: str = "operator") -> dict:
        if key not in MUTABLE:
            raise ValueError(f"unknown or read-only setting: {key}")
        spec = DEFAULTS[key][1]
        raw = str(value).strip()
        if spec == "bool":
            if raw.lower() not in ("true", "false"):
                raise ValueError(f"{key} must be true or false")
            raw = raw.lower()
        elif spec.startswith("int:") or spec.startswith("float:"):
            kind, lo, hi = spec.split(":")
            try:
                number = int(raw) if kind == "int" else float(raw)
            except ValueError:
                raise ValueError(f"{key} must be {'an integer' if kind == 'int' else 'a number'}")
            if not float(lo) <= float(number) <= float(hi):
                raise ValueError(f"{key} must be between {lo} and {hi}")
            raw = str(number)
        old = self.setting(key)
        now = now_iso()
        self.conn.execute("UPDATE settings SET value=?, updated_at=? WHERE key=?", (raw, now, key))
        effective = raw
        if key == "telemetry_enabled" and raw == "true" and self.over_budget():
            effective = "true (collection paused: storage budget reached)"
        self.conn.execute(
            "INSERT INTO settings_audit(ts,key,old_value,new_value,actor,effective) VALUES(?,?,?,?,?,?)",
            (now, key, old, raw, actor, effective))
        if old != raw:
            self.add_event({
                "ts": now, "category": "operator", "kind": "setting_changed",
                "severity": "info", "status": "ok", "detail": f"{key}: {old} -> {raw}",
                "source": "settings", "dedup_key": f"setting:{key}:{now}",
            })
        return {"key": key, "value": raw, "old": old, "effective": effective,
                "restart_required": key in ("storage_budget_mb",), "updated_at": now}

    def setting_audit(self, limit: int = 30):
        rows = self.conn.execute(
            "SELECT ts,key,old_value,new_value,actor,effective FROM settings_audit ORDER BY id DESC LIMIT ?",
            (max(1, limit),)).fetchall()
        return [dict(r) for r in rows]

    # -- events -------------------------------------------------------
    def add_event(self, ev: dict) -> bool:
        """Insert, or bump an identical recurring event. Returns True when new.

        `seen` is durable across detail retention: an event whose detail row
        aged out is never re-ingested from a cumulative source and never bumps
        a daily aggregate twice.
        """
        ts = to_iso(ev.get("ts")) or now_iso()
        detail = scrub(ev.get("detail"), int(ev.get("detail_limit", 200)))
        dedup = ev.get("dedup_key")
        if not dedup:
            dedup = f"{ev.get('kind')}|{fmt_hash(' '.join(str(ev.get(k) or '') for k in ('run_id','agent','stage','detail','status')))}"
        if self.conn.execute("SELECT 1 FROM seen WHERE dedup_key=?", (dedup,)).fetchone():
            self.conn.execute(
                "UPDATE events SET occurrences=occurrences+1, last_ts=?, ts=MAX(ts,?) WHERE dedup_key=?",
                (ts, ts, dedup))
            return False
        try:
            self.conn.execute(
                """INSERT INTO events(ts,category,kind,severity,status,run_id,session_id,agent,model,provider,mode,
                       tool,stage,error_category,duration_ms,ok,tokens_in,tokens_out,cost_usd,cost_kind,detail,source,
                       dedup_key,occurrences,first_ts,last_ts)
                   VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)""",
                (ts, ev.get("category"), ev.get("kind"), ev.get("severity"), ev.get("status"),
                 ev.get("run_id"), ev.get("session_id"), ev.get("agent"), ev.get("model"), ev.get("provider"),
                 ev.get("mode"), ev.get("tool"), ev.get("stage"), ev.get("error_category"),
                 ev.get("duration_ms"), ev.get("ok"), ev.get("tokens_in"), ev.get("tokens_out"),
                 ev.get("cost_usd"), ev.get("cost_kind"), detail, ev.get("source") or "collector",
                 dedup, ts, ts))
            self.conn.execute(
                "INSERT OR IGNORE INTO seen(dedup_key,first_ts,category) VALUES(?,?,?)",
                (dedup, ts, ev.get("category")))
            return True
        except sqlite3.IntegrityError:
            self.conn.execute(
                "UPDATE events SET occurrences=occurrences+1, last_ts=?, ts=MAX(ts,?) WHERE dedup_key=?",
                (ts, ts, dedup))
            self.conn.execute(
                "INSERT OR IGNORE INTO seen(dedup_key,first_ts,category) VALUES(?,?,?)",
                (dedup, ts, ev.get("category")))
            return False

    def add_event_once(self, key: str, ev: dict) -> bool:
        if self.conn.execute("SELECT 1 FROM seen WHERE dedup_key=?", (key,)).fetchone():
            return False
        if self.conn.execute("SELECT 1 FROM events WHERE dedup_key=?", (key,)).fetchone():
            return False
        ev = {**ev, "dedup_key": key}
        return self.add_event(ev)

    def refresh_event(self, key: str, status: str | None = None,
                      severity: str | None = None, detail: str | None = None) -> None:
        """Update derived fields of an event already recorded under `key`.

        Used when one logical entity (a consult turn) is observed again: the
        record is corrected in place, no second occurrence and no counter bump.
        """
        sets, args = [], []
        for column, value in (("status", status), ("severity", severity), ("detail", detail)):
            if value is not None:
                sets.append(f"{column}=?")
                args.append(value)
        if not sets:
            return
        # The connection is in autocommit mode (isolation_level=None): the
        # UPDATE is already durable, and commit() would raise "no transaction".
        self.conn.execute(
            f"UPDATE events SET {', '.join(sets)} WHERE dedup_key=?", (*args, key))

    def counter(self, name: str, delta: int = 1) -> int:
        now = now_iso()
        self.conn.execute(
            "INSERT INTO counters(name,value,updated_at) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET value=value+excluded.value, updated_at=excluded.updated_at",
            (name, int(delta), now))
        row = self.conn.execute("SELECT value FROM counters WHERE name=?", (name,)).fetchone()
        return int(row["value"]) if row else 0

    def counters(self) -> dict:
        return {r["name"]: int(r["value"]) for r in self.conn.execute("SELECT name,value FROM counters")}

    def bump_daily(self, day: str, metric: str, delta: float = 1) -> None:
        self.conn.execute(
            "INSERT INTO daily(day,metric,value) VALUES(?,?,?) ON CONFLICT(day,metric) DO UPDATE SET value=value+excluded.value",
            (day, metric, float(delta)))

    # -- ingestion cursor --------------------------------------------
    def cursor(self, path: Path) -> dict:
        row = self.conn.execute("SELECT * FROM ingest_files WHERE path=?", (str(path),)).fetchone()
        return dict(row) if row else {"path": str(path), "offset": 0, "inode": None, "mtime": None, "lines": 0}

    def save_cursor(self, path: Path, offset: int, inode: int | None, mtime: float | None,
                    lines: int, error: str | None = None) -> None:
        self.conn.execute(
            """INSERT INTO ingest_files(path,offset,inode,mtime,lines,last_ok,last_error)
               VALUES(?,?,?,?,?,?,?)
               ON CONFLICT(path) DO UPDATE SET offset=excluded.offset,inode=excluded.inode,mtime=excluded.mtime,
                 lines=excluded.lines,last_ok=excluded.last_ok,last_error=excluded.last_error""",
            (str(path), int(offset), inode, mtime, int(lines), None if error else now_iso(), error))

    # -- retention / budget ------------------------------------------
    def db_bytes(self) -> int:
        total = 0
        for suffix in ("", "-wal", "-shm", "-journal"):
            p = Path(str(self.path) + suffix)
            if p.exists():
                total += p.stat().st_size
        return total

    def over_budget(self) -> bool:
        budget = int(self.setting("storage_budget_mb")) * 1024 * 1024
        return self.db_bytes() > budget

    def prune(self, drop_events: bool = True) -> dict:
        # Desktop session metadata follows the same detail retention as events;
        # a live session is never pruned by the sweep.
        cutoff_sessions = now_iso(time.time() - 86400 * int(self.setting("detail_days")))
        self.conn.execute(
            "DELETE FROM sessions WHERE live=0 AND COALESCE(last_activity,'') < ?",
            (cutoff_sessions,))
        detail_days = max(1, int(self.setting("detail_days")))
        aggregate_days = max(7, int(self.setting("aggregate_days")))
        budget = int(self.setting("storage_budget_mb")) * 1024 * 1024
        now = dt.datetime.now(dt.timezone.utc)
        cut = now - dt.timedelta(days=detail_days)
        removed = self.conn.execute("DELETE FROM events WHERE ts < ?", (to_iso(cut),)).rowcount
        agg_cut = (now - dt.timedelta(days=aggregate_days)).strftime("%Y-%m-%d")
        old_daily = self.conn.execute("DELETE FROM daily WHERE day < ?", (agg_cut,)).rowcount
        seen_cut = (now - dt.timedelta(days=max(400, aggregate_days + 30))).strftime("%Y-%m-%dT%H:%M:%SZ")
        self.conn.execute("DELETE FROM seen WHERE first_ts < ?", (seen_cut,))
        dropped = 0
        if drop_events:
            # Physical budget: shed the oldest detail first, then aggregates.
            while self.db_bytes() > budget:
                rows = self.conn.execute(
                    "SELECT id FROM events ORDER BY ts LIMIT 2000").fetchall()
                if rows:
                    ids = [r["id"] for r in rows]
                    self.conn.execute(
                        f"DELETE FROM events WHERE id IN ({','.join('?' * len(ids))})", ids)
                    dropped += len(ids)
                    continue
                day_row = self.conn.execute("SELECT day FROM daily ORDER BY day LIMIT 1").fetchone()
                if day_row:
                    self.conn.execute("DELETE FROM daily WHERE day=?", (day_row["day"],))
                    old_daily += 1
                    continue
                break
            if dropped:
                self.counter("dropped_events", dropped)
                self.counter("budget_prunes")
            with contextlib.suppress(sqlite3.Error):
                self.conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            if removed or dropped or old_daily:
                with contextlib.suppress(sqlite3.Error):
                    self.conn.execute("VACUUM")
        if removed:
            self.counter("retention_deleted", int(removed))
        return {"events_aged": int(removed), "daily_aged": int(old_daily), "budget_dropped": dropped,
                "bytes": self.db_bytes(), "budget_bytes": budget}

    def close(self):
        with contextlib.suppress(sqlite3.Error):
            self.conn.close()


def fmt_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", "replace")).hexdigest()[:24]


# ---------------------------------------------------------------- sources
def read_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8", errors="replace"))
    except (OSError, ValueError):
        return None


def iter_jsonl_tail(path: Path, start: int):
    """Yield (end_offset, line_bytes) from start, skipping a partial last line."""
    with path.open("rb") as fh:
        fh.seek(0, os.SEEK_END)
        size = fh.tell()
        if start > size:  # rotated/truncated file
            start = 0
        fh.seek(start)
        buf = b""
        while True:
            block = fh.read(65536)
            if not block:
                break
            buf += block
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                yield start + len(line) + 1, line
                start += len(line) + 1
        # a trailing line without newline is left for the next pass


class Collector:
    def __init__(self, store: Store):
        self.s = store
        self.now = now_iso()
        self.sources = {}

    def _wrap(self, name, fn):
        t0 = time.time()
        try:
            # One transaction per source: telemetry is disposable, so a failed
            # source rolls back only its own batch and is retried next cycle.
            self.s.conn.execute("BEGIN IMMEDIATE")
            result = fn() or {}
            self.s.conn.execute("COMMIT")
            self.sources[name] = {"ok": True, "ms": int((time.time() - t0) * 1000), **result}
            self.s.conn.execute(
                "INSERT INTO counters(name,value,updated_at) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET value=value, updated_at=excluded.updated_at",
                (f"source_ok:{name}", 1, now_iso()))
        except Exception as exc:  # fail-open: one source cannot stop the others
            with contextlib.suppress(sqlite3.Error):
                self.s.conn.execute("ROLLBACK")
            msg = scrub(f"{type(exc).__name__}: {exc}", 180)
            self.sources[name] = {"ok": False, "ms": int((time.time() - t0) * 1000), "error": msg}
            self.s.counter("ingest_errors")
            self.s.counter(f"ingest_errors:{name}")
            self.s.conn.execute(
                "INSERT INTO counters(name,value,updated_at) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET value=value+1, updated_at=excluded.updated_at",
                (f"source_err:{name}", 1, now_iso()))
            self.s.conn.execute(
                "INSERT INTO meta(key,value) VALUES('last_error',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (f"{name}: {msg} @ {self.now}",))

    def run(self):
        self._wrap("run_ledger", self.run_ledger)
        self._wrap("runs", self.run_dirs)
        self._wrap("run_logs", self.run_logs)
        self._wrap("model_usage", self.model_usage)
        self._wrap("reviews", self.reviews)
        self._wrap("alerts", self.alerts)
        self._wrap("closeouts", self.closeouts)
        self._wrap("tool_audit", self.tool_audit)
        self._wrap("desktop", self.desktop_sessions)
        return self.sources

    # -- run ledger --------------------------------------------------
    def run_ledger(self):
        path = RUNS / "state" / "run-ledger.jsonl"
        if not path.exists():
            return {"skipped": "absent"}
        cur = self.s.cursor(path)
        inode = path.stat().st_ino
        start = int(cur["offset"]) if cur["inode"] in (None, inode) else 0
        count = 0
        for end, line in iter_jsonl_tail(path, start):
            start = end
            try:
                row = json.loads(line.decode("utf-8", "replace"))
            except ValueError:
                continue
            event = str(row.get("event") or "")
            run_id = str(row.get("caseId") or "")
            if not run_id:
                continue
            if event == "run_allocated":
                # The ledger title is prompt-derived (the dispatcher copies the
                # task text into it). Source provenance does not make it safe, so
                # no title is persisted here: Sol review 2026-10-24 reproduced the
                # task text arriving through this field. runs.title stays NULL and
                # the interface labels such a run by its kind.
                inserted = self.s.add_event_once(f"run_allocated:{run_id}", {
                    "ts": row.get("createdAt"), "category": "run", "kind": "run_created",
                    "severity": "info", "status": "allocated", "run_id": run_id,
                    "mode": row.get("runType"), "agent": "coordinator",
                    "detail": "run allocated", "source": "run-ledger"})
                self.s.conn.execute(
                    "INSERT INTO runs(run_id,kind,title,started_at,source) VALUES(?,?,?,?,?) "
                    "ON CONFLICT(run_id) DO UPDATE SET kind=excluded.kind",
                    (run_id, row.get("runType"), None, to_iso(row.get("createdAt")), "run-ledger"))
                # A replayed ledger (same lines, new inode) must not create a
                # second allocation in the daily aggregate.
                if inserted:
                    self.s.bump_daily((to_iso(row.get("createdAt")) or self.now)[:10], "runs_created")
            elif event == "discord_thread_bound":
                self.s.add_event_once(f"run_thread:{run_id}", {
                    "ts": row.get("at"), "category": "run", "kind": "run_thread_bound",
                    "severity": "info", "status": "ok", "run_id": run_id,
                    "detail": "Discord thread bound", "source": "run-ledger"})
            count += 1
        self.s.save_cursor(path, start, inode, path.stat().st_mtime, count)
        return {"events": count}

    # -- run directories --------------------------------------------
    def run_dirs(self):
        if not RUNS.is_dir():
            return {"skipped": "runs directory absent"}
        names = ("state.json", "bridge-state.json", "case.json")
        # The current kit stores consultations in runs/consult/<id>, and probe
        # runs have non-timestamp names. Discover source evidence, not folder names.
        dirs = [d for d in RUNS.iterdir() if d.is_dir() and
                any((d / n).is_file() for n in names)]
        dirs += [d for parent in RUNS.iterdir() if parent.is_dir()
                 for d in parent.iterdir() if d.is_dir() and
                 any((d / n).is_file() for n in names)]
        dirs.sort(key=lambda d: d.stat().st_mtime, reverse=True)
        seen = 0
        for d in dirs[:1200]:
            state_path = next((d / n for n in names if (d / n).is_file()), None)
            if state_path is None:
                continue
            st = read_json(state_path)
            if not isinstance(st, dict):
                continue
            run_id = str(st.get("runId") or st.get("caseId") or d.name)
            started = to_iso(st.get("startedAt")) or to_iso(st.get("createdAt"))
            if started is None and re.match(r"^\d{4}-\d{2}-\d{2}T", d.name):
                started = to_iso(f"{d.name[:10]}T{d.name[11:19].replace('-', ':')}Z")
            updated = now_iso(state_path.stat().st_mtime)
            run_state = str(st.get("runState") or st.get("state") or st.get("status") or "UNKNOWN").upper()
            phase = st.get("currentPhase")
            seats = st.get("seats") or st.get("customSeats") or []
            models = sorted({str(x.get("model")) for x in seats if isinstance(x, dict) and x.get("model")})
            models = [m for m in models if m.startswith("openai/") or "/" in m]
            # Distinguish accepted work from review-skipped and blocked outcomes.
            if run_state in ("RUNNING", "PLANNED", "PAUSED", "ACTIVE"):
                status = "active"
            elif run_state in ("COMPLETED", "COMPLETED_OPERATOR_ACCEPTED", "DONE", "COMPLETE"):
                status = "completed"
            elif run_state == "COMPLETED_UNREVIEWED":
                status = "unreviewed"
            elif run_state == "REMEDIATION_EXHAUSTED":
                status = "blocked"
            elif run_state == "ABORTED" or "FAIL" in run_state:
                status = "failed"
            else:
                status = "unknown"
            # File mtime describes the last write, not necessarily the transition.
            # Do not invent a completion timestamp when the run has none.
            ended = None if status == "active" else (
                to_iso(st.get("endedAt")) or to_iso(st.get("completedAt"))
                or to_iso(st.get("finishedAt")))
            run_mode = str(st.get("mode") or ("consult" if d.parent.name == "consult" else "custom"))
            self.s.conn.execute(
                """INSERT INTO runs(run_id,kind,title,mode,roster,coordinator,stage,state,status,
                     started_at,ended_at,updated_at,workers,source,failed,completed)
                   VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                   ON CONFLICT(run_id) DO UPDATE SET roster=excluded.roster,stage=excluded.stage,
                     state=excluded.state,
                     status=CASE WHEN excluded.status='unknown' AND runs.status IS NOT NULL
                                 THEN runs.status ELSE excluded.status END,
                     updated_at=excluded.updated_at,
                     ended_at=COALESCE(excluded.ended_at, runs.ended_at),
                     workers=excluded.workers,failed=excluded.failed,completed=excluded.completed""",
                # Never persist state.json.task (it is prompt content). The run
                # ledger's allocation title is the only title source, and it is
                # bounded metadata that already exists in Discord.
                (run_id, run_mode, None,
                 run_mode, scrub(st.get("roster"), 80), "coordinator",
                 str(phase) if phase is not None else None, run_state, status, started, ended, updated,
                 len(st.get("workers") or seats), "run-state",
                 1 if status == "failed" else 0, 1 if status == "completed" else 0))
            self.s.add_event_once(f"run_state:{run_id}", {
                "ts": started, "category": "run", "kind": "run_started", "severity": "info",
                "status": "started", "run_id": run_id, "mode": str(st.get("mode") or "custom"),
                "agent": "coordinator", "stage": str(phase) if phase is not None else None,
                "detail": "run started", "source": "run-state"})
            if status in ("completed", "failed", "blocked", "unreviewed") and ended:
                kind = {"completed": "run_completed", "failed": "run_failed",
                        "blocked": "run_blocked", "unreviewed": "run_unreviewed"}[status]
                inserted = self.s.add_event_once(f"{kind}:{run_id}", {
                    "ts": ended, "category": "run", "kind": kind,
                    "severity": "info" if status in ("completed", "unreviewed") else "warning", "status": status,
                    "run_id": run_id, "agent": "coordinator", "stage": str(phase) if phase is not None else None,
                    "detail": f"{run_state} at phase {phase}", "source": "run-state"})
                if inserted:
                    self.s.bump_daily((ended or self.now)[:10], f"runs_{status}")
            # per-seat agents
            for seat in seats if isinstance(seats, list) else []:
                if not isinstance(seat, dict):
                    continue
                agent = str(seat.get("id") or seat.get("agent") or "")
                if not agent:
                    continue
                model = str(seat.get("model") or "")
                inserted = self.s.add_event_once(f"agent:{run_id}:{agent}", {
                    "ts": started, "category": "agent", "kind": "agent_assigned",
                    "severity": "info", "status": "assigned", "run_id": run_id, "agent": agent,
                    "model": model, "provider": provider_of(seat.get("engine"), model),
                    "stage": str(phase) if phase is not None else None,
                    "detail": scrub(seat.get("billingClass") or seat.get("kind"), 60),
                    "source": "run-state"})
                if inserted:
                    self.s.bump_daily(self.now[:10], "agent_assignments")
            seen += 1
        return {"runs": seen}

    # -- run.log ----------------------------------------------------
    def run_logs(self):
        dirs = [p for p in RUNS.iterdir() if p.is_dir() and re.match(r"^\d{4}-\d{2}-\d{2}T", p.name)]
        dirs.sort(key=lambda p: (p / "run.log").stat().st_mtime if (p / "run.log").exists() else 0, reverse=True)
        parsed = 0
        for d in dirs[:40]:
            path = d / "run.log"
            if not path.exists():
                continue
            cur = self.s.cursor(path)
            inode = path.stat().st_ino
            start = int(cur["offset"]) if cur["inode"] in (None, inode) else 0
            size = path.stat().st_size
            if size - start > 1_500_000:  # bounded catch-up
                start = size - 1_500_000
            run_id = d.name
            for end, raw in iter_jsonl_tail(path, start):
                start = end
                line = raw.decode("utf-8", "replace").strip()
                if not line.startswith("[") or "] " not in line:
                    continue
                stamp, text = line[1:].split("] ", 1)
                ts = to_iso(stamp)
                parsed += 1
                if "TO-OPERATOR: phase " in text and " started:" in text:
                    m = re.match(r"phase (\d+) started: (.*?)(?: — goal:|$)", text.split("TO-OPERATOR: ", 1)[1])
                    if m:
                        # Phase titles are plan text; keep the stage number only.
                        self.s.add_event_once(f"stage:{run_id}:{m.group(1)}", {
                            "ts": ts, "category": "run", "kind": "stage_started", "severity": "info",
                            "status": "running", "run_id": run_id, "agent": "coordinator",
                            "stage": m.group(1), "detail": f"phase {m.group(1)}", "source": "run.log"})
                elif re.match(r"seat \w+ phase \d+:", text):
                    m = re.match(r"seat (\w+) phase (\d+): (.*)", text)
                    if m:
                        agent, stage, what = m.group(1), m.group(2), m.group(3)
                        status = "waiting" if "WAIT" in what else "dispatched"
                        inserted = self.s.add_event_once(f"seat:{run_id}:{agent}:{stage}:{status}", {
                            "ts": ts, "category": "agent",
                            "kind": "agent_started" if status == "dispatched" else "agent_waiting",
                            "severity": "info", "status": status, "run_id": run_id, "agent": agent,
                            "stage": stage, "detail": f"{status} in phase {stage}", "source": "run.log"})
                        if status == "dispatched" and inserted:
                            self.s.bump_daily((ts or self.now)[:10], "agent_dispatches")
                elif ERROR_RX.search(text):
                    inserted = self.s.add_event({
                        "ts": ts, "category": "agent", "kind": "agent_error", "severity": "warn",
                        "status": "failed", "run_id": run_id,
                        "error_category": error_category(text),
                        "detail": f"{error_category(text)} error in phase {phase_of_log(text)}",
                        "source": "run.log", "dedup_key": f"err:{run_id}:{fmt_hash(normalize_error(text))}"})
                    if inserted:
                        self.s.bump_daily((ts or self.now)[:10], "agent_errors")
            self.s.save_cursor(path, start, inode, path.stat().st_mtime, parsed)
        return {"lines": parsed}

    # -- engine usage ------------------------------------------------
    def model_usage(self):
        path = RUNS / "engine-usage.jsonl"
        if not path.exists():
            return {"skipped": "absent"}
        cur = self.s.cursor(path)
        inode = path.stat().st_ino
        start = int(cur["offset"]) if cur["inode"] in (None, inode) else 0
        count = 0
        for end, line in iter_jsonl_tail(path, start):
            start = end
            try:
                row = json.loads(line.decode("utf-8", "replace"))
            except ValueError:
                continue
            ts = to_iso(row.get("timestamp"))
            if not ts:
                continue
            ok = bool(row.get("success"))
            model = str(row.get("model") or "")
            engine = str(row.get("engine") or "")
            measured_in, measured_out, cost = metered_outbound_fields(row)
            engine_name = str(row.get("engine") or "").lower()
            model_name = str(row.get("model") or "").lower()
            review_receiver = (engine_name in {"openai-sol", "chatgpt", "chatgpt-sol"} or
                               model_name.startswith("chatgpt/")) and measured_in is None and measured_out is None and cost is None
            cost_kind = "review_receiving_side" if review_receiver else ("reported" if cost is not None else "unknown")
            detail = f"{row.get('purpose') or row.get('component') or 'call'}"
            if row.get("fallbackFrom"):
                detail += f" (fallback from {row.get('fallbackFrom')})"
            if row.get("attempt") and int(row.get("attempt") or 1) > 1:
                detail += f" attempt {row.get('attempt')}"
            inserted = self.s.add_event({
                "ts": ts, "category": "model", "kind": "model_call",
                "severity": "info" if ok else "warn", "status": "ok" if ok else "failed",
                "run_id": str(row.get("runId") or "") or None, "agent": str(row.get("role") or row.get("component") or ""),
                "model": model, "provider": provider_of(engine, model), "mode": None,
                "duration_ms": int(row["durationMs"]) if isinstance(row.get("durationMs"), (int, float)) else None,
                "ok": 1 if ok else 0, "tokens_in": measured_in, "tokens_out": measured_out,
                "cost_usd": cost,
                "cost_kind": cost_kind, "error_category": None if ok else str(row.get("failureClass") or "UNKNOWN"),
                "detail": scrub(detail, 140), "source": "engine-usage",
                "dedup_key": f"model:{ts}:{row.get('runId')}:{fmt_hash(line.decode('utf-8', 'replace')[:400])}"})
            day = ts[:10]
            if inserted:
                self.s.bump_daily(day, "model_calls")
                if not ok:
                    self.s.bump_daily(day, "model_failed")
                if measured_in is not None:
                    self.s.bump_daily(day, "tokens_in", measured_in)
                if measured_out is not None:
                    self.s.bump_daily(day, "tokens_out", measured_out)
                if row.get("freebucksUsed"):
                    self.s.bump_daily(day, "freebucks", row["freebucksUsed"])
                if isinstance(cost, (int, float)):
                    self.s.bump_daily(day, "cost_reported_usd", cost)
            if row.get("fallbackFrom"):
                fallback_inserted = self.s.add_event({
                    "ts": ts, "category": "model", "kind": "model_fallback", "severity": "warn",
                    "status": "fallback", "run_id": row.get("runId"), "agent": row.get("role"),
                    "model": model, "provider": provider_of(engine, model),
                    "detail": f"{row.get('fallbackFrom')} -> {engine}/{model}", "source": "engine-usage",
                    "dedup_key": f"fb:{ts}:{row.get('runId')}:{row.get('fallbackFrom')}"})
                if fallback_inserted:
                    self.s.bump_daily(day, "fallbacks")
            if int(row.get("attempt") or 1) > 1 and inserted:
                self.s.bump_daily(day, "retries")
            count += 1
        self.s.save_cursor(path, start, inode, path.stat().st_mtime, count)
        return {"records": count}

    # -- Freebuff Desktop sessions -----------------------------------
    def desktop_sessions(self):
        """Session metadata for the desktop surface the operator actually uses.

        Reads only ids, model/mode fields, status and timestamps. Thread titles,
        prompts, message parts and drafts are never selected or persisted.
        A closed/locked store is a failed source, never a failed harness turn.
        """
        now = time.time()
        kept = 0
        for path in sorted(glob.glob(DESKTOP_DB_GLOB)):
            try:
                conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=4)
            except sqlite3.Error as exc:
                raise RuntimeError(f"{Path(path).name}: {exc}") from exc
            try:
                conn.row_factory = sqlite3.Row
                rows = conn.execute(
                    "SELECT id,status,harness_id,model,agent_mode,execution_mode,created_at,"
                    "updated_at,last_prompt_at,last_turn_finished_at,last_turn_outcome,"
                    "turn_alive_at,queue_paused FROM threads WHERE status='open' "
                    "AND updated_at >= ? ORDER BY updated_at DESC LIMIT 60",
                    (int(now * 1000) - 7 * 86400 * 1000,)).fetchall()
                for row in rows:
                    last_msg = conn.execute(
                        "SELECT MAX(ts) FROM messages WHERE thread_id=?", (row["id"],)).fetchone()[0]
                    messages = conn.execute(
                        "SELECT COUNT(*) FROM messages WHERE thread_id=?", (row["id"],)).fetchone()[0]
                    stamps = [t for t in (row["updated_at"], row["last_prompt_at"],
                                          row["turn_alive_at"], last_msg)
                              if isinstance(t, (int, float)) and t > 0]
                    last = max(stamps) / 1000 if stamps else None
                    # Liveness is a pure function of the latest observed
                    # activity, so a cached row can never pin itself to running.
                    state = "inactive"
                    if last:
                        age = now - last
                        state = "running" if age < 180 else ("idle" if age < 1200 else "inactive")
                    last_iso = now_iso(last) if last else None
                    started = now_iso(row["created_at"] / 1000) if row["created_at"] else None
                    self.s.conn.execute(
                        "INSERT INTO sessions(session_id,surface,harness,model,agent_mode,"
                        "execution_mode,status,state,started_at,last_activity,last_turn_outcome,"
                        "queue_paused,messages,live,source,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) "
                        "ON CONFLICT(session_id) DO UPDATE SET harness=excluded.harness,"
                        "model=excluded.model,agent_mode=excluded.agent_mode,"
                        "execution_mode=excluded.execution_mode,status=excluded.status,"
                        "state=excluded.state,last_activity=excluded.last_activity,"
                        "last_turn_outcome=excluded.last_turn_outcome,"
                        "queue_paused=excluded.queue_paused,messages=excluded.messages,"
                        "live=excluded.live,updated_at=excluded.updated_at",
                        (str(row["id"]), "freebuff-desktop", scrub(row["harness_id"], 40),
                         scrub(row["model"], 80), scrub(row["agent_mode"], 40),
                         scrub(row["execution_mode"], 40), str(row["status"]), state,
                         started, last_iso, scrub(row["last_turn_outcome"], 60),
                         1 if row["queue_paused"] else 0, int(messages or 0),
                         1 if state in ("running", "idle") else 0, "desktop-v2", now_iso()))
                    kept += 1
            except sqlite3.Error as exc:
                raise RuntimeError(f"{Path(path).name}: {exc}") from exc
            finally:
                conn.close()
        # Recompute every stored row from its own timestamp. This is what makes
        # a session that disappeared from the source (closed thread, removed
        # project) expire instead of keeping the `running` state it had when it
        # was last observed. A failed source raises before this point, so a
        # transient read error never discards valid live state.
        self.s.conn.execute(
            "UPDATE sessions SET state=CASE "
            "WHEN COALESCE(last_activity,'')='' THEN 'inactive' "
            "WHEN last_activity >= ? THEN 'running' "
            "WHEN last_activity >= ? THEN 'idle' ELSE 'inactive' END, "
            "live=CASE WHEN COALESCE(last_activity,'') >= ? THEN 1 ELSE 0 END",
            (now_iso(now - 180), now_iso(now - 1200), now_iso(now - 1200)))
        return {"sessions": kept}

    # -- Sol reviews -------------------------------------------------
    def reviews(self):
        pointers = sorted(RUNS.glob("session-consult-*.json"), key=lambda p: p.stat().st_mtime, reverse=True)[:120]
        count = 0
        for path in pointers:
            data = read_json(path)
            if not isinstance(data, dict):
                continue
            consult = str(data.get("consultId") or path.stem)
            turn = str(data.get("turn") or "1")
            started = to_iso(data.get("dispatchedAt"))
            updated = to_iso(data.get("updatedAt")) or now_iso(path.stat().st_mtime)
            state = str(data.get("state") or "UNKNOWN")
            self.s.add_event_once(f"review_started:{consult}", {
                "ts": started, "category": "review", "kind": "review_started", "severity": "info",
                "status": "started", "run_id": consult, "agent": "sol", "model": str(data.get("engine") or "openai-sol"),
                "provider": "openai", "detail": scrub(data.get("engine"), 60), "source": "consult-pointer"})
            if state == "RESULT":
                verdict = self.verdict_of(data)
                duration = None
                # Only a first turn has a trustworthy start time; a continuation
                # reuses the consult's dispatchedAt, so its duration is unknown.
                if started and updated and turn == "1":
                    a, b = parse_iso(started), parse_iso(updated)
                    if a and b:
                        duration = int((b - a).total_seconds() * 1000)
                # One consult turn is one review iteration. The identity carries
                # no verdict, so a later observation of the same turn can only
                # refresh the recorded fields - never add an iteration or a
                # counter - and an unattributable reply is `unknown`.
                status = verdict or "unknown"
                severity = "warn" if status in REVISION_VERDICTS else "info"
                detail = f"turn {turn} verdict {status}; reply {int(data.get('replyChars') or 0)} chars"
                review_key = f"review_result:{consult}:turn-{turn}"
                inserted = self.s.add_event_once(review_key, {
                    "ts": updated, "category": "review", "kind": "review_completed",
                    "severity": severity, "status": status,
                    "run_id": consult, "agent": "sol", "model": str(data.get("engine") or "openai-sol"),
                    "provider": "openai", "duration_ms": duration, "ok": 1 if data.get("ok") else 0,
                    "stage": turn, "detail": detail, "source": "consult-pointer"})
                if not inserted:
                    self.s.refresh_event(review_key, status=status, severity=severity, detail=detail)
                if inserted:
                    self.s.bump_daily(updated[:10], "reviews")
                    if status in REVISION_VERDICTS:
                        self.s.bump_daily(updated[:10], "review_revisions")
                    if "PASS" in status or status.startswith("APPROVE") or status == "ACCEPTED":
                        self.s.bump_daily(updated[:10], "review_passes")
            elif state in REVIEW_ERROR_STATES:
                failed_inserted = self.s.add_event_once(f"review_failed:{consult}:turn-{turn}", {
                    "ts": updated, "category": "review", "kind": "review_failed", "severity": "error",
                    "status": "failed", "run_id": consult, "agent": "sol",
                    "error_category": "consult-failed", "detail": scrub(data.get("note") or state, 160),
                    "source": "consult-pointer"})
                if failed_inserted:
                    self.s.bump_daily(updated[:10], "review_failures")
            count += 1
        return {"pointers": count}

    def verdict_of(self, data) -> str | None:
        """Verdict of the CURRENT consultant turn only.

        Attribution rules (Sol review 2026-10-24):
          - only the last `## CONSULTANT ...` block is authoritative; earlier
            turns (including an earlier APPROVE) never decide this turn;
          - only an explicit verdict line (`VERDICT: ...`, `FINAL ... DECISION:
            ...`, `SIGNOFF: ...`) decides, and the LAST such line wins;
          - prose mentioning an earlier verdict ("the previous verdict was
            APPROVE") never decides this turn;
          - no explicit verdict line => None (stored as `unknown`), never a
            guess from unrelated text.
        """
        transcript = data.get("transcriptFile")
        if not transcript:
            return None
        path = Path(str(transcript))
        try:
            with path.open("rb") as fh:
                fh.seek(0, os.SEEK_END)
                size = fh.tell()
                fh.seek(max(0, size - 20000))
                text = fh.read().decode("utf-8", "replace")
        except OSError:
            return None
        blocks = re.split(r"(?m)^##\s+CONSULTANT.*$", text)
        if len(blocks) < 2:
            return None
        block = blocks[-1]
        explicit = None
        for line in block.splitlines():
            hit = explicit_verdict_line(line)
            if hit:
                explicit = hit
        return explicit

    # -- nanny alerts ------------------------------------------------
    def alerts(self):
        path = RUNS / "nanny-alerts.jsonl"
        if not path.exists():
            return {"skipped": "absent"}
        cur = self.s.cursor(path)
        inode = path.stat().st_ino
        start = int(cur["offset"]) if cur["inode"] in (None, inode) else 0
        count = 0
        for end, raw in iter_jsonl_tail(path, start):
            start = end
            try:
                row = json.loads(raw.decode("utf-8", "replace"))
            except ValueError:
                continue
            ts = to_iso(row.get("at")) or now_iso()
            severity = str(row.get("severity") or "warning").lower()
            msg = scrub(row.get("msg"), 160)
            if not msg:
                continue
            name = str(row.get("source") or "orch-nanny")
            self.s.conn.execute(
                """INSERT INTO nanny_events(name,last_decision,last_ts,detail) VALUES(?,?,?,?)
                   ON CONFLICT(name) DO UPDATE SET last_decision=excluded.last_decision,
                     last_ts=excluded.last_ts, detail=excluded.detail""",
                (name, severity, ts, msg))
            inserted = self.s.add_event({
                "ts": ts, "category": "operator", "kind": "operator_alert",
                "severity": "error" if severity in ("critical", "crit", "error") else "warn",
                "status": "alert", "session_id": scrub(row.get("session"), 60) or None,
                "error_category": name, "detail": msg, "source": "nanny-alerts",
                "dedup_key": f"alert:{name}:{fmt_hash(normalize_error(msg))}"})
            if inserted:
                self.s.bump_daily(ts[:10], "alerts")
            count += 1
        self.s.save_cursor(path, start, inode, path.stat().st_mtime, count)
        return {"alerts": count}

    # -- closeout receipts -------------------------------------------
    def closeouts(self):
        base = HUB / ".state" / "closeout-receipts"
        if not base.exists():
            return {"skipped": "absent"}
        files = sorted(base.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)[:400]
        count = 0
        for path in files:
            data = read_json(path)
            if not isinstance(data, dict):
                continue
            ts = to_iso(data.get("timestamp")) or now_iso(path.stat().st_mtime)
            result = str(data.get("result") or "UNKNOWN")
            advisory = (data.get("advisory") or {}).get("status") if isinstance(data.get("advisory"), dict) else None
            closeout_inserted = self.s.add_event_once(f"closeout:{path.name}", {
                "ts": ts, "category": "operator", "kind": "closeout",
                "severity": "info" if result == "PASS" else "error", "status": result,
                "ok": 1 if result == "PASS" else 0, "stage": str(data.get("evidenceLevel") or "legacy"),
                "detail": scrub(f"{result} ({data.get('evidenceLevel')}, verified={bool(data.get('verified'))})", 160),
                "source": "closeout-receipt"})
            if closeout_inserted:
                if result == "PASS":
                    self.s.bump_daily(ts[:10], "closeouts")
                else:
                    self.s.bump_daily(ts[:10], "closeout_failures")
            if advisory:
                self.s.add_event_once(f"advisory:{path.name}:{advisory}", {
                    "ts": ts, "category": "operator", "kind": "advisory_" + str(advisory).lower(),
                    "severity": "warn" if advisory != "QUEUED" else "info", "status": str(advisory),
                    "detail": scrub(f"documentation advisory {advisory}", 100), "source": "closeout-receipt"})
            count += 1
        return {"receipts": count}

    # -- tool decisions ---------------------------------------------
    def tool_audit(self):
        if not AUDIT.exists():
            return {"skipped": "absent"}
        cur = self.s.cursor(AUDIT)
        inode = AUDIT.stat().st_ino
        size = AUDIT.stat().st_size
        if cur["inode"] is None:  # first sight: start at EOF, no history replay
            self.s.save_cursor(AUDIT, size, inode, AUDIT.stat().st_mtime, 0)
            self.s.add_event_once("audit_initialized", {
                "ts": now_iso(), "category": "tool", "kind": "ingest_initialized", "severity": "info",
                "status": "ok", "detail": "tool-decision tail starts at current end of the audit log",
                "source": "capability-audit"})
            return {"initialized": True}
        start = int(cur["offset"]) if cur["inode"] == inode else 0
        rate = float(self.s.setting("sampling_tools"))
        count = kept = 0
        for end, raw in iter_jsonl_tail(AUDIT, start):
            start = end
            count += 1
            if count > 4000:
                break
            try:
                row = json.loads(raw.decode("utf-8", "replace"))
            except ValueError:
                continue
            decision = str(row.get("decision") or "")
            ts = to_iso(row.get("ts")) or now_iso()
            tool = scrub(row.get("tool"), 40) or "tool"
            session = scrub(row.get("sessionID"), 80) or None
            if decision in ("DENY", "ERROR", "DENY-CRED", "CRED_DENY", "REVIEW_DENY"):
                kept += 1
                self.s.add_event({
                    "ts": ts, "category": "tool", "kind": "tool_denied" if "DENY" in decision else "tool_error",
                    "severity": "warn", "status": decision.lower(), "session_id": session, "tool": tool,
                    "error_category": decision, "detail": scrub(row.get("reason"), 160),
                    "source": "capability-audit",
                    "dedup_key": f"tool:{decision}:{tool}:{fmt_hash(normalize_error(row.get('reason') or ''))}"})
            elif decision in ("TASK_DENY", "REVIEW_GRANT", "TASK_CONFLICT"):
                kept += 1
                self.s.add_event({
                    "ts": ts, "category": "operator", "kind": "gate_decision", "severity": "warn",
                    "status": decision.lower(), "session_id": session, "tool": tool,
                    "detail": scrub(row.get("reason"), 160), "source": "capability-audit",
                    "dedup_key": f"gate:{decision}:{ts}:{fmt_hash(str(row.get('reason'))[:200])}"})
            elif decision == "ALLOW":
                bucket = int(hashlib.sha1(raw).hexdigest(), 16) % 1000
                if bucket < int(rate * 1000):
                    kept += 1
                    self.s.add_event({
                        "ts": ts, "category": "tool", "kind": "tool_call", "severity": "info",
                        "status": "ok", "session_id": session, "tool": tool,
                        "detail": "allowed (sampled)", "source": "capability-audit",
                        "dedup_key": f"allow:{fmt_hash(raw.decode('utf-8', 'replace'))}"})
                else:
                    self.s.counter("sampled_out")
        self.s.save_cursor(AUDIT, start, inode, AUDIT.stat().st_mtime, count)
        return {"lines": count, "kept": kept}


def phase_of_log(text: str) -> str:
    m = re.search(r"\bphase (\d+)\b", str(text))
    return m.group(1) if m else "?"


def error_category(text: str) -> str:
    low = str(text).lower()
    for name, rx in (
        ("auth", r"401|403|unauthor|forbidden|permission denied"),
        ("rate-limit", r"429|rate.?limit|quota|too many"),
        ("timeout", r"timeout|timed out|deadline"),
        ("network", r"connection|refused|reset|unreachable|dns|socket"),
        ("not-found", r"not found|no such"),
        ("conflict", r"conflict|already exists|locked"),
        ("validation", r"invalid|malformed|schema|parse"),
    ):
        if re.search(rx, low):
            return name
    return "other"


def vocab_in(text: str) -> str | None:
    """First vocabulary verdict in one line, ordered by specificity."""
    for name, rx in VERDICTS:
        if rx.search(text):
            return name
    return None


EXPLICIT_VERDICT_RX = re.compile(
    r"(?i)^(?:final\s+)?(?:sol\s+)?(?:verdict|decision|signoff)\s*[:=]\s*(.*)$")
VERDICT_DECORATION_RX = re.compile(r"[*`_]+")


def explicit_verdict_line(line: str) -> str | None:
    """Verdict stated by an explicit verdict line, or None.

    Accepts Markdown decoration on either side of the field name, e.g.
    `**VERDICT**: HOLD`, `` `DECISION`: APPROVE ``, `- **SIGNOFF**: REJECT`,
    while keeping the anchor strict: the marker must be the line's own leading
    token. Prose such as "The previous verdict was APPROVE" never matches.
    """
    text = line.strip().lstrip("#>-*_` \t")
    text = VERDICT_DECORATION_RX.sub("", text).strip()
    match = EXPLICIT_VERDICT_RX.match(text)
    if not match:
        return None
    return vocab_in(match.group(1))


def normalize_error(text: str) -> str:
    value = re.sub(r"\b\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?\b", "<ts>", str(text))
    value = re.sub(r"\b[0-9a-f]{8,}\b", "<id>", value)
    value = re.sub(r"0x[0-9a-f]+", "<hex>", value)
    value = re.sub(r"\d+", "<n>", value)
    return value.lower().strip()[:160]


# ---------------------------------------------------------------- queries
class Harness:
    """Read-side facade used by the dashboard HTTP layer."""

    def __init__(self, state_dir: Path | str | None = None):
        self.state_dir = Path(state_dir or STATE)
        self.db_path = self.state_dir / "harness.db"
        self._store = None

    @property
    def store(self) -> Store:
        if self._store is None:
            self._store = Store(self.db_path)
        return self._store

    def close(self):
        if self._store:
            self._store.close()
            self._store = None

    # -- helpers -----------------------------------------------------
    @staticmethod
    def _range_start(range_key: str) -> str:
        windows = {"1h": 3600, "6h": 21600, "24h": 86400, "7d": 604800, "30d": 2592000, "90d": 7776000}
        seconds = windows.get(range_key, 86400)
        start = dt.datetime.now(dt.timezone.utc) - dt.timedelta(seconds=seconds)
        return start.strftime("%Y-%m-%dT%H:%M:%SZ")

    def _q(self, sql, args=()):
        return [dict(r) for r in self.store.conn.execute(sql, args).fetchall()]

    def _coverage(self, requested_start: str | None = None):
        """Retain coverage reporting for the store, not a second data source.

        Detail events are pruned after `detail_days`; daily aggregates outlive
        them. Any window asking beyond that boundary is only complete down to
        the earliest retained sample, so callers must disclose the boundary
        instead of implying a fully covered window.
        """
        earliest_event = self.store.conn.execute(
            "SELECT MIN(ts) v FROM events").fetchone()["v"]
        day_row = self.store.conn.execute(
            "SELECT MIN(day) a, MAX(day) b FROM daily").fetchone()
        terminal = self.store.conn.execute(
            "SELECT COUNT(*) n FROM runs WHERE status IN ('completed','failed') "
            "AND started_at IS NOT NULL AND ended_at IS NULL").fetchone()["n"]
        # Boundary comparison uses the parsed timestamps, not calendar dates: a
        # window starting earlier on the SAME day as the earliest retained event
        # must still be reported as partial. With no retained events at all the
        # coverage of any requested window is unknown, never "fully covered".
        partial_dt = parse_iso(earliest_event)
        start_dt = parse_iso(requested_start) if requested_start else None
        # Strictly greater: a window starting exactly AT the earliest retained
        # event covers every retained sample from its own beginning (Sol turn 3:
        # equality alone does not establish a truncated window).
        partial = (partial_dt is not None and start_dt is not None
                   and partial_dt > start_dt)
        unknown = requested_start is not None and earliest_event is None
        note = None
        if requested_start is not None:
            if unknown:
                note = "no retained detail events; per-event metrics cover nothing yet"
            elif partial:
                note = ("window extends past retained detail events; per-event metrics "
                        "cover only the retained range")
            else:
                note = "window start is within retained detail coverage"
        return {
            "earliest_event": earliest_event,
            "earliest_aggregate_day": day_row["a"],
            "latest_aggregate_day": day_row["b"],
            "terminal_runs_missing_ended_at": int(terminal),
            "window_fully_covered": requested_start is None or (not partial and not unknown),
            "note": note,
        }

    # -- overview ----------------------------------------------------
    def overview(self, range_key="24h"):
        start = self._range_start(range_key)
        runs = self._q("SELECT * FROM runs WHERE COALESCE(started_at,'') >= ? OR status='active'", (start,))
        active = [r for r in runs if r["status"] == "active"]
        done = [r for r in runs if r["status"] == "completed"]
        failed = [r for r in runs if r["status"] == "failed"]
        durations = []
        for r in done + failed:
            a, b = parse_iso(r["started_at"]), parse_iso(r["ended_at"])
            if a and b and b > a:
                durations.append((b - a).total_seconds() * 1000)
        models = self._q("SELECT COUNT(*) n, SUM(CASE WHEN ok=0 THEN 1 ELSE 0 END) failed, "
                         "SUM(COALESCE(tokens_in,0)) tin, SUM(COALESCE(tokens_out,0)) tout, "
                         "SUM(CASE WHEN cost_kind='reported' THEN COALESCE(cost_usd,0) ELSE 0 END) cost, "
                         "SUM(CASE WHEN cost_kind='reported' THEN 1 ELSE 0 END) reported "
                         "FROM events WHERE category='model' AND ts >= ?", (start,))[0]
        alerts = self._q("SELECT id,ts,kind,severity,status,tool,agent,run_id,detail,occurrences FROM events "
                         "WHERE category IN ('operator','tool') AND severity IN ('warn','error','critical') "
                         "AND ts >= ? ORDER BY ts DESC LIMIT 8", (start,))
        reviews = self._q("SELECT kind,status,COUNT(*) n FROM events WHERE category='review' AND ts >= ? "
                          "GROUP BY kind,status", (start,))
        return {
            "range": range_key,
            "active_runs": len(active),
            "desktop_sessions": self._q(
                "SELECT COUNT(*) n FROM sessions WHERE live=1 AND status='open'")[0]["n"],
            "active_agents": len({(r["run_id"], a) for r in active for a in self._agents_of(r["run_id"])})
                             + self._q("SELECT COUNT(*) n FROM sessions WHERE live=1 AND status='open'")[0]["n"],
            "completed": len(done),
            "failed": len(failed),
            "success_rate": round(len(done) / (len(done) + len(failed)), 4) if (done or failed) else None,
            "avg_ms": int(sum(durations) / len(durations)) if durations else None,
            "median_ms": int(median(durations)) if durations else None,
            "model_calls": int(models["n"] or 0),
            "model_failures": int(models["failed"] or 0),
            "tokens_in": int(models["tin"] or 0),
            "tokens_out": int(models["tout"] or 0),
            "cost_usd": round(float(models["cost"]), 6) if models["reported"] else None,
            "cost_status": "reported" if models["reported"] else "unknown",
            "alerts": alerts,
            "reviews": reviews,
            "telemetry": self.health(),
        }

    def _agents_of(self, run_id):
        rows = self._q("SELECT DISTINCT agent FROM events WHERE run_id=? AND agent IS NOT NULL", (run_id,))
        return [r["agent"] for r in rows]

    # -- live agents -------------------------------------------------
    def agents(self):
        runs = self._q("SELECT * FROM runs WHERE status='active' ORDER BY started_at DESC LIMIT 30")
        now = dt.datetime.now(dt.timezone.utc)
        out = []
        for r in runs:
            events = self._q(
                "SELECT kind,agent,model,provider,stage,status,ts,detail,duration_ms FROM events "
                "WHERE run_id=? AND category IN ('agent','model','run') ORDER BY ts DESC LIMIT 200", (r["run_id"],))
            seats = {}
            for ev in reversed(events):
                agent = ev["agent"] or "coordinator"
                if ev["kind"] in ("agent_assigned", "agent_started", "agent_waiting", "agent_error"):
                    cur = seats.setdefault(agent, {"agent": agent, "model": None, "provider": None,
                                                   "stage": None, "status": "assigned", "started_at": None,
                                                   "last_event": None, "duration_ms": None})
                    cur["model"] = cur["model"] or ev["model"]
                    cur["provider"] = cur["provider"] or ev["provider"]
                    cur["stage"] = ev["stage"] or cur["stage"]
                    cur["status"] = "error" if ev["kind"] == "agent_error" else ev["status"] or cur["status"]
                    cur["started_at"] = cur["started_at"] or ev["ts"]
                    cur["last_event"] = ev["ts"]
            updated = parse_iso(r["updated_at"])
            stale = bool(updated and not r["ended_at"] and (now - updated).total_seconds() > 900)
            for seat in seats.values():
                a = parse_iso(seat["started_at"])
                seat["duration_ms"] = int((now - a).total_seconds() * 1000) if a else None
            out.append({"run_id": r["run_id"], "title": r["title"], "mode": r["mode"], "stage": r["stage"],
                        "state": r["state"], "roster": r["roster"], "started_at": r["started_at"],
                        "updated_at": r["updated_at"], "stale": stale,
                        "coordinator": {"agent": "coordinator", "model": None,
                                        "stage": r["stage"], "status": "active" if not stale else "stale"},
                        "agents": sorted(seats.values(), key=lambda x: x["agent"])})
        cutoff = now_iso(now.timestamp() - 7200)
        sessions = self._q(
            "SELECT session_id,surface,harness,model,agent_mode,execution_mode,status,state,"
            "started_at,last_activity,last_turn_outcome,queue_paused,live,messages "
            "FROM sessions WHERE status='open' AND COALESCE(last_activity,'') >= ? "
            "ORDER BY last_activity DESC LIMIT 30", (cutoff,))
        for row in sessions:
            last = parse_iso(row["last_activity"])
            row["age_ms"] = int((now - last).total_seconds() * 1000) if last else None
        return {"runs": out, "sessions": sessions, "generated_at": now_iso()}

    # -- runs --------------------------------------------------------
    def runs(self, params: dict):
        start = self._range_start(params.get("range", "30d"))
        clauses = ["(COALESCE(started_at,'') >= ? OR status='active')"]
        args = [start]
        for field, column in (("mode", "mode"), ("status", "status"), ("agent", None)):
            value = (params.get(field) or "").strip()
            if not value:
                continue
            if field == "agent":
                clauses.append("run_id IN (SELECT run_id FROM events WHERE agent=?)")
                args.append(value)
            else:
                clauses.append(f"{column}=?")
                args.append(value)
        if params.get("failure"):
            clauses.append("status='failed'")
        if params.get("model"):
            clauses.append("run_id IN (SELECT run_id FROM events WHERE model=? AND category='model')")
            args.append(params["model"])
        if params.get("provider"):
            clauses.append("run_id IN (SELECT run_id FROM events WHERE provider=? AND category='model')")
            args.append(params["provider"])
        q = (params.get("q") or "").strip()
        if q:
            clauses.append("(COALESCE(title,'') LIKE ? OR run_id LIKE ?)")
            args += [f"%{q}%", f"%{q}%"]
        limit = min(200, max(1, int(params.get("limit", 50))))
        page = max(1, int(params.get("page", 1)))
        where = " AND ".join(clauses)
        total = self._q(f"SELECT COUNT(*) n FROM runs WHERE {where}", args)[0]["n"]
        rows = self._q(f"SELECT * FROM runs WHERE {where} ORDER BY COALESCE(started_at,'') DESC LIMIT ? OFFSET ?",
                       args + [limit, (page - 1) * limit])
        return {"total": total, "page": page, "page_size": limit, "runs": rows,
                "facets": {"agents": self._q("SELECT DISTINCT agent FROM events WHERE agent IS NOT NULL ORDER BY agent"),
                           "models": self._q("SELECT DISTINCT model FROM events WHERE model IS NOT NULL ORDER BY model"),
                           "providers": self._q("SELECT DISTINCT provider FROM events WHERE provider IS NOT NULL ORDER BY provider"),
                           "modes": self._q("SELECT DISTINCT mode FROM runs WHERE mode IS NOT NULL ORDER BY mode")}}

    def run_detail(self, run_id: str):
        rows = self._q("SELECT * FROM runs WHERE run_id=?", (run_id,))
        if not rows:
            raise FileNotFoundError(f"unknown run: {run_id}")
        run = rows[0]
        events = self._q("SELECT ts,category,kind,severity,status,agent,model,provider,stage,tool,duration_ms,ok,"
                         "tokens_in,tokens_out,cost_usd,cost_kind,detail,occurrences FROM events "
                         "WHERE run_id=? ORDER BY ts ASC LIMIT 800", (run_id,))
        stages = []
        for ev in events:
            if ev["kind"] == "stage_started":
                stages.append({"stage": ev["stage"], "started_at": ev["ts"], "title": ev["detail"]})
        for i, st in enumerate(stages):
            end = parse_iso(stages[i + 1]["started_at"]) if i + 1 < len(stages) else parse_iso(run["ended_at"])
            a = parse_iso(st["started_at"])
            if a and end:
                st["duration_ms"] = int((end - a).total_seconds() * 1000)
        reviews = self._q("SELECT status,COUNT(*) n,MIN(ts) first_ts FROM events WHERE run_id=? "
                          "AND category='review' GROUP BY status", (run_id,))
        return {"run": run, "events": events, "stages": stages,
                "review_iterations": sum(int(r["n"]) for r in reviews),
                "review_correlation": ("matched by run id" if reviews else
                                       "unavailable: Sol consults record their own consult id, not the kit run id"),
                "reviews": reviews, "outcome": run["status"]}

    # -- performance -------------------------------------------------
    def performance(self, range_key="7d"):
        start = self._range_start(range_key)
        coverage = self._coverage(start)
        terminal = self._q("SELECT started_at,ended_at,status FROM runs "
                           "WHERE status IN ('completed','failed') "
                           "AND COALESCE(ended_at,'') >= ?", (start,))
        # Completion duration is measured on COMPLETED runs; failed runs are
        # reported separately so failure time can never inflate throughput.
        completed = [r for r in terminal if r["status"] == "completed"]
        durations, by_day = [], {}
        for r in completed:
            a, b = parse_iso(r["started_at"]), parse_iso(r["ended_at"])
            if a and b and b > a:
                ms = (b - a).total_seconds() * 1000
                durations.append(ms)
                by_day[b.strftime("%Y-%m-%d")] = by_day.get(b.strftime("%Y-%m-%d"), 0) + 1
        # Terminal-status runs with no recorded end timestamp: the completed
        # count above is measured only where a real end was recorded, so the
        # remaining runs stay unknown rather than being inferred from mtimes.
        undone = self._q("SELECT COUNT(*) n FROM runs WHERE status IN ('completed','failed','blocked','unreviewed') "
                         "AND COALESCE(ended_at,'') = '' AND COALESCE(started_at,'') >= ?", (start,))[0]["n"]
        stages = self._q("SELECT run_id,stage,ts,detail FROM events WHERE kind='stage_started' AND ts >= ? "
                         "ORDER BY run_id,ts", (start,))
        stage_rows = []
        for i, row in enumerate(stages):
            end = None
            for nxt in stages[i + 1:]:
                if nxt["run_id"] != row["run_id"]:
                    break
                end = parse_iso(nxt["ts"])
                break
            a = parse_iso(row["ts"])
            if a and end:
                stage_rows.append({"stage": row["stage"], "title": row["detail"],
                                   "ms": (end - a).total_seconds() * 1000})
        model_latency = [r["duration_ms"] for r in self._q(
            "SELECT duration_ms FROM events WHERE category='model' AND duration_ms IS NOT NULL AND ts >= ?", (start,))]
        tool_latency_rows = self._q(
            "SELECT COUNT(*) n FROM events WHERE category='tool' AND duration_ms IS NOT NULL AND ts >= ?", (start,))
        fallback = self._q("SELECT COUNT(*) n FROM events WHERE kind='model_fallback' AND ts >= ?", (start,))[0]["n"]
        # Retries are counted exactly like the ingest side: attempt >= 2 rows
        # from engine-usage. The summed duration is the full wall-clock time of
        # those retry attempts (each attempt's own model-call time), not merely
        # the incremental overhead on top of a hypothetical first-success call,
        # which this ledger does not retain as a separate measurement.
        retries = self._q("SELECT COUNT(*) n, COALESCE(SUM(duration_ms),0) ms FROM events WHERE category='model' "
                          "AND detail LIKE '%attempt %' AND ts >= ?", (start,))[0]
        review_rounds = self._q("SELECT COUNT(*) n FROM events WHERE kind IN ('review_completed','review_failed') "
                                "AND ts >= ?", (start,))[0]["n"]
        return {
            "range": range_key,
            "coverage": dict(coverage, terminal_in_window=undone),
            "refresh_seconds": int(float(self.store.setting("dashboard_refresh_seconds"))),
            "completion_ms": {"p50": percentile(durations, 0.5), "p95": percentile(durations, 0.95),
                              "p99": percentile(durations, 0.99), "samples": len(durations)},
            "throughput_per_day": by_day,
            "stage_duration_ms": stage_rows[:200],
            "model_latency_ms": {"p50": percentile(model_latency, 0.5), "p95": percentile(model_latency, 0.95),
                                 "samples": len(model_latency)},
            "tool_latency_ms": {"p50": None, "p95": None, "samples": int(tool_latency_rows[0]["n"]),
                                "unavailable_reason": "the existing tool audit records decisions, not durations"},
            "fallbacks": int(fallback),
            "retries": int(retries["n"] or 0),
            "retry_attempt_ms": int(retries["ms"] or 0),
            "retry_definition": "count and summed wall-clock duration_ms of retry attempts "
                                "(attempt >= 2) from engine-usage; each attempt's full "
                                "model-call duration is included, the pre-retry wasted "
                                "time is not retained as a separate measurement",
            "review_iterations": int(review_rounds),
            "reviews_per_completed_run": round(review_rounds / len(completed), 3) if completed else None,
            "queue_wait_ms": {"unavailable_reason": "existing ledgers record the run's started_at, "
                                "not its work-queue enqueue time; enqueue and start are "
                                "not separately retained"},
            "failed_or_abandoned": sum(1 for r in terminal if r["status"] == "failed"),
            "completion_incomplete": int(undone),
            "sample_note": "percentiles are null when the range has no samples",
        }

    # -- usage -------------------------------------------------------
    def usage(self, range_key="30d"):
        start = self._range_start(range_key)
        rows = self._q(
            "SELECT model,provider,agent,mode,COUNT(*) calls,SUM(CASE WHEN ok=0 THEN 1 ELSE 0 END) failed,"
            "COALESCE(SUM(tokens_in),0) tin,COALESCE(SUM(tokens_out),0) tout,"
            "SUM(CASE WHEN tokens_in IS NOT NULL THEN 1 ELSE 0 END) tin_samples,"
            "SUM(CASE WHEN tokens_out IS NOT NULL THEN 1 ELSE 0 END) tout_samples,"
            "SUM(CASE WHEN cost_kind='reported' THEN COALESCE(cost_usd,0) ELSE 0 END) cost,"
            "SUM(CASE WHEN cost_kind='reported' THEN 1 ELSE 0 END) reported_calls,"
            "SUM(CASE WHEN ok=1 AND cost_kind!='reported' THEN 1 ELSE 0 END) unknown_cost_calls "
            "FROM events WHERE category='model' AND cost_kind!='review_receiving_side' AND ts >= ? GROUP BY model,provider,agent,mode "
            "ORDER BY tout DESC LIMIT 500", (start,))
        by_day = self._q("SELECT day,metric,value FROM daily WHERE metric IN "
                         "('tokens_in','tokens_out','model_calls','freebucks','cost_reported_usd') AND day >= ? "
                         "ORDER BY day", (start[:10],))
        completed = self._q("SELECT COUNT(*) n FROM runs WHERE status='completed' AND COALESCE(ended_at,'') >= ?",
                            (start,))[0]["n"]
        reported = sum(r["reported_calls"] for r in rows)
        cost = round(sum(r["cost"] for r in rows), 6) if reported else None
        return {
            "range": range_key,
            "refresh_seconds": int(float(self.store.setting("dashboard_refresh_seconds"))),
            "by_model": rows,
            "calls_without_input_tokens": sum(int(r["calls"] or 0) - int(r["tin_samples"] or 0) for r in rows),
            "calls_without_output_tokens": sum(int(r["calls"] or 0) - int(r["tout_samples"] or 0) for r in rows),
            "daily": by_day,
            "paid_calls": reported,
            "estimated_usd": None,
            "reported_usd": cost,
            "cost_status": "reported" if reported else "unknown",
            "cost_note": "Only verified outbound provider charges are counted; receiving-side Sol/ChatGPT reviews are excluded from token and cost usage. Subscription usage is never priced as spend.",
            "cost_per_completed_task": round(cost / completed, 6) if cost is not None and completed else None,
            "completed_tasks": int(completed),
        }

    # -- events ------------------------------------------------------
    def events(self, params: dict):
        clauses, args = ["1=1"], []
        if params.get("category"):
            clauses.append("category=?"); args.append(params["category"])
        if params.get("severity"):
            clauses.append("severity=?"); args.append(params["severity"])
        if params.get("kind"):
            clauses.append("kind=?"); args.append(params["kind"])
        if params.get("range"):
            clauses.append("ts >= ?"); args.append(self._range_start(params["range"]))
        limit = min(300, max(1, int(params.get("limit", 80))))
        rows = self._q("SELECT id,ts,category,kind,severity,status,run_id,session_id,agent,model,provider,tool,"
                       "error_category,detail,occurrences,first_ts,last_ts FROM events WHERE " + " AND ".join(clauses) +
                       " ORDER BY ts DESC LIMIT ?", args + [limit])
        return {"events": rows}

    # -- telemetry health -------------------------------------------
    def health(self):
        c = self.store.counters()
        budget = int(self.store.setting("storage_budget_mb")) * 1024 * 1024
        size = self.store.db_bytes()
        last_ingest = self.store.conn.execute(
            "SELECT value FROM meta WHERE key='last_ingest'").fetchone()
        last_error = self.store.conn.execute("SELECT value FROM meta WHERE key='last_error'").fetchone()
        sources = {k[10:]: v for k, v in c.items() if k.startswith("source_ok:")}
        errors = {k[11:]: v for k, v in c.items() if k.startswith("source_err:")}
        detail_rows = self.store.conn.execute("SELECT COUNT(*) n FROM events").fetchone()["n"]
        oldest = self.store.conn.execute("SELECT MIN(ts) v FROM events").fetchone()["v"]
        return {
            "enabled": self.store.setting("telemetry_enabled") == "true",
            "dashboard_refresh_seconds": int(float(self.store.setting("dashboard_refresh_seconds"))),
            "last_ingest": last_ingest["value"] if last_ingest else None,
            "last_error": last_error["value"] if last_error else None,
            "storage_bytes": size,
            "budget_bytes": budget,
            "budget_pct": round(100.0 * size / budget, 2) if budget else None,
            "events": int(detail_rows),
            "oldest_event": oldest,
            "detail_days": int(self.store.setting("detail_days")),
            "aggregate_days": int(self.store.setting("aggregate_days")),
            "dropped_events": c.get("dropped_events", 0),
            "ingest_errors": c.get("ingest_errors", 0),
            "sampled_out": c.get("sampled_out", 0),
            "sources_ok": sources,
            "sources_errors": errors,
            "database": str(self.db_path),
        }

    # -- nannies -----------------------------------------------------
    def nannies(self, *, platform=None, task_probe=None):
        import subprocess
        platform = os.name if platform is None else platform
        if platform == "nt":
            # Do not display systemd units on a native Windows installation.
            # A registered Task Scheduler entry only proves configuration, not
            # that its Rust child processes are running or healthy.
            if task_probe is None:
                def task_probe():
                    return subprocess.run(
                        ["schtasks.exe", "/Query", "/TN", "Singularity-Rust-Native-Supervisor", "/FO", "CSV", "/NH"],
                        capture_output=True, text=True, timeout=4, check=False)
            status = "unverified"
            try:
                probe = task_probe()
                if probe.returncode == 0:
                    status = "registered-unverified"
            except (OSError, subprocess.SubprocessError):
                pass
            return {
                "nannies": [{
                    "unit": "Singularity-Rust-Native-Supervisor",
                    "name": "Native Rust supervisor",
                    "purpose": "Native Windows process lifecycle",
                    "configured": status,
                    "effective": "unverified",
                    "last_trigger": None,
                    "source": "windows:TaskScheduler",
                    "operator_changeable": False,
                    "change_note": "A task registration is not a service health or feature-parity receipt",
                }],
                "last_alerts": self._q("SELECT name,last_decision,last_ts,detail FROM nanny_events ORDER BY last_ts DESC LIMIT 20"),
                "note": "native child process ownership, restart and behaviour require separate Windows acceptance",
                "settings": self.settings_with_effective(),
            }
        units = {
            "orch-nanny.timer": "Fleet nanny: patrols orchestration runs and emits alerts",
            "orch-nanny-relay.timer": "Nanny relay: delivers queued operator alerts",
            "oc-chat-nanny.timer": "OpenChamber chat nanny: idle-session hygiene",
            "orch-loadguard.timer": "Load guard: blocks new work under host pressure",
            "orch-session-watcher.timer": "Session watcher: stalled/zombie session detection",
            "orch-zombiewatch.timer": "Zombie watch: reaps orphaned processes",
            "ai-orchestra-guard.timer": "Orchestra guard: protected-file and gate monitoring",
            "repoql-cpu-collector.timer": "RepoQL CPU sampler (dashboard evidence)",
            "repoql-harness-telemetry.timer": "Harness telemetry collector (this dashboard)",
        }
        out = []
        for unit, purpose in units.items():
            row = {"unit": unit, "name": unit.replace(".timer", ""), "purpose": purpose,
                   "configured": None, "effective": None, "last_trigger": None,
                   "source": f"systemd:{unit}", "operator_changeable": False,
                   "change_note": "read-only here: timers are managed by the fleet unit files"}
            try:
                enabled = subprocess.run(["systemctl", "is-enabled", unit], capture_output=True, text=True, timeout=4)
                active = subprocess.run(["systemctl", "is-active", unit], capture_output=True, text=True, timeout=4)
                row["configured"] = enabled.stdout.strip() or enabled.stderr.strip() or "unknown"
                row["effective"] = active.stdout.strip() or "unknown"
                show = subprocess.run(["systemctl", "show", unit, "-p", "NextElapseUSecRealtime", "-p", "LastTriggerUSec"],
                                      capture_output=True, text=True, timeout=4)
                for line in show.stdout.splitlines():
                    if line.startswith("LastTriggerUSec="):
                        value = line.split("=", 1)[1].strip()
                        row["last_trigger"] = None if value in ("", "n/a") else value
            except (OSError, subprocess.SubprocessError):
                row["configured"] = row["effective"] = "unavailable"
            out.append(row)
        db_nanny = self._q("SELECT name,last_decision,last_ts,detail FROM nanny_events ORDER BY last_ts DESC LIMIT 20")
        return {"nannies": out, "last_alerts": db_nanny,
                "note": "mandatory review, lease, asset and compliance gates are not configurable here",
                "settings": self.settings_with_effective()}

    def settings_with_effective(self):
        data = self.store.settings()
        health = self.health()
        for key, row in data.items():
            effective = row["value"]
            if key == "telemetry_enabled" and row["value"] == "true":
                effective = "true" if not self.store.over_budget() else "true (paused: budget reached)"
            if key == "detail_days":
                effective = f"{row['value']} (oldest retained event: {health['oldest_event'] or 'none'})"
            if key == "storage_budget_mb":
                effective = f"{row['value']} MiB (in use: {health['budget_pct']}%)"
            if key == "sampling_tools":
                effective = f"{row['value']} ({round(float(row['value']) * 100)}% of allowed tool calls kept)"
            if key == "dashboard_refresh_seconds":
                effective = f"{row['value']} s"
            row["effective"] = effective
            row["requires_restart"] = False
        return data


# ---------------------------------------------------------------- collect
def collect(state_dir: Path | str | None = None) -> dict:
    state = Path(state_dir or STATE)
    state.mkdir(parents=True, exist_ok=True)
    lock_path = state / "harness-collector.lock"
    with lock_path.open("w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            return {"ok": True, "skipped": "another collector run holds the lock"}
        store = Store(state / "harness.db")
        started = time.time()
        try:
            if store.setting("telemetry_enabled") != "true":
                return {"ok": True, "skipped": "telemetry disabled by operator setting"}
            if store.over_budget():
                pruned = store.prune()
                if store.over_budget():
                    store.counter("dropped_events")
                    store.conn.execute(
                        "INSERT INTO meta(key,value) VALUES('last_error',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                        (f"storage budget still exceeded after prune at {now_iso()}; ingest skipped",))
                    return {"ok": True, "skipped": "storage budget reached", **pruned}
            else:
                pruned = store.prune(drop_events=False)
            sources = Collector(store).run()
            pruned = {**store.prune(drop_events=False), "budget": store.db_bytes()}
            store.conn.execute(
                "INSERT INTO meta(key,value) VALUES('last_ingest',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (now_iso(),))
            store.conn.execute(
                "INSERT INTO counters(name,value,updated_at) VALUES('collector_runs',1,?) "
                "ON CONFLICT(name) DO UPDATE SET value=value+1, updated_at=excluded.updated_at", (now_iso(),))
            return {"ok": True, "duration_ms": int((time.time() - started) * 1000),
                    "sources": sources, "prune": pruned, "bytes": store.db_bytes()}
        finally:
            store.close()
            with contextlib.suppress(OSError):
                lock_path.chmod(0o600)


def selftest(state_dir: Path | str) -> dict:
    """Offline check of schema, dedup, retention and budget enforcement."""
    store = Store(Path(state_dir) / "harness.db")
    try:
        base = {"category": "run", "kind": "test", "detail": "x", "source": "selftest", "ts": now_iso()}
        store.add_event({**base, "dedup_key": "selftest:dup"})
        store.add_event({**base, "dedup_key": "selftest:dup"})
        occ = store.conn.execute("SELECT occurrences FROM events WHERE dedup_key='selftest:dup'").fetchone()["occurrences"]
        assert occ == 2, f"dedup failed: {occ}"
        store.add_event({**base, "dedup_key": "selftest:old", "ts": "2020-01-01T00:00:00Z"})
        removed = store.prune(drop_events=False)["events_aged"]
        assert removed >= 1, "retention did not delete old events"
        assert int(store.setting("detail_days")) >= 1
        return {"ok": True, "dedup_occurrences": occ, "aged": removed}
    finally:
        store.close()


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Harness telemetry collector (ticket 789)")
    parser.add_argument("command", choices=["collect", "health", "selftest"])
    parser.add_argument("--state-dir", default=str(STATE))
    args = parser.parse_args(argv)
    if args.command == "collect":
        result = collect(Path(args.state_dir))
        print(json.dumps(result, default=str))
        return 0
    harness = Harness(Path(args.state_dir))
    try:
        if args.command == "health":
            print(json.dumps(harness.health(), default=str, indent=1))
        else:
            print(json.dumps(selftest(Path(args.state_dir) / "selftest"), default=str))
    finally:
        harness.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
