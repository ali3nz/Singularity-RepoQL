#!/usr/bin/env python3
"""Inspect or prepare an unapproved Option 2 Windows acceptance candidate.

Inspection is read-only on any host. Extraction requires native Windows and
writes only a new directory under the current user's Singularity preview root.
Never installs services, loads credentials, or configures Claude Desktop.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import stat
import tempfile
import zipfile

from build_option2_acceptance_bundle import (
    SOURCE, BUNDLE_FILES, binary_entries, check_acceptance_bundle,
)
from scan_source_archive import scan

SCHEMA = 'singularity-option2-prepared-candidate/v1'
OUTPUT_NAME = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$')
RESERVED_OUTPUTS = {'CON', 'PRN', 'AUX', 'NUL', 'CONIN$', 'CONOUT$'} | {
    f'{prefix}{n}' for prefix in ('COM', 'LPT') for n in range(1, 10)
}
MAX_BUNDLE_BYTES = 1004 * 1024 * 1024


def _digest(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def _assert_no_reparse(path: Path) -> None:
    """Inspect all existing ancestors without following links or junctions."""
    cursor = path
    while True:
        try:
            info = cursor.lstat()
        except FileNotFoundError:
            pass
        else:
            if stat.S_ISLNK(info.st_mode) or (getattr(info, 'st_file_attributes', 0) & 0x400):
                raise ValueError('REPARSE_PATH_REFUSED')
        if cursor == cursor.parent:
            break
        cursor = cursor.parent


def inspect(candidate: Path) -> dict:
    candidate = Path(os.path.abspath(candidate))
    _assert_no_reparse(candidate)
    if not candidate.is_file() or not 1 <= candidate.stat().st_size <= MAX_BUNDLE_BYTES:
        raise ValueError('BUNDLE_FILE_INVALID')
    verified = check_acceptance_bundle(candidate)
    if not verified.get('ok'):
        raise ValueError('BUNDLE_VERIFICATION_FAILED')
    with zipfile.ZipFile(candidate) as outer:
        receipt = json.loads(outer.read('ACCEPTANCE_BUNDLE_MANIFEST.json'))
        with zipfile.ZipFile(io.BytesIO(outer.read(BUNDLE_FILES[SOURCE]))) as nested:
            manifest = json.loads(nested.read('NATIVE_WINDOWS_SOURCE_MANIFEST.json'))
    # No assertion about publisher, signed binaries, services or GUI.
    return {
        'schema': SCHEMA,
        'status': 'INSPECTED_NOT_INSTALLED',
        'option': 2,
        'bundle_sha256': _digest(candidate.read_bytes()),
        'source_sha256': next(row['sha256'] for row in receipt['files'] if row['path'] == BUNDLE_FILES[SOURCE]),
        'source_file_count': len(manifest['files']),
        'repoql_required_version': '1.7.18',
        'manifest_git_commit': receipt.get('git_commit'),
        'runtime_tested': False,
        'installation_performed': False,
        'release_ready': False,
    }


def _preview_root() -> Path:
    local = os.environ.get('LOCALAPPDATA', '')
    if not local or not Path(local).is_absolute():
        raise ValueError('LOCALAPPDATA_REQUIRED')
    return Path(os.path.abspath(Path(local) / 'Singularity' / 'WindowsNativePreview'))


def prepare(candidate: Path, destination: Path, *, native_windows: bool | None = None,
            preview_root: Path | None = None) -> dict:
    if native_windows is None:
        native_windows = os.name == 'nt'
    if not native_windows:
        raise ValueError('NATIVE_WINDOWS_REQUIRED_FOR_EXTRACTION')
    root = Path(os.path.abspath(preview_root if preview_root is not None else _preview_root()))
    destination = Path(os.path.abspath(destination))
    if (destination.parent != root or not OUTPUT_NAME.fullmatch(destination.name)
            or destination.name.endswith('.') or destination.name.endswith(' ')
            or destination.name.split('.', 1)[0].upper() in RESERVED_OUTPUTS):
        raise ValueError('DESTINATION_MUST_BE_NEW_PREVIEW_CHILD')
    _assert_no_reparse(destination)
    if not root.is_dir():
        raise ValueError('PREVIEW_ROOT_MUST_EXIST')
    if destination.exists() or destination.is_symlink():
        raise ValueError('DESTINATION_EXISTS_REFUSED')
    # Verify all nested source digests before opening a destination. This is a
    # preparatory copy, not a trusted publisher/signature check.
    result = inspect(candidate)
    with zipfile.ZipFile(candidate) as outer:
        source_bytes = outer.read(BUNDLE_FILES[SOURCE])
        if not scan(io.BytesIO(source_bytes)).get('ok'):
            raise ValueError('SOURCE_INVENTORY_INVALID')
        binary_bytes = {name: outer.read(entry) for name, entry in binary_entries(outer.namelist()).items()}
        with zipfile.ZipFile(io.BytesIO(source_bytes)) as nested:
            manifest = json.loads(nested.read('NATIVE_WINDOWS_SOURCE_MANIFEST.json'))
            inventory = {row['path']: row for row in manifest['files']}
            if len(inventory) != len(manifest['files']):
                raise ValueError('SOURCE_DUPLICATE_INVENTORY')
            # Use a sibling temporary directory. Never write into an existing
            # installation or overwrite an unrelated file.
            pending = Path(tempfile.mkdtemp(prefix='.pending-option2-', dir=root))
            try:
                (pending / 'bin').mkdir()
                (pending / 'source').mkdir()
                for name in binary_bytes:
                    (pending / 'bin' / name).write_bytes(binary_bytes[name])
                for name, row in sorted(inventory.items()):
                    target = pending / 'source' / Path(*name.split('/'))
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with nested.open(name) as source, target.open('xb') as dest:
                        h = hashlib.sha256()
                        written = 0
                        while chunk := source.read(1024 * 1024):
                            written += len(chunk)
                            if written > row['bytes']:
                                raise ValueError('SOURCE_EXTRACT_SIZE_DRIFT')
                            h.update(chunk)
                            dest.write(chunk)
                        if written != row['bytes'] or h.hexdigest() != row['sha256']:
                            raise ValueError('SOURCE_EXTRACT_HASH_DRIFT')
                (pending / 'source' / 'NATIVE_WINDOWS_SOURCE_MANIFEST.json').write_bytes(
                    nested.read('NATIVE_WINDOWS_SOURCE_MANIFEST.json'))
                prepared = dict(result)
                prepared['status'] = 'PREPARED_ONLY_NOT_STAGED_NOT_INSTALLED'
                prepared['prepared_file_count'] = len(inventory) + len(binary_bytes) + 1
                (pending / 'PREPARATION_RECEIPT.json').write_text(
                    json.dumps(prepared, indent=2, sort_keys=True) + '\n', encoding='utf-8')
                _assert_no_reparse(destination)
                if destination.exists() or destination.is_symlink():
                    raise ValueError('DESTINATION_EXISTS_REFUSED')
                pending.rename(destination)
            except BaseException:
                shutil.rmtree(pending)
                raise
    return prepared


def main() -> int:
    parser = argparse.ArgumentParser(description='Inspect or prepare Option 2 candidate (NOT an installer)')
    parser.add_argument('--bundle', type=Path, required=True)
    parser.add_argument('--extract', action='store_true', help='Prepare files on native Windows only; no install')
    parser.add_argument('--destination', type=Path, help='New direct child of LocalAppData\\Singularity\\WindowsNativePreview')
    args = parser.parse_args()
    if args.extract:
        if args.destination is None:
            parser.error('--destination required for --extract')
        report = prepare(args.bundle, args.destination)
    else:
        report = inspect(args.bundle)
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
