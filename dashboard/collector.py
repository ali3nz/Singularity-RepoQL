#!/usr/bin/env python3
"""Persistent CPU sampler for the RepoQL host process.

Run from a systemd timer (repoql-cpu-collector.timer) so the history exists even
when no browser and no dashboard request is active.

Measurement method
------------------
`cpu_pct` is the RepoQL host process's own CPU use, computed from the delta of
`utime + stime` in /proc/<pid>/stat between two consecutive samples, divided by
the elapsed wall time and the kernel clock tick (100 Hz on this host):

    cpu_pct = (delta_ticks / CLK_TCK) / delta_seconds * 100

The scale is percent of ONE core, the same scale `ps %CPU` and `pidstat` use, so
100% means one saturated core (RepoQL's own CPUQuota is 400%). `host_pct` is the
same value divided by the CPU count — share of the whole machine. Whole-host CPU
is never reported as RepoQL usage.

Rows are written only for the RepoQL process; when it is not running a row with
state='absent' records the gap instead of inventing a measurement. Retention is
30 days (config key cpu_retention_days).
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys
import time
from pathlib import Path

SERVICE_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SERVICE_DIR))

from repoql_bridge import Config, RepoQL  # noqa: E402

SCHEMA = """
CREATE TABLE IF NOT EXISTS cpu_samples (
  ts INTEGER PRIMARY KEY,
  pid INTEGER,
  cpu_pct REAL,
  host_pct REAL,
  num_cpus INTEGER,
  load1 REAL,
  state TEXT NOT NULL,
  host_started_at TEXT
);
CREATE INDEX IF NOT EXISTS cpu_samples_ts ON cpu_samples(ts);
"""


def proc_ticks(pid: int) -> tuple[int, int]:
    with open(f"/proc/{pid}/stat", "r", encoding="utf-8") as handle:
        fields = handle.read().rsplit(") ", 1)[1].split()
    return int(fields[11]), int(fields[12])


def main() -> int:
    config = Config.load(SERVICE_DIR / "config.json")
    rql = RepoQL(config)
    config.state_dir.mkdir(parents=True, exist_ok=True)
    db_path = config.state_dir / "cpu.db"
    state_path = config.state_dir / "cpu-last.json"
    now = int(time.time())
    hz = os.sysconf("SC_CLK_TCK")
    cores = os.cpu_count() or 1
    lock = rql.host_lock()
    pid = rql.host_pid()
    load1 = os.getloadavg()[0] if hasattr(os, "getloadavg") else None

    row = {"ts": now, "pid": pid, "cpu_pct": None, "host_pct": None, "num_cpus": cores,
           "load1": load1, "state": "absent", "host_started_at": lock.get("startedAt")}

    if pid is not None:
        try:
            utime, stime = proc_ticks(pid)
            previous = None
            if state_path.exists():
                try:
                    previous = json.loads(state_path.read_text(encoding="utf-8"))
                except json.JSONDecodeError:
                    previous = None
            if previous and previous.get("pid") == pid:
                delta_ticks = (utime + stime) - int(previous["ticks"])
                delta_seconds = now - int(previous["ts"])
                if delta_seconds > 0 and delta_ticks >= 0:
                    cpu_pct = (delta_ticks / hz) / delta_seconds * 100.0
                    row["cpu_pct"] = round(cpu_pct, 2)
                    row["host_pct"] = round(cpu_pct / cores, 2)
                    row["state"] = "ok"
            else:
                # First sample for this pid: nothing to difference against yet.
                row["state"] = "priming"
            state_path.write_text(json.dumps({"pid": pid, "ticks": utime + stime, "ts": now}), encoding="utf-8")
        except OSError:
            row["state"] = "absent"

    with sqlite3.connect(db_path, timeout=10) as conn:
        conn.executescript(SCHEMA)
        conn.execute(
            "INSERT OR REPLACE INTO cpu_samples(ts, pid, cpu_pct, host_pct, num_cpus, load1, state, host_started_at)"
            " VALUES (:ts, :pid, :cpu_pct, :host_pct, :num_cpus, :load1, :state, :host_started_at)",
            row,
        )
        cutoff = now - config.cpu_retention_days * 86400
        conn.execute("DELETE FROM cpu_samples WHERE ts < ?", (cutoff,))
        conn.commit()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
