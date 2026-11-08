#!/usr/bin/env python3
"""RepoQL management dashboard — HTTP server.

A management front door over the configured RepoQL host.
RepoQL data reads come from the configured host. Writes to RepoQL are limited
to supported imports, reindexing and mount-local exclusions. The native Windows
Agents Control additionally edits only the installed Singularity Claude Code
agent definitions through revision-checked, atomic local file operations.

Design rules this file keeps:
- no second knowledge store: counts and rows come from the graph itself;
- no duplicated indexer, logger or exclusion system;
- every mutation needs the capability token, a same-origin request and an
  explicit confirmation field, and only one mutation runs at a time.
"""

from __future__ import annotations

import argparse
from contextlib import contextmanager
from file_lock import fcntl
import hashlib
import hmac
import http.client
import json
import os
import re
import secrets
import select
import ipaddress
import shutil
import socket
import sqlite3
import sys
import tempfile
import threading
import time
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse, urlsplit, urlunsplit, urljoin, unquote

from local_account import (LocalAccount, AccountRefused, session_ttl,
                           COOKIE_NAME as ACCOUNT_COOKIE_NAME)
from access import AccessVerifier
from repoql_bridge import Config, RepoQL, UpstreamError, host_uptime_seconds, summarise_log
from variant_features import features as variant_features, route_allowed as variant_route_allowed

# Ticket 789: Harness Control Center (telemetry store + HTTP adapter).
try:
    from harness_telemetry import Harness
    from harness_api import HarnessAPI
    from harness_rust import RustHarness
except Exception as _harness_import_error:  # the dashboard must boot without it
    Harness = None
    HarnessAPI = None
    RustHarness = None

SERVICE_DIR = Path(__file__).resolve().parent
STATIC_DIR = SERVICE_DIR / "static"
SECRET_CODE = "dashboard_secret_required"
READ_ONLY_SCHEMES = ("concept://", "help://", "vocabulary://", "repoql://")

COLLECTIONS = {
    "see_also": "Knowledge see-also relationships (capsules.see_also)",
    "refers_to": "Stored REFERS_TO edges (edge)",
    "composition": "Stored HAS_PART composition edges (edge)",
    "markdown": "Markdown links (markdown_links) with resolution status",
}
PERIODS = {
    "1h": (3600, 60),
    "6h": (6 * 3600, 300),
    "24h": (86400, 600),
    "7d": (7 * 86400, 1800),
    "30d": (30 * 86400, 3600),
}


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------


# The memorycore import's own namespace, and the only Files namespace /api/memory-docs serves.
MEMORY_DOCS_ROOT = "memorycore://data/"


def sqlstr(value: str) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def human_bytes(value: float | int | None) -> str:
    if value is None:
        return "—"
    size = float(value)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if size < 1024 or unit == "TB":
            return f"{size:.0f} {unit}" if unit == "B" else f"{size:.1f} {unit}"
        size /= 1024
    return f"{size:.1f} TB"


def parse_limit(params: dict, default: int = 50, maximum: int = 200) -> int:
    try:
        value = int(params.get("page_size", default))
    except (TypeError, ValueError):
        value = default
    return max(1, min(value, maximum))


def parse_page(params: dict) -> int:
    try:
        return max(1, int(params.get("page", 1)))
    except (TypeError, ValueError):
        return 1


def uri_category(uri: str) -> str:
    """Label a RepoQL URI by the record class it belongs to (display only)."""
    if not uri:
        return "unknown"
    if uri.startswith("concept:///"):
        rest = uri[len("concept:///") :]
        head = rest.split("/", 1)[0].lower()
        if head in ("wisdom", "principle", "rule", "shape", "knowledge"):
            return head
        return "concept"
    if uri.startswith("help://"):
        return "help"
    if uri.startswith("github://"):
        return "repository"
    if uri.startswith("local://"):
        return "local file"
    if uri.startswith("https://") or uri.startswith("http://"):
        return "external"
    if uri.startswith("vocabulary://"):
        return "vocabulary"
    return "file"


def repository_of(uri: str, roots: list[str]) -> str | None:
    best = None
    for root in roots:
        if uri == root or uri.startswith(root.rstrip("/") + "/"):
            if best is None or len(root) > len(best):
                best = root
    return best


# --------------------------------------------------------------------------
# exclusions (RepoQL's own mount-local .repoqlignore, recorded for reversal)
# --------------------------------------------------------------------------


class ExclusionStateError(RuntimeError):
    """Exclusion state is not trustworthy; do not mutate it."""


class ExclusionStore:
    """Metadata for exclusions written into a mount's `.repoqlignore`.

    Enforcement stays in RepoQL: the dashboard only edits the ignore file that
    RepoQL reads for that mount, inside a delimited block, so a removal can be
    exact and a human can audit every rule.
    """

    BLOCK_START = "# >>> repoql-dashboard exclusion {id}"
    BLOCK_END = "# <<< repoql-dashboard exclusion {id}"

    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = threading.Lock()
        self.path.parent.mkdir(parents=True, exist_ok=True)

    @contextmanager
    def _mutation_lock(self):
        """Serialize ledger read-modify-write across dashboard processes.

        A persistent dedicated lockfile avoids the rename/inode race that
        would result from locking the atomically replaced JSON ledger itself.
        The file is retained across process exit and is never unlinked.
        """
        lock_path = self.path.with_name(self.path.name + '.lock')
        with self._lock:
            if lock_path.is_symlink():
                raise ExclusionStateError("EXCLUSIONS_LOCK_SYMLINK_REFUSED")
            with lock_path.open('a+b') as stream:
                if lock_path.is_symlink():
                    raise ExclusionStateError("EXCLUSIONS_LOCK_SYMLINK_REFUSED")
                # msvcrt.locking protects a byte range on Windows. Ensure that
                # byte exists even on a newly created lock file.
                stream.seek(0, os.SEEK_END)
                if stream.tell() == 0:
                    stream.write(b'\0')
                    stream.flush()
                    os.fsync(stream.fileno())
                os.chmod(lock_path, 0o600)
                fcntl.flock(stream.fileno(), fcntl.LOCK_EX)
                try:
                    yield
                finally:
                    fcntl.flock(stream.fileno(), fcntl.LOCK_UN)

    def load(self) -> list[dict]:
        # A genuinely absent ledger means no exclusions. Malformed/unreadable
        # state means UNKNOWN, not empty: a subsequent add must never erase
        # an existing user's exclusions because parsing failed.
        try:
            if self.path.is_symlink():
                raise ExclusionStateError("EXCLUSIONS_LEDGER_SYMLINK_REFUSED")
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return []
        except (OSError, UnicodeError, json.JSONDecodeError) as exc:
            raise ExclusionStateError("EXCLUSIONS_LEDGER_UNREADABLE") from exc
        if not isinstance(data, dict) or not isinstance(data.get("exclusions"), list) or any(
            not isinstance(item, dict) for item in data["exclusions"]
        ):
            raise ExclusionStateError("EXCLUSIONS_LEDGER_INVALID_SCHEMA")
        return data["exclusions"]

    def save(self, records: list[dict]) -> None:
        if self.path.is_symlink():
            raise ExclusionStateError("EXCLUSIONS_LEDGER_SYMLINK_REFUSED")
        # Refuse a pre-existing pending write instead of silently truncating
        # evidence from an interrupted dashboard operation.
        tmp = self.path.with_suffix(".json.tmp")
        payload = json.dumps({"exclusions": records}, indent=2) + "\n"
        with tmp.open("x", encoding="utf-8") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(tmp, 0o600)
        tmp.replace(self.path)

    def add(self, record: dict) -> None:
        with self._mutation_lock():
            records = self.load()
            records = [r for r in records if r.get("id") != record["id"] and r.get("uri") != record["uri"]]
            records.append(record)
            self.save(records)

    def update(self, record_id: str, **fields) -> dict | None:
        with self._mutation_lock():
            records = self.load()
            for record in records:
                if record.get("id") == record_id:
                    record.update(fields)
                    self.save(records)
                    return record
        return None

    def remove(self, record_id: str) -> dict | None:
        with self._mutation_lock():
            records = self.load()
            for record in records:
                if record.get("id") == record_id:
                    records.remove(record)
                    self.save(records)
                    return record
        return None


class IgnoreFileConflict(RuntimeError):
    """The ignore file changed between reading it and replacing it."""


def atomic_write_text(path: Path, text: str, expected_current: str | None = None,
                      lock_dir: Path | None = None) -> None:
    """Replace `path` with `text` atomically, refusing to clobber a concurrent edit.

    Three protections, in order:
    1. An exclusive advisory lock (`fcntl.flock`) on a per-target lock file held
       across read, compare and replace, so two writers cannot both believe they
       are the only one. The lock file lives outside the indexed mount by
       default (the dashboard's state/locks directory).
    2. The content comparison against `expected_current` is repeated immediately
       before the replace, so an edit made by a non-cooperating process after the
       first read still aborts the write.
    3. The new content is written to a temporary file in the same directory,
       fsynced, given the original mode, then installed with `os.replace()` — a
       crash can leave the old file or the new one, never a half-written rule
       file.
    """
    digest = hashlib.sha256(str(path).encode()).hexdigest()[:16]
    lock_root = Path(lock_dir) if lock_dir else path.parent
    lock_root.mkdir(parents=True, exist_ok=True)
    lock_path = lock_root / f"{digest}.lock"
    with open(lock_path, "a+", encoding="utf-8") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        try:
            current = path.read_text(encoding="utf-8") if path.exists() else ""
            if expected_current is not None and current != expected_current:
                raise IgnoreFileConflict(f"{path} changed while the exclusion was being prepared")
            handle, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent))
            try:
                with os.fdopen(handle, "w", encoding="utf-8") as stream:
                    stream.write(text)
                    stream.flush()
                    os.fsync(stream.fileno())
                if path.exists():
                    shutil.copymode(path, temp_name)
                else:
                    os.chmod(temp_name, 0o644)
                # Re-check under the lock right before installing: a write that
                # slipped in after our first read must abort, not be clobbered.
                latest = path.read_text(encoding="utf-8") if path.exists() else ""
                if expected_current is not None and latest != expected_current:
                    raise IgnoreFileConflict(f"{path} changed while the exclusion was being prepared")
                os.replace(temp_name, path)
            finally:
                if os.path.exists(temp_name):
                    os.unlink(temp_name)
        finally:
            fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


def ignore_blocks(text: str) -> list[tuple[str, str]]:
    """Return (id, block_text) pairs for dashboard-managed blocks."""
    blocks: list[tuple[str, str]] = []
    current: tuple[str, list[str]] | None = None
    for line in text.splitlines():
        match = re.match(r"^# >>> repoql-dashboard exclusion (?P<id>\S+)", line)
        if match:
            current = (match.group("id"), [line])
            continue
        if current is not None:
            current[1].append(line)
            if re.match(rf"^# <<< repoql-dashboard exclusion {re.escape(current[0])}$", line):
                blocks.append((current[0], "\n".join(current[1])))
                current = None
    return blocks


# --------------------------------------------------------------------------
# application
# --------------------------------------------------------------------------


class App:
    def __init__(self, config: Config) -> None:
        self.config = config
        self.rql = RepoQL(config)
        self.config.state_dir.mkdir(parents=True, exist_ok=True)
        self.token_path = self.config.state_dir / "token"
        self.token = self._load_token()
        self.local_account = (LocalAccount(config.state_dir)
                              if os.environ.get('SINGULARITY_LOCAL_ACCOUNT_AUTH') == '1' else None)
        self.exclusions = ExclusionStore(self.config.state_dir / "exclusions.json")
        self.cpu_db = self.config.state_dir / "cpu.db"
        self.mutation_lock = threading.Lock()
        self.harness = (
            HarnessAPI(Harness(config.state_dir), RustHarness())
            if HarnessAPI and Harness else None
        )
        self.started_at = time.time()
        self._peer_networks = self._compile_peers(self.config.allow_peers)
        self.access = (AccessVerifier(self.config.access_team_domain, self.config.access_aud)
                       if self.config.access_team_domain and self.config.access_aud else None)
        # Separate audience: an Office grant must never authorize dashboard APIs.
        office_aud = os.environ.get("CLAUDE_OFFICE_ACCESS_AUD", "").strip()
        self.office_access = (AccessVerifier(self.config.access_team_domain, office_aud)
                              if self.config.access_team_domain and office_aud else None)

    # -- transport / identity ---------------------------------------------

    @staticmethod
    def _compile_peers(entries) -> list:
        networks = []
        for entry in entries or ():
            try:
                networks.append(ipaddress.ip_network(str(entry), strict=False))
            except ValueError:
                continue
        return networks

    def peer_allowed(self, address: str) -> bool:
        try:
            peer = ipaddress.ip_address(str(address))
        except ValueError:
            return False
        if getattr(peer, "ipv4_mapped", None) is not None:
            peer = peer.ipv4_mapped
        return any(peer in network for network in self._peer_networks)

    def access_identity(self, headers) -> dict | None:
        if self.access is None:
            return None
        assertion = headers.get("Cf-Access-Jwt-Assertion")
        return self.access.identity(assertion) if assertion else None

    # -- token ------------------------------------------------------------

    def _load_token(self) -> str:
        if self.token_path.exists():
            token = self.token_path.read_text(encoding="utf-8").strip()
            if token:
                return token
        token = secrets.token_urlsafe(32)
        self.token_path.write_text(token + "\n", encoding="utf-8")
        os.chmod(self.token_path, 0o600)
        return token

    def dashboard_url(self) -> str:
        if self.local_account is not None:
            return f"http://127.0.0.1:{self.config.port}/"
        host = self.config.bind
        if host in ("0.0.0.0", "", "::"):
            host = "127.0.0.1"
        link = f"http://{host}:{self.config.port}/#k={self.token}"
        if self.config.public_url:
            return (f"{self.config.public_url.rstrip('/')}/  (Cloudflare Access \u2014 sign in as the operator)\n"
                    f"{link}  (loopback / SSH tunnel \u2014 capability key)")
        return link

    # -- cpu database -----------------------------------------------------

    def cpu_conn(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.cpu_db, timeout=5)
        conn.row_factory = sqlite3.Row
        return conn

    def cpu_series(self, period: str) -> dict:
        # Native measurements have a separate database and explicit Rust identity
        # contract; never serve a pre-existing Linux cpu.db on Windows.
        if os.environ.get("SINGULARITY_WINDOWS_NATIVE") == "1":
            from native_cpu_history import series
            return series(self.config, period, PERIODS)
        window, bucket = PERIODS.get(period, PERIODS["1h"])
        since = int(time.time()) - window
        series: list[dict] = []
        stats = {"avg": None, "peak": None, "samples": 0, "gaps": 0, "last_sample": None, "window_seconds": window}
        if not self.cpu_db.exists():
            return {"series": [], "stats": stats, "bucket_seconds": bucket, "period": period, "retention_days": self.config.cpu_retention_days}
        with self.cpu_conn() as conn:
            rows = conn.execute(
                "SELECT ts, cpu_pct, host_pct, state FROM cpu_samples WHERE ts >= ? ORDER BY ts",
                (since,),
            ).fetchall()
            latest = conn.execute(
                "SELECT ts, cpu_pct, host_pct, pid, state FROM cpu_samples ORDER BY ts DESC LIMIT 1"
            ).fetchone()
        buckets: dict[int, list[float]] = {}
        for row in rows:
            values = buckets.setdefault(row["ts"] // bucket * bucket, [])
            if row["cpu_pct"] is not None and row["state"] == "ok":
                values.append(row["cpu_pct"])
        for stamp in sorted(buckets):
            values = buckets[stamp]
            series.append(
                {
                    "ts": stamp,
                    "avg": round(sum(values) / len(values), 2) if values else None,
                    "peak": round(max(values), 2) if values else None,
                }
            )
        measured = [row["cpu_pct"] for row in rows if row["cpu_pct"] is not None and row["state"] == "ok"]
        if measured:
            stats["avg"] = round(sum(measured) / len(measured), 2)
            stats["peak"] = round(max(measured), 2)
            stats["samples"] = len(measured)
        # A gap is a stretch longer than two sampling intervals with no usable sample.
        interval = max(1, self.config.sample_interval_seconds)
        last_ts = None
        for row in rows:
            if last_ts is not None and row["ts"] - last_ts > interval * 2:
                stats["gaps"] += 1
            last_ts = row["ts"]
        if latest:
            stats["last_sample"] = datetime.fromtimestamp(latest["ts"], timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        return {
            "series": series,
            "stats": stats,
            "bucket_seconds": bucket,
            "period": period,
            "retention_days": self.config.cpu_retention_days,
        }

    # -- shared shape builders --------------------------------------------

    def activity(self) -> dict:
        return summarise_log(self.rql.log_tail())

    def knowledge_link_map(self) -> dict:
        """name -> (category, canonical_uri) for see-also resolution."""
        rows = self.rql.query_cached(
            "capsule_index",
            "SELECT name, category, canonical_uri FROM capsules",
            60.0,
            timeout=180,
        )
        return {row["name"]: row for row in rows}

    def see_also_links(self) -> list[dict]:
        rows = self.rql.query_cached(
            "see_also_rows",
            "SELECT name, category, canonical_uri, see_also FROM capsules WHERE see_also IS NOT NULL",
            60.0,
            timeout=180,
        )
        index = self.knowledge_link_map()
        links: list[dict] = []
        for row in rows:
            values = row.get("see_also")
            if not values:
                continue
            if isinstance(values, str):
                try:
                    parsed = json.loads(values)
                except json.JSONDecodeError:
                    continue
            else:
                parsed = values
            if not isinstance(parsed, list):
                continue
            for target in parsed:
                if not isinstance(target, str):
                    continue
                target = target.strip().strip('"')
                if not target:
                    continue
                match = index.get(target)
                links.append(
                    {
                        "collection": "see_also",
                        "type": "SEE_ALSO",
                        "source_uri": row["canonical_uri"],
                        "source_name": row["name"],
                        "source_category": row.get("category") or "uncategorised",
                        "target_uri": match["canonical_uri"] if match else None,
                        "target_name": target,
                        "target_category": (match.get("category") if match else None) or "unresolved",
                        "resolved": bool(match),
                        "provenance": "capsules.see_also",
                    }
                )
        return links

    def repo_rows(self) -> dict:
        """Merged repository list: import registry + per-mount index statistics."""
        imports = self.rql.imports().get("imports", [])
        filesystems = self.rql.filesystems()
        activity = self.activity()
        mounts = activity.get("mounts", {})
        exclusions = self.exclusions.load()
        by_root = {fs["source_uri"]: fs for fs in filesystems}
        rows = []
        for entry in imports:
            root = entry.get("root")
            fs = by_root.get(root, {})
            directory = entry.get("directory") or fs.get("local_path")
            available = bool(directory and Path(directory).exists())
            rows.append(
                {
                    "root": root,
                    "kind": entry.get("kind") or fs.get("kind"),
                    "state": entry.get("state"),
                    "standing": entry.get("standing"),
                    "analysis": entry.get("analysis"),
                    "directory": directory,
                    "available": available,
                    "file_count": fs.get("file_count"),
                    "indexed_count": fs.get("indexed_count"),
                    "embedded_count": fs.get("embedded_count"),
                    "embed_pct": fs.get("embed_pct"),
                    "total_bytes": fs.get("total_bytes"),
                    "languages": fs.get("languages"),
                    "mounted_at": fs.get("mounted_at"),
                    "watching": fs.get("watching"),
                    "include_in_enumeration": fs.get("include_in_enumeration"),
                    "last_activity": mounts.get(root),
                    "excluded": sum(1 for rec in exclusions if rec.get("mount_root") == root),
                    "failed": 0,
                }
            )
        failed = self.rql.failed_files(ttl=15.0)
        roots = [row["root"] for row in rows if row["root"]]
        for item in failed:
            root = repository_of(item["uri"], roots)
            if not root:
                continue
            for row in rows:
                if row["root"] == root:
                    row["failed"] += 1
                    break
        for row in rows:
            row["status"] = self.repo_status(row)
        return {"repositories": rows, "system_mounts": [self.system_mount(fs) for fs in filesystems if not fs["source_uri"] or not any(r["root"] == fs["source_uri"] for r in rows)]}

    @staticmethod
    def repo_status(row: dict) -> str:
        if row.get("state") not in (None, "served"):
            return str(row["state"])
        if not row.get("available"):
            return "unavailable"
        if row.get("failed"):
            return "errors"
        if row.get("file_count") and row.get("indexed_count") is not None and row["indexed_count"] < row["file_count"]:
            return "indexing"
        return "indexed"

    @staticmethod
    def system_mount(fs: dict) -> dict:
        return {
            "root": fs.get("source_uri") or fs.get("id"),
            "kind": fs.get("kind") or "system",
            "directory": fs.get("local_path"),
            "file_count": fs.get("file_count"),
            "indexed_count": fs.get("indexed_count"),
            "read_only": True,
        }


# --------------------------------------------------------------------------
# HTTP layer
# --------------------------------------------------------------------------


EMBED_PREFIX = "/embed/repoql"
# Office art the Pixi client loads from root-absolute URLs (see native_panel_proxy.static_asset).
OFFICE_ASSET_PREFIXES = ("/sprites/", "/rooms/")
# The Control Panel listener is the running RepoQL host's own, read from its
# workspace bind record; 41005 is only a fallback origin. A hard-coded port
# would proxy a different workspace's panel on a machine that runs more than
# one (the installed product and this candidate do).
NATIVE_REPOQL_DEFAULT_UPSTREAM = ("127.0.0.1", 41005)


def native_repoql_upstream() -> tuple[str, int]:
    from repoql_native_auth import panel_origin

    return panel_origin() or NATIVE_REPOQL_DEFAULT_UPSTREAM


def upstream_authority(upstream: tuple[str, int]) -> str:
    host, port = upstream
    return f"[{host}]:{port}" if ":" in host else f"{host}:{port}"
MAX_EMBED_BODY = 32 * 1024 * 1024


class Handler(BaseHTTPRequestHandler):
    server_version = "RepoQLDashboard/1.0"
    app: App  # set on the subclass created in serve()

    # -- plumbing ---------------------------------------------------------

    def log_message(self, fmt: str, *args) -> None:  # quieter than the default
        if os.environ.get("RQLDASH_DEBUG"):
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def handle(self) -> None:
        """Drop peers that are neither loopback nor the tunnel connector."""
        if not self.app.peer_allowed(self.client_address[0]):
            try:
                self.connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            self.close_connection = True
            self.connection.close()
            return
        super().handle()

    def do_GET(self) -> None:
        self.route("GET")

    def do_POST(self) -> None:
        self.route("POST")

    def do_DELETE(self) -> None:
        self.route("DELETE")

    def do_PUT(self) -> None:
        self._native_panel_write("PUT")

    def do_PATCH(self) -> None:
        self._native_panel_write("PATCH")

    def _native_panel_write(self, method: str) -> None:
        # The native apps use these verbs; do not widen other dashboard APIs.
        if self.is_public_office_host() or urlparse(self.path).path.startswith(('/embed/tencent/', '/embed/office/', '/embed/kanzo/')):
            self.route(method)
        else:
            self.send_json(HTTPStatus.METHOD_NOT_ALLOWED, {'error': 'method_not_allowed'})

    def do_HEAD(self) -> None:
        if self.app.local_account is not None:
            self.send_json(HTTPStatus.METHOD_NOT_ALLOWED, {'error': 'head_not_supported_for_private_dashboard'})
            return
        """HEAD for the static surface so liveness probes that assume HEAD stop 501ing.

        Mirrors the GET static path (root / -> index.html, containment-bounded,
        same security headers) but sends no body. API paths stay HEAD-less on
        purpose: do not widen the authenticated surface with this.
        """
        if self.is_public_office_host():
            self.route("HEAD")
            return
        parsed = urlparse(self.path)
        relative = "index.html" if parsed.path in ("/", "") else parsed.path.lstrip("/")
        target = (STATIC_DIR / relative).resolve()
        if not target.is_relative_to(STATIC_DIR.resolve()) or not target.is_file():
            target = STATIC_DIR / "index.html"
        if not target.is_file():
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})
            return
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Cache-Control", "no-store" if self.app.local_account is not None else "no-cache")
        if self.app.local_account is not None:
            self.send_header("Content-Security-Policy", "frame-ancestors 'self'")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        # st_size can differ by the Access-injection marker on a real GET body;
        # this endpoint exists so connectors get a status instead of a 501.
        self.send_header("Content-Length", str(target.stat().st_size))
        self.end_headers()

    # -- auto-local session (owner addendum A2) ---------------------------
    def _loopback_peer(self) -> bool:
        """True only for a loopback peer address (never a raise on a bad address)."""
        try:
            return ipaddress.ip_address(self.client_address[0]).is_loopback
        except (ValueError, IndexError):
            return False

    def _auto_local_request_allowed(self) -> bool:
        """Cheap anti-drive-by checks for silent loopback session issuance."""
        if not self._loopback_peer():
            return False
        host = (self.headers.get('Host') or '').strip().lower()
        name, _, port = host.partition(':')
        if name not in ('127.0.0.1', 'localhost'):
            return False
        if port and port != str(self.server.server_address[1]):
            return False
        site = (self.headers.get('Sec-Fetch-Site') or '').strip().lower()
        if site and site not in ('same-origin', 'none'):
            return False
        origin = self.headers.get('Origin')
        if origin:
            try:
                parsed = urlparse(origin)
            except ValueError:
                return False
            if parsed.scheme != self.request_scheme() or parsed.netloc.lower() != host:
                return False
        return True

    def _maybe_issue_auto_local(self) -> None:
        account = getattr(getattr(self, 'app', None), 'local_account', None)
        if account is None or not account.auto_local:
            return
        if account.authenticated(self.headers.get('Cookie', '')):
            return
        if not self._auto_local_request_allowed():
            return
        self._pending_session = account.issue_session()
        self._auto_session_ok = True

    def end_headers(self) -> None:
        pending = getattr(self, '_pending_session', None)
        if pending:
            self.send_header('Set-Cookie', f'{ACCOUNT_COOKIE_NAME}={pending}; HttpOnly; '
                             f'SameSite=Strict; Path=/; Max-Age={session_ttl()}')
            self._pending_session = None
        super().end_headers()

    def route(self, method: str) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        params = {key: values[-1] for key, values in parse_qs(parsed.query).items()}
        # Consent is per request: never inherit a previous request's auto-local
        # grant (an HTTP/1.1 keep-alive handler instance is reused otherwise).
        self._auto_session_ok = False
        self._pending_session = None
        # Duck-typed handlers (the variant/HTTP unit tests) call route() without the
        # socket machinery, so the auto-local hook is optional rather than assumed.
        hook = getattr(self, '_maybe_issue_auto_local', None)
        if hook is not None:
            hook()
        try:
            profile = variant_features()
            if not variant_route_allowed(path, profile):
                self.send_json(HTTPStatus.NOT_FOUND, {"error": "feature_not_in_install_variant"})
                return
            if getattr(getattr(self, 'app', None), 'local_account', None) is not None:
                if path.startswith('/api/account/'):
                    self.serve_local_account(method, path)
                    return
                # Cookie traffic must carry an exact Origin on every mutation.
                # Machine clients with a local bearer token do not use cookies.
                if (method in ('POST', 'PUT', 'PATCH', 'DELETE')
                    and self.app.local_account.authenticated(self.headers.get('Cookie', ''))
                    and not self.bearer_authorized()
                    and not self.request_origin_allowed(require_origin=True)):
                    self.send_json(HTTPStatus.FORBIDDEN, {'error': 'account_origin_refused'})
                    return
            if path == '/setup' or path.startswith('/api/setup/'):
                self.serve_setup_health(method, path)
                return
            # MUST precede every dashboard route, including DELETE and /api/*.
            # This host is only Office; its Access audience grants no dashboard access.
            if self.is_public_office_host():
                from native_panel_proxy import serve
                serve(self, 'office', method, parsed, public_root=True)
                return
            if path == '/.well-known/singularity-health':
                # Native Windows supervisor identity probe. This endpoint is
                # intentionally small, loopback-only and unauthenticated so
                # startup checks never need to put a bearer token into a
                # process launcher configuration or query string. A matching
                # header is a readiness hint, NOT proof of process ownership.
                try:
                    local_peer = ipaddress.ip_address(self.client_address[0]).is_loopback
                except ValueError:
                    local_peer = False
                if method != 'GET' or os.environ.get('SINGULARITY_WINDOWS_NATIVE') != '1' or not local_peer:
                    self.send_json(HTTPStatus.NOT_FOUND, {'error': 'not_found'})
                    return
                body = b'{"ok":true}'
                self.send_response(HTTPStatus.OK)
                self.send_header('X-Singularity-Component', 'dashboard')
                self.send_header('Content-Type', 'application/json')
                self.send_header('Cache-Control', 'no-store')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            for panel in ('tencent', 'office', 'kanzo'):
                if path.startswith('/embed/' + panel + '/'):
                    from native_panel_proxy import serve
                    serve(self, panel, method, parsed)
                    return
            if path == EMBED_PREFIX or path.startswith(EMBED_PREFIX + "/"):
                if self.headers.get("Upgrade", "").lower() == "websocket":
                    self.proxy_repoql_websocket(path)
                    return
                if not self.authorized_for_embed():
                    self.send_json(HTTPStatus.UNAUTHORIZED, {
                        "code": SECRET_CODE,
                        "message": "Open RepoQL Control Panel from an authenticated dashboard tab.",
                    })
                    return
                self.proxy_repoql(method, parsed)
                return
            if path.startswith("/api/") or path.startswith("/v3/"):
                from repoql_native_auth import valid_launch_cookie
                iframe_cookie_ok = (path == "/api/embed/repoql/launch"
                    and valid_launch_cookie(self.headers.get("Cookie", ""), self.app.token))
                if not self.authorized() and not iframe_cookie_ok:
                    self.send_json(HTTPStatus.UNAUTHORIZED, {
                        "code": SECRET_CODE,
                        "message": "This dashboard tab has no valid key. On the dashboard host run "
                        "`python3 dashboard/server.py link` and open the printed link.",
                        "help": "docs/DASHBOARD-SETUP.md",
                    })
                    return
                if method in ("POST", "DELETE"):
                    if not self.same_origin():
                        self.send_json(HTTPStatus.FORBIDDEN, {"error": "cross-origin request refused"})
                        return
                    # A custom header is not settable by a cross-site form or <img>; it makes
                    # every mutation a deliberate JSON API call from this origin.
                    if self.headers.get("X-Requested-With") != "repoql-dashboard" and not (path.startswith("/api/v1/") or path.startswith("/v3/")):
                        self.send_json(HTTPStatus.FORBIDDEN, {"error": "missing dashboard request header"})
                        return
                if path in ('/api/embed/tencent/handshake', '/api/embed/office/handshake', '/api/embed/kanzo/handshake'):
                    if method != 'GET':
                        self.send_json(HTTPStatus.METHOD_NOT_ALLOWED, {'error': 'method_not_allowed'})
                        return
                    from native_panel_proxy import handshake
                    handshake(self, path.split('/')[3])
                    return
                if path == "/api/embed/repoql/handshake":
                    if method != "GET":
                        self.send_json(HTTPStatus.METHOD_NOT_ALLOWED, {"error": "method_not_allowed"})
                        return
                    from embed_config import panel_config
                    from repoql_native_auth import COOKIE_NAME, create_launch_cookie, refresh_native_login_path
                    ready = panel_config()["repoql"]
                    if not ready["configured"]:
                        self.send_json(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "native_repoql_proxy_unconfigured"})
                        return
                    # Obtain a fresh RepoQL-issued login automatically on each
                    # panel open. Do not return its value to the JavaScript app.
                    if not refresh_native_login_path(force=True):
                        self.send_json(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "official_repoql_login_issuance_failed"})
                        return
                    cookie = create_launch_cookie(self.app.token)
                    self.send_response(HTTPStatus.OK)
                    self.send_header("Content-Type", "application/json; charset=utf-8")
                    self.send_header("Cache-Control", "no-store")
                    self.send_header("Referrer-Policy", "no-referrer")
                    # Public host requires a signed Access JWT; loopback bearer mode
                    # uses plain HTTP. Secure is enabled whenever Access is verified.
                    secure = "; Secure" if (self.access_identity() is not None or self.request_is_https()) else ""
                    self.send_header("Set-Cookie", f"{COOKIE_NAME}={cookie}; HttpOnly; SameSite=Strict; Path=/api/embed/repoql/launch; Max-Age=60{secure}")
                    # The iframe navigation and its assets cannot carry the bearer
                    # header. This cookie authorises only the fixed native proxy route
                    # and is scoped so the dashboard itself never receives it.
                    self.send_header("Set-Cookie", f"{COOKIE_NAME}={cookie}; HttpOnly; SameSite=Strict; Path=/embed/repoql; Max-Age=3600{secure}")
                    body = b'{"ready":true}'
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                    return
                if path == "/api/embed/repoql/launch":
                    if method != "GET":
                        self.send_json(HTTPStatus.METHOD_NOT_ALLOWED, {"error": "method_not_allowed"})
                        return
                    from embed_config import panel_config
                    from repoql_native_auth import refresh_native_login_path
                    if not panel_config()["repoql"]["configured"]:
                        self.send_json(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "native_repoql_proxy_unconfigured"})
                        return
                    login = refresh_native_login_path()
                    if not login:
                        self.send_json(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "official_repoql_login_issuance_failed"})
                        return
                    self.send_response(HTTPStatus.SEE_OTHER)
                    self.send_header("Location", login)
                    self.send_header("Cache-Control", "no-store")
                    self.send_header("Referrer-Policy", "no-referrer")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                if path == "/api/ghost/scheduler":
                    self.serve_ghost_scheduler(method)
                    return
                if path == "/api/ghost/plans":
                    self.serve_ghost_plans(method)
                    return
                if path in ("/api/ghost/status", "/api/ghost/control"):
                    self.serve_ghost_api(method, path)
                    return
                if path.startswith("/api/v1/") or path.startswith("/v3/"):
                    from tencent_panel_proxy import serve_proxy
                    serve_proxy(self,method,parsed)
                    return
                result = self.dispatch(method, path, params)
                if result is not None:
                    self.send_json(HTTPStatus.OK, result)
                return
            if path.startswith(OFFICE_ASSET_PREFIXES):
                from native_panel_proxy import static_asset
                static_asset(self, method, parsed)
                return
            self.serve_static(path)
        except UpstreamError as exc:
            self.send_json(HTTPStatus.BAD_GATEWAY, {"error": str(exc), "upstream": "repoql"})
        except ValueError as exc:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
        except FileNotFoundError as exc:
            self.send_json(HTTPStatus.NOT_FOUND, {"error": str(exc)})
        except PermissionError as exc:
            self.send_json(HTTPStatus.FORBIDDEN, {"error": str(exc)})
        except Exception as exc:  # pragma: no cover - defensive
            # Unanticipated exceptions may contain access keys, capability
            # links or private filesystem paths. Neither the HTTP response nor
            # routine diagnostics should echo those values.
            print(f"dashboard internal error ({type(exc).__name__})", file=sys.stderr, flush=True)
            self.send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "internal_error"})

    def access_identity(self) -> dict | None:
        return self.app.access_identity(self.headers)

    def is_public_office_host(self) -> bool:
        """Match one configured hostname exactly, not a suffix or caller-supplied URL."""
        if not variant_features()["features"]["office"]:
            return False
        configured = urlparse(os.environ.get("CLAUDE_OFFICE_PUBLIC_URL", "")).hostname
        try:
            supplied = urlparse("//" + getattr(self, "headers", {}).get("Host", "")).hostname
        except ValueError:
            return False
        return bool(configured and supplied
                    and configured.rstrip(".").lower() == supplied.rstrip(".").lower())

    def office_access_identity(self) -> dict | None:
        verifier = getattr(self.app, "office_access", None)
        assertion = self.headers.get("Cf-Access-Jwt-Assertion")
        return verifier.identity(assertion) if verifier and assertion else None

    def serve_local_account(self, method: str, path: str) -> None:
        """Local only, single account. Never put owner credentials in browser URLs."""
        account = self.app.local_account
        if account is None:
            self.send_json(HTTPStatus.NOT_FOUND, {'error': 'not_found'})
            return
        host = self.headers.get('Host', '')
        expected = f'127.0.0.1:{self.server.server_address[1]}'
        if (host != expected or self.client_address[0] != '127.0.0.1'
                or self.headers.get('X-Forwarded-For') or self.headers.get('X-Forwarded-Proto')):
            self.send_json(HTTPStatus.FORBIDDEN, {'error': 'local_origin_required'})
            return
        if path == '/api/account/status' and method == 'GET':
            self.send_json(HTTPStatus.OK, {
                'configured': account.configured(),
                'authenticated': account.authenticated(self.headers.get('Cookie', ''))
                                 or getattr(self, '_auto_session_ok', False),
                'mode': account.mode,
                'auto_local': account.auto_local,
            })
            return
        if path not in ('/api/account/setup', '/api/account/login', '/api/account/logout', '/api/account/mode') or method != 'POST':
            self.send_json(HTTPStatus.METHOD_NOT_ALLOWED, {'error': 'method_not_allowed'})
            return
        if (self.headers.get('Origin') != f'http://{expected}'
                or self.headers.get('X-Requested-With') != 'repoql-dashboard'
                or self.headers.get('Content-Type', '').split(';')[0].lower() != 'application/json'
                or self.headers.get('Sec-Fetch-Site') == 'cross-site'):
            self.send_json(HTTPStatus.FORBIDDEN, {'error': 'local_origin_required'})
            return
        if path == '/api/account/mode' and method == 'POST':
            try:
                size = int(self.headers.get('Content-Length', '-1'))
                if size < 2 or size > 1024:
                    raise ValueError('invalid_size')
                data = json.loads(self.rfile.read(size).decode('utf-8'))
                if not isinstance(data, dict) or set(data) != {'mode'} or not isinstance(data['mode'], str):
                    raise ValueError('invalid_body')
                applied = account.set_mode(data['mode'])
            except AccountRefused as exc:
                self.send_json(HTTPStatus.BAD_REQUEST, {'error': str(exc)})
                return
            except (ValueError, UnicodeError, TypeError):
                self.send_json(HTTPStatus.BAD_REQUEST, {'error': 'invalid_request'})
                return
            if applied == 'auto-local':
                self._pending_session = account.issue_session()
                self._auto_session_ok = True
            self.send_json(HTTPStatus.OK, {'ok': True, 'mode': applied,
                                           'auto_local': account.auto_local,
                                           'configured': account.configured()})
            return
        if path == '/api/account/logout':
            account.revoke(self.headers.get('Cookie', ''))
            self._account_response(HTTPStatus.OK, {'ok': True}, cookie='', max_age=0)
            return
        try:
            size = int(self.headers.get('Content-Length', '-1'))
            if size < 2 or size > 4096:
                raise ValueError('invalid_size')
            raw = self.rfile.read(size)
            data = json.loads(raw.decode('utf-8'))
            if not isinstance(data, dict) or set(data) != {'username', 'password'}:
                raise ValueError('invalid_body')
            if path == '/api/account/setup':
                token = account.setup(data['username'], data['password'])
            else:
                token = account.login(data['username'], data['password'], self.client_address[0])
        except AccountRefused as exc:
            code = str(exc)
            self.send_json(HTTPStatus.TOO_MANY_REQUESTS if code == 'too_many_attempts' else
                           HTTPStatus.CONFLICT if code == 'account_already_configured' else
                           HTTPStatus.UNAUTHORIZED if code == 'invalid_credentials' else
                           HTTPStatus.BAD_REQUEST, {'error': code})
            return
        except (ValueError, UnicodeError, TypeError, KeyError):
            self.send_json(HTTPStatus.BAD_REQUEST, {'error': 'invalid_request'})
            return
        self._account_response(HTTPStatus.OK, {'ok': True}, cookie=token, max_age=session_ttl())

    def _account_response(self, status: HTTPStatus, payload: dict, *, cookie: str, max_age: int) -> None:
        data = json.dumps(payload, separators=(',', ':')).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Set-Cookie', f'{ACCOUNT_COOKIE_NAME}={cookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age={max_age}')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def serve_setup_health(self, method: str, path: str) -> None:
        """Setup health + Repair (W7). Same loopback and session rules as the dashboard."""
        import setup_health

        if not self.authorized():
            self.send_json(HTTPStatus.UNAUTHORIZED, {'error': 'setup_auth_required'})
            return
        port = self.server.server_address[1]
        host = (self.headers.get('Host') or '').strip().lower()
        if host not in (f'127.0.0.1:{port}', f'localhost:{port}') or not self._loopback_peer():
            self.send_json(HTTPStatus.FORBIDDEN, {'error': 'local_origin_required'})
            return
        if path == '/api/setup/health' and method == 'GET':
            self.send_json(HTTPStatus.OK, {'rows': setup_health.rows()})
            return
        if path == '/api/setup/repair' and method == 'POST':
            if (self.headers.get('Origin') != f'http://{host}'
                    or self.headers.get('X-Requested-With') != 'repoql-dashboard'):
                self.send_json(HTTPStatus.FORBIDDEN, {'error': 'local_origin_required'})
                return
            try:
                length = int(self.headers.get('Content-Length') or 0)
            except ValueError:
                length = -1
            if length < 0 or length > 4096:
                self.send_json(HTTPStatus.BAD_REQUEST, {'error': 'invalid_body'})
                return
            try:
                payload = json.loads(self.rfile.read(length) or b'{}')
            except ValueError:
                self.send_json(HTTPStatus.BAD_REQUEST, {'error': 'invalid_json'})
                return
            only = payload.get('only') if isinstance(payload, dict) else None
            if only is not None and not (isinstance(only, list) and all(isinstance(x, str) for x in only)):
                self.send_json(HTTPStatus.BAD_REQUEST, {'error': 'invalid_only'})
                return
            try:
                summary = setup_health.repair(only)
            except Exception as exc:
                self.send_json(HTTPStatus.INTERNAL_SERVER_ERROR,
                               {'error': 'repair_failed', 'detail': type(exc).__name__})
                return
            self.send_json(HTTPStatus.OK, summary)
            return
        if path == '/setup' and method == 'GET':
            body = setup_health.page_html(setup_health.rows()).encode('utf-8')
            self.send_response(HTTPStatus.OK)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_json(HTTPStatus.METHOD_NOT_ALLOWED, {'error': 'method_not_allowed'})

    def authorized(self) -> bool:
        if getattr(self, '_auto_session_ok', False):
            return True
        if self.app.local_account is not None:
            if self.app.local_account.authenticated(self.headers.get('Cookie', '')):
                return True
            # Keep a separate capability for explicit local automation clients
            # such as Claude Code; browser requests must use the owner cookie.
            if (self.headers.get('Origin') or self.headers.get('Sec-Fetch-Site')
                or self.headers.get('Sec-Fetch-Mode')):
                return False
        header = self.headers.get("Authorization", "")
        if header.startswith("Bearer ") and hmac.compare_digest(header[7:].strip(), self.app.token):
            return True
        # Public hostname path: only a JWT signed by the Access team keys counts.
        # A bare Cf-Access-Authenticated-User-Email header is spoofable and ignored.
        return self.access_identity() is not None

    def request_is_https(self) -> bool:
        proto = (self.headers.get("X-Forwarded-Proto") or "").split(',')[0].strip().lower()
        if proto == "https":
            return True
        visitor = self.headers.get("Cf-Visitor", "")
        return '"scheme":"https"' in visitor.replace(' ', '')

    def same_origin(self) -> bool:
        origin = self.headers.get("Origin")
        if not origin:
            return True
        host = urlparse(origin).netloc
        return host == self.headers.get("Host", "")

    def request_scheme(self) -> str:
        """Scheme the browser used at the public edge, not the HTTP hop."""
        return "https" if (self.request_is_https() or self.access_identity() is not None) else "http"

    def bearer_authorized(self) -> bool:
        header = self.headers.get("Authorization", "")
        return header.startswith("Bearer ") and hmac.compare_digest(header[7:].strip(), self.app.token)

    def request_origin_allowed(self, *, require_origin: bool = False) -> bool:
        """Browser-origin boundary for the same-origin native proxy.

        A missing Origin is allowed only for explicitly bearer-authenticated
        non-browser clients; browser cookie traffic must name this exact origin.
        """
        origin = self.headers.get("Origin")
        if not origin:
            return not require_origin
        try:
            parsed = urlparse(origin)
        except ValueError:
            return False
        host = self.headers.get("Host", "")
        if not host or not parsed.netloc:
            return False
        return (parsed.netloc.lower() == host.lower()
                and parsed.scheme == self.request_scheme())

    def serve_ghost_plans(self, method: str) -> None:
        """Private scheduling drafts only; never represent these as active jobs."""
        from ghost_schedule_plans import control
        if method in ("POST", "DELETE"):
            # Ghost draft prompts can contain private agent instructions.
            # Unlike general bearer-authenticated CLI routes, this endpoint is
            # browser-only and requires an exact authenticated browser origin.
            if (not self.request_origin_allowed(require_origin=True)
                    or self.headers.get("X-Requested-With") != "repoql-dashboard"
                    or self.headers.get("X-Ghost-Control") != "1"
                    or self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower() != "application/json"
                    or self.headers.get("Sec-Fetch-Site", "") == "cross-site"):

                self.send_json(HTTPStatus.FORBIDDEN, {"ok": False, "error": "control_request_rejected"})
                return
            try:
                body = self.read_body()
            except ValueError:
                self.send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": "invalid_json"})
                return
            status, payload = control(method, body)
        else:
            status, payload = control(method)
        self.send_json(HTTPStatus(status), payload)

    def serve_ghost_scheduler(self, method: str) -> None:
        """Proxy native schedule actions and require an independent live readback."""
        # A verified Cloudflare email/sub does not identify a Windows SID. This
        # per-user scheduler surface is available only through this process's
        # local dashboard capability until an operator-owned identity mapping
        # exists; never let a remote Access user inherit the server owner's SID.
        if not self.scheduler_identity_bound():
            self.send_json(HTTPStatus.FORBIDDEN, {
                "ok": False, "verified": False, "error": "scheduler_owner_binding_required", "schedules": [],
            })
            return
        if os.environ.get("SINGULARITY_WINDOWS_NATIVE") != "1":
            self.send_json(HTTPStatus.SERVICE_UNAVAILABLE, {
                "ok": False, "verified": False, "error": "native_scheduler_unavailable", "schedules": [],
            })
            return
        if method not in ("GET", "POST"):
            self.send_json(HTTPStatus.METHOD_NOT_ALLOWED, {"ok": False, "error": "method_not_allowed"})
            return
        body = None
        if method == "POST":
            from ghost_bridge import control_headers_valid
            if not control_headers_valid(self.headers, self.headers.get("Host", "")):
                self.send_json(HTTPStatus.FORBIDDEN, {"ok": False, "error": "control_request_rejected"})
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                length = -1
            if not 0 < length <= 131072:
                self.send_json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"ok": False, "error": "invalid_request_size"})
                return
            try:
                body = self.read_scheduler_body()
            except ValueError:
                self.send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": "invalid_json"})
                return
        from ghost_schedule_plans import scheduler_control
        from native_ghost import control_request as host_request
        status, payload = scheduler_control(method, body, host_request=host_request)
        self.send_json(HTTPStatus(status), payload)

    def read_scheduler_body(self) -> dict:
        """Parse scheduler JSON while refusing duplicate keys at every depth."""
        length = int(self.headers.get("Content-Length") or 0)
        if not 0 < length <= 131072:
            raise ValueError("invalid scheduler request size")
        raw = self.rfile.read(length)

        def unique_pairs(pairs):
            result = {}
            for key, value in pairs:
                if key in result:
                    raise ValueError("duplicate scheduler request field")
                result[key] = value
            return result

        try:
            payload = json.loads(raw.decode("utf-8"), object_pairs_hook=unique_pairs)
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ValueError("invalid scheduler request JSON")
        if not isinstance(payload, dict):
            raise ValueError("scheduler request must be an object")
        return payload

    def scheduler_identity_bound(self) -> bool:
        """Require this user's bearer capability and a loopback browser peer."""
        try:
            local_peer = ipaddress.ip_address(self.client_address[0]).is_loopback
        except (ValueError, IndexError, TypeError):
            local_peer = False
        account = getattr(getattr(self, 'app', None), 'local_account', None)
        owner_cookie = bool(account and account.authenticated(getattr(self, 'headers', {}).get('Cookie', '')))
        return local_peer and (self.bearer_authorized() or owner_cookie)

    def serve_ghost_api(self, method: str, path: str) -> None:
        from ghost_bridge import control_headers_valid, control_request, read_status
        if path == "/api/ghost/status":
            if method != "GET":
                self.send_json(HTTPStatus.METHOD_NOT_ALLOWED, {"error": "method_not_allowed"})
                return
            status, payload = read_status()
        elif method == "GET":
            status, payload = control_request("GET")
        elif method == "POST":
            if not control_headers_valid(self.headers, self.headers.get("Host", "")):
                self.send_json(HTTPStatus.FORBIDDEN, {"ok": False, "error": "control_request_rejected"})
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                length = -1
            if not 0 < length <= 131072:
                self.send_json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"ok": False, "error": "invalid_request_size"})
                return
            try:
                body = self.read_body()
            except ValueError:
                self.send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": "invalid_json"})
                return
            status, payload = control_request("POST", body)
        else:
            status, payload = 405, {"ok": False, "error": "method_not_allowed"}
        self.send_json(HTTPStatus(status), payload)

    def send_json(self, status: HTTPStatus, payload: dict) -> None:
        body = json.dumps(payload, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def authorized_for_embed(self) -> bool:
        """Dashboard session or a signed, scoped native-panel cookie."""
        if self.authorized():
            return True
        from repoql_native_auth import valid_launch_cookie
        return valid_launch_cookie(self.headers.get("Cookie", ""), self.app.token, max_age=3600)

    def _embed_upstream_path(self, path: str) -> str:
        if not (path == EMBED_PREFIX or path.startswith(EMBED_PREFIX + "/")):
            raise PermissionError("invalid native panel prefix")
        rest = path[len(EMBED_PREFIX):] or "/"
        if not rest.startswith("/") or rest.startswith("//") or len(rest) > 4096:
            raise PermissionError("invalid native panel path")
        # Validate multiple decoding passes: the fixed upstream may decode a
        # percent-encoded path more than once. Reject traversal *before* it
        # reaches the upstream instead of relying on its URL normalizer.
        decoded = rest
        for _ in range(3):
            if ("\\" in decoded or "\x00" in decoded or decoded.startswith("//") or
                    any(part in (".", "..") for part in decoded.split("/"))):
                raise PermissionError("invalid native panel path")
            next_decoded = unquote(decoded)
            if next_decoded == decoded:
                break
            decoded = next_decoded
        return rest

    def _rewrite_embed_text(self, text: str) -> str:
        """Point the native app's absolute asset/API paths at its same-origin prefix.

        Only text responses from the fixed upstream are touched; nothing is
        rewritten in stored data, HTML served by this dashboard, or API JSON.
        """
        import re as _re
        # Quoted absolute paths (HTML, module preload, fetch strings, CSS url()).
        text = _re.sub(r'(["\'`(=])(/(?:assets/|api/|favicon\.svg|login\b|callback\b))',
                       r'\1' + EMBED_PREFIX + r'\2', text)
        # Template-built paths such as ${location.host}/api/dashboard/session.
        text = _re.sub(r'(\})/(api/)', r'\1' + EMBED_PREFIX + r'/\2', text)
        return text

    def _safe_repoql_redirect(self, location: str, upstream_path: str) -> str:
        """Keep the official local panel's redirects on our authenticated origin.

        RepoQL may return a localhost absolute URL, e.g. after authenticating.
        Forwarding it unchanged bypasses the dashboard origin and breaks remote
        clients. No redirect may name a third-party origin or an alternate port.
        """
        if (not isinstance(location, str) or not location or len(location) > 4096
                or any(c in location for c in ("\\", "\r", "\n", "\x00"))):
            raise PermissionError("unsafe native panel redirect")
        parsed = urlsplit(location)
        if parsed.username is not None or parsed.password is not None:
            raise PermissionError("unsafe native panel redirect authority")
        if parsed.scheme or parsed.netloc:
            try:
                port = parsed.port
            except ValueError as exc:
                raise PermissionError("invalid native panel redirect port") from exc
            if (parsed.scheme != "http" or parsed.hostname not in
                    ("localhost", "127.0.0.1", "::1")
                    or port != native_repoql_upstream()[1]):
                raise PermissionError("foreign native panel redirect refused")
        # A protocol-relative URL is never relative to the fixed upstream.
        if location.startswith("//") or parsed.path.startswith("//"):
            raise PermissionError("unsafe native panel redirect path")
        raw_path = parsed.path or upstream_path.split("?", 1)[0]
        # Reject traversal in encoded and ordinary form *before* urljoin can
        # normalize it away. One decode also rules out encoded slashes and NUL.
        decoded = raw_path
        for _ in range(3):
            if ("\\" in decoded or "\x00" in decoded or decoded.startswith("//") or
                    any(part in (".", "..") for part in decoded.split("/"))):
                raise PermissionError("unsafe native panel redirect path")
            next_decoded = unquote(decoded)
            if next_decoded == decoded:
                break
            decoded = next_decoded
        resolved = urljoin(upstream_path, raw_path) if not raw_path.startswith("/") else raw_path
        if not resolved.startswith("/") or resolved.startswith("//"):
            raise PermissionError("unsafe native panel redirect path")
        # Upstream paths live beneath /embed/repoql, even when a local panel
        # returns an absolute /login or /#k=... capability URL.
        embedded = resolved if resolved.startswith(EMBED_PREFIX + "/") else EMBED_PREFIX + resolved
        return urlunsplit(("", "", embedded, parsed.query, parsed.fragment))

    def _rewrite_embed_cookie(self, value: str) -> str:
        parts = []
        for part in value.split(";"):
            item = part.strip()
            low = item.lower()
            if low.startswith("domain="):
                continue
            if low.startswith("path="):
                path = item.split("=", 1)[1] or "/"
                if path.startswith(EMBED_PREFIX):
                    pass
                elif path == "/":
                    item = "Path=" + EMBED_PREFIX
                else:
                    item = "Path=" + EMBED_PREFIX + path
            parts.append(item)
        return "; ".join(parts)

    def _repoql_forward_headers(self, *, websocket: bool = False) -> dict[str, str]:
        """Forward panel headers without exporting dashboard authentication.

        RepoQL may use its *own* Authorization bearer and session cookies, so
        do not indiscriminately remove them. The dashboard's bearer and scoped
        launch cookie must never cross the proxy boundary. Cloudflare Access
        identity headers belong to this dashboard's outer authentication only.
        """
        from repoql_native_auth import COOKIE_NAME

        hop_by_hop = {'host', 'connection', 'keep-alive', 'proxy-authorization',
                      'proxy-authenticate', 'te', 'trailer', 'transfer-encoding',
                      'upgrade', 'content-length', 'accept-encoding', 'referer'}
        if websocket:
            hop_by_hop -= {'accept-encoding'}
        result: dict[str, str] = {}
        for key, value in self.headers.items():
            low = key.lower()
            if ('\r' in key or '\n' in key or '\r' in value or '\n' in value):
                raise PermissionError('invalid forwarded header')
            if low in hop_by_hop or low.startswith('cf-access-'):
                continue
            if low == 'authorization':
                if value.startswith('Bearer ') and hmac.compare_digest(value[7:].strip(), self.app.token):
                    continue
            if low == 'cookie':
                safe_cookies = []
                for part in value.split(';'):
                    field = part.strip()
                    if field and field.split('=', 1)[0].strip().lower() != COOKIE_NAME.lower():
                        safe_cookies.append(field)
                if not safe_cookies:
                    continue
                value = '; '.join(safe_cookies)
            result[key] = value
        return result

    def proxy_repoql(self, method: str, parsed) -> None:
        upstream_path = self._embed_upstream_path(parsed.path)
        if parsed.query:
            upstream_path += "?" + parsed.query
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": "invalid_content_length"})
            return
        if length < 0 or length > 8 * 1024 * 1024:
            self.send_json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"error": "request_too_large"})
            return
        if method in ("POST", "PUT", "PATCH", "DELETE") and not self.request_origin_allowed(
                require_origin=not self.bearer_authorized()):
            self.send_json(HTTPStatus.FORBIDDEN, {"error": "cross-origin request refused"})
            return
        body = self.rfile.read(length) if length else None
        try:
            headers = self._repoql_forward_headers()
        except PermissionError:
            self.send_json(HTTPStatus.BAD_REQUEST, {'error': 'invalid_header'})
            return
        upstream = native_repoql_upstream()
        authority = upstream_authority(upstream)
        headers["Host"] = authority
        headers["Accept-Encoding"] = "identity"
        if "Origin" in headers:
            headers["Origin"] = "http://" + authority
        if method in ("POST", "PUT", "PATCH", "DELETE") and body is not None:
            headers["Content-Length"] = str(len(body))
        conn = http.client.HTTPConnection(*upstream, timeout=30)
        try:
            conn.request(method, upstream_path, body=body, headers=headers)
            response = conn.getresponse()
            content = response.read(MAX_EMBED_BODY + 1)
            if len(content) > MAX_EMBED_BODY:
                self.send_json(HTTPStatus.BAD_GATEWAY, {"error": "native_response_too_large"})
                return
            content_type = (response.getheader("Content-Type") or "").lower()
            if any(kind in content_type for kind in
                   ("text/html", "text/css", "javascript", "image/svg")):
                text = content.decode("utf-8", "replace")
                content = self._rewrite_embed_text(text).encode("utf-8")
            redirect = None
            if response.status in (301, 302, 303, 307, 308):
                try:
                    redirect = self._safe_repoql_redirect(
                        response.getheader("Location"), upstream_path)
                except (PermissionError, ValueError, TypeError):
                    # Do not send a foreign Location or a possibly credential-
                    # bearing upstream error body back to the browser.
                    self.send_json(HTTPStatus.BAD_GATEWAY,
                                   {"error": "native_repoql_redirect_refused"})
                    return
                content = b""
            self.send_response(response.status)
            for key, value in response.getheaders():
                low = key.lower()
                if low in ("connection", "keep-alive", "transfer-encoding", "content-length",
                           "content-encoding", "server", "date", "x-frame-options"):
                    continue
                if low == "set-cookie":
                    value = self._rewrite_embed_cookie(value)
                if low == "location":
                    if redirect is None:
                        # Non-redirect responses cannot inject navigation.
                        continue
                    value = redirect
                if low in ("proxy-authenticate", "proxy-authorization", "trailer", "te", "upgrade"):
                    continue
                self.send_header(key, value)
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(content)))
            self.end_headers()
            if method != "HEAD":
                self.wfile.write(content)
        except (OSError, http.client.HTTPException):
            self.send_json(HTTPStatus.BAD_GATEWAY, {"error": "native_repoql_unavailable"})
        finally:
            conn.close()

    def proxy_repoql_websocket(self, path: str) -> None:
        """Relay the official dashboard's WebSocket through the authenticated origin.

        This is an opaque byte tunnel after a checked handshake; capabilities can
        appear in the URL fragment only and are never logged here.
        """
        if not self.authorized_for_embed():
            self.send_json(HTTPStatus.UNAUTHORIZED, {"code": SECRET_CODE})
            return
        if not self.request_origin_allowed(require_origin=not self.bearer_authorized()):
            self.send_json(HTTPStatus.FORBIDDEN, {"error": "cross-origin request refused"})
            return
        try:
            upstream_path = self._embed_upstream_path(path)
        except PermissionError:
            self.send_json(HTTPStatus.FORBIDDEN, {"error": "invalid_path"})
            return
        upstream = None
        try:
            lines = [f"GET {upstream_path} HTTP/1.1"]
            for key, value in self._repoql_forward_headers(websocket=True).items():
                if key.lower() == 'origin':
                    continue
                lines.append(f"{key}: {value}")
            upstream_target = native_repoql_upstream()
            upstream_authority_text = upstream_authority(upstream_target)
            lines.append("Host: " + upstream_authority_text)
            if self.headers.get("Origin"):
                lines.append("Origin: http://" + upstream_authority_text)
            lines.append("Connection: Upgrade")
            lines.append("Upgrade: websocket")
            upstream = socket.create_connection(upstream_target, timeout=10)
            upstream.sendall(("\r\n".join(lines) + "\r\n\r\n").encode("latin-1"))
            self.connection.settimeout(None)
            upstream.settimeout(None)
            while True:
                ready, _, _ = select.select([self.connection, upstream], [], [], 300)
                if not ready:
                    return
                for source in ready:
                    data = source.recv(65536)
                    if not data:
                        return
                    target = upstream if source is self.connection else self.connection
                    target.sendall(data)
        except (OSError, PermissionError):
            return
        finally:
            if upstream is not None:
                upstream.close()
            self.close_connection = True

    def serve_static(self, path: str) -> None:
        if path.startswith(("/ghost/", "/office/")) and not variant_route_allowed(path, variant_features()):
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "feature_not_in_install_variant"})
            return
        relative = "index.html" if path in ("/", "") else path.lstrip("/")
        local_account = getattr(getattr(self, "app", None), "local_account", None)
        if local_account is not None:
            # A first auto-local request carries no cookie yet, but this request's
            # grant is already decided (A1: the dashboard opens signed in, never
            # on the sign-in page).
            signed_in = (getattr(self, '_auto_session_ok', False)
                         or local_account.authenticated(self.headers.get('Cookie', '')))
            if not signed_in:
                if relative in ('index.html', 'account.html'):
                    relative = 'account.html'
                else:
                    self.send_json(HTTPStatus.UNAUTHORIZED, {'error': 'account_login_required'})
                    return
            elif relative == 'account.html':
                relative = 'index.html'
        target = (STATIC_DIR / relative).resolve()
        # Component-boundary containment: a string prefix would accept sibling dirs like static-foo.
        if not target.is_relative_to(STATIC_DIR.resolve()) or not target.is_file():
            target = STATIC_DIR / "index.html"
        if not target.is_file():
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})
            return
        content_type = {
            ".html": "text/html; charset=utf-8",
            ".js": "application/javascript; charset=utf-8",
            ".mjs": "application/javascript; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".svg": "image/svg+xml",
            ".json": "application/json",
        }.get(target.suffix, "application/octet-stream")
        body = target.read_bytes()
        if target.name == "index.html":
            public_profile = variant_features()
            feature_json = json.dumps(public_profile, separators=(",", ":"), sort_keys=True).replace("<", "\\u003c")
            body = body.replace(b"<head>", ("<head>\n<script>window.__SINGULARITY_VARIANT__=" + feature_json + ";</script>").encode("utf-8"), 1)
        if target.name == "index.html" and local_account is not None:
            body = body.replace(b"<head>", b"<head>\n<script>window.__SINGULARITY_LOCAL_LOGIN__=true;</script>", 1)
        if target.name == "index.html" and (self.access_identity() is not None or
             (local_account and local_account.authenticated(self.headers.get('Cookie', '')))):
            # Tell the SPA that Access already vouched for this browser, so it does
            # not look for the loopback capability key in the URL fragment.
            body = body.replace(b"<head>", b"<head>\n<script>window.__RQDASH_ACCESS__=true;</script>", 1)
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-store" if local_account is not None else "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # -- dispatch ---------------------------------------------------------

    def dispatch(self, method: str, path: str, params: dict) -> dict | None:
        app = self.app
        if method == "GET":
            if path == "/api/features":
                return variant_features()
            if path == "/api/claude/agents":
                from claude_agents_control import list_agents
                return list_agents()
            if path == "/api/claude/agents/detail":
                from claude_agents_control import agent_detail
                return agent_detail(params.get("name", ""))
            if path == "/api/claude/policy":
                from claude_agents_control import policy_inventory
                return policy_inventory()
            if path == "/api/claude/mcps":
                from claude_agents_control import mcp_inventory
                return mcp_inventory()
            if path == "/api/openmausbot/overview":
                from native_openmausbot import overview
                return overview(app.config.state_dir)
            if path == "/api/native/windows/readiness":
                from native_readiness import report
                return report(app.config)
            if path == "/api/harness/office":
                from office_bridge import office_status
                return office_status()
            if path == "/api/repos/usage":
                from repo_query_usage import from_environment
                return from_environment([r["root"] for r in app.repo_rows()["repositories"] if r.get("root")])
            if path == "/api/freebuff/allowance":
                if os.environ.get("SINGULARITY_WINDOWS_NATIVE") == "1":
                    return {"available": False, "error": "not_part_of_native_gui_subscription_usage"}
                from freebuff_allowance import get_allowance
                return get_allowance()
            if path.startswith("/api/harness"):
                if app.harness is None:
                    raise UpstreamError("harness telemetry module unavailable")
                return app.harness.get(path, params)
            if path == "/api/openchamber/telemetry":
                if os.environ.get("SINGULARITY_WINDOWS_NATIVE") == "1":
                    return {"available": False, "reason": "unverified_provider_wide_usage_not_native_subscription_usage"}
                configured_summary = os.environ.get("SINGULARITY_OPENCHAMBER_SUMMARY_FILE", "").strip()
                if not configured_summary:
                    return {"available": False, "reason": "OpenChamber summary is not configured"}
                file = Path(configured_summary)
                if not file.is_file():
                    return {"available": False, "reason": "OpenChamber summary collector not deployed"}
                if file.stat().st_size > 2_000_000:
                    return {"available": False, "reason": "OpenChamber summary too large"}
                try:
                    with file.open(encoding="utf-8") as src:
                        return json.load(src)
                except (OSError, ValueError):
                    return {"available": False, "reason": "OpenChamber summary unreadable"}
            if path == "/api/agentchat/presence":
                from agentchat_feed import read_presence
                return read_presence()
            if path == "/api/agentchat/feed":
                from agentchat_feed import read_feed
                return read_feed(params.get("after", "0"), params.get("limit", "80"))
            if path == "/api/graph/annotations":
                from graph_annotations import list_annotations
                return list_annotations()
            if path.startswith("/api/unified/"):
                from unified_bridge import forward_unified
                return forward_unified("GET", path, params)
            if path == "/api/health":
                return {"ok": True, "service": "repoql-dashboard", "started_at": int(app.started_at),
                        "access": app.access.status() if app.access else {"enabled": False},
                        "peers": [str(net) for net in app._peer_networks]}
            if path == "/api/overview":
                return self.overview()
            if path == "/api/status":
                return self.status_detail()
            if path == "/api/indexing":
                return self.indexing()
            if path == "/api/files":
                return self.files(params)
            if path == "/api/repos":
                return app.repo_rows()
            if path == "/api/repos/detail":
                return self.repo_detail(params)
            if path == "/api/knowledge":
                return self.knowledge(params)
            if path == "/api/knowledge/item":
                return self.knowledge_item(params)
            if path == "/api/hub-doc-rows":
                return self.hub_doc_rows(params)
            if path == "/api/memory-docs":
                return self.memory_docs(params)
            if path == "/api/links":
                return self.links(params)
            if path == "/api/links/graph":
                return self.links_graph(params)
            if path == "/api/connectors":
                from repoql_connectors import connector_inventory
                return connector_inventory(app.rql)
            if path == "/api/errors":
                return self.errors(params)
            if path == "/api/excluded":
                return self.excluded()
            if path == "/api/embed/panels":
                from embed_config import panel_config
                return panel_config()
            if path == "/api/cpu":
                return app.cpu_series(params.get("period", "1h"))
            if path == "/api/activity":
                return self.activity_feed(params)
            raise FileNotFoundError(f"no such endpoint: {path}")
        # mutations
        body = self.read_body()
        if path == "/api/claude/agents/save":
            from claude_agents_control import save_agent
            return self.mutation("Claude Code agent definition", lambda: save_agent(body))
        if path == "/api/claude/agents/restore":
            from claude_agents_control import restore_agent
            return self.mutation("Claude Code agent restore", lambda: restore_agent(body))
        if path == "/api/graph/annotations":
            from graph_annotations import save_annotation
            return self.mutation("graph annotation",lambda:save_annotation(body))
        if path == "/api/unified/tencent/invoke":
            from unified_bridge import forward_unified
            result = forward_unified("POST", path, params, body)
            # A rejected upstream mutation must not look like an acknowledged write.
            if isinstance(result, dict) and result.get("available") is False:
                raise UpstreamError(str(result.get("error") or "unified_tencent_failed"))
            return result
        if path == "/api/harness/settings":
            if app.harness is None:
                raise UpstreamError("harness telemetry module unavailable")
            return app.harness.post(path, body)
        if path == "/api/repos/import":
            return self.post_import(body)
        if path == "/api/repos/remove":
            return self.post_remove(body)
        if path == "/api/repos/reindex":
            return self.post_reindex(body)
        if path == "/api/excluded":
            return self.post_exclude(body)
        if path == "/api/excluded/remove":
            return self.post_unexclude(body)
        raise FileNotFoundError(f"no such endpoint: {path}")

    def read_body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length > 1_000_000:
            raise ValueError("request body too large")
        if not length:
            return {}
        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ValueError("request body must be JSON")
        return payload if isinstance(payload, dict) else {}

    # -- read endpoints ---------------------------------------------------

    def overview(self) -> dict:
        app = self.app
        status = app.rql.status()
        engine = app.rql.engine_status()
        counts = app.rql.knowledge_counts()
        repos = app.repo_rows()
        activity = app.activity()
        failed = app.rql.failed_files(ttl=15.0)
        exclusions = app.exclusions.load()
        cpu_now = app.rql.cpu_now(status.get("host", {}).get("pid"))
        cpu_hist = app.cpu_series("24h")
        return {
            "service": {
                "verdict": status.get("verdict"),
                "ready": status.get("ready"),
                "queryable": status.get("queryable"),
                "phase": status.get("phase"),
                "uptime_seconds": host_uptime_seconds(status),
                "version": (status.get("host") or {}).get("version"),
                "pid": (status.get("host") or {}).get("pid"),
                "started_at": (status.get("host") or {}).get("startedAt"),
                "queued_operations": status.get("queuedOperations"),
                "fidelity": status.get("fidelity"),
                "semantic_percent": status.get("semanticPercent"),
                "account_authenticated": (status.get("account") or {}).get("authenticated"),
                "last_activity": activity.get("last_activity"),
                "current_activity": activity.get("last_line"),
                "current_phase": activity.get("current_phase"),
                "sweep": activity.get("sweep"),
                "last_complete": activity.get("last_complete"),
            },
            "indexing": {
                **engine,
                "failed_rows": len(failed),
                "excluded_rows": len(exclusions),
                "last_complete": activity.get("last_complete"),
                "progress_percent": self.progress_percent(engine),
            },
            "repositories": {
                "total": len(repos["repositories"]),
                "indexed": sum(1 for r in repos["repositories"] if r["status"] == "indexed"),
                "indexing": sum(1 for r in repos["repositories"] if r["status"] == "indexing"),
                "errors": sum(1 for r in repos["repositories"] if r["status"] == "errors"),
                "unavailable": sum(1 for r in repos["repositories"] if r["status"] == "unavailable"),
                "system_mounts": len(repos["system_mounts"]),
            },
            "knowledge": {
                "wisdom": counts.get("wisdom", 0),
                "principle": counts.get("principle", 0),
                "concept": sum(counts.values()),
                "rule": counts.get("rule", 0),
                "shape": counts.get("shape", 0),
                "knowledge": counts.get("knowledge", 0),
                "by_category": counts,
                "links": self.link_total(),
            },
            "performance": {
                "now": cpu_now,
                "avg_24h": cpu_hist["stats"]["avg"],
                "peak_24h": cpu_hist["stats"]["peak"],
                "samples_24h": cpu_hist["stats"]["samples"],
                "gaps_24h": cpu_hist["stats"]["gaps"],
                "last_sample": cpu_hist["stats"]["last_sample"],
                "series": cpu_hist["series"],
                "bucket_seconds": cpu_hist["bucket_seconds"],
            },
            "errors": {
                "indexing_failures": len(failed),
                "parse_warnings": self.parse_error_count(),
                "service_warnings": activity["counts"]["warning"],
                "service_errors": activity["counts"]["error"],
                "recent": activity.get("counts"),
            },
            "generated_at": now_iso(),
        }

    @staticmethod
    def progress_percent(engine: dict) -> float | None:
        total = engine.get("total_files") or 0
        if not total:
            return None
        done = (engine.get("complete") or 0) + (engine.get("failed") or 0) + (engine.get("skipped") or 0)
        return round(min(100.0, done / total * 100.0), 1)

    def link_total(self) -> int:
        """Every stored relationship the Links page exposes, from its cached counts."""
        cached = self.app.rql.cache.get("link_total")
        if cached is not None:
            return cached
        try:
            total = sum(int(value) for value in self.link_collection_counts().values())
        except UpstreamError:
            total = 0
        return self.app.rql.cache.set("link_total", total, 120.0)

    def parse_error_count(self) -> int:
        cached = self.app.rql.cache.get("parse_error_count")
        if cached is not None:
            return cached
        try:
            rows = self.app.rql.query(
                "SELECT count(*) AS n FROM Annotations WHERE kind IN ('parse','swift.parse_error')",
                timeout=60,
            )
            count = int(rows[0]["n"] if rows else 0)
        except UpstreamError:
            count = 0
        return self.app.rql.cache.set("parse_error_count", count, 60.0)

    def status_detail(self) -> dict:
        app = self.app
        status = dict(app.rql.status())
        account = status.pop("account", {}) or {}
        return {
            "status": status,
            "account": {
                "authenticated": account.get("authenticated"),
                "method": account.get("method"),
                "principal_class": account.get("principalClass"),
                "expires_at": account.get("expiresAt"),
                "available": account.get("available"),
            },
            "engine": app.rql.engine_status(),
            "activity": app.activity(),
            "operations": app.rql.operation_log(),
            "log_path": str(app.rql.host_log_path() or ""),
            "dashboard": {"started_at": datetime.fromtimestamp(app.started_at, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")},
        }

    def indexing(self) -> dict:
        app = self.app
        engine = app.rql.engine_status()
        activity = app.activity()
        queue = app.rql.queue()
        failed = app.rql.failed_files(ttl=15.0)
        return {
            "engine": engine,
            "progress_percent": self.progress_percent(engine),
            "activity": activity,
            "operations": app.rql.operation_log(limit=15),
            "queue": queue[:200],
            "queue_counts": self.count_by(queue, "status"),
            "failed": failed[:200],
            "recent_lines": [
                {"ts": r["ts"], "level": r["level"], "msg": r["msg"]}
                for r in app.rql.log_tail()[-40:]
            ],
        }

    @staticmethod
    def count_by(rows: list[dict], key: str) -> dict:
        counts: dict[str, int] = {}
        for row in rows:
            value = row.get(key) or "unknown"
            counts[value] = counts.get(value, 0) + 1
        return counts

    def files(self, params: dict) -> dict:
        app = self.app
        page = parse_page(params)
        page_size = parse_limit(params)
        offset = (page - 1) * page_size
        status = params.get("status") or "indexed"
        query = (params.get("q") or "").strip()
        repo = (params.get("repo") or "").strip()

        if status == "failed":
            rows = app.rql.failed_files(ttl=10.0, limit=5000)
            filtered = [
                {"uri": r["uri"], "error": r["error"], "failures": r["failures"], "stage": r["stage"],
                 "transitioned_at": r["transitioned_at"], "byte_size": r["byte_size"], "status": "failed"}
                for r in rows
                if (not query or query.lower() in r["uri"].lower())
                and (not repo or r["uri"].startswith(repo.rstrip("/") + "/"))
            ]
            return {"page": page, "page_size": page_size, "total": len(filtered), "rows": filtered[offset:offset + page_size], "status": status}

        if status == "excluded":
            records = [r for r in app.exclusions.load() if not repo or r.get("mount_root") == repo]
            filtered = [r for r in records if not query or query.lower() in r.get("uri", "").lower()]
            return {"page": page, "page_size": page_size, "total": len(filtered), "rows": filtered[offset:offset + page_size], "status": status}

        if status in ("pending", "processing", "queue"):
            queue = app.rql.queue()
            wanted = {"pending": {"pending", "queued", "waiting"}, "processing": {"active", "processing", "in_progress"}}.get(status, {"pending", "queued", "waiting", "active", "processing", "in_progress"})
            filtered = [q for q in queue if (q.get("status") or "").lower() in wanted]
            if repo:
                filtered = [q for q in filtered if (q.get("uri") or "").startswith(repo.rstrip("/") + "/")]
            if query:
                filtered = [q for q in filtered if query.lower() in (q.get("uri") or "").lower()]
            rows = [
                {"uri": q.get("uri"), "status": q.get("status"), "queue": q.get("queue"),
                 "enqueued_at": q.get("enqueued_at"), "processing_started_at": q.get("processing_started_at"),
                 "failures": q.get("failures"), "error": q.get("error")}
                for q in filtered
            ]
            return {"page": page, "page_size": page_size, "total": len(rows), "rows": rows[offset:offset + page_size], "status": status}

        clauses = ["1=1"]
        if repo:
            clauses.append("uri LIKE " + sqlstr(repo.rstrip("/") + "/%"))
        if query:
            clauses.append("uri ILIKE " + sqlstr(f"%{query}%"))
        where = " AND ".join(clauses)
        total = int(app.rql.query(f"SELECT count(*) AS n FROM Files WHERE {where}", timeout=120)[0]["n"])
        rows = app.rql.query(
            "SELECT uri, name, extension, byte_size, content_category, mtime, token_count FROM Files "
            f"WHERE {where} ORDER BY uri LIMIT {page_size} OFFSET {offset}",
            timeout=120,
        )
        for row in rows:
            row["status"] = "indexed"
        return {"page": page, "page_size": page_size, "total": total, "rows": rows, "status": status}

    def repo_detail(self, params: dict) -> dict:
        app = self.app
        root = (params.get("root") or "").strip()
        if not root:
            raise ValueError("root is required")
        repos = app.repo_rows()
        row = next((r for r in repos["repositories"] if r["root"] == root), None)
        if row is None:
            row = next((r for r in repos["system_mounts"] if r["root"] == root), None)
        if row is None:
            raise FileNotFoundError(f"unknown repository: {root}")
        prefix = sqlstr(root.rstrip("/") + "/%")
        kinds = app.rql.query(
            f"SELECT coalesce(content_category,'unknown') AS category, count(*) AS n FROM Files WHERE uri LIKE {prefix} GROUP BY 1 ORDER BY n DESC",
            timeout=180,
        )
        sample_files = app.rql.query(
            f"SELECT uri, name, extension, byte_size, content_category, mtime FROM Files WHERE uri LIKE {prefix} ORDER BY uri LIMIT 25",
            timeout=180,
        )
        failed = [f for f in app.rql.failed_files(ttl=10.0) if f["uri"].startswith(root.rstrip("/") + "/")]
        knowledge = app.rql.query(
            "SELECT name, category, canonical_uri, file_uri FROM capsules "
            f"WHERE file_uri LIKE {prefix} OR canonical_uri LIKE {prefix} ORDER BY name LIMIT 50",
            timeout=180,
        )
        exclusions = [r for r in app.exclusions.load() if r.get("mount_root") == root]
        return {
            "repository": row,
            "content_categories": kinds,
            "sample_files": sample_files,
            "failed_files": failed,
            "knowledge": knowledge,
            "exclusions": exclusions,
        }

    def knowledge(self, params: dict) -> dict:
        app = self.app
        category = (params.get("category") or "all").strip()
        query = (params.get("q") or "").strip()
        page = parse_page(params)
        page_size = parse_limit(params)
        offset = (page - 1) * page_size
        clauses = []
        if category and category != "all":
            if category == "uncategorised":
                clauses.append("category IS NULL")
            else:
                clauses.append("category = " + sqlstr(category))
        if query:
            clauses.append(f"(name ILIKE {sqlstr('%' + query + '%')} OR invariant ILIKE {sqlstr('%' + query + '%')})")
        where = " AND ".join(clauses) if clauses else "1=1"
        total = int(app.rql.query(f"SELECT count(*) AS n FROM capsules WHERE {where}", timeout=120)[0]["n"])
        rows = app.rql.query(
            "SELECT name, category, subcategory, invariant, universal, canonical_uri, capsule_uri, file_uri, see_also "
            f"FROM capsules WHERE {where} ORDER BY name LIMIT {page_size} OFFSET {offset}",
            timeout=120,
        )
        for row in rows:
            row["see_also_count"] = len(self.parse_see_also(row.get("see_also")))
        return {"page": page, "page_size": page_size, "total": total, "rows": rows, "category": category,
                "counts": app.rql.knowledge_counts()}

    @staticmethod
    def parse_see_also(value) -> list[str]:
        if not value:
            return []
        try:
            parsed = json.loads(value) if isinstance(value, str) else value
        except json.JSONDecodeError:
            return []
        if not isinstance(parsed, list):
            return []
        return [str(item).strip().strip('"') for item in parsed if str(item).strip()]

    def knowledge_item(self, params: dict) -> dict:
        app = self.app
        identifier = (params.get("uri") or "").strip()
        if not identifier:
            raise ValueError("uri is required")
        rows = app.rql.query(
            "SELECT * FROM capsules WHERE canonical_uri = {v} OR capsule_uri = {v} OR file_uri = {v} OR name = {v} LIMIT 1".format(
                v=sqlstr(identifier)
            ),
            timeout=120,
        )
        if not rows:
            raise FileNotFoundError(f"unknown knowledge record: {identifier}")
        record = rows[0]
        see_also = []
        for name in self.parse_see_also(record.get("see_also")):
            target = app.rql.query(
                f"SELECT name, category, canonical_uri FROM capsules WHERE name = {sqlstr(name)} LIMIT 1", timeout=60
            )
            see_also.append(
                {
                    "name": name,
                    "category": target[0]["category"] if target else None,
                    "uri": target[0]["canonical_uri"] if target else None,
                    "resolved": bool(target),
                }
            )
        related = app.rql.query(
            "SELECT e.type, e.destination_uri FROM edge e JOIN Files f ON f.node_id = e.source_node_id "
            f"WHERE f.uri = {sqlstr(record['file_uri'])} LIMIT 50",
            timeout=120,
        )
        inbound = app.rql.query(
            "SELECT e.type, f.uri AS source_uri FROM edge e JOIN Files f ON f.node_id = e.destination_node_id "
            f"WHERE f.uri = {sqlstr(record['file_uri'])} LIMIT 50",
            timeout=120,
        )
        links = app.rql.query(
            "SELECT destination_uri, status, start_line, link_text, href FROM markdown_links "
            f"WHERE file_uri = {sqlstr(record['file_uri'])} LIMIT 100",
            timeout=120,
        )
        content = self.read_document(record["file_uri"])
        return {
            "record": record,
            "see_also": see_also,
            "related_edges": related,
            "inbound_edges": inbound,
            "markdown_links": links,
            "content": content,
            "category": record.get("category"),
        }

    def read_document(self, uri: str) -> dict:
        proc = self.app.rql.run(["read", uri], timeout=60)
        if proc.returncode != 0:
            return {"available": False, "text": "", "error": (proc.stderr or "").strip()[:400]}
        text = proc.stdout
        # The CLI appends a "[N tok | N ms]" usage footer; it is not document content.
        text = re.sub(r"\n\[\d+ tok \| \d+ ms\]\s*$", "", text)
        return {"available": True, "text": text}

    def links(self, params: dict) -> dict:
        app = self.app
        collection = (params.get("collection") or "see_also").strip()
        if collection not in COLLECTIONS:
            collection = "see_also"
        page = parse_page(params)
        page_size = parse_limit(params)
        offset = (page - 1) * page_size
        query = (params.get("q") or "").strip()
        source_category = (params.get("source_category") or "").strip()
        target_category = (params.get("target_category") or "").strip()
        status = (params.get("status") or "").strip()

        # Graph callers only consume rows. Collection-wide count scans are
        # unnecessary here and can outlive the graph client's 12s timeout.
        include_counts = params.get("counts") != "false"

        if collection == "see_also":
            rows = app.see_also_links()
            filtered = [
                r for r in rows
                if (not query or query.lower() in (r["source_name"] + " " + r["target_name"]).lower())
                and (not source_category or r["source_category"] == source_category)
                and (not target_category or r["target_category"] == target_category)
            ]
            return {"collection": collection, "description": COLLECTIONS[collection], "page": page,
                    "page_size": page_size, "total": len(filtered), "rows": filtered[offset:offset + page_size],
                    "counts": self.link_collection_counts() if include_counts else {}}

        if collection == "markdown":
            clauses = ["1=1"]
            if query:
                clauses.append(f"(destination_uri ILIKE {sqlstr('%' + query + '%')} OR file_uri ILIKE {sqlstr('%' + query + '%')})")
            if status:
                clauses.append("status = " + sqlstr(status))
            if source_category:
                clauses.append("file_uri LIKE " + sqlstr(source_category + "%"))
            where = " AND ".join(clauses)
            if clauses == ["1=1"]:
                # Unfiltered totals are already known from the collection counts (cached);
                # avoid a second full scan of markdown_links just to page it.
                total = int(self.link_collection_counts().get("markdown", 0)) if include_counts else None
            else:
                total = int(app.rql.query(f"SELECT count(*) AS n FROM markdown_links WHERE {where}", timeout=180)[0]["n"])
            rows = app.rql.query(
                "SELECT file_uri, destination_uri, link_text, status, start_line, is_image FROM markdown_links "
                f"WHERE {where} ORDER BY file_uri, start_line LIMIT {page_size} OFFSET {offset}",
                timeout=180,
            )
            for row in rows:
                row["collection"] = "markdown"
                row["type"] = "MARKDOWN_LINK"
                row["source_uri"] = row.pop("file_uri")
                row["source_category"] = uri_category(row["source_uri"])
                row["target_category"] = uri_category(row["destination_uri"])
                row["resolved"] = row["status"] == "resolved"
                row["provenance"] = f"line {row['start_line']}"
            return {"collection": collection, "description": COLLECTIONS[collection], "page": page,
                    "page_size": page_size, "total": total, "rows": rows, "counts": self.link_collection_counts() if include_counts else {}}

        edge_type = "HAS_PART" if collection == "composition" else "REFERS_TO"
        clauses = [f"e.type = '{edge_type}'"]
        if query:
            clauses.append(f"(e.destination_uri ILIKE {sqlstr('%' + query + '%')} OR f.uri ILIKE {sqlstr('%' + query + '%')})")
        where = " AND ".join(clauses)
        if len(clauses) == 1:
            total = int(self.link_collection_counts().get(collection, 0)) if include_counts else None
        else:
            total = int(app.rql.query(
                f"SELECT count(*) AS n FROM edge e JOIN Files f ON f.node_id = e.source_node_id WHERE {where}",
                timeout=240,
            )[0]["n"])
        rows = app.rql.query(
            "SELECT f.uri AS source_uri, e.destination_uri, e.type, e.destination_uri AS target_uri "
            "FROM edge e JOIN Files f ON f.node_id = e.source_node_id "
            f"WHERE {where} LIMIT {page_size} OFFSET {offset}",
            timeout=240,
        )
        if source_category:
            rows = [r for r in rows if uri_category(r["source_uri"]) == source_category]
        for row in rows:
            row["collection"] = collection
            row["source_category"] = uri_category(row["source_uri"])
            row["target_category"] = uri_category(row["destination_uri"] or "")
            row["resolved"] = True
            row["provenance"] = f"edge ({edge_type})"
        return {"collection": collection, "description": COLLECTIONS[collection], "page": page,
                "page_size": page_size, "total": total, "rows": rows, "counts": self.link_collection_counts() if include_counts else {}}

    def hub_doc_rows(self, params: dict) -> dict:
        """The documentation import's own REFERS_TO rows, in one bounded ordered query.

        The wiki syncs every hub document as its sources/<slug> page and the unified graph joins
        the two by that slug. Paging the shared /api/links collection for these rows cost ~19
        requests per graph build and, with no ORDER BY on that route, returned a different subset
        on each run (measured 2026-10-27: node totals differed by 94 between two builds). One
        ordered query replaces that; total shows truncation against the limit.
        """
        app = self.app
        prefix = (params.get("prefix") or "").strip()
        if not prefix or len(prefix) > 200:
            raise UpstreamError("prefix is required and bounded")
        limit = 4000
        where = (f"e.type = 'REFERS_TO' AND (e.destination_uri LIKE {sqlstr(prefix + '%')} "
                 f"OR f.uri LIKE {sqlstr(prefix + '%')})")
        total = int(app.rql.query(
            f"SELECT count(*) AS n FROM edge e JOIN Files f ON f.node_id = e.source_node_id WHERE {where}",
            timeout=240,
        )[0]["n"])
        rows = app.rql.query(
            "SELECT f.uri AS source_uri, e.destination_uri, e.type, e.destination_uri AS target_uri "
            "FROM edge e JOIN Files f ON f.node_id = e.source_node_id "
            f"WHERE {where} ORDER BY f.uri, e.destination_uri, e.type LIMIT {limit}",
            timeout=240,
        )
        for row in rows:
            row["collection"] = "refers_to"
            row["source_category"] = uri_category(row["source_uri"])
            row["target_category"] = uri_category(row["destination_uri"] or "")
            row["resolved"] = True
            row["provenance"] = "edge (REFERS_TO)"
        return {"rows": rows, "total": total, "limit": limit, "prefix": prefix}

    def memory_docs(self, params: dict) -> dict:
        """The memory import's own documents, in one bounded ordered query.

        The Live Memory Graph's Memories option asks for these: the memorycore connector's files
        carry no links, so they are never reachable through the link collections. The prefix must
        name the memorycore import's own namespace (its root or a subpath beneath it), so this
        route can never enumerate other indexed files; % and _ are escaped as literals. One ordered
        query over the Files table replaces any paging; total shows truncation against the limit.
        """
        app = self.app
        prefix = (params.get("prefix") or "").strip()
        if not prefix.startswith(MEMORY_DOCS_ROOT) or len(prefix) > 200:
            raise UpstreamError("prefix must name the memorycore import (memorycore://data/...)")
        escaped = prefix.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        like = f"uri LIKE {sqlstr(escaped)} ESCAPE '\\'"
        limit = 4000
        total = int(app.rql.query(
            f"SELECT count(*) AS n FROM Files WHERE {like}",
            timeout=240,
        )[0]["n"])
        rows = app.rql.query(
            "SELECT uri, name, substr(headline, 1, 160) AS headline, content_category AS category "
            "FROM Files "
            f"WHERE {like} ORDER BY uri LIMIT {limit}",
            timeout=240,
        )
        return {"rows": rows, "total": total, "limit": limit, "prefix": prefix}

    def link_collection_counts(self) -> dict:
        cached = self.app.rql.cache.get("link_collection_counts")
        if cached is not None:
            return cached
        counts = {"see_also": len(self.app.see_also_links())}
        try:
            rows = self.app.rql.query(
                "SELECT type, count(*) AS n FROM edge WHERE type IN ('REFERS_TO','HAS_PART') GROUP BY 1", timeout=240
            )
            for row in rows:
                counts["refers_to" if row["type"] == "REFERS_TO" else "composition"] = int(row["n"])
            md = self.app.rql.query("SELECT status, count(*) AS n FROM markdown_links GROUP BY 1", timeout=180)
            counts["markdown"] = sum(int(row["n"]) for row in md)
        except UpstreamError:
            pass
        return self.app.rql.cache.set("link_collection_counts", counts, 120.0)

    def links_graph(self, params: dict) -> dict:
        """Bounded knowledge graph: stored relationships only, max 120 nodes."""
        app = self.app
        focus = (params.get("focus") or "").strip()
        links = app.see_also_links()
        nodes: dict[str, dict] = {}
        edges: list[dict] = []
        for link in links:
            if not link["resolved"]:
                continue
            if focus and focus not in (link["source_uri"], link["target_uri"]):
                continue
            for uri, name, category in (
                (link["source_uri"], link["source_name"], link["source_category"]),
                (link["target_uri"], link["target_name"], link["target_category"]),
            ):
                nodes.setdefault(uri, {"id": uri, "name": name, "category": category})
            edges.append({"source": link["source_uri"], "target": link["target_uri"], "type": "SEE_ALSO"})
            if len(nodes) >= 120:
                break
        return {"nodes": list(nodes.values())[:120], "edges": edges[:200], "focus": focus or None,
                "truncated": len(nodes) >= 120}

    def errors(self, params: dict) -> dict:
        app = self.app
        kind = (params.get("kind") or "indexing").strip()
        query = (params.get("q") or "").strip()
        page = parse_page(params)
        page_size = parse_limit(params)
        offset = (page - 1) * page_size

        if kind == "service":
            records = [
                r for r in app.rql.log_tail()
                if r["level"] in ("WRN", "WARN", "ERR", "FTL", "CRT")
                and (not query or query.lower() in r["msg"].lower())
            ]
            groups: dict[str, dict] = {}
            for record in records:
                signature = re.sub(r"\d+", "#", record["msg"])[:180]
                entry = groups.setdefault(signature, {
                    "message": record["msg"], "count": 0, "first_ts": record["ts"],
                    "last_ts": record["ts"], "level": record["level"], "component": "repoql-host",
                    "kind": "service", "signature": signature,
                })
                entry["count"] += 1
                entry["first_ts"] = record["ts"]
                entry["last_ts"] = record["ts"]
                entry["level"] = record["level"]
            ordered = sorted(groups.values(), key=lambda item: item["last_ts"], reverse=True)
            return {"kind": kind, "page": page, "page_size": page_size, "total": len(ordered),
                    "rows": ordered[offset:offset + page_size],
                    "summary": {"service": len(ordered), "indexing": len(app.rql.failed_files(ttl=15.0))}}

        if kind == "parse":
            clauses = ["kind IN ('parse','swift.parse_error')"]
            if query:
                clauses.append(f"(message ILIKE {sqlstr('%' + query + '%')} OR document_uri ILIKE {sqlstr('%' + query + '%')})")
            where = " AND ".join(clauses)
            total = int(app.rql.query(f"SELECT count(*) AS n FROM Annotations WHERE {where}", timeout=120)[0]["n"])
            rows = app.rql.query(
                "SELECT kind, severity, message, document_uri, target_uri, created_at FROM Annotations "
                f"WHERE {where} ORDER BY created_at DESC LIMIT {page_size} OFFSET {offset}",
                timeout=120,
            )
            for row in rows:
                row["component"] = "analyzer"
                row["uri"] = row.pop("target_uri") or row.get("document_uri")
            return {"kind": kind, "page": page, "page_size": page_size, "total": total, "rows": rows,
                    "summary": {"parse": total, "indexing": len(app.rql.failed_files(ttl=15.0))}}

        failed = app.rql.failed_files(ttl=10.0)
        queue_errors = [q for q in app.rql.queue() if q.get("error")]
        items = [
            {"kind": "indexing", "component": row.get("stage") or "indexer", "uri": row["uri"],
             "message": row["error"], "count": row.get("failures"), "timestamp": row.get("transitioned_at"),
             "severity": "error", "status": "failed"}
            for row in failed
        ] + [
            {"kind": "indexing", "component": row.get("stage") or "queue", "uri": row.get("uri"),
             "message": row["error"], "count": row.get("failures"), "timestamp": row.get("enqueued_at"),
             "severity": "error", "status": row.get("status")}
            for row in queue_errors
        ]
        if query:
            items = [i for i in items if query.lower() in (i["uri"] or "").lower() or query.lower() in (i["message"] or "").lower()]
        items.sort(key=lambda i: str(i.get("timestamp") or ""), reverse=True)
        return {"kind": kind, "page": page, "page_size": page_size, "total": len(items),
                "rows": items[offset:offset + page_size],
                "summary": {"indexing": len(items), "service": None}}

    def excluded(self) -> dict:
        """Show actual root .repoqlignore rules as well as dashboard write history.

        The historical endpoint returned only exclusions.json. That omitted rules
        written by RepoQL itself or operators and was mistaken for the full list.
        Never follow .repoqlignore symlinks or read outside registered mounts.
        """
        records = self.app.exclusions.load()
        native_rules = []
        unavailable = []
        roots = {}
        repositories = self.app.repo_rows()
        for repo in repositories["repositories"] + repositories["system_mounts"]:
            root, directory = repo.get("root"), repo.get("directory")
            if root and directory:
                roots[root] = Path(directory)
        for root, directory in roots.items():
            ignore = directory / ".repoqlignore"
            try:
                if ignore.is_symlink():
                    unavailable.append({"root": root, "reason": "symlink not followed"})
                    continue
                if not ignore.is_file():
                    continue
                if ignore.stat().st_size > 256 * 1024:
                    unavailable.append({"root": root, "reason": "ignore file exceeds display limit"})
                    continue
                lines = ignore.read_text(encoding="utf-8").splitlines()
            except (OSError, UnicodeError) as exc:
                unavailable.append({"root": root, "reason": type(exc).__name__})
                continue
            for number, line in enumerate(lines, 1):
                pattern = line.strip()
                if pattern and not pattern.startswith("#"):
                    native_rules.append({"mount_root": root, "ignore_file": str(ignore),
                                         "pattern": pattern, "line": number})
        return {"rows": records, "total": len(records),
                "native_rules": native_rules, "native_total": len(native_rules),
                "scanned_mounts": len(roots), "unavailable_mounts": unavailable}

    def activity_feed(self, params: dict) -> dict:
        try:
            limit = max(1, min(int(params.get("limit", 40)), 200))
        except (TypeError, ValueError):
            limit = 40
        records = self.app.rql.log_tail()[-limit:]
        return {
            "rows": [{"ts": r["ts"], "level": r["level"], "msg": r["msg"]} for r in reversed(records)],
            "summary": self.app.activity(),
        }

    # -- mutations --------------------------------------------------------

    def mutation(self, name: str, fn):
        if not self.app.mutation_lock.acquire(blocking=False):
            self.send_json(HTTPStatus.CONFLICT, {"error": "another RepoQL operation is already running from this dashboard"})
            return None
        try:
            return fn()
        finally:
            self.app.mutation_lock.release()

    def post_import(self, body: dict) -> dict:
        def run() -> dict:
            uri = (body.get("uri") or "").strip()
            if not uri:
                raise ValueError("uri is required")
            allowed = ("github://", "git://", "https://", "ssh://", "git@", "s3://", "local://", "sarif://", "coverage://", "/", ".")
            if not uri.startswith(allowed):
                raise ValueError("unsupported repository source; use a git/github URL, an s3:// prefix, a sarif/coverage file or a local path")
            before = {row["root"] for row in self.app.repo_rows()["repositories"]}
            proc = self.app.rql.run(["import", uri], timeout=900)
            output = (proc.stdout or "").strip() or (proc.stderr or "").strip()
            self.app.rql.cache.invalidate()
            after = {row["root"] for row in self.app.repo_rows()["repositories"]}
            added = sorted(after - before)
            return {
                "ok": proc.returncode == 0,
                "exit_code": proc.returncode,
                "message": output[:4000],
                "added": added,
                "repository": added[0] if added else None,
            }

        return self.mutation("import", run)

    def post_remove(self, body: dict) -> dict:
        def run() -> dict:
            root = (body.get("root") or "").strip()
            confirm = (body.get("confirm") or "").strip()
            if not root:
                raise ValueError("root is required")
            if root.startswith(READ_ONLY_SCHEMES) or root == "file:///":
                raise ValueError("system mounts cannot be removed")
            if confirm != root:
                raise ValueError("confirmation does not match the repository being removed")
            known = {row["root"] for row in self.app.repo_rows()["repositories"]}
            if root not in known:
                raise FileNotFoundError(f"unknown repository: {root}")
            proc = self.app.rql.run(["import", "remove", root], timeout=1800)
            output = (proc.stdout or "").strip() or (proc.stderr or "").strip()
            self.app.rql.cache.invalidate()
            remaining = {row["root"] for row in self.app.repo_rows()["repositories"]}
            return {
                "ok": proc.returncode == 0,
                "exit_code": proc.returncode,
                "message": output[:4000],
                "removed": root not in remaining,
            }

        return self.mutation("remove", run)

    def post_reindex(self, body: dict) -> dict:
        def run() -> dict:
            root = (body.get("root") or "").strip()
            force = bool(body.get("force"))
            if not root:
                raise ValueError("root is required")
            status = self.app.rql.status()
            if not force and (status.get("pendingFiles") or 0) > 0:
                self.send_json(HTTPStatus.CONFLICT, {
                    "error": "RepoQL already has pending work; wait for the current sweep or confirm a forced reindex",
                    "pending": status.get("pendingFiles"),
                    "phase": status.get("phase"),
                })
                return None
            glob = root.rstrip("/") + "/**"
            proc = self.app.rql.run(["host", "reindex", glob], timeout=300)
            output = (proc.stdout or "").strip() or (proc.stderr or "").strip()
            self.app.rql.cache.invalidate()
            return {"ok": proc.returncode == 0, "exit_code": proc.returncode, "message": output[:2000], "glob": glob}

        return self.mutation("reindex", run)

    def resolve_mount(self, uri: str) -> dict:
        filesystems = self.app.rql.filesystems()
        best = None
        for fs in filesystems:
            root = fs.get("source_uri") or ""
            local = fs.get("local_path")
            if not root or not local:
                continue
            if uri == root or uri.startswith(root.rstrip("/") + "/"):
                if best is None or len(root) > len(best.get("source_uri", "")):
                    best = fs
        if best is None:
            raise FileNotFoundError(f"no mounted source matches {uri}")
        return best

    def relative_path(self, uri: str, mount: dict) -> str:
        root = mount["source_uri"]
        local = mount["local_path"].rstrip("/")
        if uri.startswith("local://"):
            absolute = uri[len("local://") :]
            if not absolute.startswith(local + "/"):
                raise ValueError("file is outside its mount")
            return absolute[len(local) + 1 :]
        if not uri.startswith(root.rstrip("/") + "/"):
            raise ValueError("file is outside its mount")
        return uri[len(root.rstrip("/")) + 1 :]

    def post_exclude(self, body: dict) -> dict:
        def run() -> dict:
            uri = (body.get("uri") or "").strip()
            reason = (body.get("reason") or "").strip()[:400]
            original_error = (body.get("error") or "").strip()[:800]
            if not uri:
                raise ValueError("uri is required")
            if uri.startswith(READ_ONLY_SCHEMES):
                raise ValueError("concept, help and vocabulary records cannot be excluded")
            mount = self.resolve_mount(uri)
            local = mount.get("local_path")
            if not local:
                raise ValueError("this mount has no local directory to hold an ignore rule")
            relative = self.relative_path(uri, mount)
            ignore_path = Path(local) / ".repoqlignore"
            record_id = secrets.token_hex(6)
            block = "\n".join([
                ExclusionStore.BLOCK_START.format(id=record_id) + f" — added {now_iso()}",
                relative,
                ExclusionStore.BLOCK_END.format(id=record_id),
            ])
            existing = ignore_path.read_text(encoding="utf-8") if ignore_path.exists() else ""
            backup = None
            if not (Path(str(ignore_path) + ".bak-repoql-dashboard")).exists():
                backup = str(ignore_path) + ".bak-repoql-dashboard"
                if ignore_path.exists():
                    shutil.copy2(ignore_path, backup)
            separator = "" if existing.endswith("\n") or not existing else "\n"
            # Crash-safe and concurrency-aware: a temp file plus os.replace, and a
            # refusal if another writer changed the rules since we read them.
            try:
                atomic_write_text(ignore_path, existing + separator + block + "\n", expected_current=existing,
                                  lock_dir=self.app.config.state_dir / "locks")
            except IgnoreFileConflict as exc:
                raise ValueError(f"{exc}; re-run the exclusion") from exc
            record = {
                "id": record_id,
                "uri": uri,
                "mount_root": mount["source_uri"],
                "mount_path": local,
                "ignore_file": str(ignore_path),
                "pattern": relative,
                "reason": reason,
                "original_error": original_error,
                "excluded_at": now_iso(),
                "backup": backup,
                "verified": False,
                "state": "pending-reconcile",
            }
            self.app.exclusions.add(record)
            self.app.rql.cache.invalidate()
            # Verify against the live graph, then record what actually happened. A rule that
            # has not taken effect yet stays visibly pending instead of reading as done.
            dropped = self.poll_file_absent(uri, timeout=20)
            if not dropped:
                self.reindex_parent(mount, relative)
                dropped = self.poll_file_absent(uri, timeout=30)
            record = self.app.exclusions.update(
                record_id,
                verified=dropped,
                state="excluded" if dropped else "pending-reconcile",
                verified_at=now_iso() if dropped else None,
            ) or record
            return {"ok": True, "exclusion": record,
                    "note": "Rule written to the mount .repoqlignore and verified against the graph." if dropped
                    else "Rule written to the mount .repoqlignore; RepoQL has not dropped the row yet."}

        return self.mutation("exclude", run)

    def poll_file_absent(self, uri: str, timeout: float) -> bool:
        deadline = time.time() + timeout
        while time.time() < deadline:
            rows = self.app.rql.query(f"SELECT 1 AS present FROM Files WHERE uri = {sqlstr(uri)} LIMIT 1", timeout=60)
            if not rows:
                return True
            time.sleep(2)
        return False

    def poll_file_present(self, uri: str, timeout: float) -> bool:
        deadline = time.time() + timeout
        while time.time() < deadline:
            rows = self.app.rql.query(f"SELECT 1 AS present FROM Files WHERE uri = {sqlstr(uri)} LIMIT 1", timeout=60)
            if rows:
                return True
            time.sleep(2)
        return False

    def reindex_parent(self, mount: dict, relative: str) -> None:
        directory = relative.rsplit("/", 1)[0] if "/" in relative else ""
        glob = mount["source_uri"].rstrip("/") + "/" + (directory + "/" if directory else "") + "**"
        self.app.rql.run(["host", "reindex", glob], timeout=180)
        self.app.rql.cache.invalidate()

    def post_unexclude(self, body: dict) -> dict:
        def run() -> dict:
            record_id = (body.get("id") or "").strip()
            uri = (body.get("uri") or "").strip()
            records = self.app.exclusions.load()
            record = next((r for r in records if r["id"] == record_id or (uri and r["uri"] == uri)), None)
            if record is None:
                raise FileNotFoundError("no such exclusion")
            ignore_path = Path(record["ignore_file"])
            if ignore_path.exists():
                text = ignore_path.read_text(encoding="utf-8")
                blocks = dict(ignore_blocks(text))
                block = blocks.get(record["id"])
                if block:
                    updated = text.replace(block + "\n", "").replace(block, "")
                    try:
                        atomic_write_text(ignore_path, updated, expected_current=text,
                                          lock_dir=self.app.config.state_dir / "locks")
                    except IgnoreFileConflict as exc:
                        raise ValueError(f"{exc}; re-run the removal") from exc
            self.app.exclusions.remove(record["id"])
            self.app.rql.cache.invalidate()
            mount = self.resolve_mount(record["uri"])
            present = self.poll_file_present(record["uri"], timeout=8)
            if not present:
                self.reindex_parent(mount, record["pattern"])
                present = self.poll_file_present(record["uri"], timeout=30)
            return {"ok": True, "removed": record, "reindexed": present,
                    "note": "Rule removed from the mount .repoqlignore and the parent directory re-enumerated; "
                            + ("the file is indexed again." if present else "the file is eligible for indexing again.")}

        return self.mutation("unexclude", run)


def build_server(config: Config) -> ThreadingHTTPServer:
    app = App(config)
    handler = type("BoundHandler", (Handler,), {"app": app})
    ThreadingHTTPServer.request_queue_size = 32
    if app.local_account is not None:
        if config.bind != '127.0.0.1' or config.public_url or config.access_team_domain or config.access_aud:
            raise ValueError('LOCAL_ACCOUNT_REQUIRES_PRIVATE_LOOPBACK')
    server = ThreadingHTTPServer((config.bind, config.port), handler)
    server.daemon_threads = True
    return server


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="RepoQL management dashboard")
    parser.add_argument("--config", default=str(SERVICE_DIR / "config.json"))
    parser.add_argument("command", nargs="?", choices=["link", "check", "serve", "harness"],
                        help="link = print the capability link, check = one bridge probe, harness = telemetry health, serve = start")
    parser.add_argument("--print-link", action="store_true", help="print the capability link and exit")
    parser.add_argument("--rotate", action="store_true", help="rotate the capability secret before printing")
    parser.add_argument("--check", action="store_true", help="verify the RepoQL bridge once and exit")
    args = parser.parse_args(argv)
    if args.command == "link":
        args.print_link = True
    if args.command == "check":
        args.check = True

    config = Config.load(Path(args.config))
    # No native dashboard, connector install or secret issuance with the wrong
    # RepoQL binary. This check must run before App or the HTTP listener exists.
    if os.environ.get("SINGULARITY_WINDOWS_NATIVE") == "1":
        from native_repoql_gate import check_native_repoql
        verdict = check_native_repoql(config)
        if not verdict["ok"]:
            print(json.dumps({"release_blocked": "repoql_incompatible", **verdict}), file=sys.stderr)
            return 2
    if args.command == "harness":
        if Harness is None:
            print(json.dumps({"ok": False, "error": "harness telemetry module unavailable"}))
            return 1
        h = Harness(config.state_dir)
        try:
            print(json.dumps(h.health(), indent=2, default=str))
        finally:
            h.close()
        return 0
    if args.check:
        app = App(config)
        status = app.rql.status()
        print(json.dumps({"verdict": status.get("verdict"), "phase": status.get("phase"),
                          "pid": (status.get("host") or {}).get("pid")}, indent=2))
        return 0
    if args.print_link or args.rotate:
        app = App(config)
        if args.rotate:
            app.token_path.unlink(missing_ok=True)
            app.token = app._load_token()
        print(app.dashboard_url())
        return 0

    server = build_server(config)
    print(f"repoql-dashboard listening on http://{config.bind}:{config.port} (workspace {config.workspace})", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
