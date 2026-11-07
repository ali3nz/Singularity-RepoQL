"""Provisioner contract tests: idempotency, independence, rollback, privacy."""
import json
import os
import tempfile
import unittest
from pathlib import Path

from provisioner import (Adapter, CONNECTED, INTEGRATIONS, NEEDS_ATTENTION, UNAVAILABLE,
                         Provisioner)


def fake(name, sequence):
    """Adapter whose detect() walks a scripted state sequence."""
    box = {"state": sequence[0], "calls": 0, "files": []}

    def detect():
        return box["state"], f"state={box['state']}"

    def ensure(created):
        box["calls"] += 1
        target = Path(created[0]).parent / f"{name}.provisioned" if created else None
        if target is not None:
            target.write_text("ok", encoding="utf-8")
            box["files"].append(target)
            created.append(target)
        box["state"] = sequence[-1]
        return f"provisioned {name}"

    return Adapter(detect, ensure), box


class ProvisionerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.state = Path(self.tmp.name) / "state"

    def tearDown(self):
        self.tmp.cleanup()

    def build(self, adapters):
        return Provisioner(self.state, adapters=adapters, clock=lambda: 1_760_000_000.0)

    def test_status_reports_every_integration_without_raising(self):
        adapters = {}
        for name in INTEGRATIONS[:4]:
            adapters[name] = fake(name, [NEEDS_ATTENTION, CONNECTED])[0]

        def broken():
            raise OSError("probe denied")

        adapters["claude_code"] = Adapter(broken, None)
        rows = self.build(adapters).status()
        self.assertEqual(len(rows), len(INTEGRATIONS))
        self.assertEqual(rows[-1]["state"], UNAVAILABLE)
        self.assertIn("detect failed", rows[-1]["detail"])

    def test_repair_is_idempotent(self):
        adapter, box = fake("kanzo", [NEEDS_ATTENTION, CONNECTED])
        adapters = {name: Adapter(lambda: (CONNECTED, "ok"), None) for name in INTEGRATIONS}
        adapters["kanzo"] = adapter
        prov = self.build(adapters)

        first = prov.repair(only=["kanzo"])
        self.assertEqual(first["failed"], 0)
        self.assertEqual(first["changed"], 1)
        self.assertEqual(box["calls"], 1)

        second = prov.repair(only=["kanzo"])
        self.assertEqual(second["changed"], 0)
        self.assertEqual(second["results"][0]["action"], "noop")
        self.assertEqual(box["calls"], 1, "connected integration must not be re-provisioned")

    def test_one_failure_does_not_block_others_and_rolls_back(self):
        good, good_box = fake("repoql", [NEEDS_ATTENTION, CONNECTED])

        def bad_detect():
            return NEEDS_ATTENTION, "missing"

        def bad_ensure(created):
            junk = self.state / "junk.bin"
            junk.write_text("partial", encoding="utf-8")
            created.append(junk)
            raise RuntimeError("vendor installer failed")

        adapters = {name: Adapter(lambda: (CONNECTED, "ok"), None) for name in INTEGRATIONS}
        adapters["repoql"] = good
        adapters["tencent"] = Adapter(bad_detect, bad_ensure)
        summary = self.build(adapters).repair(only=["repoql", "tencent"])

        self.assertEqual(summary["failed"], 1)
        self.assertEqual(len(summary["results"]), 2)
        states = {r["integration"]: r for r in summary["results"]}
        self.assertEqual(states["repoql"]["action"], "applied")
        self.assertEqual(states["tencent"]["action"], "failed")
        self.assertIn("vendor installer failed", states["tencent"]["detail"])
        self.assertFalse((self.state / "junk.bin").exists(), "failed attempt must roll back")

    def test_credentials_are_private_and_never_in_receipts(self):
        adapter, _ = fake("kanzo", [NEEDS_ATTENTION, CONNECTED])
        adapters = {name: Adapter(lambda: (CONNECTED, "ok"), None) for name in INTEGRATIONS}
        adapters["kanzo"] = adapter
        prov = self.build(adapters)
        prov.repair(only=["kanzo"])

        token = prov.credential_path("kanzo")
        self.assertTrue(token.exists())
        if os.name != "nt":
            self.assertEqual(token.stat().st_mode & 0o777, 0o600)
        secret = token.read_text(encoding="utf-8")
        self.assertGreaterEqual(len(secret), 32)

        latest = (prov.receipts_dir / "latest.json").read_text(encoding="utf-8")
        self.assertNotIn(secret, latest)
        self.assertIn(str(token), latest)
        self.assertEqual(len(secret), len(secret.strip()), "no stray newline in the token")

    def test_each_attempt_writes_a_durable_receipt(self):
        adapters = {name: Adapter(lambda: (CONNECTED, "ok"), None) for name in INTEGRATIONS}
        prov = self.build(adapters)
        prov.repair(only=["kanzo", "repoql"])
        files = sorted(p.name for p in prov.receipts_dir.iterdir())
        self.assertIn("latest.json", files)
        self.assertTrue(any(name.endswith("-kanzo.json") for name in files))
        self.assertTrue(any(name.endswith("-repoql.json") for name in files))
        payload = json.loads((prov.receipts_dir / "latest.json").read_text())
        self.assertEqual(payload["changed"], 0)

    def test_private_state_tree(self):
        prov = self.build({name: Adapter(lambda: (CONNECTED, "ok"), None) for name in INTEGRATIONS})
        if os.name != "nt":
            self.assertEqual(prov.state_dir.stat().st_mode & 0o777, 0o700)
            self.assertEqual(prov.credentials_dir.stat().st_mode & 0o777, 0o700)


if __name__ == "__main__":
    unittest.main(verbosity=2)
