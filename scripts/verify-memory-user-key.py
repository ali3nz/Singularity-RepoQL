#!/usr/bin/env python3
"""Verify the admin user key without exposing it or trusting HTTP status alone."""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


def response_confirms_key(status: int, payload: object) -> bool:
    if status != 200 or not isinstance(payload, dict):
        return False
    data = payload.get("data")
    return isinstance(data, dict) and data.get("valid") is True


def main(argv: list[str]) -> int:
    key_file = Path(argv[1]) if len(argv) > 1 else Path("memory/upstream/.admin-key")
    try:
        key = key_file.read_text(encoding="utf-8").strip()
    except OSError:
        print("FAILED: admin key file is unreadable; key value was not displayed.", file=sys.stderr)
        return 2
    if not key:
        print("FAILED: admin key file is empty; key value was not displayed.", file=sys.stderr)
        return 2

    try:
        port = int(os.environ.get("MEMORY_CORE_PORT", "8420"))
    except ValueError:
        print("FAILED: MEMORY_CORE_PORT is not a valid port.", file=sys.stderr)
        return 2
    headers = {
        "Content-Type": "application/json",
        "x-tdai-service-id": "default",
    }
    gateway_key = os.environ.get("MEMORY_CORE_GATEWAY_API_KEY", "")
    if gateway_key:
        headers["Authorization"] = f"Bearer {gateway_key}"
    body = json.dumps({"user_key": key}).encode("utf-8")
    request = Request(
        f"http://127.0.0.1:{port}/v3/meta/auth/verify",
        data=body,
        headers=headers,
        method="POST",
    )
    status = 0
    payload: object = None
    try:
        with urlopen(request, timeout=5) as response:
            status = response.status
            payload = json.loads(response.read())
    except HTTPError as exc:
        status = exc.code
        try:
            payload = json.loads(exc.read())
        except (ValueError, OSError):
            payload = None
    except (URLError, TimeoutError, OSError, ValueError):
        print("FAILED: Memory Core auth/verify could not be reached or parsed.", file=sys.stderr)
        return 1
    finally:
        del key
        del body
        del request

    if not response_confirms_key(status, payload):
        print("FAILED: Memory Core auth/verify did not return data.valid=true.", file=sys.stderr)
        return 1
    print("ok — Memory Core admin key verified (auth/verify data.valid=true)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
