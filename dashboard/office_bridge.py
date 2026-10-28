"""Claude Office health and same-origin viewer launch metadata."""
from __future__ import annotations

import http.client
import json
import os
import time
from urllib.parse import parse_qs, urlsplit


def public_office_url() -> str | None:
    value = os.environ.get("CLAUDE_OFFICE_PUBLIC_URL", "").strip().rstrip("/")
    if not value:
        return None
    parsed = urlsplit(value)
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username
            or parsed.password or parsed.query or parsed.fragment or parsed.path not in ("", "/")):
        return None
    return value


def embed_url() -> str | None:
    """Launch on the dashboard origin so Office needs no second Access login."""
    value = os.environ.get("CLAUDE_OFFICE_EMBED_URL", "").strip()
    if not value:
        return None
    parsed = urlsplit(value)
    public = public_office_url()
    if not public:
        return None
    target = urlsplit(public)
    if (parsed.scheme != "https" or parsed.netloc != target.netloc
            or parsed.username or parsed.password or parsed.fragment
            or parsed.path not in ("", "/")):
        return None
    query = parse_qs(parsed.query)
    if len(query.get("token", [])) != 1 or not query["token"][0] or query.get("embed") != ["1"]:
        return None
    return "/embed/office/?embed=1"


def office_status() -> dict:
    """Probe health; the existing dashboard proxy supplies the Office API key."""
    url = public_office_url()
    host = os.environ.get("CLAUDE_OFFICE_HEALTH_HOST", "127.0.0.1")
    try:
        port = int(os.environ.get("CLAUDE_OFFICE_HEALTH_PORT", "8001"))
        timeout = float(os.environ.get("CLAUDE_OFFICE_HEALTH_TIMEOUT", "2"))
    except (TypeError, ValueError):
        return {"name": "Claude Office", "launch_url": url, "available": False,
                "reason": "Office health env config invalid"}
    result = {"name": "Claude Office", "launch_url": url,
              "embed_url": embed_url(), "available": False,
              "reason": "Office health has not been verified"}
    conn = http.client.HTTPConnection(host, port, timeout=timeout)
    t0 = time.monotonic()
    try:
        conn.request("GET", "/health")
        response = conn.getresponse()
        raw = response.read(4096)
        if response.status != 200:
            result["reason"] = "Office health endpoint returned an error"
        else:
            status = json.loads(raw)
            if status.get("status") == "ok":
                result.update(available=True, reason=None)
            else:
                result["reason"] = "Office reported an unhealthy state"
    except (OSError, ValueError, http.client.HTTPException):
        result["reason"] = f"Office is not reachable on the configured port {port}"
    finally:
        conn.close()
        result["latency_ms"] = round((time.monotonic() - t0) * 1000)
    return result
