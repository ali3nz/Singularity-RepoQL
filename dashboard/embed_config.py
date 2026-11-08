"""Read-only browser-embed configuration for the unmodified native panels."""
from __future__ import annotations

import os
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit

# A native application must be published under HTTPS or a pre-existing same-origin
# reverse-proxy path. We do not guess internal hostnames or send dashboard tokens.
def safe_embed_url(value: str) -> str | None:
    value = (value or "").strip()
    if not value or any(ch in value for ch in "\r\n\\"):
        return None
    try:
        parts = urlsplit(value)
    except ValueError:
        return None
    if parts.fragment or parts.username or parts.password:
        return None
    if any(k.lower() in {"key", "token", "secret", "password", "auth", "api_key", "user_key"}
           for k, _ in parse_qsl(parts.query, keep_blank_values=True)):
        return None
    if value.startswith("/") and not value.startswith("//") and not parts.netloc:
        # Avoid proxying the dashboard itself, an API endpoint, or its static files.
        return value if parts.path.startswith("/embed/") and ".." not in parts.path else None
    try:
        https_port_ok = parts.port in (None, 443)
    except ValueError:
        return None
    if parts.scheme == "https" and parts.hostname and https_port_ok:
        return value
    return None

def panel_config() -> dict:
    targets = {"tencent": "TENCENT_PANEL_EMBED_URL",
               "repoql": "REPOQL_NATIVE_EMBED_URL"}
    config = {name: {"url": safe_embed_url(os.environ.get(env, "")),
                     "configured": bool(safe_embed_url(os.environ.get(env, "")))}
              for name, env in targets.items()}
    from repoql_native_auth import native_repoql_config
    # Browser sees only an authenticated bootstrap endpoint, never the login URL.
    config["repoql"] = native_repoql_config(config["repoql"]["url"])
    # Only advertise the Tencent panel when a credential source is configured;
    # the proxy cannot authenticate without one and a blank embed would fake readiness.
    configured_key = (os.environ.get("SINGULARITY_TENCENT_OWNER_KEY_FILE")
                      or os.environ.get("TENCENT_OWNER_KEY_FILE") or "").strip()
    # An embed URL alone never grants a Tencent identity; missing key files
    # must not turn the navigation green on a fresh Windows installation.
    tencent_ready = bool(configured_key and Path(configured_key).is_file())
    config['tencent'] = {'url': '/embed/tencent/' if tencent_ready else None,
                         'configured': tencent_ready,
                         'automatic_login': tencent_ready}
    return config
