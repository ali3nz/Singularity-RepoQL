"""Optional native RepoQL repository accounting without exposing repository identities.

Python owns mounts, failed-file URI attribution, filesystem availability and
all authenticated graph reads. Rust receives only positional integer indexes,
validated counts and booleans. The Python reference must match exactly.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess

SCHEMA = 'singularity-repository-summary/v1'
MAX_ROWS = 4096
MAX_EVENTS = 20000
MAX_REQUEST_BYTES = 512 * 1024
MAX_OUTPUT_BYTES = 512 * 1024


def _reference(rows, failed_indices, exclusion_indices):
    failed = [0] * len(rows)
    excluded = [0] * len(rows)
    for i in failed_indices:
        failed[i] += 1
    for i in exclusion_indices:
        excluded[i] += 1
    result = []
    for i, row in enumerate(rows):
        if row.get('state') not in (None, 'served'):
            status = 'override'
        elif not row.get('available'):
            status = 'unavailable'
        elif failed[i]:
            status = 'errors'
        elif (row.get('file_count') and row.get('indexed_count') is not None
              and row['indexed_count'] < row['file_count']):
            status = 'indexing'
        else:
            status = 'indexed'
        result.append({'excluded': excluded[i], 'failed': failed[i], 'status_code': status})
    return result


def project_repositories(rows, failed_indices, exclusion_indices, *, rust_bin=None,
                         runner=subprocess.run):
    binary = os.environ.get('SINGULARITY_REPOSITORY_SUMMARY_RUST_BINARY', '') if rust_bin is None else rust_bin
    if not binary:
        return _reference(rows, failed_indices, exclusion_indices)
    if len(rows) > MAX_ROWS or len(failed_indices) + len(exclusion_indices) > MAX_EVENTS:
        raise RuntimeError('repository_summary_native_input_too_large')
    if any(type(i) is not int or i < 0 or i >= len(rows)
           for i in (*failed_indices, *exclusion_indices)):
        raise RuntimeError('repository_summary_native_invalid_index')
    safe_rows = []
    for row in rows:
        count, indexed = row.get('file_count'), row.get('indexed_count')
        if any(value is not None and (type(value) is not int or not 0 <= value <= 10**12)
               for value in (count, indexed)):
            raise RuntimeError('repository_summary_native_invalid_count')
        safe_rows.append({'override': row.get('state') not in (None, 'served'),
                          'available': bool(row.get('available')),
                          'file_count': count, 'indexed_count': indexed})
    expected = _reference(rows, failed_indices, exclusion_indices)
    path = Path(binary)
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        raise RuntimeError('repository_summary_native_binary_invalid')
    parent = path.parent
    while parent != parent.parent:
        if parent.is_symlink():
            raise RuntimeError('repository_summary_native_binary_invalid')
        parent = parent.parent
    request = json.dumps({'schema': SCHEMA, 'rows': safe_rows,
                          'failed_indices': failed_indices,
                          'exclusion_indices': exclusion_indices}, separators=(',', ':'))
    if len(request.encode('utf-8')) > MAX_REQUEST_BYTES:
        raise RuntimeError('repository_summary_native_input_too_large')
    env = {k: v for k, v in os.environ.items()
           if k.upper() in {'PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'HOME'}}
    try:
        result = runner([str(path)], input=request, text=True, capture_output=True,
                        check=False, shell=False, timeout=8, env=env)
        if result.returncode or len(result.stdout.encode('utf-8')) > MAX_OUTPUT_BYTES:
            raise RuntimeError('repository_summary_native_execution_failed')
        actual = json.loads(result.stdout)
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        raise RuntimeError('repository_summary_native_execution_failed') from exc
    if actual != expected:
        raise RuntimeError('repository_summary_native_parity_mismatch')
    return actual
