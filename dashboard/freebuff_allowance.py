"""Read the existing Freebuff session allowance through the kit's own client.

The allowance (Freebucks, daily pool, wallet) is a separate measurement from
token usage and billed API spend. This module does not implement the session API
again: it calls the maintained `freebucks-status.mjs` helper, which reads the
desktop auth state in memory and never logs the credential.

The dashboard is authenticated before this endpoint runs. The result is cached
briefly so a page refresh does not hammer the upstream session API.
"""
from __future__ import annotations

import json
import os
import subprocess
import threading
import time
from typing import Any

MODULE = os.environ.get("SINGULARITY_FREEBUCKS_STATUS_MODULE", "")
HOST_LABEL = os.environ.get("SINGULARITY_HOST_LABEL", "local")
TTL_SECONDS = 60
TIMEOUT_SECONDS = 15

_lock = threading.Lock()
_cache: dict[str, Any] | None = None
_cached_at = 0.0


def _unavailable(reason: str) -> dict[str, Any]:
    return {
        "available": False,
        "source": "freebuff-session-api",
        "host": HOST_LABEL,
        "error": reason[:200],
        "note": "Freebucks allowance is separate from tokens and is never treated as API spend.",
    }


def _read() -> dict[str, Any]:
    if not MODULE or not os.path.isfile(MODULE):
        return _unavailable("Freebuff allowance helper is not configured")
    script = (
        "import {getFreebucksStatus} from " + json.dumps("file://" + MODULE) + ";"
        "const s=await getFreebucksStatus();"
        "console.log(JSON.stringify({accountAuthenticated:s.accountAuthenticated,"
        "sessionStatus:s.sessionStatus,freebucks:s.freebucks,refreshedAt:s.refreshedAt,"
        "httpStatus:s.httpStatus,error:s.error}));"
    )
    try:
        child_env = {key: os.environ[key] for key in ("PATH", "HOME") if key in os.environ}
        if os.environ.get("FREEBUFF_CONFIG_DIR"):
            child_env["FREEBUFF_CONFIG_DIR"] = os.environ["FREEBUFF_CONFIG_DIR"]
        if os.environ.get("FREEBUFF_DESKTOP_STATE_PATH"):
            child_env["FREEBUFF_DESKTOP_STATE_PATH"] = os.environ["FREEBUFF_DESKTOP_STATE_PATH"]
        result = subprocess.run(
            ["node", "--input-type=module", "-e", script],
            capture_output=True, text=True, timeout=TIMEOUT_SECONDS, env=child_env,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return _unavailable(f"{type(exc).__name__}: {exc}")
    if result.returncode != 0:
        return _unavailable(f"node rc={result.returncode}: {result.stderr.strip()[:160]}")
    try:
        payload = json.loads(result.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        return _unavailable("invalid allowance response")
    freebucks = payload.get("freebucks")
    if not isinstance(freebucks, dict) or not freebucks.get("available"):
        return _unavailable(str(payload.get("error") or "allowance unavailable"))
    return {
        "available": True,
        "source": "freebuff-session-api",
        "host": HOST_LABEL,
        "account_authenticated": bool(payload.get("accountAuthenticated")),
        "session_status": payload.get("sessionStatus"),
        "freebucks": {
            key: freebucks.get(key) for key in (
                "balance", "dailyLimit", "dailySpent", "dailyRemaining",
                "dailyResetAt", "walletBalance", "monthlyBonus", "nextBonusAt",
                "planId",
            )
        },
        "refreshed_at": payload.get("refreshedAt"),
        "note": "Freebucks are session allowance units, not tokens or USD.",
    }


def get_allowance() -> dict[str, Any]:
    global _cache, _cached_at
    now = time.monotonic()
    with _lock:
        if _cache is not None and now - _cached_at < TTL_SECONDS:
            return dict(_cache)
        payload = _read()
        _cache = payload
        _cached_at = now
        return dict(payload)
