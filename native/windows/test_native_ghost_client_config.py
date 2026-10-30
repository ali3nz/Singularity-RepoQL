"""The complete dashboard receives only paths to its private Rust Ghost client."""
import base64
import json
from pathlib import Path
import tempfile
import unittest

from claude_complete_dashboard_host import environment


class NativeGhostClientConfigTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source = self.root / "source"
        (self.source / "dashboard").mkdir(parents=True)
        for connector in ("memorycore", "kanzo"):
            path = self.source / "connectors" / connector
            path.mkdir(parents=True)
            (path / "manifest.yaml").write_text("scheme: test\n", encoding="utf-8")
        (self.source / "dashboard" / "server.py").write_text("", encoding="utf-8")
        self.rql = self.root / "rql.exe"
        self.rql.write_bytes(b"test fixture")
        self.workspace = self.root / "workspace"
        self.workspace.mkdir()
        self.state = self.root / "Singularity" / "Dashboard"
        self.state.mkdir(parents=True)
        self.bridge = self.root / "bin" / "singularity-desktop-bridge.exe"
        self.bridge.parent.mkdir()
        self.bridge.write_bytes(b"test fixture")
        self.config = self.state.parent / "GhostScheduler" / "native-bridge-client.json"
        self.config.parent.mkdir()
        self.key = base64.b64encode(bytes(range(48))).decode("ascii")
        self.write_config()

    def write_config(self, endpoint="http://127.0.0.1:18473", key=None, **extra):
        value = {"endpoint": endpoint, "controlKey": self.key if key is None else key, **extra}
        self.config.write_text(json.dumps(value), encoding="utf-8")

    def run_environment(self, variant=2, bridge=None, config=None):
        return environment(self.source, self.rql, self.workspace, self.state, 18100,
                           variant=variant, windows=True,
                           native_bridge_exe=self.bridge if bridge is None else bridge,
                           ghost_control_config=self.config if config is None else config)

    def test_complete_environment_passes_only_private_config_paths(self):
        result = self.run_environment()
        self.assertEqual(result["SINGULARITY_NATIVE_BRIDGE_EXE"], str(self.bridge))
        self.assertEqual(result["SINGULARITY_GHOST_CONTROL_CONFIG"], str(self.config))
        self.assertNotIn(self.key, " ".join(result.values()))

    def test_complete_variant_requires_bridge_and_config(self):
        with self.assertRaisesRegex(ValueError, "DASHBOARD_NATIVE_GHOST_CONFIG_REQUIRED"):
            environment(self.source, self.rql, self.workspace, self.state, 18100, variant=2, windows=True)

    def test_lean_historical_variant_does_not_receive_ghost_environment(self):
        result = environment(self.source, self.rql, self.workspace, self.state, 18100, variant=1, windows=True)
        self.assertNotIn("SINGULARITY_NATIVE_BRIDGE_EXE", result)
        self.assertNotIn("SINGULARITY_GHOST_CONTROL_CONFIG", result)

    def test_non_loopback_or_key_mismatch_is_refused(self):
        self.write_config(endpoint="http://example.test:18473")
        with self.assertRaisesRegex(ValueError, "DASHBOARD_GHOST_CONFIG_INVALID"):
            self.run_environment()
        self.write_config(key="short")
        with self.assertRaisesRegex(ValueError, "DASHBOARD_GHOST_CONFIG_INVALID"):
            self.run_environment()

    def test_unknown_and_duplicate_config_fields_are_refused(self):
        self.write_config(extra={"unknown": True})
        with self.assertRaisesRegex(ValueError, "DASHBOARD_GHOST_CONFIG_INVALID"):
            self.run_environment()
        self.config.write_text(
            json.dumps({"endpoint": "http://127.0.0.1:18473", "controlKey": self.key})[:-1]
            + ',"controlKey":"duplicate"}',
            encoding="utf-8",
        )
        with self.assertRaisesRegex(ValueError, "DASHBOARD_GHOST_CONFIG_INVALID"):
            self.run_environment()

    def test_bridge_and_client_paths_must_match_staged_private_locations(self):
        other_bridge = self.root / "other" / "singularity-desktop-bridge.exe"
        other_bridge.parent.mkdir()
        other_bridge.write_bytes(b"test fixture")
        with self.assertRaisesRegex(ValueError, "DASHBOARD_NATIVE_BRIDGE_NOT_FROM_STAGE"):
            self.run_environment(bridge=other_bridge)
        with self.assertRaisesRegex(ValueError, "DASHBOARD_GHOST_CONFIG_OUTSIDE_PRIVATE_ROOT"):
            self.run_environment(config=self.root / "unrelated" / "native-bridge-client.json")


if __name__ == "__main__":
    unittest.main()
