"""Windows-local OpenMausBot inventory, only through the authenticated dashboard.

This adapter is observational. Bot creation, Pi registration, Tencent and Kanzo
claims remain governed by their real service contracts and cannot be inferred
from a row in the inventory. Never requests a model or another computer.
"""
from __future__ import annotations
import datetime as dt

import http.client
import json
import os
from pathlib import Path
import re
import time
import uuid

_ID = re.compile(r'[A-Za-z0-9_-]{1,128}\Z')


def _reader(state_dir: Path):
    """Create the bounded local reader shared by inventory and operations."""
    if os.environ.get('SINGULARITY_WINDOWS_NATIVE') != '1':
        raise RuntimeError('windows_native_only')
    try:
        port = int(os.environ.get('SINGULARITY_WINDOWS_OMB_PORT', '8799'))
    except ValueError:
        port = 0
    if not 1024 <= port <= 65535:
        raise RuntimeError('invalid_local_port')
    token_path = state_dir / 'omb-session.token'
    token = None
    if token_path.is_symlink():
        raise RuntimeError('credential_path_refused')
    if token_path.exists():
        try:
            if token_path.stat().st_size > 4096:
                raise ValueError('oversized')
            token = token_path.read_text(encoding='utf8').strip()
            if not re.fullmatch(r'[A-Za-z0-9_\-]{12,2048}', token):
                raise ValueError('invalid')
        except (ValueError, OSError):
            raise RuntimeError('credential_invalid')

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
    return get


def overview(state_dir: Path) -> dict:
    """At most two bounded loopback GETs, no retries, no paths from clients."""
    try:
        get = _reader(state_dir)
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
            'service_unavailable', 'service_not_authorised', 'response_too_large', 'inventory_invalid',
            'windows_native_only', 'invalid_local_port', 'credential_path_refused', 'credential_invalid') else 'unavailable'
        return {'available': False, 'reason': reason, 'bots': []}


def role_names(state_dir: Path) -> dict[str, str]:
    """Map local bot UUID identities to their current display names."""
    inventory = overview(state_dir)
    names = {}
    for bot in inventory['bots']:
        try:
            role = 'omb-' + uuid.UUID(bot['id']).hex
        except (KeyError, ValueError, TypeError, AttributeError):
            continue
        name = bot.get('name')
        if isinstance(name, str) and name.strip():
            names[role] = name.strip()[:60]
    return names


def _timestamp(value):
    """Accept epoch milliseconds or ISO timestamps with an explicit UTC offset."""
    if value is None:
        return None
    if isinstance(value, str):
        stamp = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
        if stamp.tzinfo is None or stamp.utcoffset() is None:
            raise ValueError('timestamp_timezone_missing')
        value = int(stamp.timestamp() * 1000)
    if type(value) is not int or not 0 <= value <= 253_402_300_799_999:
        raise ValueError('timestamp_invalid')
    return value


def _normalise_routines(document: dict) -> dict:
    """Keep native scheduling restrictions visible when expansion is unsupported."""
    routines = []
    for routine in document['routines']:
        if not isinstance(routine, dict):
            continue
        routine = dict(routine)
        for key in ('createdAt', 'nextRunAt'):
            if key in routine:
                routine[key] = _timestamp(routine[key])
        schedule = routine.get('schedule')
        schedule = dict(schedule) if isinstance(schedule, dict) else {}
        for key in ('anchorAt', 'at', 'endsAt'):
            if key in schedule:
                schedule[key] = _timestamp(schedule[key])
        kind = schedule.get('type')
        if kind == 'daily':
            zone = schedule.get('timeZone') or routine.get('timeZone')
            clock = schedule.get('time')
            days = schedule.get('weekdays')
            if (isinstance(zone, str) and zone and isinstance(clock, str)
                    and re.fullmatch(r'(?:[01]\d|2[0-3]):[0-5]\d', clock)
                    and isinstance(days, list) and days
                    and all(type(day) is int and 0 <= day <= 6 for day in days)):
                hour, minute = clock.split(':')
                schedule = {'type': 'cron', 'expression': '%d %d * * %s' % (
                    int(minute), int(hour), ','.join(str(day) for day in days)), 'timeZone': zone}
        elif kind == 'interval' and any(schedule.get(key) is not None for key in ('weekdays', 'window', 'endsAt')):
            schedule['type'] = 'unsupported_restricted_interval'
        elif kind == 'cron' and not schedule.get('timeZone'):
            schedule['type'] = 'unsupported_missing_timezone'
        routine['schedule'] = schedule
        routines.append(routine)
    runs = []
    for run in document['runs']:
        if not isinstance(run, dict):
            continue
        run = dict(run)
        for key in ('createdAt', 'scheduledFor', 'startedAt', 'finishedAt'):
            if key in run:
                run[key] = _timestamp(run[key])
        runs.append(run)
    return {'routines': routines, 'runs': runs}


def operations(state_dir: Path, start_ms: int, end_ms: int, *, now_ms: int | None = None) -> dict:
    """Read native routines through three bounded GETs and return safe projections."""
    from openmausbot_ops import MAX_WINDOW_DAYS, build
    if end_ms <= start_ms or end_ms - start_ms > MAX_WINDOW_DAYS * 86_400_000:
        raise ValueError('invalid operations window')
    now_ms = int(time.time() * 1000) if now_ms is None else now_ms
    documents = {'routines': None, 'bots': None}
    states = {name: {'state': 'unavailable', 'label': 'OpenMausBot %s API' % name}
              for name in documents}
    try:
        get = _reader(state_dir)
        health = get('/api/health')
        if not isinstance(health, dict) or health.get('app') != 'openmausbot':
            raise RuntimeError('unexpected_local_service')
    except (OSError, ValueError, RuntimeError, http.client.HTTPException):
        get = None
    if get is not None:
        for name, path in (('routines', '/api/routines'), ('bots', '/api/bots?messages=0')):
            try:
                document = get(path)
                if not isinstance(document, dict) or not isinstance(document.get(name), list):
                    raise ValueError('source_invalid')
                if name == 'routines':
                    if not isinstance(document.get('runs'), list):
                        raise ValueError('runs_invalid')
                    document = _normalise_routines(document)
                documents[name] = document
                states[name]['state'] = 'ok'
            except (OSError, ValueError, RuntimeError, http.client.HTTPException):
                pass
    result = build(start_ms, end_ms, now_ms=now_ms, source_documents=documents,
                   source_states=states)
    # Native OMB also keeps queued, waiting, cancelled and missed records.
    # Only a running record verifies that a turn is currently running.
    if result['now']:
        result['now']['running'] = [run for run in result['runs'] if run['status'] == 'running']
    run_states = {run['id']: run['status'] for run in result['runs']}
    for occurrence in result['occurrences']:
        if occurrence['state'] == 'running':
            status = run_states.get(occurrence['run_id'])
            occurrence['state'] = status if status in ('running', 'queued', 'waiting', 'cancelled', 'missed') else 'unknown_status'
    for run in result['runs']:
        if run['status'] == 'missed':
            result['attention'].append({'kind': 'missed_run', 'bot_id': run['bot_id'],
                'routine_id': run['routine_id'], 'run_id': run['id'],
                'at': run['finished_at'] or run['scheduled_for'] or run['created_at'],
                'text': 'Run missed: %s' % (run['routine_name'] or 'routine'), 'source': run['source']})
    result['attention'].sort(key=lambda item: item['at'] or 0, reverse=True)
    return result
