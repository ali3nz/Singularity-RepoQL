"""Strict opt-in bridge for independently checked, read-only native Rust tools.

This is a source migration compatibility gate, not an authorization or
installation mechanism. There is deliberately no fallback when native selection
fails: an unverified native result must never be substituted silently.
"""
from __future__ import annotations

import json
from pathlib import Path
import subprocess


class RustReadOnlyBridgeError(ValueError):
    """A native result could not be proven equal to the current source contract."""


def run_checked(binary: Path, args: list[str], reference: dict, *, data: dict | None = None,
                timeout: int = 10, env: dict[str, str] | None = None) -> dict:
    binary = Path(binary)
    if not binary.is_absolute() or not binary.is_file() or binary.is_symlink():
        raise RustReadOnlyBridgeError('RUST_BINARY_INVALID')
    # Only this explicitly configured executable is invoked, without a shell.
    # The input is never copied to the command line or written to disk.
    try:
        encoded = None if data is None else json.dumps(data, ensure_ascii=False)
    except (ValueError, TypeError, UnicodeError):
        raise RustReadOnlyBridgeError('RUST_INPUT_INVALID') from None
    if encoded is not None and len(encoded.encode('utf-8')) > 256 * 1024:
        raise RustReadOnlyBridgeError('RUST_INPUT_LIMIT')
    try:
        process = subprocess.run([str(binary), *args], input=encoded,
                                 capture_output=True, text=True, encoding='utf-8',
                                 timeout=timeout, check=False, **({"env": env} if env is not None else {}))
    except (OSError, subprocess.TimeoutExpired, UnicodeError):
        raise RustReadOnlyBridgeError('RUST_EXECUTION_FAILED') from None
    if process.returncode not in (0, 2) or not isinstance(process.stdout, str):
        raise RustReadOnlyBridgeError('RUST_EXECUTION_FAILED')
    try:
        output_bytes = len(process.stdout.encode('utf-8'))
    except UnicodeError:
        raise RustReadOnlyBridgeError('RUST_INVALID_RESPONSE') from None
    if output_bytes > 1024 * 1024:
        raise RustReadOnlyBridgeError('RUST_EXECUTION_FAILED')
    try:
        actual = json.loads(process.stdout)
    except (ValueError, UnicodeError):
        raise RustReadOnlyBridgeError('RUST_INVALID_RESPONSE') from None
    if not isinstance(actual, dict) or actual != reference:
        raise RustReadOnlyBridgeError('RUST_REFERENCE_MISMATCH')
    if process.returncode != (0 if reference.get('ok', reference.get('bothConnectorsActive', reference.get('ready'))) is True else 2):
        raise RustReadOnlyBridgeError('RUST_EXIT_POLICY_MISMATCH')
    return actual
