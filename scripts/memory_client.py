#!/usr/bin/env python3
"""Shared MemoryCore L0 request client for Singularity.

Every automatic writer (knowledge promotion, document ingestion) sends its
requests through this single function so the request contract — gateway
Authorization header, service/user-key headers, ``/v3`` prefix, JSON in/out —
lives in exactly one place. Credentials never leave the caller's config object
and are never printed, logged or written to disk.
"""
import json
import urllib.error
import urllib.request


def ensure_success(resp, context="memory request"):
    """Application-level success check for MemoryCore responses.

    Transport success (HTTP 200) is NOT proof of a successful write: the
    gateway contract returns ``{"code": N, ...}`` where non-zero N means the
    application rejected the request. Malformed payloads are also refused —
    never treated as success. Error messages carry only the generic context,
    never authentication headers or secret values.
    """
    if resp is None:
        raise RuntimeError(f"{context}: empty memory response — not treated as success")
    if isinstance(resp, (str, bytes)) or not hasattr(resp, "get"):
        raise RuntimeError(f"{context}: malformed memory response (expected object) — not treated as success")
    code = resp.get("code")
    if code is not None:
        try:
            ok = int(code) == 0
        except (TypeError, ValueError):
            ok = False
        if not ok:
            raise RuntimeError(f"{context}: memory API reported application code {code} — not treated as success")
    if resp.get("error"):
        raise RuntimeError(f"{context}: memory API reported an application error — not treated as success")
    return resp


def memory_call(base, cfg, path, payload, timeout=10):
    """POST one MemoryCore request and decode the JSON response.

    ``cfg`` carries authPrefix, gatewayKey, serviceId and userKey (as loaded by
    callers from the installation's memory.json). Raises on any network /
    decode failure; callers turn errors into explicit degraded statuses —
    never into fabricated success.
    """
    req = urllib.request.Request(
        base.rstrip("/") + "/v3" + path,
        data=json.dumps(payload).encode(),
        headers={
            "Content-Type": "application/json",
            "Authorization": cfg["authPrefix"] + cfg["gatewayKey"],
            "x-tdai-service-id": cfg["serviceId"],
            "x-tdai-user-key": cfg["userKey"],
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())
