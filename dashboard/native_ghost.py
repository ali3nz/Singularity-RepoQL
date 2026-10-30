"""Windows-only Ghost control via Rust and a private loopback service.

The legacy Linux Unix socket remains unchanged. This adapter never assumes a
Windows Ghost daemon is installed, never executes a shell, and never returns
success unless the native Rust client received an acknowledged response.
"""
from __future__ import annotations
import json
import os
from pathlib import Path
import subprocess

ALLOWED_ACTIONS = frozenset({'stop', 'set-model', 'continue', 'remove-queued', 'hold', 'release',
                             'pause-task', 'resume-task', 'set-prompt', 'revert-prompt',
                             'register-schedule', 'update-schedule', 'cancel-schedule'})
MAX_ACTION_BYTES = 131072


def unavailable():
    return 503, {'ok': False, 'state': 'unknown', 'error': 'Native Ghost service unavailable; no action confirmed.'}


def control_request(method, body=None, *, executable=None, runner=subprocess.run):
    if method not in ('GET', 'POST'):
        return 405, {'ok': False, 'error': 'method_not_allowed'}
    if method == 'POST':
        if not isinstance(body, dict) or body.get('confirm') is not True:
            return 400, {'ok': False, 'error': 'confirmation_required'}
        if body.get('action') not in ALLOWED_ACTIONS:
            return 400, {'ok': False, 'error': 'unknown_action'}
        ident = body.get('requestId')
        if (not isinstance(ident, str) or not 1 <= len(ident) <= 128 or
                not all(c.isascii() and (c.isalnum() or c in '_-') for c in ident)):
            return 400, {'ok': False, 'error': 'invalid_request_id'}
    payload = json.dumps(body, separators=(',', ':'), ensure_ascii=False).encode() if method == 'POST' else b''
    if len(payload) > MAX_ACTION_BYTES:
        return 413, {'ok': False, 'error': 'request_too_large'}
    name = executable or os.environ.get('SINGULARITY_NATIVE_BRIDGE_EXE', '')
    if not name:
        return unavailable()
    exe = Path(name)
    if (not exe.is_absolute() or exe.name.lower() != 'singularity-desktop-bridge.exe'
            or str(exe).startswith('\\\\') or not exe.is_file() or exe.is_symlink()):
        return unavailable()
    if not os.environ.get('SINGULARITY_GHOST_CONTROL_CONFIG'):
        return unavailable()
    try:
        result = runner([str(exe), 'ghost-control', method], input=payload,
                        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=False,
                        shell=False, timeout=180)
        if len(result.stdout) > 1024 * 1024:
            return unavailable()
        decoded = json.loads(result.stdout)
        status = decoded.get('status')
        response = decoded.get('body')
        if (type(status) is not int or not 200 <= status <= 599 or
                not isinstance(response, dict)):
            return unavailable()
        if result.returncode != 0 or status >= 500:
            return unavailable()
        # Never present a mutation as committed if the upstream explicitly said no.
        if method == 'POST' and response.get('ok') is not True:
            return status if status >= 400 else 502, response
        return status, response
    except (OSError, ValueError, TypeError, subprocess.TimeoutExpired):
        return unavailable()
