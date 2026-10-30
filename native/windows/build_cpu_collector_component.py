#!/usr/bin/env python3
"""Emit a safe Rust-supervisor component for the optional Windows CPU collector.

This emits data for operator review; it never registers a task, installs Python,
changes a running supervisor, or runs arbitrary input. Source-only until the
Windows supervisor has been compiled and its process containment accepted.
"""
from __future__ import annotations

import argparse
import json
import ntpath
import re


_COMPONENT = 'windows-cpu-history'
_REJECT = set('<>"|?*')
_WIN_RESERVED = re.compile(r'^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$', re.I)


def local_win_file(value: str, basename: str | None = None) -> str:
    """Reject UNC, device namespaces, relative paths, ADS and unsafe segments.

    This checks *syntax* cross-platform, not on-disk Windows reparse points or ACLs.
    The Rust supervisor's preflight must revalidate the final installed files.
    """
    if not isinstance(value, str) or len(value) > 1024 or not value or '\x00' in value:
        raise ValueError('invalid absolute Windows file path')
    if '/' in value or any(ord(c) < 32 for c in value) or value.startswith('\\\\'):
        raise ValueError('non-local or malformed Windows file path')
    drive, tail = ntpath.splitdrive(value)
    if not re.fullmatch(r'[A-Za-z]:', drive) or not tail.startswith('\\'):
        raise ValueError('a local drive-absolute path is required')
    pieces = tail.split('\\')[1:]
    if not pieces or any(not p or p in ('.', '..') or p.endswith((' ', '.')) or ':' in p
                         or any(c in _REJECT for c in p) or _WIN_RESERVED.fullmatch(p)
                         for p in pieces):
        raise ValueError('unsafe Windows path component')
    result = drive.upper() + tail
    if basename and ntpath.basename(result).lower() != basename.lower():
        raise ValueError('unexpected executable or collector filename')
    return result


def make_component(*, variant: int, python_exe: str, dashboard_dir: str,
                   dashboard_config: str, bridge_exe: str, repoql_exe: str) -> dict:
    if type(variant) is not int or variant not in (1, 2, 3, 4):
        raise ValueError('exact Windows installation option 1..4 required')
    py = local_win_file(python_exe, 'python.exe')
    dashboard = local_win_file(dashboard_dir + '\\README.md')[:-len('\\README.md')]
    config = local_win_file(dashboard_config)
    bridge = local_win_file(bridge_exe, 'singularity-desktop-bridge.exe')
    repoql = local_win_file(repoql_exe, 'rql.exe')
    return {
        'id': _COMPONENT,
        'executable': py,
        'args': ['-E', '-s', '-B', dashboard + '\\native_cpu_history.py', '--config', config],
        'workingDir': dashboard,
        'env': {
            'SINGULARITY_WINDOWS_NATIVE': '1',
            'SINGULARITY_INSTALL_VARIANT': str(variant),
            'SINGULARITY_NATIVE_BRIDGE_EXE': bridge,
            'SINGULARITY_RQL_BIN': repoql,
        },
        # Collector has no HTTP server. Rust supervisor owns its process handle;
        # supervisor failure-on-exit replaces a misleading generic health port.
        'health': None,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description='Preview CPU collector component for native Rust supervisor')
    parser.add_argument('--variant', required=True, type=int)
    parser.add_argument('--python-exe', required=True)
    parser.add_argument('--dashboard-dir', required=True)
    parser.add_argument('--dashboard-config', required=True)
    parser.add_argument('--bridge-exe', required=True)
    parser.add_argument('--repoql-exe', required=True)
    args = parser.parse_args()
    try:
        component = make_component(variant=args.variant, python_exe=args.python_exe,
                                   dashboard_dir=args.dashboard_dir, dashboard_config=args.dashboard_config,
                                   bridge_exe=args.bridge_exe, repoql_exe=args.repoql_exe)
    except ValueError as exc:
        parser.error(str(exc))
    print(json.dumps({'releaseReady': False, 'requiresNativeWindowsPreflight': True,
                      'supervisorComponent': component}, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
