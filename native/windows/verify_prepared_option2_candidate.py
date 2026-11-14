#!/usr/bin/env python3
"""Re-verify an Option 2 prepared preview against the ORIGINAL acceptance ZIP.

Read-only. Does not install, stage, configure, execute binaries, call services,
validate the publisher's signature, or mark release acceptance as passed.
For Windows operators: the original bundle is a locally reviewed input, not an
independent trust root; compare its provenance before running this verification.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import stat
import zipfile

from build_option2_acceptance_bundle import SOURCE, BUNDLE_FILES, binary_entries
from prepare_option2_candidate import inspect, _assert_no_reparse, _preview_root, OUTPUT_NAME, RESERVED_OUTPUTS

SCHEMA = 'singularity-option2-prepared-verification/v1'


def digest_file(path: Path, expected_size: int, expected_sha: str) -> None:
    _assert_no_reparse(path)
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_size != expected_size:
        raise ValueError('PREPARED_FILE_SIZE_OR_TYPE_DRIFT')
    h = hashlib.sha256()
    with path.open('rb') as stream:
        while chunk := stream.read(1024 * 1024):
            h.update(chunk)
    if h.hexdigest() != expected_sha:
        raise ValueError('PREPARED_FILE_HASH_DRIFT')


def verify_prepared(bundle: Path, prepared: Path, *, native_windows: bool | None = None,
                    preview_root: Path | None = None) -> dict:
    if native_windows is None:
        native_windows = os.name == 'nt'
    if not native_windows:
        raise ValueError('NATIVE_WINDOWS_REQUIRED_FOR_PREPARED_VERIFICATION')
    root = Path(os.path.abspath(preview_root if preview_root is not None else _preview_root()))
    prepared = Path(os.path.abspath(prepared))
    if (prepared.parent != root or not OUTPUT_NAME.fullmatch(prepared.name)
            or prepared.name.endswith(('.', ' '))
            or prepared.name.split('.', 1)[0].upper() in RESERVED_OUTPUTS):
        raise ValueError('PREPARED_DIRECTORY_NOT_OWNED_PREVIEW_CHILD')
    _assert_no_reparse(prepared)
    if not prepared.is_dir():
        raise ValueError('PREPARED_DIRECTORY_MISSING')

    # Re-check the original ZIP, not just its potentially editable on-disk receipt.
    inspected = inspect(bundle)
    with zipfile.ZipFile(bundle) as outer:
        with zipfile.ZipFile(io.BytesIO(outer.read(BUNDLE_FILES[SOURCE]))) as inner:
            manifest_bytes = inner.read('NATIVE_WINDOWS_SOURCE_MANIFEST.json')
            manifest = json.loads(manifest_bytes)
        binary_rows = {}
        binaries = binary_entries(outer.namelist())
        for name, entry in binaries.items():
            data = outer.read(entry)
            binary_rows[name] = (len(data), hashlib.sha256(data).hexdigest())
    rows = manifest['files']
    if len({row['path'] for row in rows}) != len(rows):
        raise ValueError('SOURCE_DUPLICATE_INVENTORY')

    expected = {
        'PREPARATION_RECEIPT.json',
        'source/NATIVE_WINDOWS_SOURCE_MANIFEST.json',
        *('source/' + row['path'] for row in rows),
        *('bin/' + name for name in binary_rows),
    }
    actual = set()
    # Do not follow directory junctions or symlinks into foreign files.
    for parent, directories, filenames in os.walk(prepared, topdown=True, followlinks=False):
        for item in directories + filenames:
            current = Path(parent) / item
            info = current.lstat()
            if stat.S_ISLNK(info.st_mode) or (getattr(info, 'st_file_attributes', 0) & 0x400):
                raise ValueError('PREPARED_REPARSE_PATH_REFUSED')
            if item in filenames:
                if not stat.S_ISREG(info.st_mode):
                    raise ValueError('PREPARED_NONREGULAR_FILE_REFUSED')
                actual.add(current.relative_to(prepared).as_posix())
    if actual != expected:
        raise ValueError('PREPARED_INVENTORY_DRIFT')
    for row in rows:
        digest_file(prepared / 'source' / Path(*row['path'].split('/')), row['bytes'], row['sha256'])
    digest_file(prepared / 'source' / 'NATIVE_WINDOWS_SOURCE_MANIFEST.json',
                len(manifest_bytes), hashlib.sha256(manifest_bytes).hexdigest())
    for name, (size, sha) in binary_rows.items():
        digest_file(prepared / 'bin' / name, size, sha)

    receipt_file = prepared / 'PREPARATION_RECEIPT.json'
    if receipt_file.stat().st_size > 16 * 1024:
        raise ValueError('PREPARATION_RECEIPT_OVERSIZED')
    try:
        receipt = json.loads(receipt_file.read_text(encoding='utf-8'))
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError('PREPARATION_RECEIPT_INVALID') from exc
    expected_receipt = dict(inspected)
    expected_receipt['status'] = 'PREPARED_ONLY_NOT_STAGED_NOT_INSTALLED'
    expected_receipt['prepared_file_count'] = len(rows) + len(binary_rows) + 1
    if receipt != expected_receipt:
        raise ValueError('PREPARATION_RECEIPT_DRIFT')
    return {
        'schema': SCHEMA,
        'status': 'PREPARED_CONTENT_VERIFIED_NOT_INSTALLED',
        'option': 2,
        'bundle_sha256': inspected['bundle_sha256'],
        'source_sha256': inspected['source_sha256'],
        'verified_source_files': len(rows),
        'verified_native_binaries': len(binary_rows),
        'runtime_tested': False,
        'publisher_identity_verified': False,
        'installation_performed': False,
        'release_ready': False,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description='Verify a prepared Option 2 preview; does not install')
    parser.add_argument('--bundle', type=Path, required=True)
    parser.add_argument('--prepared', type=Path, required=True)
    parser.add_argument('--preview-root', type=Path, default=None,
                        help='Preview root that must own --prepared (defaults to the per-user preview root)')
    args = parser.parse_args()
    print(json.dumps(verify_prepared(args.bundle, args.prepared, preview_root=args.preview_root), indent=2, sort_keys=True))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
