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
