"""Fail-closed Windows CPU sample from native Rust binary, never Linux /proc."""
from __future__ import annotations
import json
import os
from pathlib import Path
import subprocess


def sample_cpu(pid=None, *, executable=None, runner=subprocess.run):
    raw = executable or os.environ.get('SINGULARITY_NATIVE_BRIDGE_EXE', '')
    if not raw:
        return {'available': False, 'reason': 'native_rust_telemetry_not_configured'}
    exe = Path(raw)
    # Only a named local executable, not a shell script, UNC share, or URL.
    if (not exe.is_absolute() or exe.name.lower() != 'singularity-desktop-bridge.exe'
            or str(exe).startswith('\\\\') or not exe.is_file() or exe.is_symlink()):
        return {'available': False, 'reason': 'native_rust_telemetry_invalid_executable'}
    args = [str(exe), 'cpu-sample', '--sample-ms', '250']
    if pid is not None:
        if type(pid) is not int or not 1 <= pid <= 2**32 - 1:
            return {'available': False, 'reason': 'invalid_repoql_pid'}
        args.extend(['--pid', str(pid)])
    try:
        proc = runner(args, shell=False, check=False, stdout=subprocess.PIPE,
                      stderr=subprocess.DEVNULL, timeout=4,
                      creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        if proc.returncode != 0 or len(proc.stdout) > 16384:
            raise ValueError('native probe failed')
        data = json.loads(proc.stdout)
        if not isinstance(data, dict) or data.get('available') is not True or data.get('source') != 'win32-system-process-times':
            raise ValueError('invalid probe response')
        def pct(value):
            return round(value, 2) if type(value) in (float, int) and 0 <= value <= 100 else None
        system = pct(data.get('system_cpu_pct'))
        process = pct(data.get('process_cpu_pct'))
        cores = data.get('logical_cores')
        per_core = data.get('process_per_core_pct')
        if type(cores) is not int or not 1 <= cores <= 4096:
            raise ValueError('invalid CPU capacity')
        if per_core is not None and (type(per_core) not in (float, int) or not 0 <= per_core <= cores * 100):
            raise ValueError('invalid process CPU reading')
        if system is None:
            raise ValueError('missing total system measurement')
        if pid is not None and data.get('pid') != pid:
            raise ValueError('process identity mismatch')
        # This is the Win32 creation FILETIME for the opened process HANDLE,
        # not a PID-only claim. Do not attribute CPU to RepoQL if absent.
        created = data.get('process_created_filetime')
        if pid is not None and (type(created) is not int or created <= 0 or
                                per_core is None or process is None):
            raise ValueError('unverified process identity or measurement')
        return {'available': True, 'pid': pid, 'cpu_pct': round(per_core,2) if per_core is not None else None, 'host_pct': process, 'cores': cores,
                'system_cpu_pct': system, 'source': 'rust-win32',
                'process_created_filetime': created if pid is not None else None,
                'process_scale': 'percent-of-host-capacity'}
    except (OSError, ValueError, TypeError, subprocess.TimeoutExpired):
        return {'available': False, 'reason': 'native_rust_telemetry_unavailable'}
