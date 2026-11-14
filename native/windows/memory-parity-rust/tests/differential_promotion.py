#!/usr/bin/env python3
"""Promotion shortlist/cursor/cap reference and optional compiled Rust oracle.

No credentials, document excerpts, gateway URL or state-file writes cross the
native test boundary. A reference-only run is NOT native Rust equivalence.
"""
from __future__ import annotations
import argparse
import importlib.util
import json
from pathlib import Path
import random
import subprocess


def load(repo: Path):
    spec = importlib.util.spec_from_file_location('promotion_reference', repo / 'scripts/memory_promote.py')
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def run(repo: Path, cli: Path | None) -> None:
    reference = load(repo)
    rng = random.Random(160016)
    cases = []
    for i in range(200):
        rows = [{'id': f'id-{j}', 'ts': j * 100 - 100,
                 'excerpt': (' ' * rng.randrange(1, 4) if i % 17 == 0 else
                             'PRIVATE_TEXT_NEVER_SENT_' + 'é' * rng.randrange(0, 260))}
                for j in range(rng.randrange(0, 24))]
        done = [r['id'] for r in rows if rng.random() < 0.15]
        cursor = {'afterTs': rng.choice([0, 100, 200, 400]), 'doneIds': done}
        expected = reference.select_shortlist(rows, cursor)
        request = {'afterTs': cursor['afterTs'], 'doneIds': done,
                   'records': [{'id': r['id'], 'ts': r['ts'], 'excerptLen': len(r['excerpt']),
                                'hasText': bool(r['excerpt'].strip())} for r in rows]}
        cases.append(('promotion-shortlist', request, expected))
    for i in range(200):
        n = rng.randrange(0, 18)
        pending = {f'id-{j}': {'ts': (j + 1) * 100} for j in range(n)}
        done = [f'id-{j}' for j in range(n) if rng.random() < 0.7]
        deferred = {f'id-{j}': {'rec_ts': (j + 1) * 100, 'reason': 'review later'}
                    for j in range(n) if rng.random() < 0.22}
        after = rng.choice([0, 0, 100, 300])
        target = rng.choice([0, 100, 200, 500, n * 100, (n + 1) * 100])
        presented = max((v['ts'] for v in pending.values()), default=0)
        cursor = {'afterTs': after, 'pendingReview': pending, 'maxPresentedTs': presented,
                  'lastShortlist': pending, 'doneIds': done, 'deferred': deferred}
        expected = reference.advance_decision(cursor, target)
        request = {'afterTs': after, 'advanceTs': target, 'maxPresentedTs': presented, 'doneIds': done,
                   'pendingReview': [{'id': id_, 'ts': v['ts']} for id_,v in sorted(pending.items())],
                   'deferred': [{'id': id_, 'recTs': v['rec_ts']} for id_,v in sorted(deferred.items())]}
        cases.append(('promotion-advance', request, expected))
    for i in range(200):
        now = 900000
        times = [now + rng.randrange(-900000, 90000) for _ in range(rng.randrange(0, 7))]
        promotions = {f'concept-{j}': {'ts': ts} for j, ts in enumerate(times)}
        name = rng.choice(['concept-0', 'concept-2', 'new', ''])
        cursor = {'promotions': promotions}
        expected = reference.eligible_promotion(cursor, name, now)
        request = {'nowTs': now, 'recentTs': list(times),
                   'priorTs': promotions[name]['ts'] if name and name in promotions else None}
        cases.append(('promotion-eligibility', request, expected))
    assert len(cases) == 600
    for index, (command, request, expected) in enumerate(cases):
        encoded = json.dumps(request, ensure_ascii=False)
        for forbidden in ('PRIVATE_TEXT', 'memory.json', 'gatewayKey', 'Authorization'):
            if forbidden in encoded:
                raise AssertionError(f'Private memory content crossed native boundary in case {index}')
        if cli is None:
            continue
        process = subprocess.run([str(cli), command], input=encoded.encode('utf-8'),
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 timeout=8, check=False)
        try:
            actual = json.loads(process.stdout)
        except (UnicodeError, ValueError):
            raise AssertionError(f'Non-JSON Rust response: case {index}, {command}') from None
        if process.returncode or actual != expected:
            raise AssertionError(f'Rust promotion differential divergence: case {index}, {command}')
    print('PROMOTION_REFERENCE_CASES_OK', len(cases))
    print('NATIVE_RUST_DIFFERENTIAL_PASS' if cli else 'NATIVE_RUST_DIFFERENTIAL_NOT_RUN')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--repo', required=True, type=Path)
    parser.add_argument('--rust-cli', type=Path)
    args = parser.parse_args()
    if args.rust_cli and not args.rust_cli.is_file():
        parser.error('compiled Rust binary missing')
    run(args.repo, args.rust_cli)
