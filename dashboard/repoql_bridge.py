#!/usr/bin/env python3
"""Read-only bridge to the configured RepoQL host.

Every call goes through the host's own CLI (`rql`) over its unix socket, so the
dashboard sees exactly the graph, knowledge rows, status document and host log
that RepoQL itself reports. Nothing is cached to a second database; the only
local files are CPU samples written by collector.py and exclusion metadata.

Why the CLI and not a private API client: `rql` is the supported contract with a
running host (it is what every agent on the fleet uses), its `--json` shapes are
documented, and it needs no extra credential handling in this service.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

LOG_LINE_RE = re.compile(
    r"^\[(?P<ts>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}) PID (?P<pid>\d+) (?P<level>[A-Z]{2,4})\] (?P<msg>.*)$"
)
SWEEP_RE = re.compile(r"\[(?P<state>[a-z]+)\]\s+(?P<pct>\d+(?:\.\d+)?)% complete files=(?P<done>[\d,]+)/(?P<total>[\d,]+)")
COMPLETE_RE = re.compile(r"\[complete\]\s+(?P<pct>\d+(?:\.\d+)?)% complete files=(?P<done>[\d,]+)/(?P<total>[\d,]+)")
MOUNT_RE = re.compile(r"mount (?P<root>\S+) completed")


class UpstreamError(RuntimeError):
    """RepoQL answered with an error, or the CLI could not run."""


@dataclass(frozen=True)
class Config:
    workspace: Path
    rql: Path
    state_dir: Path
    bind: str
    port: int
    sample_interval_seconds: int = 30
    cpu_retention_days: int = 30
    # Peer addresses allowed to open a TCP connection at all. Loopback is the
    # SSH-tunnel path; the docker bridge is the Cloudflare Tunnel connector. Any
    # other peer is dropped without a response, so the listener is not reachable
    # from the LAN even though it binds the host's interfaces.
    allow_peers: tuple[str, ...] = ("127.0.0.1", "::1")
    # Cloudflare Access application in front of the public hostname.
    access_team_domain: str | None = None
    access_aud: str | None = None
    public_url: str = ""

    @staticmethod
    def load(path: Path) -> "Config":
        """Load JSON config when present, then let environment variables win.

        A portable install can run with no config file at all: every setting has
        a ``SINGULARITY_*`` environment override (``RQLDASH_*`` is accepted as a
        legacy alias) and a neutral default that never names a fleet host.
        """
        data: dict = {}
        if path is not None and Path(path).is_file():
            data = json.loads(Path(path).read_text(encoding="utf-8"))
        access = data.get("access") or {}

        def pick(primary: str, legacy: str, key: str, default=None):
            value = os.environ.get(primary)
            if value is None:
                value = os.environ.get(legacy)
            if value is None:
                value = data.get(key, default)
            return value

        peers_value = pick("SINGULARITY_ALLOW_PEERS", "RQLDASH_ALLOW_PEERS", "allow_peers", "")
        if isinstance(peers_value, str):
            peers = tuple(item.strip() for item in peers_value.split(",") if item.strip())
        else:
            peers = tuple(peers_value or ())
        if not peers:
            peers = ("127.0.0.1", "::1")
        return Config(
            workspace=Path(pick("SINGULARITY_WORKSPACE", "RQLDASH_WORKSPACE", "workspace",
                                str(Path.home()))),
            rql=Path(pick("SINGULARITY_RQL_BIN", "RQLDASH_RQL", "rql", "rql")),
            state_dir=Path(pick("SINGULARITY_STATE_DIR", "RQLDASH_STATE", "state_dir",
                                str((Path(os.environ.get('LOCALAPPDATA') or Path.home() / 'AppData' / 'Local') / 'Singularity' / 'Dashboard')
                                    if os.name == 'nt' else (Path.home() / '.local' / 'state' / 'singularity-dashboard')))),
            bind=pick("SINGULARITY_BIND", "RQLDASH_BIND", "bind", "127.0.0.1"),
            port=int(pick("SINGULARITY_PORT", "RQLDASH_PORT", "port", 18100)),
            sample_interval_seconds=int(pick("SINGULARITY_SAMPLE_INTERVAL",
                                             "RQLDASH_SAMPLE_INTERVAL",
                                             "sample_interval_seconds", 30)),
            cpu_retention_days=int(pick("SINGULARITY_CPU_RETENTION_DAYS",
                                        "RQLDASH_CPU_RETENTION_DAYS",
                                        "cpu_retention_days", 30)),
            allow_peers=peers,
            access_team_domain=(pick("SINGULARITY_ACCESS_TEAM", "RQLDASH_ACCESS_TEAM",
                                     "team_domain", access.get("team_domain", "")) or None),
            access_aud=(pick("SINGULARITY_ACCESS_AUD", "RQLDASH_ACCESS_AUD", "aud",
                             access.get("aud", "")) or None),
            public_url=pick("SINGULARITY_PUBLIC_URL", "RQLDASH_PUBLIC_URL", "public_url", "") or "",
        )


class TTLCache:
    """Small thread-safe TTL cache: one upstream call per key per window."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._items: dict[str, tuple[float, Any]] = {}
        self._inflight: dict[str, threading.Lock] = {}

    def get(self, key: str) -> Any | None:
        with self._lock:
            item = self._items.get(key)
        if not item:
            return None
        expires, value = item
        if expires < time.monotonic():
            return None
        return value

    def set(self, key: str, value: Any, ttl: float) -> Any:
        with self._lock:
            self._items[key] = (time.monotonic() + ttl, value)
        return value

    def key_lock(self, key: str) -> threading.Lock:
        with self._lock:
            return self._inflight.setdefault(key, threading.Lock())

    def invalidate(self, prefix: str = "") -> None:
        with self._lock:
            for key in list(self._items):
                if key.startswith(prefix):
                    del self._items[key]


class RepoQL:
    """Synchronous bridge with short-lived caching and bounded concurrency."""

    def __init__(self, config: Config) -> None:
        self.config = config
        self.cache = TTLCache()
        # RepoQL runs a two-worker indexer and a 4GiB DuckDB budget; a dashboard
        # must never queue more than a couple of reads behind itself.
        self._query_slots = threading.BoundedSemaphore(3)
        self._mutation_lock = threading.Lock()

    # -- process helpers ---------------------------------------------------

    def run(self, args: Iterable[str], timeout: float = 120.0) -> subprocess.CompletedProcess:
        cmd = [str(self.config.rql), *args]
        return subprocess.run(
            cmd,
            cwd=str(self.config.workspace),
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )

    def query(self, sql: str, timeout: float = 120.0) -> list[dict]:
        """Run SQL against the indexed graph and return rows."""
        with self._query_slots:
            proc = self.run(["query", "--json", sql], timeout=timeout)
        if proc.returncode != 0:
            message = (proc.stderr or proc.stdout or "").strip()
            raise UpstreamError(message.splitlines()[0] if message else "rql query failed")
        text = proc.stdout.strip()
        if not text:
            return []
        try:
            rows = json.loads(text)
        except json.JSONDecodeError as exc:  # pragma: no cover - upstream shape drift
            raise UpstreamError(f"rql query returned non-JSON output: {exc}") from exc
        return rows if isinstance(rows, list) else [rows]

    def query_cached(self, key: str, sql: str, ttl: float, timeout: float = 120.0) -> list[dict]:
        cached = self.cache.get(key)
        if cached is not None:
            return cached
        with self.cache.key_lock(key):
            cached = self.cache.get(key)
            if cached is not None:
                return cached
            rows = self.query(sql, timeout=timeout)
            return self.cache.set(key, rows, ttl)

    def json_command_cached(self, key: str, args: list[str], ttl: float, timeout: float = 120.0) -> Any:
        cached = self.cache.get(key)
        if cached is not None:
            return cached
        with self.cache.key_lock(key):
            cached = self.cache.get(key)
            if cached is not None:
                return cached
            proc = self.run(args, timeout=timeout)
            if proc.returncode != 0:
                message = (proc.stderr or proc.stdout or "").strip()
                raise UpstreamError(message.splitlines()[0] if message else f"rql {' '.join(args)} failed")
            try:
                payload = json.loads(proc.stdout)
            except json.JSONDecodeError as exc:
                raise UpstreamError(f"rql {' '.join(args)} returned non-JSON output") from exc
            return self.cache.set(key, payload, ttl)

    # -- host facts --------------------------------------------------------

    def status(self, ttl: float = 3.0) -> dict:
        return self.json_command_cached("status", ["host", "status", "--json", "--all"], ttl)

    def imports(self, ttl: float = 10.0) -> dict:
        return self.json_command_cached("imports", ["import", "list", "--json"], ttl)

    def engine_status(self, ttl: float = 3.0) -> dict:
        rows = self.query_cached("engine", "SELECT * FROM engine_status", ttl)
        return rows[0] if rows else {}

    def filesystems(self, ttl: float = 20.0) -> list[dict]:
        sql = (
            "SELECT source_uri, local_path, kind, file_count, indexed_count, embedded_count, embed_pct, "
            "languages, total_bytes, total_tokens, mounted_at, include_in_enumeration, watching, analysis, history "
            "FROM Filesystems ORDER BY file_count DESC"
        )
        return self.query_cached("filesystems", sql, ttl, timeout=180)

    def operation_log(self, ttl: float = 5.0, limit: int = 25) -> list[dict]:
        sql = (
            "SELECT kind, state, is_terminal, ready_percent, total, indexed, failed, skipped, active, "
            "runtime_s, created_at, started_at, completed_at, raw_name FROM Operations "
            f"ORDER BY created_at DESC LIMIT {int(limit)}"
        )
        return self.query_cached(f"operations:{limit}", sql, ttl)

    def failed_files(self, ttl: float = 10.0, limit: int = 2000) -> list[dict]:
        sql = (
            "SELECT uri, error, failures, stage, transitioned_at, media_type, byte_size "
            f"FROM failed_files ORDER BY transitioned_at DESC LIMIT {int(limit)}"
        )
        return self.query_cached(f"failed_files:{limit}", sql, ttl)

    def queue(self, ttl: float = 5.0, limit: int = 500) -> list[dict]:
        sql = (
            "SELECT work_id, queue, status, uri, work_kind, enqueued_at, processing_started_at, worker, "
            "attempt, error, stage, reason, active, failures "
            f"FROM indexing_queue ORDER BY enqueued_at DESC LIMIT {int(limit)}"
        )
        return self.query_cached(f"queue:{limit}", sql, ttl)

    # -- host process / log ------------------------------------------------

    @property
    def cache_dir(self) -> Path:
        return self.config.workspace / ".repoql" / "cache"

    def host_lock(self) -> dict:
        try:
            return json.loads((self.cache_dir / "host.lock").read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}

    def host_pid(self) -> int | None:
        pid = self.host_lock().get("pid")
        try:
            pid = int(pid)
        except (TypeError, ValueError):
            return None
        if os.name == "nt":
            # Python cannot verify process start-time/executable ownership; a
            # Windows Rust supervisor will provide authoritative host status.
            return None
        return pid if Path(f"/proc/{pid}").exists() else None

    def host_log_path(self) -> Path | None:
        pid = self.host_pid()
        if pid is not None:
            candidate = self.cache_dir / f"host_{pid}.log"
            if candidate.exists():
                return candidate
        logs = sorted(self.cache_dir.glob("host_*.log"), key=lambda p: p.stat().st_mtime, reverse=True)
        return logs[0] if logs else None

    def log_tail(self, max_bytes: int = 1_500_000) -> list[dict]:
        """Parsed tail of the live host log (newest last), bounded by bytes."""
        path = self.host_log_path()
        if not path:
            return []
        cached = self.cache.get(f"log:{path}:{max_bytes}")
        if cached is not None:
            return cached
        try:
            size = path.stat().st_size
            with path.open("rb") as handle:
                if size > max_bytes:
                    handle.seek(size - max_bytes)
                    handle.readline()  # drop the partial first line
                lines = handle.read().decode("utf-8", "replace").splitlines()
        except OSError:
            return []
        records: list[dict] = []
        for line in lines:
            match = LOG_LINE_RE.match(line)
            if not match:
                continue
            records.append(
                {
                    "ts": match.group("ts"),
                    "pid": int(match.group("pid")),
                    "level": match.group("level"),
                    "msg": match.group("msg"),
                    "raw": line,
                }
            )
        return self.cache.set(f"log:{path}:{max_bytes}", records, 2.0)

    # -- knowledge ---------------------------------------------------------

    def knowledge_counts(self, ttl: float = 15.0) -> dict:
        rows = self.query_cached(
            "knowledge_counts",
            "SELECT coalesce(category, '(none)') AS category, count(*) AS n FROM capsules GROUP BY 1 ORDER BY n DESC",
            ttl,
            timeout=180,
        )
        return {row["category"]: row["n"] for row in rows}

    def link_counts(self, ttl: float = 20.0) -> dict:
        rows = self.query_cached(
            "link_counts",
            "SELECT type, count(*) AS n FROM edge GROUP BY 1 ORDER BY n DESC",
            ttl,
            timeout=240,
        )
        return {row["type"]: row["n"] for row in rows}

    # -- CPU ---------------------------------------------------------------

    def cpu_now(self, pid: int | None = None) -> dict:
        """Instantaneous CPU% of the RepoQL host process, measured from /proc.

        Percent is per core (100 = one saturated core), matching `ps %CPU`'s
        scale but computed from a real delta rather than the lifetime average.
        """
        if os.environ.get("SINGULARITY_WINDOWS_NATIVE") == "1":
            from native_cpu import sample_cpu
            return sample_cpu(pid if pid is not None else self.host_pid())
        pid = pid or self.host_pid()
        if pid is None:
            return {"available": False, "reason": "repoql-host process is not running"}
        try:
            first = _proc_cpu_ticks(pid)
            time.sleep(0.25)
            second = _proc_cpu_ticks(pid)
        except OSError:
            return {"available": False, "reason": "RepoQL process disappeared while sampling"}
        hz = os.sysconf("SC_CLK_TCK")
        delta_ticks = (second[0] + second[1]) - (first[0] + first[1])
        delta_wall = max(second[2] - first[2], 1e-6)
        pct = (delta_ticks / hz) / delta_wall * 100.0
        cores = os.cpu_count() or 1
        return {
            "available": True,
            "pid": pid,
            "cpu_pct": round(pct, 2),
            "host_pct": round(pct / cores, 2),
            "cores": cores,
            "sampled_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }


def _proc_cpu_ticks(pid: int) -> tuple[int, int, float]:
    with open(f"/proc/{pid}/stat", "r", encoding="utf-8") as handle:
        fields = handle.read().rsplit(") ", 1)[1].split()
    # After the comm field: state is fields[0]; utime is field 14, stime 15.
    utime = int(fields[11])
    stime = int(fields[12])
    return utime, stime, time.monotonic()


def summarise_log(records: list[dict]) -> dict:
    """Derive dashboard activity facts from parsed log records."""
    activity = {
        "last_activity": records[-1]["ts"] if records else None,
        "last_line": records[-1]["msg"] if records else None,
        "current_phase": None,
        "sweep": None,
        "last_complete": None,
        "mounts": {},
        "counts": {"info": 0, "warning": 0, "error": 0},
    }
    for record in reversed(records):
        level = record["level"]
        if level in ("WRN", "WARN"):
            activity["counts"]["warning"] += 1
        elif level in ("ERR", "FTL", "CRT"):
            activity["counts"]["error"] += 1
        else:
            activity["counts"]["info"] += 1
        if activity["last_complete"] is None:
            match = COMPLETE_RE.search(record["msg"])
            if match:
                activity["last_complete"] = {"ts": record["ts"], "line": record["msg"]}
        if activity["sweep"] is None:
            match = SWEEP_RE.search(record["msg"])
            if match:
                activity["sweep"] = {
                    "ts": record["ts"],
                    "state": match.group("state"),
                    "percent": float(match.group("pct")),
                    "done": int(match.group("done").replace(",", "")),
                    "total": int(match.group("total").replace(",", "")),
                    "line": record["msg"],
                }
        if activity["current_phase"] is None:
            phrase = record["msg"]
            for phase in ("analyze", "sweep", "index", "embed", "hot-path", "full-text", "structure"):
                if f"[{phase}]" in phrase or phrase.startswith(f"{phase} ["):
                    activity["current_phase"] = phase
                    break
        mount_match = MOUNT_RE.search(record["msg"])
        if mount_match and mount_match.group("root") not in activity["mounts"]:
            activity["mounts"][mount_match.group("root")] = record["ts"]
    return activity


def host_uptime_seconds(status: dict) -> int | None:
    started = (status.get("host") or {}).get("startedAt")
    if not started:
        return None
    try:
        from datetime import datetime, timezone

        stamp = datetime.fromisoformat(started.replace("Z", "+00:00"))
        return max(0, int((datetime.now(timezone.utc) - stamp).total_seconds()))
    except ValueError:
        return None
