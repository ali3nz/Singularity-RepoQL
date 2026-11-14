#!/usr/bin/env python3
"""Synthetic task recovery contract checks, with optional real Rust differential.

No source DB, Kanzo task, registered identity, or MemoryCore service is read.
Authorization is synthetic; this only checks pure post-authorization formatting.
"""
import argparse
import json
import subprocess
from pathlib import Path

TASK = 'task-abcdef1234'
AGENT = 'agent-alpha'
IDENTITY = {'team_id': 't1', 'user_id': 'u1', 'agent_id': 'a1'}


def fixtures():
    for i in range(64):
        valid_task = TASK if i % 13 else 'task-noevidence1'
        captured = f'2026-11-12T{(i % 20):02d}:00:00Z'
        unit = {'task_id': TASK, 'task_id_source': 'binding', 'agent': AGENT,
                'session_id': 's1', 'first_seq': 1, 'last_seq': 10,
                'status': 'reconciled', 'at': captured}
        ledger = {'units': {'oc:s1:1-10': unit,
            'oc:other:1-4': {**unit, 'task_id': 'task-other123', 'session_id': 'other'}}}
        atom = {'id': f'l1-{i}', 'task_id': valid_task, 'session_id': 's1',
                'content': f'Atom {i}', 'timestamp': '2026-11-12T11:00:00Z'}
        message = {'id': f'l0-{i}', 'task_id': valid_task, 'session_id': 's1',
                   'content': f'Chat {i}', 'timestamp': '2026-11-12T09:00:00Z'}
        l1rows = [atom]
        if i % 4 == 0: l1rows.append({**atom, 'id': 'leak', 'task_id': 'task-other123'})
        if i % 5 == 0: l1rows.append({**atom, 'id': 'alien', 'agent_id': 'wrong'})
        if i % 7 == 0: l1rows.append(atom)
        l0rows = [message]
        if i % 6 == 0: l0rows.append({**message, 'id': 'foreign', 'session_id': 'other'})
        l1 = {'code': 0, 'data': {'atoms': l1rows}}
        l0 = {'code': 0 if i % 17 else 1, 'data': {'messages': l0rows}}
        yield {
            'ledger': ledger, 'taskId': valid_task, 'agent': AGENT, 'identity': IDENTITY,
            'query': 'incident', 'authorizationVerified': i % 19 != 0,
            'l1Response': l1, 'l0Response': l0,
            'maxUnits': 30, 'l1Limit': 5 if i % 3 else 1,
            'l0Limit': 3 if i % 2 else 2,
        }


def invoke(args, payload):
    proc = subprocess.run(args, input=json.dumps(payload), text=True,
                          capture_output=True, timeout=6, check=False)
    if proc.returncode != 0:
        raise AssertionError(f'{args[0]} exited {proc.returncode}: {proc.stderr[:300]}')
    return json.loads(proc.stdout)


def main():
    cli = argparse.ArgumentParser()
    cli.add_argument('--repo', type=Path, required=True)
    cli.add_argument('--rust-cli', type=Path)
    opts = cli.parse_args()
    oracle = opts.repo / 'memory/portable/task-recovery-oracle.mjs'
    if not oracle.is_file():
        raise SystemExit(f'missing oracle: {oracle}')
    count = 0
    for payload in fixtures():
        expected = invoke(['node', str(oracle)], payload)
        if payload['authorizationVerified'] is False:
            assert expected['code'] == 'KANZO_AUTHORIZATION_NOT_VERIFIED', expected
            assert expected['refs'] == [], expected
        if opts.rust_cli:
            native = invoke([str(opts.rust_cli), 'task-recovery-snapshot'], payload)
            assert native.get('ok') is True and native.get('value') == expected, (
                count, expected, native)
        count += 1
    print(json.dumps({'suite': 'task-recovery-postauth', 'reference': count,
                      'rustDifferential': count if opts.rust_cli else 'NOT_RUN'}))

if __name__ == '__main__':
    main()
