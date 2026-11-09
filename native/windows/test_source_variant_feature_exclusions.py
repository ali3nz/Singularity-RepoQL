"""Verify Windows source archives omit Ghost and keep Office optional."""
from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest
import zipfile

from build_source_variants import build
from windows_source_policy import windows_ghost_source, windows_office_source


class NativeVariantFeatureExclusions(unittest.TestCase):
    def test_all_four_archives_disable_ghost_and_keep_office_optional(self):
        with tempfile.TemporaryDirectory(prefix="native-variant-source-") as temporary:
            out = Path(temporary)
            for variant in (1, 2, 3, 4):
                artifact = out / f"option{variant}.zip"
                result = build(variant, artifact)
                self.assertFalse(result["name"].endswith("INSTALLER.zip"))
                with zipfile.ZipFile(artifact) as archive:
                    names = set(archive.namelist())
                    manifest = json.loads(archive.read("NATIVE_WINDOWS_SOURCE_MANIFEST.json"))
                self.assertEqual(manifest["variant"], variant)
                office_enabled = variant in (2, 4)
                self.assertIs(manifest["features"]["ghost"], False)
                self.assertIs(manifest["features"]["office"], office_enabled)
                self.assertIs(manifest["rustGhostFeature"], False)
                self.assertIs(manifest["rustOfficeFeature"], office_enabled)
                self.assertFalse(any(windows_ghost_source(name) for name in names))
                self.assertEqual(
                    "office/patches/windows-ghost-only.patch" in names,
                    office_enabled,
                )
                if not office_enabled:
                    self.assertFalse(any(windows_office_source(name) for name in names))

    def test_ghost_paths_are_excluded_across_classifier_groups(self):
        for name in (
            "ghost/dream.mjs",
            "dashboard/static/ghost/dashboard.js",
            "dashboard/ghost_bridge.py",
            "adapters/claude-code/agents/singularity-ghost.md",
            "openchamber/agents/ghost.md",
            "native/desktop-bridge/src/ghost.rs",
            "harness/kit/lib/ghostwake.mjs",
        ):
            with self.subTest(path=name):
                self.assertTrue(windows_ghost_source(name))
        self.assertFalse(windows_ghost_source("office/patches/windows-ghost-only.patch"))


if __name__ == "__main__":
    unittest.main()
