#!/usr/bin/env python3
"""Check the pinned upstream -> l1recordids -> fleet1175 overlay chain.

Never edits the supplied upstream tree. Without the exact pinned preimage, the
validation refuses instead of guessing that a six-file patch will apply.
"""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
BASE = HERE.parent / 'core-v2.0.2-l1recordids'
EXPECTED_FINAL = {
    'src/core/record/l1-writer.ts': 'f8f9b0f72e7c1ec19dcb69b93f18adad1f26671613f0850c7743ca596daebfca',
    'src/core/record/l1-extractor.ts': '9cd8a09b463501912a05f61d8dd57cac41693f59def6f528b99ea1d3df32aca7',
    'src/core/record/l1-dedup.ts': '80087ee66fd277e959a5e84cf5349c3393390a28d3b2172bb10e40cab7604552',
    'src/core/store/sqlite/memory-store.ts': '035c03b823840df9240b0fb8b844871860a382157ee5ecebc7834aa0d9086209',
    'src/core/store/tcvdb/memory-store.ts': '736a11961cf2cd958907180c537254f4d79bc1c7366e3aae7275c27b8066d616',
    'src/core/store/types.ts': '621e907b6bc5d17d1aa4ab3b9bab5e5d58098fdda798771e8be4b3bdb50af962',
}

def digest(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()

def check_paths(root: Path, rows: list, head: bool):
    key = 'head_sha256' if head else 'base_sha256'
    for row in rows:
        expected = row.get(key)
        if expected is None:
            continue
        file = root / row['path']
        if not file.is_file() or digest(file) != expected:
            raise RuntimeError(f'PINNED_{key.upper()}_MISMATCH: {row["path"]}')

def apply_patch(root: Path, patch: Path):
    r = subprocess.run(['patch', '-p1', '--batch', '--forward', '--reject-file=-', '-i', str(patch)],
                       cwd=root, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if r.returncode:
        raise RuntimeError(f'PATCH_NOT_APPLICABLE: {patch.name}: {(r.stdout + r.stderr)[-1200:]}')

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--upstream', type=Path, required=True, help='Verified pinned Tencent MemoryCore source directory')
    parser.add_argument('--output', type=Path, default=None, help='Optional NEW output directory, must not exist')
    args = parser.parse_args()
    upstream = args.upstream.resolve(strict=True)
    series = json.loads((BASE / 'series.json').read_text())
    if digest(BASE / series['patch']['file']) != series['patch']['sha256']:
        raise RuntimeError('BASE_OVERLAY_HASH_MISMATCH')
    check_paths(upstream, series['files'], False)
    with tempfile.TemporaryDirectory(prefix='singularity-l1idem2-') as tmp:
        target = Path(tmp) / 'MemoryCore'
        shutil.copytree(upstream, target)
        apply_patch(target, BASE / series['patch']['file'])
        check_paths(target, series['files'], True)
        apply_patch(target, HERE / 'l1idem2.patch')
        for rel, expected in EXPECTED_FINAL.items():
            if digest(target / rel) != expected:
                raise RuntimeError(f'FLEET1175_HEAD_HASH_MISMATCH: {rel}')
        if args.output is not None:
            output = args.output.resolve()
            if output.exists():
                raise RuntimeError('OUTPUT_ALREADY_EXISTS')
            shutil.copytree(target, output)
        print(json.dumps({'ok': True, 'stage': 'PINNED_SOURCE_AND_BOTH_OVERLAYS_VERIFIED',
                          'files': len(EXPECTED_FINAL), 'output': str(args.output) if args.output else None}))

if __name__ == '__main__':
    main()
