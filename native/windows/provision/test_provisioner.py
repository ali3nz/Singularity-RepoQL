"""Provisioner contract tests: idempotency, independence, rollback, privacy."""
import json
import os
import shutil
import socket
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import provisioner
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
        receipt = json.loads(latest)
        self.assertEqual(receipt["results"][0]["credential"], str(token))
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
            node = shutil.which("node")
            if not node:
                self.skipTest("Node.js is required for the OpenMausBot runtime contract")
            return Path(node)
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

    def test_kanzo_and_office_repair_delegate_to_rc_services(self):
        adapters = self.adapters()
        fake = SimpleNamespace(
            defaults=lambda env: {}, layout=lambda d: {"office_port": 1},
            ensure_kanzo=Mock(return_value={"port": 4999}),
            ensure_office=Mock(return_value={"ok": True}))
        with patch.object(provisioner, "_rc_services", return_value=fake):
            self.assertIn("4999", adapters["kanzo"].ensure([]))
            self.assertIn("Office started", adapters["office"].ensure([]))
        fake.ensure_kanzo.assert_called_once()
        fake.ensure_office.assert_called_once()
        self.assertIn("office", INTEGRATIONS)

    def test_claude_uses_the_per_user_install_path(self):
        bin_dir = self.root / ".local" / "bin"
        bin_dir.mkdir(parents=True)
        (bin_dir / "claude.exe").write_bytes(b"MZ")
        adapters = self.adapters(USERPROFILE=self.root, SINGULARITY_CLAUDE_EXE=self.root / "absent")
        state, detail = adapters["claude_code"].detect()
        self.assertEqual(state, NEEDS_ATTENTION)
        self.assertIn("repoql@repoql-plugins is not installed", detail)
        plugins = self.root / ".claude" / "plugins"
        plugins.mkdir(parents=True)
        (plugins / "installed_plugins.json").write_text(
            '{"plugins": {"repoql@repoql-plugins": [{"version": "1.7.18"}]}}', encoding="utf-8")
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

    def test_tencent_repair_names_the_missing_vendor_input(self):
        # With no pre-staged config the adapter builds and starts the RC-owned
        # stack; on a machine without the vendor runtime it must fail naming the
        # exact missing input, never fall back to a stub.
        adapters = self.adapters(SINGULARITY_TENCENT_PANEL_PORT=1, LOCALAPPDATA=self.root)
        with self.assertRaises(RuntimeError) as caught:
            adapters["tencent"].ensure([])
        self.assertIn("node is missing", str(caught.exception))

    def test_tencent_native_default_port_is_the_rc_panel(self):
        adapters = self.adapters(LOCALAPPDATA=self.root, SINGULARITY_WINDOWS_NATIVE="1")
        with patch.object(provisioner, "_port_open", return_value=False) as probe:
            state, detail = adapters["tencent"].detect()
        probe.assert_called_once_with("127.0.0.1", 18126)
        self.assertEqual(state, NEEDS_ATTENTION)
        self.assertIn("18126", detail)

    def test_openmausbot_delegates_to_the_headless_lane(self):
        site = self.root / "rc"
        (site / "stage" / "omb" / "dist-server").mkdir(parents=True)
        (site / "stage" / "omb" / "cli.js").write_text("// cli\n")
        (site / "stage" / "omb" / headless.MARKER).write_text("// bundle\n")
        adapters = self.adapters(SINGULARITY_OMB_ROOT=site, SINGULARITY_OMB_STATE=site / "state",
                                 SINGULARITY_OMB_NODE=self.node_shim(), SINGULARITY_OMB_PORT=1024)
        state, detail = adapters["openmausbot"].detect()
        self.assertEqual(state, NEEDS_ATTENTION)
        self.assertIn("not answering", detail)
        low = self.adapters(SINGULARITY_OMB_ROOT=site, SINGULARITY_OMB_STATE=site / "state",
                            SINGULARITY_OMB_NODE=self.node_shim(), SINGULARITY_OMB_PORT=1)
        self.assertEqual(low["openmausbot"].detect()[0], UNAVAILABLE)
        empty = self.adapters(SINGULARITY_OMB_ROOT=self.root / "bare")
        self.assertEqual(empty["openmausbot"].detect()[0], NEEDS_ATTENTION)

    def test_openmausbot_repair_does_not_generate_a_dashboard_credential(self):
        adapters = self.adapters(SINGULARITY_OMB_ROOT=self.root / "rc",
                                 SINGULARITY_OMB_STATE=self.root / "rc" / "state",
                                 SINGULARITY_OMB_NODE="node.exe")
        adapter = adapters["openmausbot"]
        self.assertFalse(adapter.requires_credential)
        states = iter([(NEEDS_ATTENTION, "bot missing"), (CONNECTED, "ready")])
        adapter.detect = lambda: next(states)
        adapter.ensure = lambda _created: "initial bot reused"
        state_dir = self.root / "openmausbot-state"
        provisioner = Provisioner(state_dir, adapters={"openmausbot": adapter}, clock=lambda: 1_760_000_000.0)
        result = provisioner.repair(only=["openmausbot"])
        self.assertEqual(result["failed"], 0)
        self.assertFalse((state_dir / "credentials" / "openmausbot.token").exists())

    def test_openmausbot_verify_is_read_only_and_bot_only_apply_reuses_existing(self):
        site = self.root / "rc"
        if os.name != "nt":
            self.skipTest("native Windows adapter path")
        module = SimpleNamespace(
            DEFAULT_PORT=18211,
            detect=Mock(return_value=(CONNECTED, "headless OMB is ready")),
            payload_ready=Mock(return_value=True),
            start_via_task=Mock(return_value={"started": False}),
        )
        env = {"LOCALAPPDATA": str(self.root), "SINGULARITY_OMB_ROOT": str(site),
               "SINGULARITY_OMB_STATE": str(site / "state"), "SINGULARITY_OMB_NODE": "node.exe",
               "SINGULARITY_WINDOWS_OMB_PORT": "18211", "PATH": ""}
        verified_report = {
            "present": True, "ambiguous": False, "botRegistrationVerified": True,
            "botConfigVerified": True, "otherBotsPreserved": True,
            "botOnlyBoundaryVerified": True,
        }
        report = json.dumps(verified_report)
        with patch.object(provisioner, "_sibling_module", return_value=module), \
             patch.object(provisioner.subprocess, "run", return_value=SimpleNamespace(
                 returncode=0, stdout=report, stderr="")) as run:
            adapters = build_adapters(env)
            self.assertEqual(adapters["openmausbot"].detect()[0], CONNECTED)
            self.assertIn("--verify-bot", run.call_args.args[0])
            self.assertNotIn("--apply", run.call_args.args[0])

            mismatched = dict(verified_report, botConfigVerified=False)
            run.return_value = SimpleNamespace(returncode=0, stdout=json.dumps(mismatched), stderr="")
            state, detail = adapters["openmausbot"].detect()
            self.assertEqual(state, NEEDS_ATTENTION)
            self.assertIn("configuration", detail)

            missing_readback = json.dumps({"botRegistrationVerified": True, "botReused": True})
            run.return_value = SimpleNamespace(returncode=0, stdout=missing_readback, stderr="")
            with self.assertRaisesRegex(RuntimeError, "configuration or bot-only boundary"):
                adapters["openmausbot"].ensure([])

            applied = json.dumps(dict(verified_report,
                                      botReused=True, scheduleRequested=False,
                                      scheduleCreated=False, scheduleVerified=False,
                                      chatReportVerified=False, liveRulesLoadedVerified=False,
                                      reloadRequired=False))
            module.start_via_task.reset_mock()
            run.return_value = SimpleNamespace(returncode=0, stdout=applied, stderr="")
            self.assertIn("initial bot reused", adapters["openmausbot"].ensure([]))
            command = run.call_args.args[0]
            self.assertIn("--apply", command)
            self.assertIn("--bot-only", command)
            module.start_via_task.assert_called_once_with(site, site / "state", "node.exe", port=18211)
            self.assertFalse((self.root / "openmausbot-state" / "credentials" / "openmausbot.token").exists())


class OpenMausBotMcpPairingTests(unittest.TestCase):
    """Desktop MCP pairing lane: token validation, honest ensure, no leaks."""

    TOKEN = "omb_sess_" + "A1b2C3d4E5f6G7h8"

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.local = self.root / "local"
        self.env = {"LOCALAPPDATA": str(self.local), "USERNAME": "tester",
                    "USERDOMAIN": "HOST", "PATH": ""}
        self.token = self.local / "Singularity" / "OpenMausBot" / "mcp-session.token"

    def tearDown(self):
        self.tmp.cleanup()

    def install_desktop(self):
        base = self.local / "Programs" / "OpenMausBot"
        (base / "resources" / "server").mkdir(parents=True)
        (base / "OpenMausBot.exe").write_bytes(b"MZ")

    def write_token(self, value: str):
        self.token.parent.mkdir(parents=True, exist_ok=True)
        self.token.write_text(value, encoding="utf-8")

    def adapter(self, **extra):
        return provisioner.build_adapters({**self.env, **extra})["openmausbot_mcp"]

    def assert_no_token(self, *texts):
        for text in texts:
            self.assertNotIn(self.TOKEN, text)
            self.assertNotIn("omb_sess_", text)
            self.assertNotIn("A1b2C3d4", text)

    def test_integration_is_registered_beside_the_headless_lane(self):
        self.assertIn("openmausbot_mcp", INTEGRATIONS)
        self.assertIn("openmausbot", INTEGRATIONS)
        self.assertEqual(len(set(INTEGRATIONS)), len(INTEGRATIONS))
        self.assertFalse(self.adapter().requires_credential)

    def test_missing_desktop_is_unavailable(self):
        state, detail = self.adapter().detect()
        self.assertEqual(state, UNAVAILABLE)
        self.assertIn("not installed", detail)

    def test_installed_without_token_needs_attention(self):
        self.install_desktop()
        state, detail = self.adapter().detect()
        self.assertEqual(state, NEEDS_ATTENTION)
        self.assertIn("no OpenMausBot MCP session token", detail)

    def test_well_formed_token_connects_without_echoing_it(self):
        self.install_desktop()
        self.write_token(self.TOKEN + "\n")
        state, detail = self.adapter().detect()
        self.assertEqual(state, CONNECTED)
        self.assert_no_token(detail)

    def test_bad_formats_are_rejected_without_echo(self):
        self.install_desktop()
        bad_values = [
            "omb_sess_short",                  # suffix under 12 characters
            "sess_" + "A" * 20,                # wrong prefix
            "omb_sess_" + "A" * 12 + "/x",     # illegal character
            self.TOKEN + " trailing words",    # embedded whitespace
            self.TOKEN + "!",                  # punctuation
            "émb_sess_" + "A" * 20,       # non-ASCII
        ]
        for value in bad_values:
            with self.subTest(value=value[:12]):
                self.write_token(value)
                state, detail = self.adapter().detect()
                self.assertEqual(state, NEEDS_ATTENTION)
                self.assertIn("unexpected format", detail)
                self.assert_no_token(detail)

    def test_oversized_token_file_is_refused(self):
        self.install_desktop()
        self.write_token("omb_sess_" + "A" * 5000)
        state, detail = self.adapter().detect()
        self.assertEqual(state, NEEDS_ATTENTION)
        self.assertIn("oversized", detail)
        self.assert_no_token(detail)

    def test_symlinked_token_is_refused(self):
        self.install_desktop()
        target = self.root / "elsewhere.token"
        target.write_text(self.TOKEN, encoding="utf-8")
        self.token.parent.mkdir(parents=True, exist_ok=True)
        try:
            os.symlink(target, self.token)
        except (OSError, NotImplementedError):
            self.skipTest("symbolic links need privilege on this host")
        state, detail = self.adapter().detect()
        self.assertEqual(state, NEEDS_ATTENTION)
        self.assertIn("link", detail)
        self.assert_no_token(detail)

    def test_directory_at_token_path_is_not_a_regular_file(self):
        self.install_desktop()
        self.token.mkdir(parents=True)
        state, detail = self.adapter().detect()
        self.assertEqual(state, NEEDS_ATTENTION)
        self.assertIn("not a regular file", detail)

    def test_ensure_without_desktop_asks_the_user_and_fakes_nothing(self):
        state_dir = self.root / "state"
        adapters = provisioner.build_adapters(self.env)
        with patch.object(provisioner.subprocess, "run") as run:
            result = Provisioner(state_dir, adapters={"openmausbot_mcp": adapters["openmausbot_mcp"]},
                                 clock=lambda: 1_760_000_000.0).repair(only=["openmausbot_mcp"])
        run.assert_not_called()
        row = result["results"][0]
        self.assertEqual(row["action"], "needs_user_action")
        self.assertFalse(row["changed"])
        self.assertEqual(result["failed"], 0)
        self.assertIn("install OpenMausBot", row["detail"])
        self.assertFalse((state_dir / "credentials" / "openmausbot_mcp.token").exists())

    def test_ensure_with_api_down_or_running_both_need_the_user(self):
        self.install_desktop()
        adapter = self.adapter(SINGULARITY_OMB_DESKTOP_PORT="8799")
        with patch.object(provisioner, "_port_open", return_value=False):
            with self.assertRaisesRegex(provisioner.NeedsUserAction, "not answering on 127.0.0.1:8799"):
                adapter.ensure([])
        with patch.object(provisioner, "_port_open", return_value=True), \
             patch.object(provisioner.subprocess, "run") as run:
            with self.assertRaisesRegex(provisioner.NeedsUserAction, "one-time pairing"):
                adapter.ensure([])
        run.assert_not_called()

    def test_invalid_desktop_port_is_a_user_action_not_a_crash(self):
        self.install_desktop()
        adapter = self.adapter(SINGULARITY_OMB_DESKTOP_PORT="80")
        with self.assertRaisesRegex(provisioner.NeedsUserAction, "service range"):
            adapter.ensure([])

    def test_token_never_reaches_receipts_on_a_refused_pairing(self):
        self.install_desktop()
        self.write_token(self.TOKEN + "!")
        state_dir = self.root / "state"
        adapters = provisioner.build_adapters(self.env)
        with patch.object(provisioner, "_port_open", return_value=True):
            Provisioner(state_dir, adapters={"openmausbot_mcp": adapters["openmausbot_mcp"]},
                        clock=lambda: 1_760_000_000.0).repair(only=["openmausbot_mcp"])
        for receipt in (state_dir / "receipts").glob("*.json"):
            self.assertNotIn("omb_sess_", receipt.read_text(encoding="utf-8"))

    def test_icacls_restriction_uses_argv_without_shell_or_token(self):
        self.install_desktop()
        self.write_token(self.TOKEN)
        run = Mock(return_value=SimpleNamespace(returncode=0, stdout="", stderr=""))
        provisioner.restrict_to_current_user([self.token.parent, self.token], self.env, run=run)
        self.assertEqual(run.call_count, 2)
        for call in run.call_args_list:
            argv = call.args[0]
            self.assertIsInstance(argv, list)
            self.assertTrue(argv[0].lower().endswith("icacls.exe"))
            self.assertNotIn("shell", call.kwargs)
            self.assertEqual(call.kwargs["creationflags"], getattr(provisioner.subprocess, "CREATE_NO_WINDOW", 0))
            self.assert_no_token(" ".join(argv))
        self.assertIn("HOST\\tester:(OI)(CI)(F)", run.call_args_list[0].args[0])
        self.assertIn("HOST\\tester:(F)", run.call_args_list[1].args[0])

    def test_icacls_failure_reports_without_stderr(self):
        run = Mock(return_value=SimpleNamespace(returncode=5, stdout="", stderr="secret detail"))
        with self.assertRaisesRegex(RuntimeError, "icacls could not restrict") as ctx:
            provisioner.restrict_to_current_user([self.root], self.env, run=run)
        self.assertNotIn("secret detail", str(ctx.exception))

    def test_icacls_requires_a_resolvable_account(self):
        with self.assertRaisesRegex(RuntimeError, "not resolvable"):
            provisioner.restrict_to_current_user([self.root], {}, run=Mock())


if __name__ == "__main__":
    unittest.main(verbosity=2)
