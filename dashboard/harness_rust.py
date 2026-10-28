#!/usr/bin/env python3
"""Client for the read-only Rust coordinator snapshot (Harness Control Center).

The Rust service (`orchestra-observer coord-serve`) exposes one bounded,
authenticated, READ-ONLY read model of the harness run tree. This module is the
dashboard's only integration point with it:

  * loopback-only by default; a non-loopback base URL is refused unless the
    caller passes allow_remote=True explicitly;
  * every failure is returned as {"available": False, ...} so the dashboard
    keeps working when the Rust service is down (telemetry must never block the
    page);
  * the schema string is validated, so an incompatible Rust build is reported
    as unavailable instead of silently rendering wrong data;
  * no prompts, transcripts or tokens are stored or logged.
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

SCHEMA = "orchestra-coordinator-read/1"
DEFAULT_BASE = "http://127.0.0.1:7879"
MAX_BODY = 4 * 1024 * 1024
LOOPBACK_HOSTS = {"127.0.0.1", "::1", "localhost"}


def _is_loopback(base: str) -> bool:
    try:
        host = urllib.parse.urlsplit(base).hostname or ""
    except ValueError:
        return False
    return host in LOOPBACK_HOSTS


class RustHarness:
    def __init__(self, base_url: str | None = None, token: str | None = None,
                 token_file: str | os.PathLike | None = None,
                 timeout: float = 0.8, allow_remote: bool = False):
        self.base_url = (base_url or os.environ.get("RUST_HARNESS_URL") or DEFAULT_BASE).rstrip("/")
        self.allow_remote = allow_remote
        self.timeout = timeout
        self._token = token
        self._token_file = Path(
            token_file
            or os.environ.get("RUST_HARNESS_TOKEN_FILE")
            or Path(os.environ.get("SINGULARITY_STATE_DIR")
                    or Path.home() / ".local" / "state" / "singularity-dashboard") / "coordinator.token"
        )

    # -- auth ---------------------------------------------------------
    def token(self) -> str:
        if self._token:
            return self._token
        env = os.environ.get("ORCHESTRA_COORD_TOKEN")
        if env:
            self._token = env.strip()
            return self._token
        try:
            self._token = self._token_file.read_text(encoding="utf-8").strip()
        except OSError:
            self._token = ""
        return self._token

    def configured(self) -> bool:
        return bool(self.token()) and (self.allow_remote or _is_loopback(self.base_url))

    # -- transport ----------------------------------------------------
    def _get(self, path: str) -> dict:
        if not (self.allow_remote or _is_loopback(self.base_url)):
            return {"available": False, "error": "non_loopback_refused"}
        token = self.token()
        if not token:
            return {"available": False, "error": "not_configured"}
        request = urllib.request.Request(self.base_url + path, method="GET")
        request.add_header("Authorization", "Bearer " + token)
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                body = response.read(MAX_BODY + 1)
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError) as exc:
            # Never include the header or the token in the error text.
            return {"available": False, "error": type(exc).__name__}
        if len(body) > MAX_BODY:
            return {"available": False, "error": "response_too_large"}
        try:
            payload = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return {"available": False, "error": "invalid_json"}
        if not isinstance(payload, dict):
            return {"available": False, "error": "invalid_payload"}
        return payload

    # -- read model ---------------------------------------------------
    def health(self) -> dict:
        payload = self._get("/v1/health")
        if payload.get("available") is False:
            return payload
        if not payload.get("ok"):
            return payload
        if payload.get("schema") != SCHEMA or payload.get("readOnly") is not True:
            return {"available": False, "error": "schema_mismatch"}
        return {"available": True, **payload}

    def snapshot(self) -> dict:
        payload = self._get("/v1/snapshot")
        if payload.get("available") is False:
            return payload
        if payload.get("schema") != SCHEMA:
            return {"available": False, "error": "schema_mismatch"}
        if not isinstance(payload.get("runs"), list) or not isinstance(payload.get("health"), dict):
            return {"available": False, "error": "invalid_payload"}
        payload["available"] = True
        return payload

    def authority(self) -> dict:
        payload = self._get("/v1/authority")
        if payload.get("available") is False:
            return payload
        if not payload.get("ok"):
            return {"available": False, "error": payload.get("error", "unknown")}
        if not isinstance(payload.get("runs"), list):
            return {"available": False, "error": "invalid_payload"}
        payload["available"] = True
        return payload

    def status(self) -> dict:
        """One dashboard-shaped view: service health plus authority ownership."""
        health = self.health()
        if not health.get("available"):
            return {
                "available": False,
                "error": health.get("error", "unavailable"),
                "baseUrl": self.base_url,
            }
        authority = self.authority()
        return {"available": bool(authority.get("available")), "health": health, "authority": authority,
                "error": authority.get("error") if not authority.get("available") else None}

    def run(self, run_id: str) -> dict:
        if not run_id or "/" in run_id or ".." in run_id:
            return {"available": False, "error": "invalid_run_id"}
        payload = self._get("/v1/runs/" + urllib.parse.quote(run_id, safe=""))
        if payload.get("available") is False:
            return payload
        if not payload.get("ok") or not isinstance(payload.get("run"), dict):
            return {"available": False, "error": payload.get("error", "not_found")}
        payload["available"] = True
        return payload
