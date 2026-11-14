"""Optional bounded Rust read projection for RepoQL link filtering and paging.

The authenticated Python handler retains SQL reads, names, URIs, categories and
query matching. The native child receives only boolean row match flags and
integer pagination bounds; an exact Python comparison is mandatory.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess

SCHEMA = "singularity-dashboard-link-page/v1"
MAX_ROWS = 50000
MAX_INPUT_BYTES = 120000
MAX_OUTPUT_BYTES = 16384


def _reference(matches: list[bool], page: int, page_size: int) -> dict:
    selected = [i for i, matched in enumerate(matches) if matched]
    return {"total": len(selected), "indices": selected[(page - 1) * page_size:page * page_size]}


def page_links(rows: list[dict], page: int, page_size: int, *, query: str = "",
               source_category: str = "", target_category: str = "", rust_bin=None,
               runner=subprocess.run) -> dict:
    """Return the selected rows and total, without exposing row content to Rust."""
    if type(page) is not int or type(page_size) is not int or page < 1 or page_size < 1 or page_size > 200:
        raise ValueError("invalid_link_paging")
    query_lower = query.lower()
    matches = [
        (not query or query_lower in (row["source_name"] + " " + row["target_name"]).lower())
        and (not source_category or row["source_category"] == source_category)
        and (not target_category or row["target_category"] == target_category)
        for row in rows
    ]
    expected = _reference(matches, page, page_size)
    binary = os.environ.get("SINGULARITY_DASHBOARD_LINK_PAGE_RUST_BINARY", "") if rust_bin is None else rust_bin
    if binary:
        if len(matches) > MAX_ROWS:
            raise RuntimeError("link_page_native_input_too_large")
        path = Path(binary)
        if not path.is_absolute() or path.is_symlink() or not path.is_file():
            raise RuntimeError("link_page_native_binary_invalid")
        parent = path.parent
        while parent != parent.parent:
            if parent.is_symlink():
                raise RuntimeError("link_page_native_binary_invalid")
            parent = parent.parent
        payload = json.dumps({"schema": SCHEMA, "matches": matches,
                              "page": page, "page_size": page_size}, separators=(",", ":"))
        if len(payload.encode("utf-8")) > MAX_INPUT_BYTES:
            raise RuntimeError("link_page_native_input_too_large")
        env = {k: v for k, v in os.environ.items()
               if k.upper() in {"PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "HOME"}}
        try:
            process = runner([str(path)], input=payload, capture_output=True, text=True,
                             timeout=8, shell=False, check=False, env=env)
            if process.returncode or len(process.stdout.encode("utf-8")) > MAX_OUTPUT_BYTES:
                raise RuntimeError("link_page_native_execution_failed")
            actual = json.loads(process.stdout)
        except (OSError, ValueError, subprocess.SubprocessError) as exc:
            raise RuntimeError("link_page_native_execution_failed") from exc
        if actual != expected:
            raise RuntimeError("link_page_native_parity_mismatch")
    return {"total": expected["total"], "rows": [rows[i] for i in expected["indices"]]}
