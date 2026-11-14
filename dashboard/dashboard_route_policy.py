"""Optional native route selection after the dashboard HTTP authority checks.

Only known public route spellings cross stdin, not incoming URLs, headers,
query values, identities or request bodies. Python keeps the handler and its
authorization, origin, body parsing, and mutation controls.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import stat
import subprocess

SCHEMA = "singularity-dashboard-routes/v1"
BINARY_ENV = "SINGULARITY_DASHBOARD_ROUTE_RUST_BINARY"

READ_ROUTES = {
    "/api/features": "read_features",
    "/api/claude/agents": "read_claude_agents",
    "/api/claude/agents/detail": "read_claude_agents_detail",
    "/api/claude/policy": "read_claude_policy",
    "/api/claude/mcps": "read_claude_mcps",
    "/api/openmausbot/overview": "read_openmausbot_overview",
    "/api/openmausbot/models": "read_openmausbot_models",
    "/api/openmausbot/ops": "read_openmausbot_ops",
    "/api/native/windows/readiness": "read_native_windows_readiness",
    "/api/harness/office": "read_harness_office",
    "/api/repos/usage": "read_repos_usage",
    "/api/freebuff/allowance": "read_freebuff_allowance",
    "/api/openchamber/telemetry": "read_openchamber_telemetry",
    "/api/agentchat/avatars": "read_agentchat_avatars",
    "/api/agentchat/presence": "read_agentchat_presence",
    "/api/agentchat/feed": "read_agentchat_feed",
    "/api/graph/annotations": "read_graph_annotations",
    "/api/health": "read_health",
    "/api/overview": "read_overview",
    "/api/status": "read_status",
    "/api/indexing": "read_indexing",
    "/api/files": "read_files",
    "/api/repos": "read_repos",
    "/api/repos/detail": "read_repos_detail",
    "/api/knowledge": "read_knowledge",
    "/api/knowledge/item": "read_knowledge_item",
    "/api/hub-doc-rows": "read_hub_doc_rows",
    "/api/memory-docs": "read_memory_docs",
    "/api/links": "read_links",
    "/api/links/graph": "read_links_graph",
    "/api/connectors": "read_connectors",
    "/api/errors": "read_errors",
    "/api/excluded": "read_excluded",
    "/api/embed/panels": "read_embed_panels",
    "/api/cpu": "read_cpu",
    "/api/activity": "read_activity",
}

WRITE_ROUTES = {
    "/api/claude/agents/save": "write_claude_agents_save",
    "/api/openmausbot/bots/model": "write_openmausbot_bots_model",
    "/api/claude/agents/restore": "write_claude_agents_restore",
    "/api/graph/annotations": "write_graph_annotations",
    "/api/unified/tencent/invoke": "write_unified_tencent_invoke",
    "/api/harness/settings": "write_harness_settings",
    "/api/repos/import": "write_repos_import",
    "/api/repos/remove": "write_repos_remove",
    "/api/repos/reindex": "write_repos_reindex",
    "/api/excluded": "write_excluded",
    "/api/excluded/remove": "write_excluded_remove",
}

READ_PREFIXES = (
    ("/api/harness", "read_harness"),
    ("/api/unified/", "read_unified"),
)


def _safe_binary(binary):
    path = Path(binary)
    if not path.is_absolute() or path.drive.startswith("\\"):
        raise RuntimeError("dashboard_route_native_binary_invalid")
    try:
        for entry in (path, *path.parents):
            info = entry.lstat()
            if (stat.S_ISLNK(info.st_mode)
                    or getattr(info, "st_file_attributes", 0) & 0x400):
                raise OSError
        if not stat.S_ISREG(path.lstat().st_mode):
            raise OSError
    except OSError:
        raise RuntimeError("dashboard_route_native_binary_invalid") from None
    return path


def classify_dashboard_route(method, path, *, rust_bin=None, runner=subprocess.run):
    reading = method == "GET"
    expected = (READ_ROUTES if reading else WRITE_ROUTES).get(path)
    public_key = path if expected is not None else ""
    if reading and expected is None:
        for prefix, route in READ_PREFIXES:
            if path.startswith(prefix):
                public_key, expected = prefix, route
                break
    binary = os.environ.get(BINARY_ENV, "") if rust_bin is None else rust_bin
    if not binary:
        return expected
    request = json.dumps({"schema": SCHEMA, "read": reading, "key": public_key},
                         separators=(",", ":"))
    env = {key: value for key, value in os.environ.items()
           if key.upper() in {"SYSTEMROOT", "WINDIR", "PATH", "TEMP", "TMP"}}
    try:
        result = runner([str(_safe_binary(binary))], input=request, capture_output=True,
                        encoding="utf-8", timeout=3, shell=False, check=False, env=env,
                        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        if result.returncode or len(result.stdout) > 256:
            raise RuntimeError("dashboard_route_native_execution_failed")
        actual = json.loads(result.stdout)
    except (OSError, ValueError, subprocess.SubprocessError):
        raise RuntimeError("dashboard_route_native_execution_failed") from None
    if actual != {"route": expected}:
        raise RuntimeError("dashboard_route_native_parity_mismatch")
    return actual["route"]
