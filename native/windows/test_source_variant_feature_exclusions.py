"""Verify the actual four source archives keep native Ghost runtime optional."""
from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest
import zipfile

from build_source_variants import build
from windows_source_policy import WINDOWS_GHOST_ONLY_FILES


class NativeVariantFeatureExclusions(unittest.TestCase):
    def test_all_four_archives_have_the_expected_ghost_payload(self):
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
                self.assertEqual(manifest["features"]["ghost"], variant in (2, 4))
                if variant in (1, 3):
                    self.assertTrue(WINDOWS_GHOST_ONLY_FILES.isdisjoint(names))
                else:
                    self.assertTrue(WINDOWS_GHOST_ONLY_FILES <= names)


if __name__ == "__main__":
    unittest.main()
