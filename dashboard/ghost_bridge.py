"""Expose the existing Ghost operator snapshot and private hub in RepoQL.

Ghost remains the authoritative agent and collector. This is only an HTTP adapter;
no Ghost task, collector, memory, or control state is duplicated here.
"""
from __future__ import annotations

import http.client
import json
import os
from pathlib import Path
import socket
import time

SNAPSHOT_PATH = os.environ.get('SINGULARITY_GHOST_SNAPSHOT', '')
CONTROL_SOCKET = os.environ.get('SINGULARITY_GHOST_CONTROL_SOCKET', '')
MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024
MAX_CONTROL_BYTES = 1024 * 1024
MAX_ACTION_BYTES = 131072
ACTIONS = frozenset({'stop', 'set-model', 'continue', 'remove-queued', 'hold', 'release',
                     'pause-task', 'resume-task', 'set-prompt', 'revert-prompt'})


def read_status(*, path: str | None = None, now_ms: int | None = None) -> tuple[int, dict]:
    """Match Ghost's original unknown/stale contract exactly."""
    configured = path or os.environ.get('RQDASH_GHOST_SNAPSHOT', SNAPSHOT_PATH)
    if not configured:
        return 503, {'state': 'unknown', 'collector': 'unconfigured',
                     'error': 'Ghost collector is not configured.'}
    filename = Path(configured)
    try:
        if filename.stat().st_size > MAX_SNAPSHOT_BYTES:
            raise ValueError('oversized')
        data = json.loads(filename.read_text(encoding='utf-8'))
        if not isinstance(data, dict):
            raise ValueError('invalid snapshot')
    except (OSError, ValueError, json.JSONDecodeError):
        return 503, {'state': 'unknown', 'collector': 'unavailable',
                     'error': 'Waiting for collector data.'}
    now = now_ms if now_ms is not None else int(time.time() * 1000)
    generated = data.get('generatedAt')
    try:
        age = now - float(generated)
        fresh = float('-inf') < age <= 45000 and age >= -5000
    except (ValueError, TypeError):
        fresh = False
    if not fresh or data.get('collector') != 'ok':
        data = {**data, 'state': 'unknown', 'stale': True}
    return 200, data


class UnixHTTPConnection(http.client.HTTPConnection):
    def __init__(self, path: str, timeout: float):
        super().__init__('localhost', timeout=timeout)
        self.socket_path = path

    def connect(self):
        conn = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        conn.settimeout(self.timeout)
        try:
            conn.connect(self.socket_path)
        except OSError:
            conn.close()
            raise
        self.sock = conn


def control_request(method: str, body: dict | None = None,
                    *, socket_path: str | None = None) -> tuple[int, dict]:
    """Preserve the existing private hub status/error response semantics."""
    if method not in ('GET', 'POST'):
        return 405, {'ok': False, 'error': 'method_not_allowed'}
    if method == 'POST':
        if not isinstance(body, dict) or body.get('confirm') is not True:
            return 400, {'ok': False, 'error': 'confirmation_required'}
        if body.get('action') not in ACTIONS:
            return 400, {'ok': False, 'error': 'unknown_action'}
        request_id = body.get('requestId')
        if not isinstance(request_id, str) or not request_id or len(request_id) > 128:
            return 400, {'ok': False, 'error': 'invalid_request_id'}
    raw = json.dumps(body, separators=(',', ':')).encode() if method == 'POST' else b''
    if len(raw) > MAX_ACTION_BYTES:
        return 413, {'ok': False, 'error': 'request_too_large'}
    path = socket_path or os.environ.get('RQDASH_GHOST_CONTROL_SOCKET', CONTROL_SOCKET)
    if not path:
        return 503, {'ok': False, 'state': 'unknown', 'error': 'Ghost control is not configured.'}
    client = UnixHTTPConnection(path, 62.0)
    try:
        client.request(method, '/action' if method == 'POST' else '/state', body=raw if method == 'POST' else None,
                       headers={'Content-Type': 'application/json'})
        response = client.getresponse()
        data = response.read(MAX_CONTROL_BYTES + 1)
        if len(data) > MAX_CONTROL_BYTES:
            raise ValueError('oversized hub response')
        payload = json.loads(data)
        if not isinstance(payload, dict):
            raise ValueError('invalid hub response')
        return response.status, payload
    except (OSError, TimeoutError, ValueError, http.client.HTTPException):
        return 503, {'ok': False, 'state': 'unknown',
                     'error': 'Control service unavailable. No action is confirmed; refresh before retrying.'}
    finally:
        client.close()


def control_headers_valid(headers, host: str) -> bool:
    """Only same-origin, explicitly confirmed browser requests may mutate Ghost."""
    origin = headers.get('Origin', '')
    if not isinstance(origin, str) or not origin:
        return False
    from urllib.parse import urlparse
    parsed = urlparse(origin)
    return (parsed.scheme in ('http', 'https') and parsed.netloc == host
            and headers.get('X-Ghost-Control') == '1'
            and headers.get('X-Requested-With') == 'repoql-dashboard'
            and headers.get('Content-Type', '').split(';')[0].strip() == 'application/json'
            and headers.get('Sec-Fetch-Site', '') != 'cross-site')
