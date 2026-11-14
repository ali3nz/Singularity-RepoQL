#!/usr/bin/env python3
"""Read-only exact file inventory verification for Wave 22 source candidates.

No compilation, execution of packaged binaries, network calls, or release
approval. WAVE22_SOURCE_MANIFEST.json deliberately excludes itself and the root
SHA256SUMS; SHA256SUMS includes the Wave22 manifest to close the hash cycle.
"""
from __future__ import annotations
import hashlib
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = 'WAVE22_SOURCE_MANIFEST.json'
EXCLUDE = {MANIFEST, 'SHA256SUMS'}


def inventory() -> dict[str, Path]:
    result = {}
    for p in ROOT.rglob('*'):
        if not p.is_file():
            continue
        if any(seg in {'.git', '__pycache__', 'target'} for seg in p.relative_to(ROOT).parts):
            continue
        relative = p.relative_to(ROOT).as_posix()
        result[relative] = p
    return result


def verify() -> int:
    manifest = json.loads((ROOT / MANIFEST).read_text(encoding='utf8'))
    all_files = inventory()
    expected = manifest.get('files')
    if (manifest.get('schema') != 'singularity-rust-wave22-source-manifest/v1' or
            manifest.get('status') != 'SOURCE_ONLY_UNCOMPILED_NOT_INSTALLER' or not isinstance(expected, list)):
        print('SOURCE_MANIFEST_INVALID')
        return 2
    expected_names = {row.get('path') for row in expected}
    if len(expected_names) != len(expected) or expected_names != set(all_files) - EXCLUDE:
        print('SOURCE_FILE_INVENTORY_MISMATCH')
        return 2
    for row in expected:
        path = all_files[row['path']]
        if path.is_symlink():
            print('SYMLINK_NOT_ACCEPTED')
            return 2
        content = path.read_bytes()
        if (len(content) != row.get('bytes') or
                hashlib.sha256(content).hexdigest() != row.get('sha256')):
            print('SOURCE_HASH_MISMATCH', row['path'])
            return 2
    lines = (ROOT / 'SHA256SUMS').read_text(encoding='utf8').splitlines()
    sha_receipts = {}
    for line in lines:
        digest, sep, name = line.partition('  ')
        if not sep or name in sha_receipts:
            print('SHA256SUMS_INVALID')
            return 2
        sha_receipts[name] = digest
    if set(sha_receipts) != set(all_files) - {'SHA256SUMS'}:
        print('SHA256SUMS_INVENTORY_MISMATCH')
        return 2
    for name, expected_hash in sha_receipts.items():
        if hashlib.sha256(all_files[name].read_bytes()).hexdigest() != expected_hash:
            print('SHA256SUMS_MISMATCH', name)
            return 2
    print(f'SOURCE_ONLY_INTEGRITY_PASS: {len(all_files)} files; Rust compilation NOT_RUN')
    return 0


if __name__ == '__main__':
    sys.exit(verify())
