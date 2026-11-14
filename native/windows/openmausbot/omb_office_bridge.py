#!/usr/bin/env python3
"""(Windows build: 18211 origin, optional token, keys.json ingest key.)
OpenMausBot SSE -> Claude Office metadata-only activity adapter.

Consumes ONE authenticated OpenMausBot event stream. No bot model calls, API
polling, session text, tool parameters, or memory writes. Never interprets
an Office event as proof of permanent idle-bot rendering.
"""
from __future__ import annotations

import json
import hashlib
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

BOT_ID = re.compile(r"^[A-Za-z0-9_-]{8,128}$")
MAX_FRAME = 256 * 1024
MAX_INVENTORY = 2_000_000
ALLOWED_OFFICE_HOSTS = {"claude-office", "product-office", "127.0.0.1", "::1"}


def checked_origins(omb: str, office: str) -> None:
    origin = urlsplit(omb)
    target = urlsplit(office)
    if (origin.scheme != "http" or origin.hostname not in {"127.0.0.1", "::1"}
            or origin.username or origin.password or origin.path not in ("", "/")
            or origin.query or origin.fragment or not origin.port):
        raise ValueError("OMB origin must be HTTP loopback with an explicit port")
    if (target.scheme != "http" or target.hostname not in ALLOWED_OFFICE_HOSTS
            or target.path != "/api/v1/events" or target.query or target.fragment
            or target.username or target.password or not target.port):
        raise ValueError("Office ingest must be a local Docker service /api/v1/events")


def read_secret(path: str) -> str:
    p = Path(path)
    if not p.is_file():
        raise ValueError("missing required protected secret file")
    value = p.read_text().strip()
    if not value or "\n" in value:
        raise ValueError("invalid required secret")
    return value


def read_office_key(path: str) -> str:
    value = json.loads(Path(path).read_text(encoding="utf-8-sig")).get("ingestKey")
    if not isinstance(value, str) or not value or "\n" in value:
        raise ValueError("invalid required secret")
    return value


def sse_messages(lines):
    """Yield bounded (cursor, parsed JSON) SSE frames with no raw logging."""
    data = []
    cursor = None
    size = 0
    overflow = False
    for raw in lines:
        line = raw.decode("utf-8", "replace") if isinstance(raw, bytes) else raw
        line = line.rstrip("\r\n")
        if not line:
            if data and not overflow:
                try:
                    frame = json.loads("\n".join(data))
                except (ValueError, UnicodeError):
                    frame = None
                if isinstance(frame, dict):
                    yield cursor, frame
            data, cursor, size, overflow = [], None, 0, False
            continue
        if line.startswith("id:"):
            cursor = line[3:].strip()[:200]
        elif line.startswith("data:"):
            value = line[5:].lstrip(" ")
            size += len(value)
            if size > MAX_FRAME:
                overflow = True
                data.clear()
            elif not overflow:
                data.append(value)


def office_session_id(bot_id: str) -> str:
    """Stable Office identity within its upstream 128-character session ID cap.

    Preserve existing seat IDs for normal bots. Long imported OpenMausBot IDs
    need a deterministic suffix to avoid silent truncation/collisions.
    """
    if not isinstance(bot_id, str) or not BOT_ID.fullmatch(bot_id):
        raise ValueError("invalid OpenMausBot bot identity")
    prefix = "openmausbot-"
    if len(prefix) + len(bot_id) <= 128:
        return prefix + bot_id
    return prefix + bot_id[:64] + "-" + hashlib.sha256(bot_id.encode("ascii")).hexdigest()[:32]


def safe_name(value, bot_id: str) -> str:
    if not isinstance(value, str):
        return "MausBot " + bot_id[-8:]
    name = "".join(ch for ch in value if ch.isprintable() and ch not in "\r\n\t").strip()
    return name[:64] or ("MausBot " + bot_id[-8:])


class OfficeMapper:
    """Maps only roster-owned bot/threads to whitelisted Office metadata."""
    def __init__(self):
        self.bots = {}
        self.threads = {}
        self.active = set()

    def remember_bot(self, bot):
        if not isinstance(bot, dict):
            return
        bot_id = bot.get("id")
        if not isinstance(bot_id, str) or not BOT_ID.fullmatch(bot_id):
            return
        self.bots[bot_id] = safe_name(bot.get("name"), bot_id)
        tids = [bot.get("threadId"), bot.get("mainThreadId")]
        tids += [t.get("threadId") for t in bot.get("tasks", [])
                 if isinstance(t, dict)] if isinstance(bot.get("tasks"), list) else []
        # A bot's task roster can change. Retire stale thread mappings before
        # accepting its latest server-owned set.
        self.threads = {tid: owner for tid, owner in self.threads.items()
                        if owner != bot_id}
        for tid in tids:
            if isinstance(tid, str) and BOT_ID.fullmatch(tid):
                self.threads[tid] = bot_id

    def seat_event(self, bot_id, event_type, extra=None):
        office_id = office_session_id(bot_id)
        return {
            "event_type": event_type,
            "session_id": office_id,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "data": {
                "agent_id": office_id,
                "native_agent_id": bot_id,
                # Office derives displayName from project_name; its event
                # schema ignores display_name. Use the actual bot label.
                "project_name": self.bots[bot_id],
                "source": "openmausbot",
                **(extra or {}),
            },
        }

    def mapped_events(self, frame):
        kind = frame.get("kind")
        if kind == "bot.deleted":
            bot_id = frame.get("botId")
            if bot_id not in self.bots:
                return []
            # Only bot deletion is a genuine departure. Engine processes exit
            # between turns, but the persistent bot and its Office seat remain.
            event = self.seat_event(bot_id, "session_end")
            self.bots.pop(bot_id)
            self.threads = {tid: owner for tid, owner in self.threads.items()
                            if owner != bot_id}
            self.active = {item for item in self.active if item[0] != bot_id}
            return [event]
        if kind == "bot":
            bot = frame.get("bot")
            bot_id = bot.get("id") if isinstance(bot, dict) else None
            was_known = bot_id in self.bots if isinstance(bot_id, str) else False
            self.remember_bot(bot)
            if not isinstance(bot_id, str) or bot_id not in self.bots or was_known:
                return []
            # A newly created bot joins the Office even before its first model
            # turn. Use the same identity for the subsequent actual activity.
            return [self.seat_event(bot_id, "session_start"),
                    self.seat_event(bot_id, "stop")]
        if kind != "runtime" or not isinstance(frame.get("event"), dict):
            return []
        event = frame["event"]
        thread_id = event.get("threadId")
        bot_id = self.threads.get(thread_id)
        if not bot_id:
            return []
        typ = event.get("type")
        types = {
            "turn.started": ("session_start", {}),
            "turn.completed": ("stop", {}),
            "session.exited": ("stop", {}),
        }
        if typ in types:
            office_type, extra = types[typ]
        elif typ == "item.started" and event.get("itemType") == "tool":
            office_type, extra = "pre_tool_use", {"tool_name": "tool"}
        elif typ == "item.completed" and event.get("itemType") == "tool":
            office_type, extra = "post_tool_use", {"tool_name": "tool", "success": event.get("ok") is True}
        else:
            return []
        if typ == "turn.started":
            already = any(owner == bot_id for owner, _ in self.active)
            self.active.add((bot_id, thread_id))
            if already:
                return []
        elif typ in ("turn.completed", "session.exited"):
            was_active = (bot_id, thread_id) in self.active
            self.active.discard((bot_id, thread_id))
            # Another thread is still active. Nor should an engine-exit event
            # duplicate the stop already emitted at turn completion.
            if any(owner == bot_id for owner, _ in self.active) or (typ == "session.exited" and not was_active):
                return []
        return [self.seat_event(bot_id, office_type, extra)]


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def request_json(opener, endpoint, token):
    req = urllib.request.Request(endpoint, headers={
        **({"Authorization": "Bearer " + token} if token else {}), "Accept": "application/json",
    })
    with opener.open(req, timeout=8) as response:
        if response.status != 200:
            raise RuntimeError("inventory unavailable")
        raw = response.read(MAX_INVENTORY + 1)
        if len(raw) > MAX_INVENTORY:
            raise RuntimeError("bot inventory exceeds safe limit")
        obj = json.loads(raw)
        if not isinstance(obj, dict) or not isinstance(obj.get("bots"), list):
            raise RuntimeError("bot inventory schema changed")
        return obj["bots"]


class OfficeRefused(Exception):
    pass


class OfficeDeliveryUnavailable(Exception):
    """A delivery was not acknowledged; continuing could silently lose an event."""
    pass


def send_office(opener, endpoint, secret, payload):
    body = json.dumps(payload, separators=(",", ":")).encode("utf8")
    req = urllib.request.Request(endpoint, data=body, method="POST", headers={
        "Content-Type": "application/json", "X-API-Key": secret,
    })
    try:
        with opener.open(req, timeout=2) as res:
            if res.status not in (200, 201, 202, 204):
                raise OfficeDeliveryUnavailable("Claude Office did not acknowledge an event")
    except urllib.error.HTTPError as exc:
        if 400 <= exc.code < 500:
            raise OfficeRefused("Claude Office authentication or rate limit refusal") from None
        raise OfficeDeliveryUnavailable("Claude Office event delivery failed") from None
    except (urllib.error.URLError, TimeoutError, OSError):
        raise OfficeDeliveryUnavailable("Claude Office event delivery failed") from None


def run() -> int:
    origin = os.environ.get("OMB_ORIGIN", "http://127.0.0.1:18211").rstrip("/")
    office = os.environ.get("OFFICE_EVENTS_URL", "http://127.0.0.1:18128/api/v1/events")
    checked_origins(origin, office)
    # Windows: the bundled OpenMausBot is loopback --no-pair, so a token is
    # optional; the Office ingest key is read in-process from its keys.json.
    token = ""
    if os.environ.get("OMB_TOKEN_FILE"):
        token = read_secret(os.environ["OMB_TOKEN_FILE"])
    office_key = read_office_key(os.environ["OFFICE_KEYS_JSON"])
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect)
    mapper = OfficeMapper()
    for bot in request_json(opener, origin + "/api/bots?messages=0", token):
        mapper.remember_bot(bot)
    since = None
    delay = 5
    while True:
        url = origin + "/api/events?screens=off"
        if since:
            from urllib.parse import quote
            url += "&since=" + quote(since, safe="")
        request = urllib.request.Request(url, headers={
            **({"Authorization": "Bearer " + token} if token else {}), "Accept": "text/event-stream",
        })
        try:
            with opener.open(request, timeout=70) as response:
                if response.status != 200 or "text/event-stream" not in response.headers.get("Content-Type", ""):
                    raise RuntimeError("not an OpenMausBot SSE stream")
                delay = 5
                for cursor, frame in sse_messages(response):
                    if cursor:
                        since = cursor
                    if frame.get("kind") == "hello" and frame.get("resumed") is False:
                        # Gap in cursor replay: rebuild identity map once.
                        mapper = OfficeMapper()
                        for bot in request_json(opener, origin + "/api/bots?messages=0", token):
                            mapper.remember_bot(bot)
                    for event in mapper.mapped_events(frame):
                        send_office(opener, office, office_key, event)
        except OfficeRefused:
            print("Claude Office refused events; bridge stopped without retry", file=sys.stderr)
            return 2
        except OfficeDeliveryUnavailable:
            print("Claude Office delivery was not acknowledged; bridge stopped for manual reconciliation", file=sys.stderr)
            return 2
        except urllib.error.HTTPError as exc:
            # No repeated attempts after auth or rate-limit refusals.
            if exc.code in (401, 403, 404, 429) or 400 <= exc.code < 500:
                print("OpenMausBot stream refused; bridge stopped", file=sys.stderr)
                return 2
        except (urllib.error.URLError, TimeoutError, OSError, RuntimeError, ValueError):
            pass
        time.sleep(delay)
        delay = min(60, delay * 2)


if __name__ == "__main__":
    try:
        sys.exit(run())
    except (KeyError, ValueError, RuntimeError, OSError, urllib.error.HTTPError):
        print("Office bridge configuration or initial inventory invalid; bridge stopped", file=sys.stderr)
        sys.exit(2)
