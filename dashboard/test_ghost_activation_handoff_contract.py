"""Source contract for the dashboard's explicit, readback-gated schedule flow."""
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parent


class GhostActivationHandoffContract(unittest.TestCase):
    def test_browser_reviews_fresh_revision_before_activation_or_update(self):
        js = (ROOT / "static/ghost/tasks.js").read_text(encoding="utf-8")
        html = (ROOT / "static/ghost/index.html").read_text(encoding="utf-8")
        self.assertIn("action: 'activation-preview'", js)
        self.assertIn("expectedRevision: plan.revision", js)
        self.assertIn("previewSha256: body.preview.sha256", js)
        self.assertIn("'register-schedule'", js)
        self.assertIn("'update-schedule'", js)
        self.assertIn("action: 'cancel-schedule'", js)
        self.assertIn("schedulerRegistered !== false", js)
        self.assertIn("executionAuthorized !== false", js)
        self.assertIn('id="activation-dialog"', html)
        self.assertIn('id="activation-confirm"', html)
        self.assertIn("fresh Task Scheduler readback", js)

    def test_server_separates_plan_ledger_from_native_readback(self):
        server = (ROOT / "server.py").read_text(encoding="utf-8")
        plans = (ROOT / "ghost_schedule_plans.py").read_text(encoding="utf-8")
        self.assertIn('path == "/api/ghost/scheduler"', server)
        self.assertIn("from native_ghost import control_request as host_request", server)
        self.assertIn("def scheduler_identity_bound", server)
        self.assertIn('"scheduler_readback_unverified"', plans)
        self.assertIn('"schedule_activation_readback_mismatch"', plans)
        self.assertIn('"previewSha256"', plans)
        self.assertIn('"ownerSid"', plans)
        self.assertNotIn('row["active"] = True', plans)


if __name__ == "__main__":
    unittest.main()
