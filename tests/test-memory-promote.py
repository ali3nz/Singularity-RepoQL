#!/usr/bin/env python3
"""Regression tests for the promotion scanner's Memory Core contract.

Verified against the shipped image: POST /v3/conversation/search requires a
`query` field (400 without one), and the paginated listing lives at
POST /v3/conversation/query with records under data.messages. The scanner must
use QUERY and parse that shape.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
import urllib.request
from unittest import mock
from pathlib import Path

sys.path.insert(0, "scripts")

import memory_promote  # noqa: E402  (path inserted above)

# The scanner reads auth secrets from memory.json; tests point the loader at
# a fixture (values are obviously synthetic, never real).
def _seed_secrets() -> None:
    fixture = json.dumps({"authPrefix": "Bearer ", "gatewayKey": "synthetic-gw-key", "serviceId": "synthetic-service", "userKey": ""})
    tmp = Path(tempfile.mkdtemp(prefix="promote-secrets-")) / "memory.json"
    tmp.write_text(fixture)
    os.environ["MEMORY_SECRETS"] = str(tmp)
    os.environ.setdefault("MEMORY_CORE_BASE_URL", "http://127.0.0.1:8420")


_seed_secrets()


def seeded_env(monkeypatch_target, captured, payload):
    """Stub urlopen to capture requests and return a canned payload."""

    class FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def read(self):
            return json.dumps(payload).encode()

    def fake_urlopen(req, timeout=None):
        captured.append(
            {"url": req.full_url, "body": json.loads(req.data.decode()), "headers": dict(req.header_items())}
        )
        return FakeResponse()

    patcher = mock.patch(monkeypatch_target, fake_urlopen)
    patcher.start()
    return patcher


class CompactRecords(unittest.TestCase):
    def test_documented_v3_shape_parses_data_messages(self):
        doc = {
            "code": 0,
            "data": {
                "messages": [
                    {"id": "msg-1", "role": "user", "content": "decision text", "timestamp": "2026-10-19T10:00:00Z"},
                    {"id": "msg-2", "role": "assistant", "content": "ok", "timestamp": "2026-10-19T10:00:01Z"},
                ],
                "total": 2,
            },
        }
        rows = memory_promote.compact_records(doc)
        self.assertEqual([r["id"] for r in rows], ["msg-1", "msg-2"])
        self.assertTrue(all(r["excerpt"] for r in rows))
        self.assertGreater(rows[0]["ts"], 0)

    def test_legacy_list_and_flat_shapes_still_work(self):
        flat = [{"id": "a", "content": "x", "timestamp": "2026-10-19T10:00:00Z"}]
        self.assertEqual(memory_promote.compact_records(flat)[0]["id"], "a")
        legacy = {"messages": [{"id": "b", "text": "y"}]}
        self.assertEqual(memory_promote.compact_records(legacy)[0]["id"], "b")

    def test_unknown_shape_returns_no_guessed_rows(self):
        self.assertEqual(memory_promote.compact_records({"error": "boom"}), [])


class SearchUsesQueryEndpoint(unittest.TestCase):
    def tearDown(self):
        sys.argv = sys.argv[:1]

    def test_search_posts_conversation_query_with_scope_and_paging(self):
        captured: list = []
        payload = {"code": 0, "data": {"messages": [], "total": 0}}
        patcher = seeded_env("urllib.request.urlopen", captured, payload)
        self.addCleanup(patcher.stop)
        result = memory_promote.search("http://127.0.0.1:8420", {"team_id": "t", "user_id": "u", "agent_id": "a"}, 20)
        self.assertEqual(len(captured), 1)
        self.assertTrue(captured[0]["url"].endswith("/v3/conversation/query"))
        self.assertFalse(captured[0]["url"].endswith("/v3/conversation/search"))
        body = captured[0]["body"]
        self.assertEqual(body["team_id"], "t")
        self.assertEqual(body["offset"], 0)
        self.assertEqual(body["limit"], 20)
        self.assertEqual(result, payload)


if __name__ == "__main__":
    unittest.main(verbosity=2)
