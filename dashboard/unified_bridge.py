"""Authenticated Python-dashboard to Rust-loopback bridge.

Existing Cloudflare JWT/capability and same-origin validation execute in server.py
before this module. Rust independently requires a gateway secret and binds loopback.
"""
from __future__ import annotations
import json
import http.client
import os
import socket
import sys
import subprocess
import threading
import time
from pathlib import Path
from urllib.parse import urlencode, urlsplit

BASE = os.environ.get('UNIFIED_SERVICE_BASE', 'http://127.0.0.1:18101').rstrip('/')
SECRET_FILE = Path(os.environ.get('UNIFIED_GATEWAY_TOKEN_FILE')
                   or Path(os.environ.get('SINGULARITY_STATE_DIR')
                           or Path.home() / '.local' / 'state' / 'singularity-dashboard') / 'unified-gateway.token')
ROUTES = {
    ('GET', '/api/unified/health'): '/v1/health',
    ('GET', '/api/unified/graph'): '/v1/graph',
    ('GET', '/api/unified/usage'): '/v1/usage',
    ('GET', '/api/unified/openrouter'): '/v1/openrouter',
    ('GET', '/api/unified/tencent/catalog'): '/v1/tencent/catalog',
    ('POST', '/api/unified/tencent/invoke'): '/v1/tencent/invoke',
}

# Stale-while-revalidate cache for the slow (~10 s, ~0.6 MB) graph route only.
GRAPH_FRESH_S = 60
GRAPH_STALE_S = 900
GRAPH_PARTIAL_S = 5
GRAPH_CACHE_MAX = 8
_now = time.monotonic
_graph_cache = {}          # key -> (stored_at, payload)
_graph_lock = threading.Lock()
_graph_key_locks = {}
_graph_refreshing = set()
# A localhost port can be rebound to a new source between requests. Even when
# the binary path is unchanged, the owning PID change invalidates cached graph
# provenance. In particular, never carry old tunneled graph results across a
# native Windows gateway cutover.
_gateway_identity = None
_graph_epoch = 0
_gateway_identity_lock = threading.Lock()


def _graph_cache_clear():
    global _graph_epoch
    with _graph_lock:
        _graph_epoch += 1
        _graph_cache.clear(); _graph_key_locks.clear(); _graph_refreshing.clear()


def _cacheable(payload):
    return isinstance(payload, dict) and payload.get('available') is not False


def _partial(payload):
    return any(s.get('available') is False for s in payload.get('sources', [])
               if isinstance(s, dict))


def _store(key, payload, epoch=None):
    with _graph_lock:
        # An in-flight read from a previous process/source must never refill
        # the cache after the native gateway identity changes.
        if epoch is not None and epoch != _graph_epoch:
            return False
        _graph_cache[key] = (_now(), payload)
        while len(_graph_cache) > GRAPH_CACHE_MAX:
            old = min(_graph_cache, key=lambda k: _graph_cache[k][0])
            _graph_cache.pop(old)
            if old not in _graph_refreshing:
                _graph_key_locks.pop(old, None)
        return True


def _tagged(payload, state, age):
    if not isinstance(payload, dict):
        return payload
    out = dict(payload)
    out['_cache'] = {'state': state, 'age_s': int(age)}
    return out


def _refresh(key, method, path, params, body, epoch):
    try:
        payload = _fetch_upstream(method, path, params, body)
        if _cacheable(payload):
            _store(key, payload, epoch)
    except Exception as exc:  # keep the previous good entry; never kill the server
        print(f'unified graph background refresh failed: {type(exc).__name__}', flush=True)
    finally:
        with _graph_lock:
            if epoch == _graph_epoch:
                _graph_refreshing.discard(key)


def _cached_graph(method, path, params, body):
    key = tuple(sorted((params or {}).items()))
    with _graph_lock:
        hit = _graph_cache.get(key)
        epoch = _graph_epoch
        key_lock = _graph_key_locks.setdefault(key, threading.Lock())
    if hit:
        age = _now() - hit[0]
        partial = _partial(hit[1])
        if age < (GRAPH_PARTIAL_S if partial else GRAPH_FRESH_S):
            return _tagged(hit[1], 'fresh', age)
        # A partial source failure must not be served stale for 15 minutes.
        # After the short burst-coalescing TTL, synchronously retry the source.
        # Windows native graphs must fail closed after their fresh TTL rather
        # than displaying a prior result while an upstream refresh is failing.
        if not partial and age < GRAPH_STALE_S and os.environ.get('SINGULARITY_WINDOWS_NATIVE') != '1':
            with _graph_lock:
                start = key not in _graph_refreshing
                if start:
                    _graph_refreshing.add(key)
            if start:
                threading.Thread(target=_refresh, args=(key, method, path, params, body, epoch), daemon=True).start()
            return _tagged(hit[1], 'stale', age)
    with key_lock:  # identical concurrent misses share one upstream call
        with _graph_lock:
            hit = _graph_cache.get(key)
        ttl = GRAPH_PARTIAL_S if hit and _partial(hit[1]) else GRAPH_FRESH_S
        if hit and _now() - hit[0] < ttl:
            return _tagged(hit[1], 'fresh', _now() - hit[0])
        payload = _fetch_upstream(method, path, params, body)
        with _graph_lock:
            same_source = epoch == _graph_epoch
        if not same_source:
            return {'available': False, 'error': 'unified_gateway_changed_during_graph_read'}
        if _cacheable(payload):
            _store(key, payload, epoch)
        return _tagged(payload, 'miss', 0)


def _native_gateway_owner():
    """Require the native Windows listener to be the actual local gateway.

    Loopback-only connection security is not source locality: ssh.exe -L
    produces a loopback listener backed by dockerhost. In native Windows mode
    validate the owning executable before reading/sending the bearer token.
    No negative result may be cached as successful, and no remote fallback exists.
    """
    if os.environ.get('SINGULARITY_WINDOWS_NATIVE') != '1' or sys.platform != 'win32':
        return True
    try:
        host, port = _fixed_loopback_base()
    except (ValueError, PermissionError):
        return False
    # Windows gateway contract binds a direct IPv4 loopback listener, not a
    # shim on a different port which could itself forward to another host.
    if host != '127.0.0.1':
        return False
    expected = os.environ.get('SINGULARITY_WINDOWS_GATEWAY_EXE', 'unified-repoql-control.exe').strip()
    if not expected or '\r' in expected or '\n' in expected:
        return False
    # A path, when configured, pins the exact executable as well as the name.
    name = Path(expected).name.casefold()
    if name not in ('unified-repoql-control.exe',):
        return False
    try:
        # Some Windows builds expose listening sockets with state Unknown.
        # Hold a real connection and verify its server-side owner instead.
        with socket.create_connection((host, port), timeout=2) as connection:
            client_port = connection.getsockname()[1]
            command = (
                '$ErrorActionPreference = "Stop"; '
                f'$connections = @(Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort {port} '
                f'-RemoteAddress 127.0.0.1 -RemotePort {client_port} -State Established -ErrorAction Stop); '
                'if ($connections.Count -ne 1) { exit 2 }; '
                '$p = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $connections[0].OwningProcess); '
                'if ($null -eq $p) { exit 3 }; '
                '[Console]::Out.WriteLine($p.ProcessId); '
                '[Console]::Out.WriteLine($p.Name); '
                '[Console]::Out.WriteLine($p.ExecutablePath)'
            )
            result = subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive',
                                     '-Command', command], capture_output=True,
                                    text=True, timeout=9, check=False,
                                    creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    except (OSError, subprocess.TimeoutExpired):
        return False
    if result.returncode != 0:
        return False
    lines=result.stdout.splitlines()
    if len(lines) < 3:
        return False
    try:
        pid = int(lines[0].strip())
    except ValueError:
        return False
    if pid <= 0 or lines[1].strip().casefold() != name:
        return False
    actual = lines[2].strip()
    if not actual:
        return False
    actual_norm = os.path.normcase(os.path.abspath(actual))
    if os.path.isabs(expected) and actual_norm != os.path.normcase(os.path.abspath(expected)):
        return False
    identity = (port, pid, actual_norm)
    global _gateway_identity
    with _gateway_identity_lock:
        if identity != _gateway_identity:
            _graph_cache_clear()
            _gateway_identity = identity
    return True


def _native_origin_failure():
    if _native_gateway_owner():
        return None
    _graph_cache_clear()
    return {'available': False, 'error': 'windows_local_unified_gateway_unverified'}


def forward_unified(method, path, params=None, body=None):
    if (method, path) not in ROUTES:
        raise FileNotFoundError('unknown unified route')
    local_error = _native_origin_failure()
    if local_error is not None:
        return local_error
    if (method, path) == ('GET', '/api/unified/graph'):
        return _cached_graph(method, path, params, body)
    payload = _fetch_upstream(method, path, params, body)
    if (method, path) == ('GET', '/api/unified/usage') and os.environ.get('SINGULARITY_WINDOWS_NATIVE') == '1':
        from native_gui_usage import project
        from variant_features import features
        return project(payload, profile=features())
    return payload


def _fixed_loopback_base():
    """Pin the actual connection to an IP literal, never DNS or redirects.

    The dashboard is a credentialed proxy. Calling urlopen() here would allow
    an upstream 30x to influence its destination; origin aliases and URL user
    information must not be accepted as security boundaries.
    """
    parts = urlsplit(BASE)
    if (parts.scheme != 'http' or parts.hostname not in ('127.0.0.1', '::1')
            or parts.username is not None or parts.password is not None
            or parts.path not in ('', '/') or parts.query or parts.fragment):
        raise PermissionError('unified bridge requires a fixed loopback IP origin')
    try:
        port = parts.port
    except ValueError as exc:
        raise PermissionError('unified bridge port invalid') from exc
    if port is None or not 1 <= port <= 65535:
        raise PermissionError('unified bridge requires an explicit port')
    return parts.hostname, port


def _fetch_upstream(method, path, params=None, body=None):
    # Reject invalid origins before opening any connection or reading a key.
    host, port = _fixed_loopback_base()
    local_error = _native_origin_failure()
    if local_error is not None:
        return local_error
    try:
        secret = SECRET_FILE.read_text(encoding='utf-8').strip()
    except OSError:
        return {'available': False, 'error': 'unified_gateway_not_configured'}
    if not secret or '\r' in secret or '\n' in secret:
        return {'available': False, 'error': 'unified_gateway_not_configured'}
    route = ROUTES.get((method, path))
    if route is None:
        raise FileNotFoundError('unknown unified route')
    qs = urlencode(params or {}) if method == 'GET' else ''
    target = route + ('?' + qs if qs else '')
    headers = {
        'Authorization': 'Bearer ' + secret,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
    }
    encoded = json.dumps(body or {}).encode('utf-8') if method == 'POST' else None
    conn = http.client.HTTPConnection(host, port, timeout=75 if path == '/api/unified/graph' else 18)
    try:
        conn.request(method, target, body=encoded, headers=headers)
        response = conn.getresponse()
        # HTTPConnection does not follow redirects. Never send the gateway key
        # to an upstream-specified Location; even a relative redirect is a
        # configuration mismatch for this fixed protocol.
        if response.status in (301, 302, 303, 307, 308):
            return {'available': False, 'error': 'unified_upstream_redirect_refused'}
        if response.status < 200 or response.status >= 300:
            return {'available': False, 'error': f'unified_http_{response.status}'}
        raw = response.read(8 * 1024 * 1024 + 1)
        if len(raw) > 8 * 1024 * 1024:
            return {'available': False, 'error': 'unified_response_too_large'}
    except (OSError, TimeoutError, http.client.HTTPException):
        return {'available': False, 'error': 'unified_service_unavailable'}
    finally:
        conn.close()
    try:
        return json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        return {'available': False, 'error': 'unified_invalid_response'}
