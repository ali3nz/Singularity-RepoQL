#!/usr/bin/env python3
"""Source reference CPU history and optional actual compiled Rust parity."""
import argparse
import json
from pathlib import Path
import random
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / 'dashboard'))
from native_cpu_history import _project_rows_python

NOW = 1793253600
ARGS = {'period':'1h','window':3600,'bucket':60,'retention_days':30,
        'sample_interval_seconds':15}


def fixtures():
    yield [(NOW, 0.0, 'ok')]
    yield [(NOW, None, 'identity_mismatch')]
    yield [(NOW - 3500, 409600.0, 'ok'), (NOW, 0.0, 'ok')]
    yield [(NOW - 21, 10.0, 'ok'), (NOW - 4, None, 'unavailable'),
           (NOW, 30.0, 'ok')]
    rng = random.Random(30011)
    for i in range(400):
        length = 1 + rng.randrange(1, 90)
        timestamps = sorted(NOW - rng.randrange(0, 3600) for _ in range(length))
        rows = []
        for ts in timestamps:
            state = rng.choice(['ok','ok','ok','unavailable','identity_mismatch'])
            cpu = rng.randrange(0, 200_000) / 100 if state == 'ok' else None
            rows.append((ts, cpu, state))
        yield rows


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--rust-cli', type=Path)
    args = parser.parse_args()
    binary = args.rust_cli.resolve() if args.rust_cli else None
    if binary is not None and not binary.is_file():
        parser.error('native Rust binary missing')
    count = 0
    for rows in fixtures():
        expected = _project_rows_python(rows, **ARGS)
        assert expected['stats']['samples'] <= len(rows)
        assert expected['measurement_source'] == 'rust-win32-process-times'
        request = {'period':ARGS['period'], 'now':NOW, 'window':ARGS['window'],
                   'bucket':ARGS['bucket'], 'retention_days':ARGS['retention_days'],
                   'sample_interval_seconds':ARGS['sample_interval_seconds'], 'rows':rows}
        if binary:
            result = subprocess.run([str(binary)], input=json.dumps(request), text=True,
                                    encoding='utf-8', capture_output=True, shell=False, timeout=10)
            if result.returncode != 0 or json.loads(result.stdout) != expected:
                raise AssertionError(f'CPU Rust compiled differential mismatch at {count}: {result.returncode}')
        count += 1
    if binary:
        clean = {'period':'1h','now':NOW,'window':3600,'bucket':60,'retention_days':30,
                 'sample_interval_seconds':15,'rows':[(NOW,35,'ok')]}
        for invalid in (dict(clean, db_path='private'), dict(clean, rows=[(NOW,35,'forged')]),
                        dict(clean, rows=[(NOW,True,'ok')]),
                        dict(clean, window=0), dict(clean, rows=[])):
            got = subprocess.run([str(binary)],input=json.dumps(invalid),text=True,
                                 encoding='utf-8',capture_output=True,timeout=10,shell=False)
            if got.returncode == 0 or 'private' in got.stdout + got.stderr:
                raise AssertionError('Rust accepted untrusted CPU history input or leaked it')
        print(f'NATIVE_CPU_HISTORY_COMPILED_PARITY_PASSED: {count} cases')
    else:
        print(f'NATIVE_CPU_HISTORY_REFERENCE_ONLY_PASSED: {count} cases (Rust executable NOT_RUN)')


if __name__ == '__main__':
    main()
