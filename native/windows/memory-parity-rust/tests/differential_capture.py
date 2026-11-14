#!/usr/bin/env python3
"""Source capture oracle plus optional compiled Rust differential (state-only)."""
import argparse
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[4]
LEGACY = ROOT / 'scripts' / 'memory_turn_capture.py'


def run(binary, args, *, text=None):
    proc = subprocess.run([*binary, *args], input=text, capture_output=True, text=True, timeout=10)
    return proc.returncode, proc.stdout + proc.stderr


def exercise(binary):
    with tempfile.TemporaryDirectory(prefix='singularity-capture-diff-') as t:
        base = Path(t)
        state_dir = base / 'state'
        lesson = base / 'lesson.md'
        lesson.write_text('Canonical lesson about RepoQL retrieval\nPreserve exact claim scope.\n', encoding='utf-8')
        count = 0
        for i in range(3):
            rc, msg = run(binary, ['propose','--lesson-file',str(lesson),'--state-dir',str(state_dir),'--skip-rql'])
            assert rc == 0, f'propose {i}: {rc}, {msg}'
            assert 'PENDING WRITTEN:' in msg and 'unverified-dedup' in msg
            count += 1
        assert len(list((state_dir / 'pending').glob('*.md'))) == 3
        rc, msg = run(binary, ['propose','--lesson-file',str(lesson),'--state-dir',str(state_dir),'--skip-rql'])
        assert rc == 5 and 'DEFERRED' in msg and len(list((state_dir / 'pending').glob('*.md'))) == 3
        pending = sorted((state_dir / 'pending').glob('*.md'))
        rc, msg = run(binary, ['confirm','--file',str(pending[0]),'--state-dir',str(state_dir)])
        assert rc == 0 and 'CONFIRMED:' in msg, msg
        assert (state_dir / 'confirmed' / pending[0].name).is_file()
        rc, msg = run(binary, ['status','--state-dir',str(state_dir)])
        assert rc == 0 and 'confirmed captures in last 24h: 1 / 3' in msg, msg
        state = json.loads((state_dir / 'state.json').read_text('utf-8'))
        assert len(state['confirmed']) == 1
        assert re.fullmatch(r'[0-9]{10}-[a-z]{4}-canonical-lesson-about-repoql-retrieval\.md', pending[0].name)
        assert 'Canonical lesson about RepoQL retrieval' in (state_dir / 'confirmed' / pending[0].name).read_text('utf-8')
        rc, msg = run(binary, ['confirm','--file',str(pending[0]),'--state-dir',str(state_dir)])
        assert rc == 2
        too_big = base / 'oversized.md'
        too_big.write_text('y'*8001)
        rc, msg = run(binary, ['propose','--lesson-file',str(too_big),'--state-dir',str(state_dir),'--skip-rql'])
        assert rc == 3 and not any(p.name.startswith('oversized') for p in (state_dir / 'pending').glob('*.md'))
        corrupt = base / 'bad'
        corrupt.mkdir()
        (corrupt / 'state.json').write_text('{broken',encoding='utf-8')
        rc, msg = run(binary, ['status','--state-dir',str(corrupt)])
        assert rc == 6
        return {'proposals': count,'pendingCap': True,'confirmation': True,'oversizedRejected':True,'corruptStateRefused':True}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--repo', type=Path, default=ROOT)
    ap.add_argument('--rust-cli', type=Path)
    args = ap.parse_args()
    legacy = args.repo / 'scripts' / 'memory_turn_capture.py'
    source = exercise([sys.executable, str(legacy)])
    result = {'sourceReference':source,'rustCompared':False}
    if args.rust_cli:
        if not args.rust_cli.is_file():
            raise SystemExit(f'Rust CLI missing: {args.rust_cli}')
        native = exercise([str(args.rust_cli.resolve())])
        assert native == source, f'Rust mismatch: {native} != {source}'
        result.update({'rustCompared':True, 'rust':native})
    print(json.dumps(result, sort_keys=True))


if __name__ == '__main__':
    main()
