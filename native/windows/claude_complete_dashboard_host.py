#!/usr/bin/env python3
"""Launch the staged dashboard with explicit native-Windows identity and scope.

No shell, implicit downloads, credential arguments or global environment writes.
The dashboard itself enforces native RepoQL 1.7.18 and the fetch/render
connector contract before issuing a capability or binding the loopback server.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import re
import os
from pathlib import Path
import stat
import sys

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


def _native_office_environment(source_root: Path, state_dir: Path, runtime_root: Path | None = None) -> dict[str, str]:
    # Current installs keep Office beside Dashboard. Older installs placed it
    # below WindowsNative, so retain that layout only when no current receipt exists.
    dashboard_root = state_dir.parent if state_dir.name == 'Option4' else state_dir
    office_root = dashboard_root.parent / 'Office'
    receipt_path = office_root / 'office-install.json'
    try:
        _assert_no_reparse(receipt_path)
        if not receipt_path.is_file():
            office_root = (runtime_root or source_root.parent).parent / 'office'
            receipt_path = office_root / 'office-install.json'
        config_path = office_root / 'service' / 'service.json'
        _assert_no_reparse(receipt_path)
        _assert_no_reparse(config_path)
        receipt = json.loads(receipt_path.read_text(encoding='utf-8-sig'))
        config = json.loads(config_path.read_text(encoding='utf-8-sig'))
        port = config['port']
        if (receipt['schema'] != 'singularity-windows-office/v1'
                or Path(receipt['installRoot']) != office_root
                or type(port) is not int or not 1024 <= port <= 65535
                or type(receipt['port']) is not int or receipt['port'] != port):
            return {}
    except (OSError, UnicodeError, ValueError, TypeError, KeyError):
        return {}
    env = {
        'CLAUDE_OFFICE_HEALTH_HOST': '127.0.0.1',
        'CLAUDE_OFFICE_HEALTH_PORT': str(port),
        'SINGULARITY_OFFICE_HOST': '127.0.0.1',
        'SINGULARITY_OFFICE_PORT': str(port),
    }
    if not any(os.environ.get(name, '').strip() for name in (
            'SINGULARITY_OFFICE_NATIVE_AUTH_MODE', 'SINGULARITY_OFFICE_PANEL_KEY_FILE',
            'SINGULARITY_OFFICE_EMBED_URL', 'CLAUDE_OFFICE_EMBED_URL')):
        keys_path = office_root / 'state' / 'keys.json'
        try:
            _assert_no_reparse(keys_path)
            if keys_path.is_file():
                env.update(SINGULARITY_OFFICE_NATIVE_AUTH_MODE='service_keys',
                           SINGULARITY_OFFICE_PANEL_KEY_FILE=str(keys_path))
        except (OSError, ValueError):
            pass
    return env


def _verified_route_binary(source_root: Path, digest: str, *, name='singularity-dashboard-routes.exe') -> str:
    if not re.fullmatch(r'[0-9a-f]{64}', digest):
        raise ValueError('DASHBOARD_RUST_ROUTE_DIGEST_INVALID')
    binary = source_root.parent / 'bin' / name
    _assert_no_reparse(binary)
    if not binary.is_file() or not 1 <= binary.stat().st_size <= 100 * 1024 * 1024:
        raise ValueError('DASHBOARD_RUST_ROUTE_BINARY_INVALID')
    with binary.open('rb') as stream:
        actual = hashlib.sha256()
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            actual.update(chunk)
    if actual.hexdigest() != digest:
        raise ValueError('DASHBOARD_RUST_ROUTE_HASH_DRIFT')
    return str(binary)


def environment(source_root: Path, rql: Path, workspace: Path, state_dir: Path, port: int, *, variant=2, windows=True,
                native_bridge_exe: Path | None = None, ghost_control_config: Path | None = None,
                native_runtime_root: Path | None = None, rust_route_sha256: str | None = None,
                rust_listener_sha256: str | None = None, rust_unified_proxy_sha256: str | None = None):
    paths=(source_root,rql,workspace,state_dir)
    if not windows or not all(p.is_absolute() for p in paths):
        raise ValueError('NATIVE_WINDOWS_ABSOLUTE_PATH_REQUIRED')
    if not (1024 <= port <= 65535):
        raise ValueError('DASHBOARD_PORT_INVALID')
    if type(variant) is not int or variant not in (1, 2, 3, 4):
        raise ValueError('DASHBOARD_VARIANT_INVALID')
    if any(p.is_symlink() for p in paths):
        raise ValueError('DASHBOARD_REPARSE_PATH_REFUSED')
    runtime_root = source_root.parent
    if native_runtime_root is not None:
        local = os.environ.get('LOCALAPPDATA')
        if (not local or not native_runtime_root.is_absolute()
                or str(native_runtime_root).startswith('\\\\')):
            raise ValueError('DASHBOARD_RUNTIME_ROOT_INVALID')
        expected = Path(local) / 'Singularity' / 'WindowsNative' / 'current'
        if os.path.normcase(os.path.abspath(native_runtime_root)) != os.path.normcase(os.path.abspath(expected)):
            raise ValueError('DASHBOARD_RUNTIME_ROOT_INVALID')
        _assert_no_reparse(native_runtime_root)
        if not native_runtime_root.is_dir():
            raise ValueError('DASHBOARD_RUNTIME_ROOT_INVALID')
        runtime_root = native_runtime_root
    if not (source_root/'dashboard/server.py').is_file() or not (source_root/'dashboard/dashboard_route_policy.py').is_file() or not (source_root/'dashboard/native_listener.py').is_file() or not (source_root/'connectors/memorycore/manifest.yaml').is_file() or not (source_root/'connectors/kanzo/manifest.yaml').is_file():
        raise ValueError('DASHBOARD_OR_CONNECTOR_SOURCE_MISSING')
    if rql.name.lower()!='rql.exe' or not rql.is_file() or not workspace.is_dir() or not state_dir.is_dir():
        raise ValueError('DASHBOARD_DEPENDENCY_MISSING')
    env = {
        'SINGULARITY_WINDOWS_NATIVE':'1',
        'SINGULARITY_WINDOWS_OMB_PORT':'18211',
        'SINGULARITY_LOCAL_ACCOUNT_AUTH':'1',
        'PYTHONDONTWRITEBYTECODE':'1',
        'SINGULARITY_INSTALL_VARIANT':str(variant),
        'SINGULARITY_WORKSPACE':str(workspace),
        'SINGULARITY_RQL_BIN':str(rql),
        'SINGULARITY_RQL_EXE':str(rql),
        'SINGULARITY_STATE_DIR':str(state_dir),
        'REPOQL_NATIVE_EMBED_URL':'/embed/repoql',
        'REPOQL_NATIVE_WORKSPACE':str(workspace),
        'SINGULARITY_BIND':'127.0.0.1',
        'SINGULARITY_ALLOW_PEERS':'127.0.0.1/32,::1/128',
        'SINGULARITY_PORT':str(port),
        # Bind all unified dashboard calls to a project-owned Windows executable.
        # The gateway may be absent: missing is explicitly unavailable, never an
        # invitation to use a fleet SSH forward or a Dockerhost credential.
        'SINGULARITY_WINDOWS_GATEWAY_EXE':str(source_root.parent / 'bin' / 'unified-repoql-control.exe' if native_runtime_root is None else runtime_root / 'bin' / 'unified-repoql-control.exe'),
        'UNIFIED_SERVICE_BASE':'http://127.0.0.1:18101',
        'UNIFIED_GATEWAY_TOKEN_FILE':str(state_dir / 'unified-gateway.token'),
    }
    if rust_route_sha256 is not None:
        if variant != 2:
            raise ValueError('DASHBOARD_RUST_ROUTE_VARIANT_INVALID')
        env['SINGULARITY_DASHBOARD_ROUTE_RUST_BINARY'] = _verified_route_binary(source_root, rust_route_sha256)
    if rust_listener_sha256 is not None:
        if variant != 2:
            raise ValueError('DASHBOARD_RUST_LISTENER_VARIANT_INVALID')
        env['SINGULARITY_DASHBOARD_NATIVE_LISTENER'] = _verified_route_binary(source_root, rust_listener_sha256, name='singularity-dashboard-listener.exe')
    if rust_unified_proxy_sha256 is not None:
        if variant != 2:
            raise ValueError('DASHBOARD_RUST_PROXY_VARIANT_INVALID')
        env['SINGULARITY_UNIFIED_PROXY_RUST_BINARY'] = _verified_route_binary(
            source_root, rust_unified_proxy_sha256, name='singularity-unified-proxy.exe')
    # The native MemoryCore provisioning process creates this existing owner
    # identity. Do not mint a parallel dashboard key or copy a secret into the UI.
    # The path is derived from the staged user-owned runtime, not user input.
    owner_file = runtime_root.parent / 'memory' / 'state' / 'secrets' / 'admin-user-key'
    _assert_no_reparse(owner_file)
    if owner_file.is_file():
        env['SINGULARITY_TENCENT_OWNER_KEY_FILE'] = str(owner_file)
    # MemoryPanel uses the native loopback port for every Windows variant.
    env.update(SINGULARITY_TENCENT_HOST='127.0.0.1', SINGULARITY_TENCENT_PORT='18126',
               SINGULARITY_TENCENT_SERVICE_ID='default',
               TENCENT_PANEL_BASE='http://127.0.0.1:18126')
    if variant in (2, 4):
        env.update(_native_office_environment(source_root, state_dir, runtime_root))
    # Keep the legacy keyword arguments accepted for existing task callers.
    # They are intentionally inert: do not inspect paths or load Ghost config.
    return env


def main(argv=None):
    p=argparse.ArgumentParser(description='Native Claude Code Complete dashboard launch')
    for arg in ('source-root','rql-exe','workspace','state-dir'):
        p.add_argument('--'+arg,required=True,type=Path)
    p.add_argument('--port',type=int,default=18100)
    p.add_argument('--variant',type=int,choices=(1,2,3,4),default=2)
    # Retained for older scheduled-task command lines; deliberately ignored.
    p.add_argument('--native-bridge-exe',type=Path)
    p.add_argument('--ghost-control-config',type=Path)
    p.add_argument('--native-runtime-root',type=Path)
    p.add_argument('--rust-route-sha256')
    p.add_argument('--rust-listener-sha256')
    p.add_argument('--rust-unified-proxy-sha256')
    p.add_argument('--mode',choices=('serve','check'),default='serve')
    a=p.parse_args(argv)
    env=environment(a.source_root,a.rql_exe,a.workspace,a.state_dir,a.port,variant=a.variant,windows=(os.name=='nt'), native_runtime_root=a.native_runtime_root,
                    rust_route_sha256=a.rust_route_sha256, rust_listener_sha256=a.rust_listener_sha256,
                    rust_unified_proxy_sha256=a.rust_unified_proxy_sha256)
    # Only the task's staged digest opts in, not ambient global configuration.
    os.environ.pop('SINGULARITY_DASHBOARD_ROUTE_RUST_BINARY', None)
    os.environ.pop('SINGULARITY_DASHBOARD_NATIVE_LISTENER', None)
    os.environ.pop('SINGULARITY_UNIFIED_PROXY_RUST_BINARY', None)
    os.environ.update(env)
    # Import only from the verified staged dashboard path, not from PATH or cwd.
    sys.path.insert(0,str(a.source_root/'dashboard'))
    import server
    # Config.load uses the validated SINGULARITY_* environment above; the
    # Linux example JSON is deliberately excluded from Windows public archives.
    return server.main([a.mode])


if __name__=='__main__':
    try:
        raise SystemExit(main())
    except (ValueError, OSError) as exc:
        print('DASHBOARD_LAUNCH_REFUSED: '+str(exc),file=sys.stderr)
        raise SystemExit(2)
