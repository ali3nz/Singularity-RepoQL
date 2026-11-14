"""Optional identity-free Rust ordering for the authenticated indexing error API.

The authenticated Python handler owns RepoQL access, query filtering, messages,
URIs and pagination limits. The child receives numeric timestamp ranks only;
its complete output is compared with Python before any rows are returned.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess

SCHEMA = "singularity-dashboard-indexing-errors/v1"
MAX_EVENTS = 10000
MAX_INPUT_BYTES = 180000
MAX_OUTPUT_BYTES = 20000


def _reference(items, page, page_size):
    # Python list.sort is stable, including equal timestamp keys.
    ordered = sorted(range(len(items)),
                     key=lambda index: str(items[index].get("timestamp") or ""),
                     reverse=True)
    start = (page - 1) * page_size
    selected = ordered[start:start + page_size]
    return ({"total": len(items), "rows": [items[i] for i in selected]},
            {"total": len(items), "indices": selected})


def project_indexing_errors(items, page, page_size, *, rust_bin=None,
                            runner=subprocess.run):
    if (type(page) is not int or type(page_size) is not int
            or page < 1 or page_size < 1 or page_size > 200):
        raise ValueError("invalid_indexing_error_paging")
    projected, expected = _reference(items, page, page_size)
    binary = (os.environ.get("SINGULARITY_DASHBOARD_INDEXING_ERRORS_RUST_BINARY", "")
              if rust_bin is None else rust_bin)
    if not binary:
        return projected
    if len(items) > MAX_EVENTS:
        raise RuntimeError("indexing_errors_native_input_too_large")
    # Only sorted, deterministic timestamp ordinals cross the process boundary.
    stamps = [str(item.get("timestamp") or "") for item in items]
    ranks = {stamp: index for index, stamp in enumerate(sorted(set(stamps)))}
    request = json.dumps({"schema": SCHEMA, "ranks": [ranks[s] for s in stamps],
                          "page": page, "page_size": page_size}, separators=(",", ":"))
    if len(request.encode("utf-8")) > MAX_INPUT_BYTES:
        raise RuntimeError("indexing_errors_native_input_too_large")
    path = Path(binary)
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        raise RuntimeError("indexing_errors_native_binary_invalid")
    parent = path.parent
    while parent != parent.parent:
        if parent.is_symlink():
            raise RuntimeError("indexing_errors_native_binary_invalid")
        parent = parent.parent
    env = {key: value for key, value in os.environ.items()
           if key.upper() in {"PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "HOME"}}
    try:
        proc = runner([str(path)], input=request, text=True, capture_output=True,
                      check=False, shell=False, timeout=8, env=env)
        if proc.returncode or len(proc.stdout.encode("utf-8")) > MAX_OUTPUT_BYTES:
            raise RuntimeError("indexing_errors_native_execution_failed")
        actual = json.loads(proc.stdout)
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        raise RuntimeError("indexing_errors_native_execution_failed") from exc
    if actual != expected:
        raise RuntimeError("indexing_errors_native_parity_mismatch")
    return projected
