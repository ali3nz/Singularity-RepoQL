"""Windows-local OpenMausBot inventory, only through the authenticated dashboard.

This adapter is observational. Bot creation, Pi registration, Tencent and Kanzo
claims remain governed by their real service contracts and cannot be inferred
from a row in the inventory. Never requests a model or another computer.
"""
from __future__ import annotations

import http.client
import json
import os
from pathlib import Path
import re

_ID = re.compile(r'[A-Za-z0-9_-]{1,128}\Z')


def overview(state_dir: Path) -> dict:
    """At most two bounded loopback GETs, no retries, no paths from clients."""
    if os.environ.get('SINGULARITY_WINDOWS_NATIVE') != '1':
        return {'available': False, 'reason': 'windows_native_only', 'bots': []}
    try:
        port = int(os.environ.get('SINGULARITY_WINDOWS_OMB_PORT', '8799'))
    except ValueError:
        port = 0
    if not 1024 <= port <= 65535:
        return {'available': False, 'reason': 'invalid_local_port', 'bots': []}
    token_path = state_dir / 'omb-session.token'
    token = None
    if token_path.is_symlink():
        return {'available': False, 'reason': 'credential_path_refused', 'bots': []}
    if token_path.exists():
        try:
            if token_path.stat().st_size > 4096:
                raise ValueError('oversized')
            token = token_path.read_text(encoding='utf8').strip()
            if not re.fullmatch(r'[A-Za-z0-9_\-]{12,2048}', token):
                raise ValueError('invalid')
        except (ValueError, OSError):
            return {'available': False, 'reason': 'credential_invalid', 'bots': []}

    def get(path: str):
        connection = http.client.HTTPConnection('127.0.0.1', port, timeout=2)
        try:
            headers = {'Accept': 'application/json', 'Host': f'127.0.0.1:{port}'}
            if token:
                headers['Authorization'] = 'Bearer ' + token
            connection.request('GET', path, headers=headers)
            reply = connection.getresponse()
            if reply.status != 200:
                raise RuntimeError('service_not_authorised' if reply.status in (401, 403) else 'service_unavailable')
            if reply.getheader('Content-Length') and int(reply.getheader('Content-Length')) > 262144:
                raise RuntimeError('response_too_large')
            body = reply.read(262145)
            if len(body) > 262144:
                raise RuntimeError('response_too_large')
            return json.loads(body)
        finally:
            connection.close()

    try:
        health = get('/api/health')
        if type(health) is not dict or health.get('app') != 'openmausbot':
            return {'available': False, 'reason': 'unexpected_local_service', 'bots': []}
        fleet = get('/api/bots?messages=0')
        if type(fleet) is not dict or type(fleet.get('bots')) is not list:
            raise RuntimeError('inventory_invalid')
        bots = []
        for bot in fleet['bots'][:100]:
            if type(bot) is not dict or not isinstance(bot.get('id'), str) or not _ID.fullmatch(bot['id']):
                continue
            bots.append({'id': bot['id'], 'name': str(bot.get('name') or 'Unnamed bot')[:120],
                         'working': bool(bot.get('busy')), 'thread_id': str(bot.get('threadId') or '')[:128],
                         'registration': 'not_verified', 'duo': 'not_verified',
                         'kanzo': 'not_verified', 'memory': 'not_verified'})
        return {'available': True, 'bots': bots, 'total': len(fleet['bots']),
                'truncated': len(fleet['bots']) > 100,
                'source': 'windows_loopback_openmausbot',
                'note': 'Bot presence is not native provisioning, Kanzo, Duo or Tencent verification.'}
    except (OSError, ValueError, RuntimeError, json.JSONDecodeError) as exc:
        reason = str(exc) if isinstance(exc, RuntimeError) and str(exc) in (
            'service_unavailable', 'service_not_authorised', 'response_too_large', 'inventory_invalid') else 'unavailable'
        return {'available': False, 'reason': reason, 'bots': []}
