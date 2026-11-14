"""Optional Rust event state aggregation for the authenticated live agent view.

Rust receives numeric agent IDs and event-field presence flags only. Python owns
SQLite, source attribution, agent/model names, timestamps and visible output.
"""
from __future__ import annotations
import json
import os
from pathlib import Path
import subprocess

SCHEMA = 'singularity-harness-agent-seats/v1'
KINDS = {'agent_assigned':1, 'agent_started':2, 'agent_waiting':3, 'agent_error':4}
MAX_EVENTS = 200
MAX_AGENTS = 200
MAX_BYTES = 32 * 1024


def _reference(safe):
    seats = {}
    for index, row in enumerate(safe):
        if row['kind'] == 0:
            continue
        agent = row['agent']
        if agent not in seats:
            seats[agent] = {'agent_index': agent, 'model_pos': None,
                            'provider_pos': None, 'stage_pos': None,
                            'status_pos': None, 'status_error': False,
                            'started_pos': None, 'last_pos': None,
                            '_model_frozen': False, '_provider_frozen': False,
                            '_started_frozen': False}
        seat = seats[agent]
        if not seat['_model_frozen']:
            seat['model_pos'] = index
            seat['_model_frozen'] = row['model']
        if not seat['_provider_frozen']:
            seat['provider_pos'] = index
            seat['_provider_frozen'] = row['provider']
        if row['stage']:
            seat['stage_pos'] = index
        if row['kind'] == 4:
            seat['status_error'] = True
            seat['status_pos'] = None
        elif row['status']:
            seat['status_error'] = False
            seat['status_pos'] = index
        if not seat['_started_frozen']:
            seat['started_pos'] = index
            seat['_started_frozen'] = row['ts']
        seat['last_pos'] = index
    return [{k: v for k, v in seat.items() if not k.startswith('_')}
            for seat in seats.values()]


def _safe_events(events):
    ordered = list(reversed(events))
    names = []
    by_name = {}
    safe = []
    for ev in ordered:
        agent = ev['agent'] or 'coordinator'
        if agent not in by_name:
            by_name[agent] = len(names)
            names.append(agent)
        safe.append({'agent':by_name[agent], 'kind':KINDS.get(ev['kind'], 0),
                     'model':bool(ev['model']), 'provider':bool(ev['provider']),
                     'stage':bool(ev['stage']), 'status':bool(ev['status']),
                     'ts':bool(ev['ts'])})
    return ordered, names, safe


def project_agent_seats(events, *, rust_bin=None, runner=subprocess.run):
    ordered, names, safe = _safe_events(events)
    expected = _reference(safe)
    binary = (os.environ.get('SINGULARITY_HARNESS_AGENT_SEATS_RUST_BINARY', '')
              if rust_bin is None else rust_bin)
    if binary:
        if len(events) > MAX_EVENTS or len(names) > MAX_AGENTS:
            raise RuntimeError('agent_seats_native_input_too_large')
        path = Path(binary)
        if not path.is_absolute() or path.is_symlink() or not path.is_file():
            raise RuntimeError('agent_seats_native_binary_invalid')
        parent = path.parent
        while parent != parent.parent:
            if parent.is_symlink():
                raise RuntimeError('agent_seats_native_binary_invalid')
            parent = parent.parent
        request = json.dumps({'schema':SCHEMA,'agent_count':len(names),
                              'events':safe}, separators=(',', ':'))
        if len(request.encode('utf-8')) > MAX_BYTES:
            raise RuntimeError('agent_seats_native_input_too_large')
        env = {k:v for k,v in os.environ.items()
               if k.upper() in {'PATH','SYSTEMROOT','WINDIR','TEMP','TMP','HOME'}}
        try:
            result = runner([str(path)], input=request,text=True,capture_output=True,
                            timeout=8,check=False,shell=False,env=env)
            if result.returncode or len(result.stdout.encode('utf-8')) > 64 * 1024:
                raise RuntimeError('agent_seats_native_execution_failed')
            actual = json.loads(result.stdout)
        except (OSError, ValueError, subprocess.SubprocessError) as exc:
            raise RuntimeError('agent_seats_native_execution_failed') from exc
        if actual != expected:
            raise RuntimeError('agent_seats_native_parity_mismatch')
    seats = {}
    for row in expected:
        def get(pos, field):
            return ordered[pos][field] if pos is not None else None
        agent = names[row['agent_index']]
        seats[agent] = {'agent':agent,
                        'model':get(row['model_pos'],'model'),
                        'provider':get(row['provider_pos'],'provider'),
                        'stage':get(row['stage_pos'],'stage'),
                        'status':('error' if row['status_error'] else
                                  get(row['status_pos'],'status') or 'assigned'),
                        'started_at':get(row['started_pos'],'ts'),
                        'last_event':get(row['last_pos'],'ts'),
                        'duration_ms':None}
    return seats
