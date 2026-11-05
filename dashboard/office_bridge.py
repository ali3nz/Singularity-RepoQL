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


def validated_legacy_embed_token(*, strict: bool = True) -> str | None:
    """Return an existing Office launch token only for its configured HTTPS host.

    Do not log or return this value from any dashboard HTTP endpoint. This
    supports an explicit native-Windows rollback, not authentication bypass.
    """
    value = os.environ.get("SINGULARITY_OFFICE_EMBED_URL", "").strip() or os.environ.get("CLAUDE_OFFICE_EMBED_URL", "").strip()
    public = public_office_url()
    if not value or not public:
        return None
    parsed = urlsplit(value)
    target = urlsplit(public)
    if (parsed.scheme != "https" or parsed.netloc != target.netloc
            or parsed.username or parsed.password or parsed.fragment
            or parsed.path not in ("", "/")):
        return None
    pairs = parse_qs(parsed.query, keep_blank_values=True)
    # Office may pass an optional room selection through its established URL.
    # Do not allow arbitrary additional query parameters in native mode.
    if (strict and (set(pairs) - {"token", "embed", "room"})) or len(pairs.get("token", [])) != 1 or pairs.get("embed") != ["1"] or (strict and "room" in pairs and pairs["room"] not in (["modern"], ["dm"])):
        return None
    token = pairs["token"][0]
    if not token or len(token) > 4096 or any(c in token for c in "\r\n"):
        return None
    return token


def embed_url() -> str | None:
    """Return a same-origin iframe URL, never the upstream bearer token."""
    if os.environ.get("SINGULARITY_WINDOWS_NATIVE") == "1":
        # Prefer the proven production token-URL method by default. The
        # private-file mechanism remains an explicit optional alternative.
        from native_panel_proxy import backend_key
        try:
            backend_key("office")
        except (OSError, PermissionError, ValueError):
            return None
        return "/embed/office/?embed=1"
    # Preserve the pre-port Linux launch semantics (including unrelated
    # extra query parameters), while native rollback remains stricter.
    return "/embed/office/?embed=1" if validated_legacy_embed_token(strict=False) else None


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
