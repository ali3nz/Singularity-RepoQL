"""Exercise the native host GET /state payload through dashboard validation."""
from __future__ import annotations

from dataclasses import replace
import json
from pathlib import Path
import sys
import threading
import unittest
from urllib.request import Request, urlopen


HERE = Path(__file__).resolve().parent
WINDOWS_DIR = HERE.parent
sys.path.insert(0, str(WINDOWS_DIR))

import ghost_scheduler_host as host_mod  # noqa: E402
import ghost_schedule_plans as dashboard_plans  # noqa: E402
from test_ghost_scheduler_host import FakeTaskScheduler, GhostHostTests  # noqa: E402


class HostDashboardContractTests(unittest.TestCase):
    def test_live_host_get_payload_passes_dashboard_readback_validator(self):
        fixture = GhostHostTests()
        fixture.setUp()
        server = None
        thread = None
        try:
            config = replace(fixture.config, listen_port=0)
            scheduler = FakeTaskScheduler()
            host = host_mod.GhostScheduler(
                config,
                scheduler,
                drafts=fixture.drafts,
                runner=lambda _prompt: 0,
                clock=fixture.host.clock,
            )
            status, _ = host.handle_action(
                {
                    "action": "register-schedule",
                    "confirm": True,
                    "requestId": "contract_0001",
                    "draftId": "a" * 32,
                    "expectedDraftRevision": 1,
                }
            )
            self.assertEqual(status, 200)
            server = host_mod.create_http_server(host)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            endpoint = f"http://127.0.0.1:{server.server_address[1]}/state"

            def get_state(method, body):
                self.assertEqual(method, "GET")
                self.assertIsNone(body)
                request = Request(
                    endpoint,
                    headers={"X-Ghost-Control-Key": config.control_key},
                    method="GET",
                )
                with urlopen(request, timeout=3) as response:
                    return response.status, json.loads(response.read())

            code, public, verified = dashboard_plans._scheduler_readback(get_state)
            self.assertEqual(code, 200)
            self.assertTrue(public["verified"])
            self.assertTrue(verified["capabilities"]["readback"])
            self.assertEqual(len(public["schedules"]), 1)
            self.assertEqual(
                public["schedules"][0]["jobId"],
                verified["schedules"][0]["jobId"],
            )
        finally:
            if server is not None:
                server.shutdown()
                server.server_close()
            if thread is not None:
                thread.join(timeout=3)
            fixture.tearDown()


if __name__ == "__main__":
    unittest.main()
