import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

THIS = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('overlay_validation', THIS / 'validate-overlay.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class OverlayValidationTests(unittest.TestCase):
    def test_final_hashes_are_exactly_the_six_reviewed_files(self):
        manifest = module.EXPECTED_FINAL
        self.assertEqual(len(manifest), 6)
        self.assertTrue(all(len(h) == 64 for h in manifest.values()))
        self.assertIn('src/core/record/l1-writer.ts', manifest)

    def test_unpinned_preimage_is_rejected(self):
        series = json.loads((THIS.parent / 'core-v2.0.2-l1recordids' / 'series.json').read_text())
        with tempfile.TemporaryDirectory() as td:
            with self.assertRaisesRegex(RuntimeError, 'PINNED_BASE_SHA256_MISMATCH'):
                module.check_paths(Path(td), series['files'], False)

    def test_upstream_overlay_has_original_pinned_hash(self):
        series = json.loads((THIS.parent / 'core-v2.0.2-l1recordids' / 'series.json').read_text())
        old = THIS.parent / 'core-v2.0.2-l1recordids' / series['patch']['file']
        self.assertEqual(module.digest(old), series['patch']['sha256'])

if __name__ == '__main__':
    unittest.main()
