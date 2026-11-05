"""Unit tests for the native Windows Rust supervisor config generator."""
from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest

import build_supervisor_config as generator


class SupervisorConfigTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.install = self.root / "WindowsNative"
        self.source = self.install / "current" / "source"
        self.bin = self.install / "current" / "bin"
        self.office = self.root / "office"
        self.memory = self.install / "memory"
        for directory in (
            self.source / "native" / "windows",
            self.bin,
            self.office / "backend",
            self.memory / "build" / "MemoryCore",
            self.memory / "build" / "MemoryPanel",
            self.source / "scripts",
        ):
            directory.mkdir(parents=True, exist_ok=True)
        (self.source / "scripts" / "native-memory-supervisor.mjs").write_text("// fixture", encoding="utf-8")
        (self.memory / "stack.json").write_text("{}", encoding="utf-8")
        for path in (
            self.source / "native" / "windows" / "claude_complete_dashboard_host.py",
            self.source / "native" / "windows" / "ghost_scheduler_host.py",
            self.bin / "singularity-desktop-bridge.exe",
            self.root / "python.exe",
            self.root / "office-python.exe",
            self.root / "node.exe",
            self.root / "rql.exe",
            self.root / "ghost-config.json",
            self.root / "ghost-client.json",
        ):
            path.write_text("fixture", encoding="utf-8")
        self.workspace = self.root / "workspace"
        self.workspace.mkdir()
        self.dashboard_state = self.root / "Dashboard"
        self.dashboard_state.mkdir()
        self.output = self.install / "supervisor.json"

    def tearDown(self) -> None:
        self.temp.cleanup()

    def args(self, output: Path | None = None) -> list[str]:
        return [
            "--install-root", str(self.install),
            "--source-root", str(self.source),
            "--bin-dir", str(self.bin),
            "--python", str(self.root / "python.exe"),
            "--repoql", str(self.root / "rql.exe"),
            "--workspace", str(self.workspace),
            "--office-source", str(self.office),
            "--office-python", str(self.root / "office-python.exe"),
            "--ghost-config", str(self.root / "ghost-config.json"),
            "--ghost-client-config", str(self.root / "ghost-client.json"),
            "--dashboard-state", str(self.dashboard_state),
            "--memory-root", str(self.memory),
            "--node", str(self.root / "node.exe"),
            "--output", str(output or self.output),
        ]

    def test_emits_exact_four_component_contract(self) -> None:
        self.assertEqual(generator.main(self.args()), 0)
        stack = json.loads(self.output.read_text(encoding="utf-8"))
        self.assertEqual(stack["schema"], "singularity-rust-supervisor/v1")
        self.assertEqual(stack["variant"], 2)
        self.assertEqual(stack["repoqlVersion"], "1.7.18")
        self.assertEqual([item["id"] for item in stack["components"]],
                         ["office", "dashboard", "ghost", "memory"])
        ports = [item["health"]["port"] for item in stack["components"] if "health" in item]
        self.assertEqual(len(ports), len(set(ports)))
        memory = [item for item in stack["components"] if item["id"] == "memory"][0]
        self.assertNotIn("health", memory)
        self.assertEqual(memory["args"][1], "serve")
        for item in stack["components"]:
            self.assertTrue(Path(item["executable"]).is_absolute())
            self.assertTrue(Path(item["workingDir"]).is_absolute())
            for key in item.get("env", {}):
                self.assertNotIn("TOKEN", key.upper())
                self.assertNotIn("SECRET", key.upper())
                self.assertNotIn("API_KEY", key.upper())

    def test_memory_component_is_omitted_without_a_build(self) -> None:
        import shutil
        shutil.rmtree(self.memory / "build" / "MemoryCore")
        self.assertEqual(generator.main(self.args()), 0)
        stack = json.loads(self.output.read_text(encoding="utf-8"))
        self.assertEqual([item["id"] for item in stack["components"]],
                         ["office", "dashboard", "ghost"])

    def test_skip_office_emits_the_non_office_stack(self) -> None:
        args = self.args()
        args = [item for item in args if item not in (
            "--office-source", str(self.office), "--office-python", str(self.root / "office-python.exe"))]
        args.extend(["--skip-office"])
        self.assertEqual(generator.main(args), 0)
        stack = json.loads(self.output.read_text(encoding="utf-8"))
        self.assertEqual([item["id"] for item in stack["components"]],
                         ["dashboard", "ghost", "memory"])
        self.assertNotIn("office", [item["id"] for item in stack["components"]])

    def test_credentials_are_refused_in_environment(self) -> None:
        with self.assertRaises(SystemExit):
            generator.component(
                "memory", self.root / "node.exe", ["x"], self.memory,
                env={"TDAI_LLM_API_KEY": "not-written"})

    def test_check_mode_does_not_write(self) -> None:
        self.assertEqual(generator.main(self.args() + ["--check"]), 0)
        self.assertFalse(self.output.exists())


if __name__ == "__main__":
    unittest.main()
