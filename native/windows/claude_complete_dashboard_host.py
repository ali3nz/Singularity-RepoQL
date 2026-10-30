#!/usr/bin/env python3
"""Launch the staged dashboard with explicit native-Windows identity and scope.

No shell, implicit downloads, credential arguments or global environment writes.
The dashboard itself enforces native RepoQL 1.7.18 and the fetch/render
connector contract before issuing a capability or binding the loopback server.
"""
from __future__ import annotations
import argparse
import base64
import json
import os
from pathlib import Path
import stat
import sys
from urllib.parse import urlsplit

sys.dont_write_bytecode = True
os.environ['PYTHONDONTWRITEBYTECODE'] = '1'


def _assert_no_reparse(path: Path) -> None:
    reparse_flag = getattr(stat, 'FILE_ATTRIBUTE_REPARSE_POINT', 0x400)
    for candidate in (path, *path.parents):
        try:
            info = candidate.lstat()
        except FileNotFoundError:
            continue
        if candidate.is_symlink() or getattr(info, 'st_file_attributes', 0) & reparse_flag:
            raise ValueError('DASHBOARD_REPARSE_PATH_REFUSED')


def _native_ghost_environment(source_root: Path, state_dir: Path,
                              bridge_exe: Path | None, ghost_control_config: Path | None,
                              *, windows: bool) -> dict[str, str]:
    if not windows or bridge_exe is None or ghost_control_config is None:
        raise ValueError('DASHBOARD_NATIVE_GHOST_CONFIG_REQUIRED')
    if not bridge_exe.is_absolute() or bridge_exe.name.lower() != 'singularity-desktop-bridge.exe':
        raise ValueError('DASHBOARD_NATIVE_BRIDGE_INVALID')
    expected_bridge = source_root.parent / 'bin' / 'singularity-desktop-bridge.exe'
    if os.path.normcase(os.path.abspath(bridge_exe)) != os.path.normcase(os.path.abspath(expected_bridge)):
        raise ValueError('DASHBOARD_NATIVE_BRIDGE_NOT_FROM_STAGE')
    if not ghost_control_config.is_absolute() or ghost_control_config.name.lower() != 'native-bridge-client.json':
        raise ValueError('DASHBOARD_GHOST_CONFIG_INVALID')
    expected_config = state_dir.parent / 'GhostScheduler' / 'native-bridge-client.json'
    if os.path.normcase(os.path.abspath(ghost_control_config)) != os.path.normcase(os.path.abspath(expected_config)):
        raise ValueError('DASHBOARD_GHOST_CONFIG_OUTSIDE_PRIVATE_ROOT')
    _assert_no_reparse(bridge_exe)
    _assert_no_reparse(ghost_control_config)
    if not bridge_exe.is_file() or not ghost_control_config.is_file() or ghost_control_config.stat().st_size > 4096:
        raise ValueError('DASHBOARD_NATIVE_GHOST_DEPENDENCY_MISSING')
    try:
        def unique_object(pairs):
            result = {}
            for key, value in pairs:
                if key in result:
                    raise ValueError('DASHBOARD_GHOST_CONFIG_DUPLICATE_FIELD')
                result[key] = value
            return result
        config = json.loads(ghost_control_config.read_text(encoding='utf-8'), object_pairs_hook=unique_object)
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError):
        raise ValueError('DASHBOARD_GHOST_CONFIG_INVALID') from None
    if not isinstance(config, dict) or set(config) != {'endpoint', 'controlKey'}:
        raise ValueError('DASHBOARD_GHOST_CONFIG_INVALID')
    endpoint = config.get('endpoint')
    key = config.get('controlKey')
    if not isinstance(endpoint, str) or not isinstance(key, str) or not key or len(key) > 1024 or any(ord(c) < 32 for c in key):
        raise ValueError('DASHBOARD_GHOST_CONFIG_INVALID')
    try:
        parsed = urlsplit(endpoint)
        port = parsed.port
    except ValueError:
        raise ValueError('DASHBOARD_GHOST_CONFIG_INVALID') from None
    if (parsed.scheme != 'http' or parsed.hostname != '127.0.0.1' or parsed.username is not None or
            parsed.password is not None or parsed.path not in ('', '/') or parsed.query or parsed.fragment or
            port is None or not 1024 <= port <= 65535):
        raise ValueError('DASHBOARD_GHOST_CONFIG_INVALID')
    try:
        decoded = base64.b64decode(key, validate=True)
    except ValueError:
        raise ValueError('DASHBOARD_GHOST_CONFIG_INVALID') from None
    if len(decoded) != 48 or base64.b64encode(decoded).decode('ascii') != key:
        raise ValueError('DASHBOARD_GHOST_CONFIG_INVALID')
    return {
        'SINGULARITY_NATIVE_BRIDGE_EXE': str(bridge_exe),
        'SINGULARITY_GHOST_CONTROL_CONFIG': str(ghost_control_config),
    }


def environment(source_root: Path, rql: Path, workspace: Path, state_dir: Path, port: int, *, variant=2, windows=True,
                native_bridge_exe: Path | None = None, ghost_control_config: Path | None = None):
    paths=(source_root,rql,workspace,state_dir)
    if not windows or not all(p.is_absolute() for p in paths):
        raise ValueError('NATIVE_WINDOWS_ABSOLUTE_PATH_REQUIRED')
    if not (1024 <= port <= 65535):
        raise ValueError('DASHBOARD_PORT_INVALID')
    if type(variant) is not int or variant not in (1, 2, 3, 4):
        raise ValueError('DASHBOARD_VARIANT_INVALID')
    if any(p.is_symlink() for p in paths):
        raise ValueError('DASHBOARD_REPARSE_PATH_REFUSED')
    if not (source_root/'dashboard/server.py').is_file() or not (source_root/'connectors/memorycore/manifest.yaml').is_file() or not (source_root/'connectors/kanzo/manifest.yaml').is_file():
        raise ValueError('DASHBOARD_OR_CONNECTOR_SOURCE_MISSING')
    if rql.name.lower()!='rql.exe' or not rql.is_file() or not workspace.is_dir() or not state_dir.is_dir():
        raise ValueError('DASHBOARD_DEPENDENCY_MISSING')
    env = {
        'SINGULARITY_WINDOWS_NATIVE':'1',
        'PYTHONDONTWRITEBYTECODE':'1',
        'SINGULARITY_INSTALL_VARIANT':str(variant),
        'SINGULARITY_WORKSPACE':str(workspace),
        'SINGULARITY_RQL_BIN':str(rql),
        'SINGULARITY_RQL_EXE':str(rql),
        'SINGULARITY_STATE_DIR':str(state_dir),
        'SINGULARITY_BIND':'127.0.0.1',
        'SINGULARITY_ALLOW_PEERS':'127.0.0.1/32,::1/128',
        'SINGULARITY_PORT':str(port),
    }
    if variant in (2,4):
        env.update(_native_ghost_environment(source_root,state_dir,native_bridge_exe,ghost_control_config,windows=windows))
    elif native_bridge_exe is not None or ghost_control_config is not None:
        raise ValueError('DASHBOARD_NATIVE_GHOST_CONFIG_NOT_ALLOWED')
    return env


def main(argv=None):
    p=argparse.ArgumentParser(description='Native Claude Code Complete dashboard launch')
    for arg in ('source-root','rql-exe','workspace','state-dir'):
        p.add_argument('--'+arg,required=True,type=Path)
    p.add_argument('--port',type=int,default=18100)
    p.add_argument('--variant',type=int,choices=(1,2,3,4),default=2)
    p.add_argument('--native-bridge-exe',type=Path)
    p.add_argument('--ghost-control-config',type=Path)
    p.add_argument('--mode',choices=('serve','check'),default='serve')
    a=p.parse_args(argv)
    env=environment(a.source_root,a.rql_exe,a.workspace,a.state_dir,a.port,variant=a.variant,windows=(os.name=='nt'),
                    native_bridge_exe=a.native_bridge_exe,ghost_control_config=a.ghost_control_config)
    os.environ.update(env)
    # Import only from the verified staged dashboard path, not from PATH or cwd.
    sys.path.insert(0,str(a.source_root/'dashboard'))
    import server
    return server.main(['--config',str(a.source_root/'dashboard'/'config.example.json'),a.mode])


if __name__=='__main__':
    try:
        raise SystemExit(main())
    except (ValueError, OSError) as exc:
        print('DASHBOARD_LAUNCH_REFUSED: '+str(exc),file=sys.stderr)
        raise SystemExit(2)
