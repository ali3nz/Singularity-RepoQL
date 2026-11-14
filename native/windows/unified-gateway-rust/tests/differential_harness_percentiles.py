#!/usr/bin/env python3
"""Independent 600-case harness performance oracle; compiled Rust opt-in."""
import argparse
import json
from pathlib import Path
import random
import subprocess


def percentile(values, ratio):
    if not values:
        return None
    ordered = sorted(values)
    if len(ordered) == 1:
        return float(ordered[0])
    rank = (len(ordered) - 1) * ratio
    lower = int(rank)
    upper = min(lower + 1, len(ordered) - 1)
    weight = rank - lower
    return ordered[lower] * (1 - weight) + ordered[upper] * weight


def oracle(complete, model):
    return {'completion_ms': {'p50': percentile(complete, 0.5),
                              'p95': percentile(complete, 0.95),
                              'p99': percentile(complete, 0.99),
                              'samples': len(complete)},
            'model_latency_ms': {'p50': percentile(model, 0.5),
                                 'p95': percentile(model, 0.95),
                                 'samples': len(model)}}


def cases():
    yield [], []
    yield [0], [0]
    yield [0, 10], [20, 30]
    yield [0.0, 1.25, 2.5, 3.75], []
    yield [100.5] * 5, [-1.0, 0.0, 1.0]
    rng = random.Random(33117)
    for _ in range(595):
        def arr():
            return [rng.randrange(-10000, 100000) / rng.choice((1, 2, 4, 10))
                    for _ in range(rng.randrange(0, 160))]
        yield arr(), arr()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--rust-cli', type=Path)
    args = parser.parse_args()
    binary = args.rust_cli.resolve() if args.rust_cli else None
    if binary and not binary.is_file():
        parser.error('compiled Rust binary missing')
    count = 0
    for complete, model in cases():
        expected = oracle(complete, model)
        assert len(complete) + len(model) <= 20000
        request = {'schema': 'singularity-harness-percentiles/v1',
                   'completion_ms': complete, 'model_latency_ms': model}
        if binary:
            got = subprocess.run([str(binary)], input=json.dumps(request), text=True,
                                 encoding='utf-8', capture_output=True, timeout=15, shell=False)
            if got.returncode or json.loads(got.stdout) != expected:
                raise AssertionError(f'harness percentile compiled parity mismatch at {count}')
        count += 1
    assert count == 600
    if binary:
        base = {'schema': 'singularity-harness-percentiles/v1',
                'completion_ms': [1], 'model_latency_ms': []}
        for invalid in (dict(base, token='PRIVATE'), dict(base, completion_ms=['PRIVATE']),
                        dict(base, completion_ms=[True]), dict(base, completion_ms=[1e13]),
                        dict(base, model_latency_ms={'secret': 'PRIVATE'})):
            got = subprocess.run([str(binary)], input=json.dumps(invalid), text=True,
                                 capture_output=True, timeout=15, shell=False)
            if got.returncode == 0 or 'PRIVATE' in got.stdout + got.stderr:
                raise AssertionError('harness percentile Rust rejected-input boundary broken')
        print(f'HARNESS_PERCENTILES_COMPILED_PARITY_PASSED: {count} cases')
    else:
        print(f'HARNESS_PERCENTILES_REFERENCE_ONLY_PASSED: {count} cases (Rust executable NOT_RUN)')


if __name__ == '__main__':
    main()
