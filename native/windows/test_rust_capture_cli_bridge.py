"""Wave 7: tests the explicit delegation contract without requiring a Rust binary."""
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "memory_turn_capture.py"
spec = importlib.util.spec_from_file_location("singularity_memory_turn_capture", SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class RustCaptureDelegationTests(unittest.TestCase):
    def test_unset_switch_keeps_existing_source_runtime(self):
        with mock.patch.dict(os.environ, {"SINGULARITY_RUST_TURN_CAPTURE_BIN": ""}):
            with mock.patch.object(module.subprocess, "run") as run:
                self.assertIsNone(module._delegate_to_native_when_enabled())
                run.assert_not_called()

    def test_missing_binary_fails_before_any_state_write(self):
        with tempfile.TemporaryDirectory() as temp:
            candidate = str(Path(temp) / "not-built.exe")
            with mock.patch.dict(os.environ, {"SINGULARITY_RUST_TURN_CAPTURE_BIN": candidate}):
                with mock.patch.object(module.subprocess, "run") as run:
                    with self.assertRaises(SystemExit) as cm:
                        module._delegate_to_native_when_enabled()
                    self.assertEqual(cm.exception.code, 6)
                    run.assert_not_called()

    def test_native_nonzero_exit_is_preserved_never_falls_back(self):
        with tempfile.TemporaryDirectory() as temp:
            binary = Path(temp) / "native.exe"
            binary.write_bytes(b"test fixture")
            args = [str(SCRIPT), "propose", "--lesson-file", "-"]
            with mock.patch.dict(os.environ, {"SINGULARITY_RUST_TURN_CAPTURE_BIN": str(binary)}):
                with mock.patch.object(module.sys, "argv", args):
                    with mock.patch.object(module.subprocess, "run", return_value=subprocess.CompletedProcess([], 5)) as run:
                        with self.assertRaises(SystemExit) as cm:
                            module._delegate_to_native_when_enabled()
                        self.assertEqual(cm.exception.code, 5)
                        run.assert_called_once_with([str(binary), "propose", "--lesson-file", "-"], check=False)

    def test_spawn_failure_is_not_swallowed(self):
        with tempfile.TemporaryDirectory() as temp:
            binary = Path(temp) / "native.exe"
            binary.write_bytes(b"test fixture")
            with mock.patch.dict(os.environ, {"SINGULARITY_RUST_TURN_CAPTURE_BIN": str(binary)}):
                with mock.patch.object(module.subprocess, "run", side_effect=OSError("blocked")):
                    with self.assertRaises(SystemExit) as cm:
                        module._delegate_to_native_when_enabled()
                    self.assertEqual(cm.exception.code, 6)


if __name__ == "__main__":
    unittest.main()
