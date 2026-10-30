#!/usr/bin/env python3
"""Read-only native Windows *runtime observation*, not full product parity.

Requires a Windows host for CLI execution. Does not spawn managed services,
install packages, send credentials, mutate GUI state, or synthesize successful
feature receipts. Real functional tests remain independent release gates.

The configuration is intentionally data-only and includes neither URLs nor
arbitrary commands: probes connect only to IPv4 loopback and use a fixed GET.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import http.client
import json
import ntpath
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
from typing import Any

from repoql_compat import REQUIRED_VERSION, parse_version

SCHEMA = 'singularity-windows-runtime-observation-config/v1'
REPORT_SCHEMA = 'singularity-windows-runtime-observation/v1'
HEALTH_PATH = '/.well-known/singularity-health'
COMPONENT_IDS = frozenset({
    'dashboard', 'rust-harness-authority', 'desktop-bridge', 'tencent-memorycore',
    'kanzo', 'agent-chat', 'memory-graph', 'ghost', 'claude-office', 'self-learning',
})
FILE_IDS = frozenset({'repoql', 'bridge', 'supervisor', 'gui'})
_ID_RE = re.compile(r'^[a-z][a-z0-9-]{0,63}$')


def _local_windows_path(value: Any) -> bool:
    if not isinstance(value, str) or not value or len(value) > 500 or '\x00' in value:
        return False
    drive, tail = ntpath.splitdrive(value)
    if not re.fullmatch(r'[A-Za-z]:', drive) or not tail.startswith('\\'):
        return False
    if any(x in ('.', '..') for x in value.replace('/', '\\').split('\\')):
        return False
    if '/' in value or any(x in value for x in ('\r', '\n')):
        return False
    for segment in tail.split('\\'):
        if not segment:
            continue
        if any(ord(ch) < 32 or ch in '<>:"|?*' for ch in segment) or segment.endswith((' ', '.')):
            return False
        stem = segment.split('.', 1)[0].upper()
        if stem in ('CON', 'PRN', 'AUX', 'NUL', 'CONIN$', 'CONOUT$') or re.fullmatch(r'(COM|LPT)[1-9]', stem):
            return False
    return ntpath.normpath(value) == value


def validate(config: Any) -> None:
    if not isinstance(config, dict) or set(config) != {'schema', 'variant', 'repoql_version', 'files', 'health'}:
        raise ValueError('INVALID_CONFIG_FIELDS')
    if config['schema'] != SCHEMA or type(config['variant']) is not int or config['variant'] not in (1, 2, 3, 4):
        raise ValueError('INVALID_SCHEMA_OR_VARIANT')
    if config['repoql_version'] != REQUIRED_VERSION:
        raise ValueError('INVALID_REPOQL_PIN')
    files = config['files']
    if not isinstance(files, dict) or set(files) != FILE_IDS:
        raise ValueError('INVALID_BINARY_INVENTORY')
    expected_names = {
        'repoql': 'rql.exe', 'bridge': 'singularity-desktop-bridge.exe',
        'supervisor': 'singularity-windows-supervisor.exe',
    }
    for name, location in files.items():
        if not _local_windows_path(location) or not location.lower().endswith('.exe'):
            raise ValueError(f'INVALID_LOCAL_WINDOWS_BINARY:{name}')
        basename = ntpath.basename(location).lower()
        if name in expected_names and basename != expected_names[name]:
            raise ValueError(f'UNEXPECTED_EXECUTABLE_IDENTITY:{name}')
        if basename in ('wsl.exe', 'docker.exe', 'bash.exe', 'cmd.exe', 'powershell.exe'):
            raise ValueError(f'FORBIDDEN_RUNTIME_WRAPPER:{name}')
    health = config['health']
    if not isinstance(health, list) or len(health) > 12:
        raise ValueError('INVALID_HEALTH_INVENTORY')
    seen_ids, seen_ports = set(), set()
    for check in health:
        if not isinstance(check, dict) or set(check) != {'id', 'port'}:
            raise ValueError('INVALID_HEALTH_FIELDS')
        component, port = check['id'], check['port']
        if not isinstance(component, str) or not _ID_RE.fullmatch(component) or component not in COMPONENT_IDS:
            raise ValueError('INVALID_COMPONENT_ID')
        if type(port) is not int or not (1 <= port <= 65535) or component in seen_ids or port in seen_ports:
            raise ValueError('INVALID_OR_DUPLICATE_HEALTH_PORT')
        if config['variant'] in (1, 3) and component in ('ghost', 'claude-office'):
            raise ValueError('OPTIONAL_SERVICE_FORBIDDEN_IN_LEAN_VARIANT')
        seen_ids.add(component)
        seen_ports.add(port)


def _no_reparse_existing(path: Path) -> bool:
    # A reparse point anywhere in the path breaks ownership of executable
    # identity. Avoid following it even when the final file exists.
    cursor = path
    while True:
        try:
            s = cursor.lstat()
        except OSError:
            return False
        if stat.S_ISLNK(s.st_mode) or (getattr(s, 'st_file_attributes', 0) & 0x400):
            return False
        if cursor.parent == cursor:
            break
        cursor = cursor.parent
    return path.is_file()


def _pe_header_valid(path: Path) -> bool:
    try:
        with path.open('rb') as f:
            if f.read(2) != b'MZ':
                return False
            f.seek(0x3c)
            offset = int.from_bytes(f.read(4), 'little')
            if offset < 64 or offset > 8 * 1024 * 1024:
                return False
            f.seek(offset)
            return f.read(4) == b'PE\0\0'
    except OSError:
        return False


def check_binary(path_str: str, *, windows_host: bool, allowed_version: str | None = None,
                 runner=subprocess.run) -> dict:
    result = {'status': 'BLOCKED', 'native_pe': False, 'actual_version': None}
    if not windows_host:
        result['reason'] = 'NOT_EXECUTED_ON_NATIVE_WINDOWS'
        return result
    path = Path(path_str)
    if not _local_windows_path(path_str) or not _no_reparse_existing(path) or not _pe_header_valid(path):
        result['reason'] = 'NATIVE_PE_OR_LOCAL_PATH_NOT_VERIFIED'
        return result
    result['native_pe'] = True
    # Never execute arbitrary configuration-provided command lines. Only the
    # well-known RepoQL --version probe is allowed; other binaries are not run.
    if allowed_version is None:
        result['status'] = 'OBSERVED_BINARY_ONLY'
        return result
    try:
        completed = runner([path_str, '--version'], capture_output=True, text=True,
                           timeout=5, check=False,
                           creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        banner = completed.stdout[:4096] if completed.returncode == 0 else ''
        version = parse_version(banner) if len(completed.stdout) <= 4096 else None
        result['actual_version'] = version
        result['status'] = 'OBSERVED_VERSION_MATCH' if version == allowed_version else 'BLOCKED'
        if version != allowed_version:
            result['reason'] = 'REPOQL_VERSION_MISMATCH_OR_AMBIGUOUS'
    except (OSError, ValueError, subprocess.TimeoutExpired):
        result['reason'] = 'REPOQL_VERSION_PROBE_FAILED'
    return result


def observe_health(component: str, port: int, *, connector=http.client.HTTPConnection) -> dict:
    # Explicit IPv4 loopback, no proxy, no ambient auth, no redirects. A valid
    # identity-shaped response is only a *reachability* observation, not proof
    # that the expected child owns the port or its full feature set works.
    result = {'status': 'BLOCKED', 'evidence': 'IDENTITY_HEADER_ONLY'}
    conn = None
    try:
        conn = connector('127.0.0.1', port, timeout=2)
        conn.request('GET', HEALTH_PATH, headers={'Host': '127.0.0.1', 'Connection': 'close'})
        reply = conn.getresponse()
        headers = reply.getheaders()
        ids = [v for k, v in headers if k.lower() == 'x-singularity-component']
        # Refuse redirects, duplicate identity headers, unbounded replies,
        # and a response which only mimics status 200.
        length = reply.getheader('Content-Length')
        if reply.status == 200 and ids == [component] and (length is None or (length.isdecimal() and int(length) <= 4096)):
            body = reply.read(4097)
            if len(body) <= 4096:
                result['status'] = 'OBSERVED_IDENTITY_SHAPED_HTTP'
    except (OSError, ValueError, http.client.HTTPException, TimeoutError):
        result['reason'] = 'LOOPBACK_HEALTH_UNAVAILABLE'
    finally:
        if conn is not None:
            conn.close()
    return result


def observe(config: dict, *, windows_host: bool | None = None, binary_checker=check_binary,
            health_checker=observe_health, now=None) -> dict:
    validate(config)
    windows_host = os.name == 'nt' if windows_host is None else windows_host
    observed = (now or datetime.now(timezone.utc)).isoformat()
    bins = {key: binary_checker(value, windows_host=windows_host, allowed_version=REQUIRED_VERSION if key == 'repoql' else None)
            for key, value in config['files'].items()}
    endpoints = {row['id']: (health_checker(row['id'], row['port']) if windows_host
                              else {'status': 'BLOCKED', 'reason': 'NOT_EXECUTED_ON_NATIVE_WINDOWS'})
                 for row in config['health']}
    return {
        'schema': REPORT_SCHEMA, 'observed_at': observed, 'platform': 'native-windows' if windows_host else 'non-windows',
        'variant': config['variant'], 'repoql_required_version': REQUIRED_VERSION,
        'binary_observations': bins, 'service_observations': endpoints,
        'feature_receipts_generated': [], 'behavioral_parity_verified': False,
        'installer_verified': False, 'runtime_dependency_closure_verified': False,
        'public_release_ready': False,
        'note': 'Read-only observations are never functional, security, or production-parity certificates.',
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description='Read-only Singularity native Windows runtime probe (not release approval)')
    parser.add_argument('--config', required=True, type=Path)
    parser.add_argument('--output', type=Path, help='Report path; will refuse an existing file')
    args = parser.parse_args(argv)
    if os.name != 'nt':
        parser.error('NATIVE_WINDOWS_REQUIRED: refusing to generate fake Windows observations')
    try:
        config_bytes = args.config.read_bytes()
        if len(config_bytes) > 64 * 1024:
            raise ValueError('CONFIG_TOO_LARGE')
        config = json.loads(config_bytes)
        report = observe(config)
        value = json.dumps(report, indent=2) + '\n'
        if args.output:
            with args.output.open('x', encoding='utf-8') as f:
                f.write(value)
        else:
            print(value)
        return 0 if report['binary_observations']['repoql']['status'] == 'OBSERVED_VERSION_MATCH' else 2
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        parser.error(f'CONFIG_OR_OUTPUT_REFUSED:{type(exc).__name__}')


if __name__ == '__main__':
    raise SystemExit(main())
