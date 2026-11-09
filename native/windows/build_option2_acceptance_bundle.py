#!/usr/bin/env python3
"""Assemble a Windows-compiled, Option 2 *acceptance candidate* from verified inputs.

This tool does NOT install software, start services, prove GUI compatibility, or
assert runtime parity. It refuses production assembly off native Windows.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import stat
import struct
import zipfile

from scan_source_archive import scan

SCHEMA = 'singularity-option2-windows-acceptance-bundle/v1'
DATE = (2026, 1, 1, 0, 0, 0)
MAX_BINARY = 100 * 1024 * 1024
BRIDGE = 'singularity-desktop-bridge.exe'
SUPERVISOR = 'singularity-windows-supervisor.exe'
SOURCE = 'singularity-native-windows-option2-SOURCE-ONLY.zip'
BOOTSTRAP_SOURCES = (
    'native/windows/prepare_option2_candidate.py',
    'native/windows/verify_prepared_option2_candidate.py',
    'native/windows/build_option2_acceptance_bundle.py',
    'native/windows/scan_source_archive.py',
    'native/windows/windows_source_policy.py',
)
BUNDLE_FILES = {
    BRIDGE: 'bin/' + BRIDGE,
    SUPERVISOR: 'bin/' + SUPERVISOR,
    SOURCE: 'source/' + SOURCE,
    **{name: 'bootstrap/' + name.rsplit('/', 1)[1] for name in BOOTSTRAP_SOURCES},
}



def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def check_local_file(path: Path, *, max_bytes: int) -> bytes:
    # Do not follow symlinks in an input path, including parent segments.
    path = Path(os.path.abspath(path))
    cursor = path
    while True:
        try:
            info = cursor.lstat()
        except OSError as exc:
            raise ValueError('INPUT_MISSING') from exc
        if stat.S_ISLNK(info.st_mode) or (getattr(info, 'st_file_attributes', 0) & 0x400):
            raise ValueError('INPUT_REPARSE_REFUSED')
        if cursor == path and not stat.S_ISREG(info.st_mode):
            raise ValueError('INPUT_NOT_REGULAR_FILE')
        if cursor.parent == cursor:
            break
        cursor = cursor.parent
    if not 1 <= path.stat().st_size <= max_bytes:
        raise ValueError('INPUT_SIZE_OUT_OF_BOUNDS')
    return path.read_bytes()


def validate_amd64_pe(data: bytes) -> None:
    # Structural identity check only; a PE header alone is not authenticity.
    if len(data) < 128 or data[:2] != b'MZ':
        raise ValueError('NOT_NATIVE_WINDOWS_PE')
    off = struct.unpack_from('<I', data, 0x3c)[0]
    if off < 64 or off + 24 > len(data) or data[off:off+4] != b'PE\0\0':
        raise ValueError('NOT_NATIVE_WINDOWS_PE')
    machine = struct.unpack_from('<H', data, off + 4)[0]
    if machine != 0x8664:  # x86_64-pc-windows-msvc
        raise ValueError('NOT_AMD64_PE')


def assemble(source_zip: Path, bridge_exe: Path, supervisor_exe: Path, output: Path,
             *, native_windows: bool | None = None, commit: str | None = None) -> dict:
    if native_windows is None:
        native_windows = os.name == 'nt'
    if not native_windows:
        raise ValueError('NATIVE_WINDOWS_BUILD_REQUIRED')
    if output.exists() or output.is_symlink():
        raise ValueError('OUTPUT_EXISTS_REFUSED')
    if commit is not None and not re.fullmatch(r'[0-9a-fA-F]{40}', commit):
        raise ValueError('INVALID_COMMIT_ID')
    expected = {BRIDGE: bridge_exe, SUPERVISOR: supervisor_exe, SOURCE: source_zip}
    if any(Path(p).name != name for name, p in expected.items()):
        raise ValueError('UNEXPECTED_INPUT_FILENAME')
    inputs = {
        BRIDGE: check_local_file(bridge_exe, max_bytes=MAX_BINARY),
        SUPERVISOR: check_local_file(supervisor_exe, max_bytes=MAX_BINARY),
        SOURCE: check_local_file(source_zip, max_bytes=96 * 1024 * 1024),
    }
    for key in (BRIDGE, SUPERVISOR):
        validate_amd64_pe(inputs[key])
    scanned = scan(io.BytesIO(inputs[SOURCE]))
    if not scanned.get('ok') or scanned.get('variant') != 2 or scanned.get('release_ready') is not False:
        raise ValueError('SOURCE_ARCHIVE_NOT_OPTION2_SOURCE_ONLY')
    # Explicit validation independent of a permissive future scanner.
    with zipfile.ZipFile(io.BytesIO(inputs[SOURCE])) as z:
        manifest = json.loads(z.read('NATIVE_WINDOWS_SOURCE_MANIFEST.json'))
    if (manifest.get('schema') != 1 or manifest.get('variant') != 2 or
        manifest.get('gui') != 'claude-desktop-code' or
        manifest.get('release_status') != 'SOURCE_ONLY_UNCOMPILED_NOT_INSTALLER' or
        manifest.get('repoql', {}).get('requiredVersion') != '1.7.18' or
        manifest.get('repoql', {}).get('connectorContract') != 'fetch-render' or
        'connectorAbi' in manifest.get('repoql', {}) or
        manifest.get('features', {}).get('office') is not True or
        manifest.get('features', {}).get('ghost') is not False):
        raise ValueError('SOURCE_OPTION2_PIN_OR_FEATURE_MISMATCH')
    # Bootstrap helpers are byte-identical copies from the already verified
    # nested source. The candidate is therefore usable after extracting only
    # the outer ZIP, without requiring an independent source checkout.
    with zipfile.ZipFile(io.BytesIO(inputs[SOURCE])) as nested:
        for name in BOOTSTRAP_SOURCES:
            inputs[name] = nested.read(name)
    entries = [{
        'path': BUNDLE_FILES[name], 'sha256': sha256(inputs[name]), 'bytes': len(inputs[name])
    } for name in sorted(inputs)]
    receipt = {
        'schema': SCHEMA,
        'product': 'Claude Code Complete Option 2',
        'platform': 'windows-amd64',
        'source_profile': 2,
        'source_manifest_release_status': 'SOURCE_ONLY_UNCOMPILED_NOT_INSTALLER',
        'repoql_required_version': '1.7.18',
        'repoql_binary_included': False,
        'claude_desktop_binary_included': False,
        'office_runtime_included': False,
        'ghost_runtime_verified': False,
        'installer_included': False,
        'installation_performed': False,
        'native_gui_accepted': False,
        'runtime_behavior_verified': False,
        'production_release_ready': False,
        'git_commit': commit.lower() if commit else None,
        'files': entries,
    }
    metadata = (json.dumps(receipt, indent=2, sort_keys=True) + '\n').encode('utf-8')
    output.parent.mkdir(parents=True, exist_ok=True)
    # ZIP deterministic: no ambient timestamps, attributes or unspecified files.
    try:
        with zipfile.ZipFile(output, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=7) as z:
            for name in sorted(inputs):
                zi = zipfile.ZipInfo(BUNDLE_FILES[name], DATE)
                zi.compress_type = zipfile.ZIP_DEFLATED
                zi.external_attr = 0o644 << 16
                z.writestr(zi, inputs[name])
            zi = zipfile.ZipInfo('ACCEPTANCE_BUNDLE_MANIFEST.json', DATE)
            zi.compress_type = zipfile.ZIP_DEFLATED
            zi.external_attr = 0o644 << 16
            z.writestr(zi, metadata)
        check_acceptance_bundle(output)
    except BaseException:
        output.unlink(missing_ok=True)
        raise
    return {'status': 'WINDOWS_ACCEPTANCE_CANDIDATE_NOT_INSTALLER', 'sha256': sha256(output.read_bytes()),
            'bytes': output.stat().st_size, 'files': len(entries), 'release_ready': False}


def check_acceptance_bundle(path: Path) -> dict:
    with zipfile.ZipFile(path) as z:
        names = z.namelist()
        expected_names = set(BUNDLE_FILES.values()) | {'ACCEPTANCE_BUNDLE_MANIFEST.json'}
        if len(names) != len(expected_names) or set(names) != expected_names or z.testzip() is not None:
            raise ValueError('BUNDLE_ENTRIES_INVALID')
        receipt = json.loads(z.read('ACCEPTANCE_BUNDLE_MANIFEST.json'))
        if (receipt.get('schema') != SCHEMA or receipt.get('source_profile') != 2 or
            receipt.get('repoql_required_version') != '1.7.18' or
            receipt.get('production_release_ready') is not False or
            receipt.get('installer_included') is not False):
            raise ValueError('BUNDLE_RECEIPT_INVALID')
        files = receipt.get('files')
        if not isinstance(files, list) or len(files) != len(BUNDLE_FILES):
            raise ValueError('BUNDLE_RECEIPT_INVALID')
        mapped = {row['path']: row for row in files}
        if set(mapped) != set(BUNDLE_FILES.values()):
            raise ValueError('BUNDLE_FILE_INVENTORY_INVALID')
        for name in sorted(mapped):
            data = z.read(name)
            if len(data) != mapped[name]['bytes'] or sha256(data) != mapped[name]['sha256']:
                raise ValueError('BUNDLE_DIGEST_MISMATCH')
        for name in (BRIDGE, SUPERVISOR):
            validate_amd64_pe(z.read(BUNDLE_FILES[name]))
        nested = scan(io.BytesIO(z.read(BUNDLE_FILES[SOURCE])))
        if not nested.get("ok") or nested.get("variant") != 2:
            raise ValueError("BUNDLED_SOURCE_INVALID")
        with zipfile.ZipFile(io.BytesIO(z.read(BUNDLE_FILES[SOURCE]))) as source:
            for name in BOOTSTRAP_SOURCES:
                if z.read(BUNDLE_FILES[name]) != source.read(name):
                    raise ValueError('BOOTSTRAP_SOURCE_DRIFT')
    return {'ok': True, 'source_profile': 2, 'production_release_ready': False}


def main() -> int:
    p = argparse.ArgumentParser(description='Native Windows Option 2 acceptance candidate assembler; NOT installer')
    p.add_argument('--source', type=Path, required=True)
    p.add_argument('--bridge', type=Path, required=True)
    p.add_argument('--supervisor', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--commit', help='Optional 40-hex-digit repository commit')
    args = p.parse_args()
    result = assemble(args.source, args.bridge, args.supervisor, args.output, commit=args.commit)
    print(json.dumps(result, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
