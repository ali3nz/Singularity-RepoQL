#!/usr/bin/env python3
"""Deterministic readiness differential, optionally using the actual compiled CLI."""
import argparse
import json
from pathlib import Path
import random
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / 'dashboard'))
from native_readiness import PROBE_NAMES, _project_python


def fixtures():
    for office in (False, True):
        for mask in range(128):
            probes = {name: bool(mask & (1 << i)) for i, name in enumerate(PROBE_NAMES)}
            yield {'variant': 2, 'features': {'office': office}}, probes
    rng = random.Random(29011)
    for i in range(400):
        office = bool(rng.randrange(2))
        probes = {name: bool(rng.randrange(2)) for name in PROBE_NAMES}
        variant = None if i % 41 == 0 else 2
        yield {'variant': variant, 'features': {'office': office}}, probes


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--rust-cli', type=Path)
    args = parser.parse_args()
    binary = args.rust_cli.resolve() if args.rust_cli else None
    if binary and not binary.is_file():
        parser.error('native executable missing')
    count = 0
    for profile, verified in fixtures():
        expected = _project_python(profile, verified)
        assert expected['release_ready'] is False
        request = {'variant': profile['variant'], 'office': bool(profile['features']['office']),
                   'probes': {name: bool(verified[name]) for name in PROBE_NAMES}}
        assert set(request['probes']) == set(PROBE_NAMES)
        if binary:
            result = subprocess.run([str(binary)], input=json.dumps(request),
                                    text=True, capture_output=True, encoding='utf-8',
                                    timeout=10, shell=False)
            if result.returncode != 0 or json.loads(result.stdout) != expected:
                raise AssertionError(f'compiled readiness Rust mismatch at case {count}: exit {result.returncode}')
        count += 1
    if binary:
        valid = {'variant':2,'office':True,'probes':{name:True for name in PROBE_NAMES}}
        for invalid in (dict(valid, secret='private'), dict(valid, office='true'),
                        dict(valid, variant=3), dict(valid, probes={'repoql_version':True}),
                        dict(valid, probes={**valid['probes'], 'password': True})):
            result = subprocess.run([str(binary)], input=json.dumps(invalid),
                                    text=True, capture_output=True, encoding='utf-8', timeout=10,
                                    shell=False)
            if result.returncode == 0 or 'private' in result.stdout + result.stderr:
                raise AssertionError('invalid readiness request was accepted or private input leaked')
        print(f'NATIVE_READINESS_COMPILED_PARITY_PASSED: {count} cases')
    else:
        print(f'NATIVE_READINESS_REFERENCE_ONLY_PASSED: {count} cases (Rust executable NOT_RUN)')


if __name__ == '__main__':
    main()
