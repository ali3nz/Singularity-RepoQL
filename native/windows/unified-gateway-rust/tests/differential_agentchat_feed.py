#!/usr/bin/env python3
"""Source-only Python Agent Chat oracle and optional compiled Rust differential.

The regular reference suite does not count as Rust execution. A compiled
singularity-agentchat-feed executable is mandatory for --rust-cli mode.
"""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import random
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / 'dashboard'))
from agentchat_feed import _read_feed_python, _read_presence_python

NOW = datetime(2026, 11, 12, 12, 0, 0, tzinfo=timezone.utc)


def fixtures():
    rng = random.Random(8675309)
    cases = []
    for case in range(100):
        with tempfile.TemporaryDirectory(prefix='agentchat-differential-') as tmp:
            root = Path(tmp)
            (root / 'inbox').mkdir()
            (root / 'inbox-sessions').mkdir()
            roles = ['alpha', 'beta', 'omb-' + 'e' * 32, 'session_z']
            for recipient_index, role in enumerate(roles):
                folder = root / ('inbox-sessions' if recipient_index % 2 else 'inbox')
                path = folder / f'{role}.jsonl'
                lines = []
                for i in range((case + recipient_index) % 11 + 1):
                    mid = (i + 1) * (case % 7 + 1)
                    stamp = f'2026-11-12T11:{(i * 3 + case) % 60:02d}:00Z'
                    row = {
                        'id': mid, 'from': rng.choice(['planner', 'builder', 'omb-' + 'e' * 32, 'INVALID/ROLE']),
                        'fromSession': 'session-' + str(case),
                        'createdAt': stamp, 'origin': 'kanzo',
                        'text': rng.choice(['hello', 'éclair 🧠', 'x' * 1800, '']),
                        'runNumber': rng.choice([None, 0, 4]),
                        'privateToken': 'DO_NOT_RENDER',
                    }
                    lines.append(json.dumps(row, ensure_ascii=False))
                if case % 9 == 0:
                    lines.append('NOT_JSON')
                path.write_text('\n'.join(lines) + '\n', encoding='utf-8')
            if case % 12 == 0:
                secret = root / 'private.txt'
                secret.write_text('DO_NOT_RENDER', encoding='utf-8')
                try:
                    (root / 'inbox' / 'secret.jsonl').symlink_to(secret)
                except OSError:
                    pass
            after = [0, 1, 7, 50][case % 4]
            limit = [1, 4, 20, 150][case % 4]
            feed = _read_feed_python(after, limit, root=root)
            presence = _read_presence_python(root=root, now=NOW)
            assert all('DO_NOT_RENDER' not in json.dumps(message) for message in feed['messages'])
            assert all(agent['status'] == 'idle' for agent in presence['agents'])
            yield root, after, limit, feed, presence


def differential(binary: Path):
    if not binary.is_absolute() or not binary.is_file():
        raise SystemExit('compiled Rust executable missing or relative')
    count = 0
    for root, after, limit, feed, presence in fixtures():
        for mode, args, expected in (
            ('feed', [str(after), str(limit)], feed),
            ('presence', [NOW.isoformat()], presence),
        ):
            proc = subprocess.run([str(binary), mode, str(root), *args],
                                  capture_output=True, text=True, timeout=10)
            if proc.returncode != 0:
                raise AssertionError(f'Rust binary failed {mode}: rc={proc.returncode}')
            try:
                actual = json.loads(proc.stdout)
            except json.JSONDecodeError as err:
                raise AssertionError('Rust binary returned malformed JSON') from err
            if actual != expected:
                raise AssertionError(
                    f'Rust {mode} differs from Python at fixture {count}: '
                    f'{json.dumps(actual, ensure_ascii=False)[:240]} != '
                    f'{json.dumps(expected, ensure_ascii=False)[:240]}')
        count += 1
    print(f'NATIVE_AGENTCHAT_PARITY_PASSED: {2*count} feed and presence checks')


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--rust-cli', type=Path)
    args = p.parse_args()
    if args.rust_cli:
        differential(args.rust_cli.resolve())
    else:
        count = 0
        for _ in fixtures():
            count += 1
        print(f'AGENTCHAT_REFERENCE_ONLY_PASSED: {count*2} Python checks; Rust binary NOT_RUN')


if __name__ == '__main__':
    main()
