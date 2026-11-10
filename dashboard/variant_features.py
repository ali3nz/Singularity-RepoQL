"""Variant-driven dashboard feature policy, sourced from the shared Rust manifest.

Absence of SINGULARITY_INSTALL_VARIANT preserves existing Linux dashboard behaviour.
Native Windows distribution MUST set an explicit variant and fail closed.
"""
from __future__ import annotations
import json
import os
from pathlib import Path

MANIFEST = Path(__file__).resolve().parent.parent / "native" / "windows" / "variants.json"


def features(variant=None, *, native_windows=None):
    if variant is None:
        variant = os.environ.get("SINGULARITY_INSTALL_VARIANT", "").strip()
    if native_windows is None:
        native_windows = os.environ.get("SINGULARITY_WINDOWS_NATIVE", "") == "1"
    policy = json.loads(MANIFEST.read_text(encoding="utf-8"))
    if not variant:
        if native_windows:
            raise ValueError("native Windows dashboard requires SINGULARITY_INSTALL_VARIANT=1..4")
        # Legacy installations which do not opt into native variant packaging
        # must not be silently given a different feature set.
        return {"variant": None, "gui": "legacy", "features": {k: k != "ghost" for k in policy["variants"]["4"]["features"]}}
    row = policy["variants"].get(str(variant))
    if row is None:
        raise ValueError("install variant must be one of 1, 2, 3, 4")
    selected = dict(row["features"])
    selected["ghost"] = False  # Ghost is retired from the Windows product.
    return {"variant": int(variant), "gui": row["gui"], "features": selected}


def route_allowed(path, profile):
    f = profile["features"]
    if path.startswith(("/embed/office/", "/api/embed/office/", "/api/harness/office", "/office/")) or path == "/office":
        return f["office"]
    if path.startswith(("/embed/kanzo/", "/api/embed/kanzo/")) or path == "/kanban":
        return f["kanban"]
    if path.startswith("/api/agentchat/") or path == "/agentchat":
        return f["agent_chat"]
    return True
