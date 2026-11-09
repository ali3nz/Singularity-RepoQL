#!/usr/bin/env python3
"""Fail-closed SOURCE-only ZIP gate for Windows options 1..4.

Does not imply an installable or tested Windows binary. Never extracts archive.
"""
import argparse
import hashlib
import json
import zipfile

from windows_source_policy import linux_deployment_asset, windows_ghost_source

FORBIDDEN_SUFFIXES = ('.db', '.sqlite', '.sqlite3', '.key', '.pem', '.pfx', '.p12', '.log', '.kdbx')
FORBIDDEN_SEGMENTS = {'node_modules', '__pycache__', '.git', 'secrets', '.venv', 'runs'}
WINDOWS_RESERVED_BASES = {'CON', 'PRN', 'AUX', 'NUL', 'CONIN$', 'CONOUT$'} | {
    f'{prefix}{n}' for prefix in ('COM', 'LPT') for n in range(1, 10)
}
WINDOWS_FORBIDDEN = set('<>:"|?*')
MAX_UNPACKED_BYTES = 96 * 1024 * 1024


def windows_safe_member(name: str) -> bool:
    """Refuse archive paths that have alternate meaning on Windows/NTFS."""
    if not name or len(name) > 240 or name.startswith('/') or '\\' in name:
        return False
    for part in name.split('/'):
        if (not part or part in ('.', '..') or len(part) > 200
                or part[-1] in '. ' or any(ord(c) < 32 or c in WINDOWS_FORBIDDEN for c in part)):
            return False
        if part.split('.', 1)[0].upper() in WINDOWS_RESERVED_BASES:
            return False
    return True


OPTIONAL_MODULES = {
    'office': ('office/', 'openchamber/plugins/product-office/', 'native/desktop-bridge/src/office.rs',
               'dashboard/office_bridge.py', 'native/gui-plugins/openchamber/singularity-office.mjs'),
}


def scan(path):
    issues = []
    with zipfile.ZipFile(path) as z:
        all_names = z.namelist()
        seen = set()
        folded = set()
        unpacked = 0
        for name in all_names:
            # Don't normalize through PurePosixPath before checking: it
            # silently discards `.` segments and doubled slashes.
            parts = name.split('/')
            folded_name = name.casefold()
            if not windows_safe_member(name) or name in seen or folded_name in folded or name.endswith('/'):
                issues.append('invalid Windows member, reserved name or case-insensitive collision')
            if (not name or name.startswith('/') or '\\' in name or '.' in parts or '..' in parts
                    or '' in parts or ':' in name or name in seen or name.endswith('/')):
                issues.append('invalid or duplicate archive member')
            seen.add(name)
            folded.add(folded_name)
            if any(part.lower() in FORBIDDEN_SEGMENTS for part in parts):
                issues.append('forbidden runtime directory')
            if name.lower().endswith(FORBIDDEN_SUFFIXES):
                issues.append('forbidden private/runtime file type')
            info = z.getinfo(name)
            unpacked += info.file_size
            if unpacked > MAX_UNPACKED_BYTES:
                issues.append('uncompressed source budget exceeded')
            if info.flag_bits & 1:
                issues.append('encrypted archive member forbidden')
            if info.compress_type not in (zipfile.ZIP_DEFLATED, zipfile.ZIP_STORED):
                issues.append('unsupported archive compression')
            if (info.external_attr >> 16) & 0o170000 == 0o120000:
                issues.append('symbolic link in source archive')
            if info.file_size > 16 * 1024 * 1024:
                issues.append('oversized source file')
        if z.testzip() is not None:
            issues.append('CRC error')
        if 'NATIVE_WINDOWS_SOURCE_MANIFEST.json' not in seen or 'SHA256SUMS' not in seen:
            return {'ok': False, 'issues': sorted(set(issues + ['missing manifest/checksums']))}
        manifest = json.loads(z.read('NATIVE_WINDOWS_SOURCE_MANIFEST.json'))
        variant = manifest.get('variant')
        if variant not in (1, 2, 3, 4) or manifest.get('release_status') != 'SOURCE_ONLY_UNCOMPILED_NOT_INSTALLER':
            issues.append('invalid source-only profile')
        if manifest.get('repoql', {}).get('requiredVersion') != '1.7.18':
            issues.append('RepoQL 1.7.18 pin missing')
        if (manifest.get('repoql', {}).get('connectorContract') != 'fetch-render'
                or 'connectorAbi' in manifest.get('repoql', {})):
            issues.append('current fetch/render connector contract missing')
        complete = variant in (2, 4)
        feature = manifest.get('features', {})
        if (feature.get('office') is not complete or feature.get('ghost') is not False
                or manifest.get('rustOfficeFeature') is not complete
                or manifest.get('rustGhostFeature') is not False):
            issues.append('variant feature leak')
        names = set(all_names) - {'NATIVE_WINDOWS_SOURCE_MANIFEST.json'}
        if any(windows_ghost_source(name) for name in names):
            issues.append('Ghost source leaked into Windows source package')
        if any(linux_deployment_asset(name) for name in names):
            issues.append('Linux/Docker deployment entrypoint in Windows source package')
        if manifest.get('no_wsl_required_for_intended_runtime') is True:
            issues.append('unsupported native Windows acceptance claim')
        if manifest.get('production_feature_parity') != 'UNVERIFIED':
            issues.append('unsupported production parity assertion')
        receipts = manifest.get('files')
        if not isinstance(receipts, list) or {row.get('path') for row in receipts} != names:
            issues.append('file manifest does not match the ZIP')
        else:
            for row in receipts:
                actual = hashlib.sha256(z.read(row['path'])).hexdigest()
                if row['sha256'] != actual or row['bytes'] != z.getinfo(row['path']).file_size:
                    issues.append('manifest SHA256 or size mismatch')
                    break
        sha_file = z.read('SHA256SUMS').decode('utf-8')
        sha_lines = [ln.split('  ', 1) for ln in sha_file.splitlines()]
        expected_sha_names = names - {'SHA256SUMS'}
        if not all(len(pair) == 2 for pair in sha_lines) or {pair[1] for pair in sha_lines} != expected_sha_names:
            issues.append('SHA256SUMS inventory mismatch')
        else:
            for digest, name in sha_lines:
                if hashlib.sha256(z.read(name)).hexdigest() != digest:
                    issues.append('SHA256SUMS digest mismatch')
                    break
        if not complete and any(n.startswith(OPTIONAL_MODULES['office']) for n in all_names):
            issues.append('optional Office module leaked into lean variant')
        for member in all_names:
            if member.lower().endswith(('.exe', '.dll', '.msi', '.msix')):
                issues.append('binary executable in source-only package')
                break
    return {'ok': not issues, 'issues': sorted(set(issues)), 'variant': variant,
            'count': len(all_names), 'release_ready': False}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('zip', nargs='+')
    args = parser.parse_args()
    results = {}
    for path in args.zip:
        try:
            results[path] = scan(path)
        except (OSError, ValueError, KeyError, zipfile.BadZipFile, json.JSONDecodeError) as exc:
            results[path] = {'ok': False, 'issues': [type(exc).__name__]}
    print(json.dumps(results, indent=2))
    return 0 if all(item['ok'] for item in results.values()) else 1


if __name__ == '__main__':
    raise SystemExit(main())
