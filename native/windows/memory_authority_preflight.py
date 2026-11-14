#!/usr/bin/env python3
"""Read-only native memory authority readiness diagnostic, not a deployment gate."""
import argparse
import json
import os
from rust_readonly_bridge import run_checked, RustReadOnlyBridgeError
from pathlib import Path


def inspect(root: Path, env: dict):
    config = root / 'harness' / 'kit' / 'config.json'
    try:
        doc = json.loads(config.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return {'ok': False, 'code': 'KIT_CONFIG_UNAVAILABLE', 'checks': {}}
    flags = doc.get('memoryProvenance') or {}
    requested = env.get('ORCH_MEMORY_RETRIEVAL_FILTER', flags.get('retrievalFilter', 'DISABLED'))
    enabled = str(requested).upper() == 'ENABLED'
    checks = {}
    for name, key in [('tombstones', 'ORCH_TOMBSTONES_DIR'), ('lineage', 'ORCH_LINEAGE_DIR')]:
        raw = env.get(key, '')
        p = Path(raw) if raw else None
        checks[name] = {'configured': bool(raw), 'localDirectoryExists': bool(p and p.is_dir()),
                        'notSymlink': bool(p and p.is_dir() and not p.is_symlink())}
    ok = not enabled or all(c['configured'] and c['localDirectoryExists'] and c['notSymlink'] for c in checks.values())
    return {'ok': ok, 'code': 'WINDOWS_MEMORY_AUTHORITY_READY_FOR_RUNTIME_TEST' if ok else 'WINDOWS_MEMORY_AUTHORITY_UNVERIFIED',
            'retrievalFilterEnabled': enabled, 'checks': checks,
            'note': 'Directory readiness only; does not verify native Windows live MemoryCore or RepoQL'}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True, type=Path)
    parser.add_argument('--rust-binary', type=Path, help='opt-in compiled Rust preflight, checked against the Python result')
    a = parser.parse_args()
    r = inspect(a.root, dict(os.environ))
    if a.rust_binary is not None:
        try:
            r = run_checked(a.rust_binary, ['preflight', '--root', str(a.root)], r)
        except RustReadOnlyBridgeError as exc:
            print(json.dumps({'ok': False, 'code': str(exc), 'checks': {}}))
            return 2
    print(json.dumps(r, sort_keys=True))
    return 0 if r['ok'] else 2


if __name__ == '__main__':
    raise SystemExit(main())
