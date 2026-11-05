"""RepoQL-owned login bootstrap for the embedded official dashboard.

The installed `rql dashboard` command is the only issuer of the login URL.
The server refreshes it automatically; no operator copy/paste and no generated
fake tokens. Never include the issued URL in logs, JSON config or Drive bundles.
"""
from __future__ import annotations

import hashlib
import hmac
import os
import re
import secrets
import stat
import subprocess
import tempfile
import threading
import time
from http.cookies import SimpleCookie
from pathlib import Path
from urllib.parse import parse_qs, quote, urlsplit

DEFAULT_LOGIN_FILE = os.environ.get("SINGULARITY_REPOQL_LOGIN_FILE") or str(
    Path.home() / ".local" / "state" / "singularity-dashboard" / "native_repoql_login.url")
DEFAULT_RQL = os.environ.get("SINGULARITY_RQL_BIN", "rql")
DEFAULT_WORKSPACE = os.environ.get("SINGULARITY_WORKSPACE", str(Path.home()))
TOKEN_PATTERN = re.compile(r"^[A-Za-z0-9._~+=/-]{12,2048}$")
# The official CLI prints a localhost URL. Do not trust arbitrary domains or
# additional query parameters even if something appears in command output.
LOGIN_URL_PATTERN = re.compile(
    r"https?://(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?/"
    r"(?:login\?t=[^\s\"'<>]+|#[^\s\"'<>]*?k=[^\s\"'<>]+)"
)
_REFRESH_LOCK = threading.Lock()
# Windows has no meaningful POSIX 0600 mode: keep short-lived issuer output only
# in this dashboard process, never in a weakly protected cache file.
_WINDOWS_LOGIN_CACHE: dict[str, tuple[float, str]] = {}

def _is_windows() -> bool:
    return os.name == "nt"


def parse_native_login(raw: str) -> str | None:
    """Convert only a RepoQL-shaped localhost login to the same-origin route.

    The installed RepoQL 1.7.x CLI prints a capability link of the form
    http://127.0.0.1:<port>/#k=<capability>; older builds print
    /login?t=<token>. Both are official issuer output; anything else is
    rejected rather than guessed.
    """
    try:
        url = urlsplit(raw.strip())
        if url.scheme not in ("http", "https") or url.hostname not in ("localhost", "127.0.0.1", "::1"):
            return None
        if url.username or url.password:
            return None
        if url.port is not None and url.port <= 0:
            return None
        if url.fragment:
            if url.query or url.path.rstrip("/") not in ("", "/login"):
                return None
            fragment = parse_qs(url.fragment, strict_parsing=True)
            if set(fragment) != {"k"} or len(fragment["k"]) != 1 or not TOKEN_PATTERN.fullmatch(fragment["k"][0]):
                return None
            # The capability stays in the URL fragment: it is never sent to the
            # proxy or written to an access log by the browser.
            return "/embed/repoql/#k=" + quote(fragment["k"][0], safe="")
        if url.path.rstrip("/") != "/login":
            return None
        query = parse_qs(url.query, strict_parsing=True)
        if set(query) != {"t"} or len(query["t"]) != 1 or not TOKEN_PATTERN.fullmatch(query["t"][0]):
            return None
        return "/embed/repoql/login?t=" + quote(query["t"][0], safe="")
    except (ValueError, TypeError):
        return None

def _login_file(login_file: str | None = None) -> Path | None:
    name = login_file or os.environ.get("REPOQL_NATIVE_LOGIN_URL_FILE", DEFAULT_LOGIN_FILE)
    path = Path(name)
    return path if path.is_absolute() else None


def native_login_path(login_file: str | None = None) -> str | None:
    """Read an already-issued URL from a strictly private regular file."""
    path = _login_file(login_file)
    if path is None:
        return None
    if _is_windows():
        cached = _WINDOWS_LOGIN_CACHE.get(str(path))
        if cached and time.monotonic() - cached[0] < 30:
            return parse_native_login(cached[1])
        return None
    try:
        metadata = path.lstat()
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_mode & 0o077 or metadata.st_size > 4096:
            return None
        return parse_native_login(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError):
        return None


def refresh_native_login_path(*, force: bool = False, login_file: str | None = None,
                              rql_binary: str | None = None, workspace: str | None = None) -> str | None:
    """Issue/refresh an official login URL, with no prompts and no shell.

    Called when an authenticated browser enters RepoQL Control Panel. The
    handshake forces renewal so host restarts do not leave a stale login.
    Launch reuses that just-issued credential within 30 seconds, or obtains a
    fresh one itself if the handshake was bypassed. On issuance failure we fail
    closed instead of redirecting using an expired or fabricated credential.
    """
    path = _login_file(login_file)
    if path is None:
        return None
    with _REFRESH_LOCK:
        if not force:
            if _is_windows():
                cached = _WINDOWS_LOGIN_CACHE.get(str(path))
                if cached and time.monotonic() - cached[0] < 30:
                    return parse_native_login(cached[1])
            try:
                if not _is_windows() and time.time() - path.stat().st_mtime < 30:
                    existing = native_login_path(str(path))
                    if existing is not None:
                        return existing
            except OSError:
                pass
        binary = Path(rql_binary or os.environ.get("SINGULARITY_RQL_BIN")
                     or os.environ.get("REPOQL_NATIVE_RQL_BINARY", DEFAULT_RQL))
        cwd = Path(workspace or os.environ.get("SINGULARITY_WORKSPACE")
                   or os.environ.get("REPOQL_NATIVE_WORKSPACE", DEFAULT_WORKSPACE))
        if not binary.is_absolute() or not cwd.is_absolute() or not cwd.is_dir():
            return None
        try:
            proc = subprocess.run(
                [str(binary), "dashboard", "--url"], cwd=str(cwd), stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                timeout=15, check=False,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                env={**os.environ, "BROWSER": "echo", "CI": "1"},
            )
        except (OSError, subprocess.TimeoutExpired, UnicodeError):
            return None
        if proc.returncode != 0:
            return None
        issued = None
        for candidate in LOGIN_URL_PATTERN.findall((proc.stdout or "") + "\n" + (proc.stderr or "")):
            if parse_native_login(candidate):
                issued = candidate
                break
        if issued is None:
            return None
        if _is_windows():
            # No file on Windows: the endpoint and dashboard run in one process.
            # A process restart deliberately invalidates all pending launches.
            _WINDOWS_LOGIN_CACHE[str(path)] = (time.monotonic(), issued)
            return parse_native_login(issued)
        try:
            # Existing state directory is managed by the dashboard service;
            # no new directory hierarchy or permission changes needed.
            path.parent.mkdir(parents=True, exist_ok=True)
            fd, temp_path = tempfile.mkstemp(prefix=".repoql-native-", dir=str(path.parent))
            try:
                os.fchmod(fd, 0o600)
                with os.fdopen(fd, "w", encoding="utf-8") as out:
                    out.write(issued + "\n")
                    out.flush()
                    os.fsync(out.fileno())
                os.replace(temp_path, path)
            finally:
                if os.path.exists(temp_path):
                    os.unlink(temp_path)
        except OSError:
            # Do not redirect using a token we cannot retain for the following
            # launch request; never disclose the token in an exception string.
            return None
        return parse_native_login(issued)


def native_repoql_config(embed_url: str | None) -> dict:
    same_origin = embed_url is not None and embed_url.rstrip("/") == "/embed/repoql"
    # No key is minted by this read-only config endpoint. An authenticated
    # handshake obtains it on demand; this flag describes capability only.
    return {"configured": bool(same_origin),
            "url": "/api/embed/repoql/launch" if same_origin else None,
            "login_ready": bool(same_origin), "automatic_login": bool(same_origin)}


# A short-lived dashboard-only cookie lets the iframe navigate after a bearer
# token authenticated the handshake. It is NOT a RepoQL login credential.
COOKIE_NAME = "repoql_native_launch"


def create_launch_cookie(dashboard_secret: str, now: int | None = None, *, audience: str = "repoql") -> str:
    timestamp = int(time.time() if now is None else now)
    nonce = secrets.token_hex(12)
    data = f"{timestamp}.{nonce}"
    if audience not in ("repoql", "tencent", "office", "kanzo"):
        raise ValueError("unsupported dashboard cookie audience")
    digest = hmac.new(dashboard_secret.encode(), (audience + ":" + data).encode(), hashlib.sha256).hexdigest()
    return data + "." + digest


def valid_launch_cookie(cookie_header: str, dashboard_secret: str, now: int | None = None,
                        max_age: int = 60, *, audience: str = "repoql") -> bool:
    try:
        cookies = SimpleCookie()
        cookies.load(cookie_header)
        value = cookies[COOKIE_NAME].value
        ts, nonce, signature = value.split(".")
        timestamp = int(ts)
        current = int(time.time() if now is None else now)
        if not 0 <= current - timestamp <= max(1, int(max_age)) or not re.fullmatch(r"[a-f0-9]{24}", nonce):
            return False
        if audience not in ("repoql", "tencent", "office", "kanzo"):
            return False
        data = f"{timestamp}.{nonce}"
        expected = hmac.new(dashboard_secret.encode(), (audience + ":" + data).encode(), hashlib.sha256).hexdigest()
        return hmac.compare_digest(expected, signature)
    except (KeyError, ValueError, AttributeError):
        return False
