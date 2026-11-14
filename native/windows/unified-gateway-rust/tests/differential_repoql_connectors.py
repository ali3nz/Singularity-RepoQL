#!/usr/bin/env python3
"""Compiled Windows Rust connector inventory parity versus Python reference.

Without --rust-cli, only validates the Python reference fixture generator. A
passed reference-only run does not claim the Rust source compiles or matches.
"""
import argparse
from datetime import datetime, timedelta, timezone
import json
import random
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / 'dashboard'))
from repoql_connectors import _inventory_from_payload, _native_public_payload

NOW = datetime(2026, 11, 12, 12, 0, tzinfo=timezone.utc)


def fixtures():
    rng = random.Random(27351)
    stamps = [NOW, NOW - timedelta(minutes=4), NOW - timedelta(days=3),
              NOW + timedelta(seconds=60), NOW + timedelta(hours=2)]
    base = [
        [], {}, None, False, 42,
        {'schema': 'repoql.imports.status/v1', 'connectors': []},
        {'schema': 'unsupported/v1', 'connectors': []},
        {'installed': [{'name': 'Legacy RepoQL Connector', 'id': 'legacy'}]},
        {'connectors': [{'scheme': 'kanzo', 'state': 'installed'}],
         'imports': [{'kind': 'connector', 'scheme': 'kanzo', 'root': 'kanzo://',
                      'state': 'current', 'freshAsOf': NOW.isoformat(),
                      'sweepIntervalSeconds': 60, 'files': 4, 'bytes': 150}]},
        {'connectors': [{'scheme': 'kanzo', 'state': 'installed'}],
         'imports': [{'kind': 'connector', 'scheme': 'kanzo', 'root': 'another://',
                      'state': 'current', 'freshAsOf': NOW.isoformat()}]},
        {'connectors': [False, None, {}, 23]},
        {'connectors': [{'scheme': f'connector{i}', 'state': 'installed'} for i in range(203)]},
        {'connectors': [{'scheme': 'x', 'state': 'installed', 'secret': 'DO_NOT_RENDER'}],
         'imports': [{'kind': 'connector', 'scheme': 'x', 'root': 'x://', 'state': 'current',
                      'freshAsOf': NOW.isoformat(), 'secret': 'DO_NOT_RENDER'}]},
    ]
    for item in base:
        yield item
    states = ['installed', 'missing', 'failed', 'queued', 'active', '', None, True, 'INSTALL!ED']
    import_states = ['current', 'failed', 'error', 'queued', 'pending', 'stalled', 'unknown', '', None]
    schemes = ['memorycore', 'kanzo', 'custom+one', 'invalid/scheme', '', 'MYSCHEME', 'x' * 67]
    roots = ['memorycore://folder', 'kanzo://', 'custom+one://foo', '', 'other://folder', 'garbage', 'kanzo://contains space']
    for _ in range(400):
        registry = []
        imports = []
        for _ in range(rng.randrange(1, 8)):
            scheme = rng.choice(schemes)
            registry.append({'scheme': scheme, 'state': rng.choice(states),
                             'title': rng.choice(['Title', '', 'A' * 160, 'éclair 🧠', None]),
                             'version': '1.7.18', 'apiKey': 'DO_NOT_RENDER'})
        for _ in range(rng.randrange(0, 10)):
            scheme = rng.choice(schemes)
            imports.append({'kind': rng.choice(['connector', 'other', None]),
                            'scheme': scheme,
                            'root': rng.choice(roots + [scheme + '://']),
                            'state': rng.choice(import_states),
                            'freshAsOf': rng.choice([stamp.isoformat() for stamp in stamps] + [
                                'invalid', None, NOW.isoformat().replace('+00:00', 'Z')]),
                            'sweepIntervalSeconds': rng.choice([None, -5, 0, 10, 60, 300, 900, True, 2.5]),
                            'files': rng.choice([None, 0, 3, -1, True, 12.5]),
                            'bytes': rng.choice([None, 1024, -3, False, 3.4]),
                            'secret': 'DO_NOT_RENDER'})
        yield {'schema': rng.choice(['repoql.imports.status/v1', '', 'different']),
               'connectors': registry, 'imports': imports,
               'credential': 'DO_NOT_RENDER'}


def check(binary, payload, expected):
    proc = subprocess.run([str(binary)], input=json.dumps({'payload': _native_public_payload(payload), 'now': NOW.isoformat()}, ensure_ascii=False),
                          text=True, encoding='utf-8', capture_output=True, timeout=10, shell=False)
    if proc.returncode != 0:
        raise AssertionError(f'compiled Rust connector projection exited {proc.returncode}')
    actual = json.loads(proc.stdout)
    if actual != expected:
        raise AssertionError('compiled Rust connector projection differs from Python: '
                             + repr((actual, expected))[:700])
    if 'DO_NOT_RENDER' in proc.stdout:
        raise AssertionError('Rust leaked private registry or import content')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--rust-cli', type=Path)
    args = parser.parse_args()
    binary = args.rust_cli.resolve() if args.rust_cli else None
    if binary and not binary.is_file():
        parser.error('compiled Rust connector binary not present')
    count = 0
    for payload in fixtures():
        expected = _inventory_from_payload(payload, NOW)
        if _inventory_from_payload(_native_public_payload(payload), NOW) != expected:
            raise AssertionError('public native request changed Python connector reference')
        if expected is not None and not isinstance(expected.get('connectors'), list):
            raise AssertionError('Python reference produced invalid connector schema')
        if binary:
            check(binary, payload, expected)
        count += 1
    if binary:
        proc = subprocess.run([str(binary)], input=json.dumps({'now': NOW.isoformat(), 'payload': {},
                                                               'private': 'DO_NOT_RENDER'}),
                              capture_output=True, text=True, encoding='utf-8', timeout=10)
        if proc.returncode == 0 or 'DO_NOT_RENDER' in (proc.stdout + proc.stderr):
            raise AssertionError('Rust did not reject unexpected private request field')
        print(f'NATIVE_REPOQL_CONNECTOR_PARITY_PASSED: {count} cases and request field rejection')
    else:
        print(f'REPOQL_CONNECTOR_REFERENCE_ONLY_PASSED: {count} cases (Rust executable NOT_RUN)')


if __name__ == '__main__':
    main()
