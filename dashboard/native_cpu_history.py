"""Separate, fail-closed native Windows RepoQL CPU history.

The sampler depends on the installed Rust Win32 bridge. It does not read /proc,
Docker, WSL, systemd, or the legacy Linux cpu.db. No GUI requests cause writes.
An operator must explicitly run this process under the native supervisor.
"""
from __future__ import annotations

import argparse
from contextlib import closing
from datetime import datetime, timezone
import os
from pathlib import Path
import sqlite3
import sys
import time

from native_cpu import sample_cpu
from repoql_bridge import Config, RepoQL

WIN_EPOCH_TICKS = 116444736000000000
SCHEMA = """
CREATE TABLE IF NOT EXISTS win_cpu_samples (
  ts INTEGER PRIMARY KEY,
  pid INTEGER,
  process_created_filetime INTEGER,
  cpu_pct REAL,
  host_pct REAL,
  system_pct REAL,
  num_cpus INTEGER,
  state TEXT NOT NULL CHECK(state IN ('ok','unavailable','identity_mismatch'))
);
"""


def db_path(config: Config) -> Path:
    # The dashboard can be installed in four profiles on the same account.
    # Do not merge CPU histories from different GUI installations.
    option = os.environ.get('SINGULARITY_INSTALL_VARIANT')
    if option not in ('1', '2', '3', '4'):
        raise ValueError('explicit native Windows installation variant required')
    return config.state_dir / f'cpu-windows-option{option}-v1.db'


def _started_unix(value: object) -> float | None:
    if not isinstance(value, str) or len(value) > 48:
        return None
    try:
        result = datetime.fromisoformat(value.replace('Z', '+00:00'))
        return result.timestamp() if result.tzinfo else None
    except (ValueError, OverflowError, OSError):
        return None


def record(config: Config, status: dict, *, sampler=sample_cpu, now: int | None = None) -> dict:
    """Collect a bounded Rust sample, validate process identity, and retain one row.

    status must be returned by a configured native RepoQL executable, rather
    than a stale host.lock. A restarted process/PID may only be attributed when
    its Win32 creation FILETIME agrees with the RepoQL host startup time.
    """
    now = int(time.time()) if now is None else now
    if type(now) is not int or now < 0:
        raise ValueError('invalid sampling clock')
    host = status.get('host') if isinstance(status, dict) else None
    host = host if isinstance(host, dict) else {}
    pid = host.get('pid')
    started = _started_unix(host.get('startedAt'))
    row = {'ts': now, 'pid': None, 'process_created_filetime': None,
           'cpu_pct': None, 'host_pct': None, 'system_pct': None,
           'num_cpus': None, 'state': 'unavailable'}
    if type(pid) is int and 1 <= pid <= 2**32 - 1 and started is not None:
        row['pid'] = pid
        sample = sampler(pid)
        created = sample.get('process_created_filetime') if isinstance(sample, dict) else None
        if (isinstance(sample, dict) and sample.get('available') is True
                and sample.get('source') == 'rust-win32' and sample.get('pid') == pid
                and type(created) is int and created > WIN_EPOCH_TICKS):
            created_unix = (created - WIN_EPOCH_TICKS) / 10000000
            # Allow rounding of the host start timestamp, not an unrelated PID.
            if abs(created_unix - started) <= 5 and type(sample.get('cpu_pct')) in (int, float) and type(sample.get('host_pct')) in (int, float):
                cpu, host_cpu = sample['cpu_pct'], sample['host_pct']
                sys_cpu, cores = sample.get('system_cpu_pct'), sample.get('cores')
                if (0 <= cpu <= 409600 and 0 <= host_cpu <= 100 and
                        type(sys_cpu) in (int, float) and 0 <= sys_cpu <= 100 and
                        type(cores) is int and 1 <= cores <= 4096 and
                        cpu <= cores * 100 + 0.01):
                    row.update({'process_created_filetime': created, 'cpu_pct': round(cpu, 2),
                                'host_pct': round(host_cpu, 2), 'system_pct': round(sys_cpu, 2),
                                'num_cpus': cores, 'state': 'ok'})
                else:
                    row['state'] = 'identity_mismatch'
            else:
                row['state'] = 'identity_mismatch'
        elif isinstance(sample, dict) and sample.get('available'):
            row['state'] = 'identity_mismatch'
    retention = config.cpu_retention_days
    if type(retention) is not int or not 1 <= retention <= 365:
        raise ValueError('invalid CPU retention window')
    path = db_path(config)
    config.state_dir.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(path, timeout=5)) as db:
        db.executescript(SCHEMA)
        db.execute('INSERT OR REPLACE INTO win_cpu_samples '
                   '(ts,pid,process_created_filetime,cpu_pct,host_pct,system_pct,num_cpus,state) '
                   'VALUES (:ts,:pid,:process_created_filetime,:cpu_pct,:host_pct,:system_pct,:num_cpus,:state)', row)
        db.execute('DELETE FROM win_cpu_samples WHERE ts < ?', (now - retention * 86400,))
        db.commit()
    return row


def series(config: Config, period: str, periods: dict, *, now: int | None = None) -> dict:
    window, bucket = periods.get(period, periods['1h'])
    now = int(time.time()) if now is None else now
    empty = {'avg': None, 'peak': None, 'samples': 0, 'gaps': 0,
             'last_sample': None, 'window_seconds': window}
    result = {'available': False, 'reason': 'native_windows_cpu_history_collector_not_installed',
              'measurement_source': 'rust-win32-process-times', 'process_scale': 'percent-of-one-core',
              'series': [], 'stats': empty, 'bucket_seconds': bucket,
              'period': period, 'retention_days': config.cpu_retention_days}
    try:
        path = db_path(config)
    except ValueError:
        return {**result, 'reason': 'native_windows_install_variant_unconfigured'}
    if not path.is_file():
        return result
    try:
        # Opening in read-only mode ensures a dashboard read cannot create or
        # mutate the database; it cannot connect to legacy Linux cpu.db.
        with closing(sqlite3.connect(path.as_uri() + '?mode=ro', uri=True, timeout=2)) as db:
            rows = db.execute('SELECT ts,cpu_pct,state FROM win_cpu_samples WHERE ts >= ? AND ts <= ? ORDER BY ts',
                              (now-window, now)).fetchall()
    except (sqlite3.Error, OSError):
        return {**result, 'reason': 'native_windows_cpu_history_unreadable'}
    if not rows:
        return {**result, 'reason': 'native_windows_cpu_history_no_samples'}
    values_by_bucket: dict[int, list[float]] = {}
    all_values = []
    last_ts = None
    gaps = 0
    for ts, cpu, state in rows:
        if last_ts is not None and ts - last_ts > max(1, config.sample_interval_seconds) * 2:
            gaps += 1
        last_ts = ts
        slot = ts // bucket * bucket
        values = values_by_bucket.setdefault(slot, [])
        if state == 'ok' and type(cpu) in (float, int) and 0 <= cpu <= 409600:
            values.append(cpu)
            all_values.append(cpu)
        else:
            gaps += 1
    plotted = [{'ts': ts, 'avg': round(sum(vals)/len(vals), 2) if vals else None,
                'peak': round(max(vals), 2) if vals else None}
               for ts, vals in sorted(values_by_bucket.items())]
    stats = {'avg': round(sum(all_values)/len(all_values), 2) if all_values else None,
             'peak': round(max(all_values), 2) if all_values else None,
             'samples': len(all_values), 'gaps': gaps,
             'last_sample': datetime.fromtimestamp(rows[-1][0], timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
             'window_seconds': window}
    return {**result, 'available': bool(all_values),
            'reason': None if all_values else 'native_windows_cpu_history_no_verified_samples',
            'stats': stats, 'series': plotted}


def main() -> int:
    parser = argparse.ArgumentParser(description='Native Windows Rust CPU history collector, no Docker/WSL')
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--once', action='store_true', help='Collect one bounded sample and exit')
    args = parser.parse_args()
    if os.name != 'nt' or os.environ.get('SINGULARITY_WINDOWS_NATIVE') != '1':
        print('native Windows mode required', file=sys.stderr)
        return 2
    if not args.config.is_file():
        return 2
    if os.environ.get('SINGULARITY_INSTALL_VARIANT') not in ('1','2','3','4'):
        return 2
    config = Config.load(args.config)
    if not 5 <= config.sample_interval_seconds <= 3600:
        return 2
    rql = RepoQL(config)
    return run_collector(config, rql.status, once=args.once)


def collect_once(config: Config, status_fn, *, sampler=sample_cpu, now: int | None = None) -> dict:
    """One sample; upstream failure is a gap, storage failure is fatal.

    An unavailable RepoQL/Rust process is operationally distinct from a failed
    local database write. In particular, never hide SQLite errors by attempting
    another write under the same broken storage conditions.
    """
    try:
        status = status_fn(ttl=0)
    except (OSError, TimeoutError, ValueError, RuntimeError, TypeError):
        status = {}
    return record(config, status, sampler=sampler, now=now)


def run_collector(config: Config, status_fn, *, once: bool = False,
                  sampler=sample_cpu, sleep=time.sleep, clock=time.time) -> int:
    """Managed process entry point. Exit on disk faults for supervisor recovery.

    A timed polling process is intentionally not an independent task scheduler:
    the Rust Job Object owns termination, including stop/reboot/rollback.
    """
    while True:
        collect_once(config, status_fn, sampler=sampler, now=int(clock()))
        if once:
            return 0
        sleep(config.sample_interval_seconds)


if __name__ == '__main__':
    raise SystemExit(main())
