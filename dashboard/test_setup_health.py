"""Setup health / Repair contract tests (isolated state dirs, loopback only)."""
import json
import os
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

import http.client

from repoql_bridge import Config
from server import build_server

INTEGRATIONS = {"kanzo", "repoql", "tencent", "openmausbot", "claude_code"}
STATES = {"connected", "needs-attention", "not-available"}


class Base(unittest.TestCase):
    mode = None

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.state = root / "provision"
        env = {
            "SINGULARITY_LOCAL_ACCOUNT_AUTH": "1",
            "SINGULARITY_PROVISION_STATE_DIR": str(self.state),
        }
        if self.mode is not None:
            env["SINGULARITY_DASHBOARD_AUTH_MODE"] = self.mode
        self.env = patch.dict(os.environ, env, clear=False)
        self.env.start()
        config = Config(workspace=root, rql=root / "rql", state_dir=root / "state",
                        bind="127.0.0.1", port=0, allow_peers=("127.0.0.1/32",))
        self.server = build_server(config)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.port = self.server.server_address[1]

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.env.stop()
        self.temp.cleanup()

    def request(self, path, *, method="GET", headers=None, payload=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        body = json.dumps(payload).encode() if payload is not None else None
        conn.request(method, path, body=body, headers=headers or {})
        response = conn.getresponse()
        data = response.read()
        result = (response.status, dict((k.lower(), v) for k, v in response.getheaders()), data)
        conn.close()
        return result

    def mutation_headers(self):
        return {"Origin": f"http://127.0.0.1:{self.port}",
                "X-Requested-With": "repoql-dashboard",
                "Content-Type": "application/json",
                "Sec-Fetch-Site": "same-origin"}


class AutoLocalSetupHealth(Base):
    mode = None

    def test_setup_page_renders_every_integration(self):
        status, headers, body = self.request("/setup")
        self.assertEqual(status, 200)
        self.assertIn("text/html", headers.get("content-type", ""))
        text = body.decode()
        self.assertIn("Setup health", text)
        for name in INTEGRATIONS:
            self.assertIn(name, text)
        self.assertIn("/api/setup/repair", text)

    def test_health_endpoint_reports_honest_states(self):
        status, _, body = self.request("/api/setup/health")
        self.assertEqual(status, 200)
        rows = json.loads(body)["rows"]
        self.assertEqual({r["integration"] for r in rows}, INTEGRATIONS)
        for row in rows:
            self.assertIn(row["state"], STATES)
            self.assertTrue(row["detail"])

    def test_repair_runs_only_the_requested_integration(self):
        status, _, body = self.request("/api/setup/repair", method="POST",
                                       headers=self.mutation_headers(),
                                       payload={"only": ["tencent"]})
        self.assertEqual(status, 200)
        summary = json.loads(body)
        self.assertEqual([r["integration"] for r in summary["results"]], ["tencent"])
        self.assertIn("changed", summary)
        self.assertTrue((self.state / "receipts" / "latest.json").exists(),
                        "repair must leave a durable receipt")

    def test_repair_without_origin_is_refused(self):
        status, _, _ = self.request("/api/setup/repair", method="POST",
                                    headers={"Content-Type": "application/json"},
                                    payload={"only": ["tencent"]})
        self.assertEqual(status, 403)

    def test_repair_rejects_malformed_only(self):
        status, _, _ = self.request("/api/setup/repair", method="POST",
                                    headers=self.mutation_headers(), payload={"only": "tencent"})
        self.assertEqual(status, 400)

    def test_no_credential_value_is_rendered(self):
        self.request("/api/setup/repair", method="POST", headers=self.mutation_headers(),
                     payload={"only": ["kanzo"]})
        _, _, page = self.request("/setup")
        text = page.decode()
        for token in (self.state / "credentials").glob("*.token") if (self.state / "credentials").exists() else []:
            self.assertNotIn(token.read_text(), text)


class PasswordModeSetupHealth(Base):
    mode = "password"

    def test_health_requires_a_session(self):
        status, _, _ = self.request("/api/setup/health")
        self.assertEqual(status, 401)

    def test_setup_page_requires_a_session(self):
        status, _, _ = self.request("/setup")
        self.assertEqual(status, 401)


if __name__ == "__main__":
    unittest.main(verbosity=2)
