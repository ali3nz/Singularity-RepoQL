#!/usr/bin/env python3
"""Create the *file payload* for Singularity RepoQL's Windows MSI.

The payload includes source and three actual compiled Windows binaries. It does
not register tasks, provision credentials or claim live Windows functionality.
Input ZIP is pinned to the variant-2 archive built by
native/windows/build_source_variants.py from the rc-fleet893 tree. That
archive carries regenerated SHA256SUMS and
NATIVE_WINDOWS_SOURCE_MANIFEST.json, and it never touches Drive.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import sys
import zipfile

SOURCE_SHA256 = 'f47d9de7d53027895bfe9b47be3ab32095b4d74d4cbe447b83ad7f5d8b31fb34'
REQUIRED_BINARIES = {
    'singularity-desktop-bridge.exe': 'bridge',
    'singularity-windows-supervisor.exe': 'supervisor',
    'unified-repoql-control.exe': 'gateway',
    'kanzo_board_audit.exe': 'kanzo_audit',
}
MAX_UNPACKED = 96 * 1024 * 1024
WIN_FORBIDDEN = set('<>:"|?*')
RESERVED = {'CON', 'PRN', 'AUX', 'NUL', 'CONIN$', 'CONOUT$'} | {
    f'{prefix}{n}' for prefix in ('COM', 'LPT') for n in range(1, 10)
}


def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def validate_name(name: str) -> None:
    if not name or name.startswith('/') or '\\' in name or name.endswith('/'):
        raise ValueError('UNSAFE_ARCHIVE_MEMBER')
    if len(name) > 240:
        raise ValueError('WINDOWS_LONG_PATH_REFUSED')
    for part in name.split('/'):
        if (not part or part in {'.', '..'} or part[-1] in {' ', '.'}
                or len(part) > 200 or any(x in WIN_FORBIDDEN or ord(x) < 32 for x in part)
                or part.split('.', 1)[0].upper() in RESERVED):
            raise ValueError('UNSAFE_WINDOWS_FILENAME')


def safe_extract(archive: Path, destination: Path) -> int:
    if digest(archive) != SOURCE_SHA256:
        raise ValueError('SOURCE_ARCHIVE_SHA256_MISMATCH')
    seen = set()
    total = 0
    with zipfile.ZipFile(archive) as z:
        if z.testzip() is not None:
            raise ValueError('BAD_ZIP_CRC')
        entries = z.infolist()
        for member in entries:
            validate_name(member.filename)
            folded = member.filename.casefold()
            if folded in seen:
                raise ValueError('CASE_INSENSITIVE_COLLISION')
            seen.add(folded)
            if member.flag_bits & 1 or member.compress_type not in (zipfile.ZIP_DEFLATED, zipfile.ZIP_STORED):
                raise ValueError('ENCRYPTED_OR_UNKNOWN_COMPRESSION')
            if stat.S_IFMT(member.external_attr >> 16) == stat.S_IFLNK:
                raise ValueError('SYMLINK_IN_SOURCE_ARCHIVE')
            total += member.file_size
            if total > MAX_UNPACKED:
                raise ValueError('SOURCE_SIZE_LIMIT_EXCEEDED')
        for member in entries:
            target = destination.joinpath(*member.filename.split('/'))
            target.parent.mkdir(parents=True, exist_ok=True)
            with z.open(member) as incoming, target.open('xb') as outgoing:
                shutil.copyfileobj(incoming, outgoing)
    return len(entries)


def assert_pe(path: Path) -> None:
    if not path.is_file() or path.stat().st_size < 20_000:
        raise ValueError(f'WINDOWS_BINARY_MISSING_OR_TOO_SMALL: {path.name}')
    with path.open('rb') as f:
        if f.read(2) != b'MZ':
            raise ValueError(f'WINDOWS_PE_HEADER_MISSING: {path.name}')


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument('--source-zip', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--bridge', type=Path, required=True)
    p.add_argument('--supervisor', type=Path, required=True)
    p.add_argument('--gateway', type=Path, required=True)
    p.add_argument('--kanzo-audit', type=Path, required=True)
    a = p.parse_args()
    inputs = {k: getattr(a, v) for k, v in REQUIRED_BINARIES.items()}
    for path in inputs.values():
        assert_pe(path)
    if a.output.exists():
        raise ValueError('OUTPUT_DIRECTORY_ALREADY_EXISTS')
    a.output.mkdir(parents=True)
    try:
        source = a.output / 'source'
        source.mkdir()
        source_count = safe_extract(a.source_zip, source)
        target_bin = a.output / 'bin'
        target_bin.mkdir()
        bin_hashes = {}
        for filename, path in inputs.items():
            shutil.copy2(path, target_bin / filename)
            bin_hashes[filename] = digest(target_bin / filename)
        launch = Path(__file__).with_name('Start-Here.ps1')
        shutil.copy2(launch, a.output / launch.name)
        guidance = Path(__file__).with_name('README-MSI.md')
        shutil.copy2(guidance, a.output / guidance.name)
        # The bootstrapper's Launch button opens this interactive, current-user
        # wizard. No key values are passed through MSI properties or Burn logs.
        for name in ('Configure-Singularity.ps1', 'Configure-Singularity.cmd', 'Readiness.ps1',
                     'Start-Singularity.ps1'):
            shutil.copy2(Path(__file__).with_name(name), a.output / name)
        result = {'schema': 'singularity-msi-payload/1', 'source_zip_sha256': SOURCE_SHA256,
                  'source_file_count': source_count, 'binary_sha256': bin_hashes,
                  'scope': 'payload-files-only', 'native_runtime_accepted': False}
        (a.output / 'INSTALLER-PAYLOAD-RECEIPT.json').write_text(
            json.dumps(result, indent=2, sort_keys=True) + '\n', encoding='utf-8')
        print(json.dumps(result, indent=2))
    except BaseException:
        shutil.rmtree(a.output)
        raise
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
