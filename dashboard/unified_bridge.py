"""Authenticated Python-dashboard to Rust-loopback bridge.

Existing Cloudflare JWT/capability and same-origin validation execute in server.py
before this module. Rust independently requires a gateway secret and binds loopback.
"""
from __future__ import annotations
import json
import os
import threading
import time
from pathlib import Path
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

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


def _graph_cache_clear():
    with _graph_lock:
        _graph_cache.clear(); _graph_key_locks.clear(); _graph_refreshing.clear()


def _cacheable(payload):
    return isinstance(payload, dict) and payload.get('available') is not False


def _partial(payload):
    return any(s.get('available') is False for s in payload.get('sources', [])
               if isinstance(s, dict))


def _store(key, payload):
    with _graph_lock:
        _graph_cache[key] = (_now(), payload)
        while len(_graph_cache) > GRAPH_CACHE_MAX:
            old = min(_graph_cache, key=lambda k: _graph_cache[k][0])
            _graph_cache.pop(old)
            if old not in _graph_refreshing:
                _graph_key_locks.pop(old, None)


def _tagged(payload, state, age):
    if not isinstance(payload, dict):
        return payload
    out = dict(payload)
    out['_cache'] = {'state': state, 'age_s': int(age)}
    return out


def _refresh(key, method, path, params, body):
    try:
        payload = _fetch_upstream(method, path, params, body)
        if _cacheable(payload):
            _store(key, payload)
    except Exception as exc:  # keep the previous good entry; never kill the server
        print(f'unified graph background refresh failed: {type(exc).__name__}', flush=True)
    finally:
        with _graph_lock:
            _graph_refreshing.discard(key)


def _cached_graph(method, path, params, body):
    key = tuple(sorted((params or {}).items()))
    with _graph_lock:
        hit = _graph_cache.get(key)
        key_lock = _graph_key_locks.setdefault(key, threading.Lock())
    if hit:
        age = _now() - hit[0]
        partial = _partial(hit[1])
        if age < (GRAPH_PARTIAL_S if partial else GRAPH_FRESH_S):
            return _tagged(hit[1], 'fresh', age)
        # A partial source failure must not be served stale for 15 minutes.
        # After the short burst-coalescing TTL, synchronously retry the source.
        if not partial and age < GRAPH_STALE_S:
            with _graph_lock:
                start = key not in _graph_refreshing
                if start:
                    _graph_refreshing.add(key)
            if start:
                threading.Thread(target=_refresh, args=(key, method, path, params, body), daemon=True).start()
            return _tagged(hit[1], 'stale', age)
    with key_lock:  # identical concurrent misses share one upstream call
        with _graph_lock:
            hit = _graph_cache.get(key)
        ttl = GRAPH_PARTIAL_S if hit and _partial(hit[1]) else GRAPH_FRESH_S
        if hit and _now() - hit[0] < ttl:
            return _tagged(hit[1], 'fresh', _now() - hit[0])
        payload = _fetch_upstream(method, path, params, body)
        if _cacheable(payload):
            _store(key, payload)
        return _tagged(payload, 'miss', 0)


def forward_unified(method, path, params=None, body=None):
    if (method, path) not in ROUTES:
        raise FileNotFoundError('unknown unified route')
    if (method, path) == ('GET', '/api/unified/graph'):
        return _cached_graph(method, path, params, body)
    return _fetch_upstream(method, path, params, body)


def _fetch_upstream(method, path, params=None, body=None):
    parts = urlsplit(BASE)
    if parts.scheme != 'http' or parts.hostname not in ('127.0.0.1','localhost','::1'):
        raise PermissionError('unified bridge refuses non-loopback upstream')
    try:
        secret = SECRET_FILE.read_text(encoding='utf-8').strip()
    except OSError:
        return {'available': False, 'error': 'unified_gateway_not_configured'}
    if not secret:
        return {'available': False, 'error': 'unified_gateway_not_configured'}
    qs = urlencode(params or {}) if method == 'GET' else ''
    url = BASE + ROUTES[(method,path)] + ('?' + qs if qs else '')
    request = Request(url, method=method, headers={
        'Authorization': 'Bearer ' + secret,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
    }, data=json.dumps(body or {}).encode('utf-8') if method == 'POST' else None)
    try:
        with urlopen(request, timeout=75 if path == '/api/unified/graph' else 18) as response:
            raw = response.read(8 * 1024 * 1024 + 1)
    except HTTPError as exc:
        detail = ''
        try:
            payload = json.loads(exc.read(2048).decode('utf-8'))
            if isinstance(payload, dict) and isinstance(payload.get('error'), str):
                detail = payload['error'][:160]
        except (ValueError, UnicodeDecodeError, OSError):
            detail = ''
        return {'available': False, 'error': f'unified_http_{exc.code}' + (':' + detail if detail else '')}
    except (URLError, TimeoutError, OSError):
        return {'available': False, 'error': 'unified_service_unavailable'}
    if len(raw) > 8 * 1024 * 1024:
        return {'available': False, 'error': 'unified_response_too_large'}
    try:
        return json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        return {'available': False, 'error': 'unified_invalid_response'}
