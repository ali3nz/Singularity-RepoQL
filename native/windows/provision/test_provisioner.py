"""Provisioner contract tests: idempotency, independence, rollback, privacy."""
import json
import os
import socket
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from provisioner import (Adapter, CONNECTED, INTEGRATIONS, NEEDS_ATTENTION, UNAVAILABLE,
                         Provisioner, build_adapters)

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "openmausbot"))
import headless  # noqa: E402


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

    def test_detect_only_integration_reports_its_real_state(self):
        # No automated repair must not turn a connected integration into a
        # fabricated needs-attention row.
        adapters = {name: Adapter(lambda: (CONNECTED, "ok"), None) for name in INTEGRATIONS}
        row = self.build(adapters).repair(only=["tencent"])["results"][0]
        self.assertEqual(row["action"], "skipped")
        self.assertEqual(row["state_before"], CONNECTED)
        self.assertEqual(row["state_after"], CONNECTED)

    def test_concurrent_credential_creation_reuses_the_winner(self):
        # Two repairs may race on the same integration; the loser must adopt the
        # existing private credential instead of failing or overwriting it.
        prov = self.build({name: Adapter(lambda: (CONNECTED, "ok"), None) for name in INTEGRATIONS})
        path, created = prov.ensure_credential("kanzo")
        self.assertTrue(created)
        original = path.read_text(encoding="utf-8")
        with patch("provisioner.os.open", side_effect=FileExistsError):
            again, created_again = prov.ensure_credential("kanzo")
        self.assertFalse(created_again)
        self.assertEqual(again, path)
        self.assertEqual(again.read_text(encoding="utf-8"), original)

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


class RealAdapterTests(unittest.TestCase):
    """The default factory must probe real, overridable, local locations only."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)

    def adapters(self, **env):
        values = {k: str(v) for k, v in env.items()}
        values.setdefault("PATH", os.environ.get("PATH", ""))
        return build_adapters(values)

    def node_shim(self) -> Path:
        """A `node` that claims the package's minimum version."""
        if os.name == "nt":
            return Path(sys.executable)
        shim = self.root / "bin" / "node"
        shim.parent.mkdir(parents=True, exist_ok=True)
        shim.write_text('#!/bin/sh\nif [ "$1" = "-v" ]; then echo v24.0.0; exit 0; fi\nexit 0\n')
        shim.chmod(0o755)
        return shim

    def test_kanzo_and_repoql_use_explicit_binaries(self):
        kanzo = self.root / "kanzo.exe"
        rql = self.root / "rql.exe"
        kanzo.write_bytes(b"MZ")
        rql.write_bytes(b"MZ")
        adapters = self.adapters(SINGULARITY_KANZO_EXE=kanzo, SINGULARITY_RQL_EXE=rql)
        self.assertEqual(adapters["kanzo"].detect()[0], CONNECTED)
        self.assertEqual(adapters["repoql"].detect()[0], CONNECTED)
        missing = self.adapters(SINGULARITY_KANZO_EXE=self.root / "nope.exe", PATH="")
        self.assertEqual(missing["kanzo"].detect()[0], NEEDS_ATTENTION)

    def test_claude_uses_the_per_user_install_path(self):
        bin_dir = self.root / ".local" / "bin"
        bin_dir.mkdir(parents=True)
        (bin_dir / "claude.exe").write_bytes(b"MZ")
        adapters = self.adapters(USERPROFILE=self.root, SINGULARITY_CLAUDE_EXE=self.root / "absent")
        state, detail = adapters["claude_code"].detect()
        self.assertEqual(state, CONNECTED)
        self.assertIn("login is the owner's step", detail)
        empty = self.adapters(USERPROFILE=self.root / "other")
        self.assertEqual(empty["claude_code"].detect()[0], NEEDS_ATTENTION)

    def test_tencent_probes_the_configured_panel_port(self):
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            sock.listen(1)
            port = sock.getsockname()[1]
            adapters = self.adapters(SINGULARITY_TENCENT_PANEL_PORT=port)
            self.assertEqual(adapters["tencent"].detect()[0], CONNECTED)
        adapters = self.adapters(SINGULARITY_TENCENT_PANEL_PORT=port)
        self.assertEqual(adapters["tencent"].detect()[0], NEEDS_ATTENTION)
        self.assertEqual(self.adapters(SINGULARITY_TENCENT_PANEL_PORT="x")["tencent"].detect()[0],
                         UNAVAILABLE)

    def test_tencent_repair_refuses_without_a_staged_stack(self):
        adapters = self.adapters(SINGULARITY_TENCENT_PANEL_PORT=1)
        with self.assertRaises(RuntimeError) as caught:
            adapters["tencent"].ensure([])
        self.assertIn("not staged", str(caught.exception))

    def test_openmausbot_delegates_to_the_headless_lane(self):
        site = self.root / "rc"
        (site / "stage" / "omb" / "dist-server").mkdir(parents=True)
        (site / "stage" / "omb" / "cli.js").write_text("// cli\n")
        (site / "stage" / "omb" / headless.MARKER).write_text("// bundle\n")
        adapters = self.adapters(SINGULARITY_OMB_ROOT=site, SINGULARITY_OMB_STATE=site / "state",
                                 SINGULARITY_OMB_NODE=self.node_shim(), SINGULARITY_OMB_PORT=1)
        state, detail = adapters["openmausbot"].detect()
        self.assertEqual(state, NEEDS_ATTENTION)
        self.assertIn("not answering", detail)
        empty = self.adapters(SINGULARITY_OMB_ROOT=self.root / "bare")
        self.assertEqual(empty["openmausbot"].detect()[0], NEEDS_ATTENTION)


if __name__ == "__main__":
    unittest.main(verbosity=2)
