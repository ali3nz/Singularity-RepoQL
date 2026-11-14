"""Opt-in, strictly compared Rust release decisions on trusted sanitized facts.

This process owns filesystem inspection and native scheduler evidence. Rust
receives no paths, credentials, logs, raw receipts or ability to mutate state.
A selected native failure is an error, not permission to silently fall back.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import stat

RUST_ENV = 'SINGULARITY_RUST_RELEASE_EVIDENCE_BIN'


def checked_policy(command: str, facts: dict, reference: dict) -> dict:
    configured = os.environ.get(RUST_ENV, '')
    if not configured:
        return reference
    if command not in ('upgrade-plan-stdin', 'acceptance-matrix-stdin'):
        raise ValueError('RELEASE_RUST_COMMAND_REFUSED')
    binary = Path(configured)
    if not binary.is_absolute():
        raise ValueError('RELEASE_RUST_BINARY_INVALID')
    # Junctions and reparse-point ancestors are not trusted binary ownership.
    for part in (binary, *binary.parents):
        try:
            info = part.lstat()
        except OSError:
            if part == binary:
                raise ValueError('RELEASE_RUST_BINARY_INVALID') from None
            continue
        if stat.S_ISLNK(info.st_mode) or (getattr(info,'st_file_attributes',0) & 0x400):
            raise ValueError('RELEASE_RUST_BINARY_INVALID')
    if not binary.is_file():
        raise ValueError('RELEASE_RUST_BINARY_INVALID')
    try:
        payload = json.dumps(facts, separators=(',', ':'), ensure_ascii=False)
        if len(payload.encode('utf-8')) > 64 * 1024:
            raise ValueError('RELEASE_RUST_INPUT_LIMIT')
        proc = subprocess.run([str(binary), command], input=payload,
                              capture_output=True, text=True, encoding='utf-8',
                              timeout=10, check=False)
        if proc.returncode != 0 or len(proc.stdout.encode('utf-8')) > 256 * 1024:
            raise ValueError('RELEASE_RUST_EXECUTION_FAILED')
        result = json.loads(proc.stdout)
        if not isinstance(result, dict) or result != reference:
            raise ValueError('RELEASE_RUST_REFERENCE_MISMATCH')
    except (subprocess.TimeoutExpired, OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError('RELEASE_RUST_EXECUTION_FAILED') from None
    return result
