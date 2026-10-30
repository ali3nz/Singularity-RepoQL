import tempfile
import unittest
import zipfile
from pathlib import Path
from scan_source_archive import scan, windows_safe_member


class SourceArchiveSecurity(unittest.TestCase):
    def test_rejects_untrusted_archive_path(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'bad.zip'
            with zipfile.ZipFile(target, 'w') as out:
                out.writestr('../private.key', 'not-a-real-key')
            result = scan(target)
            self.assertFalse(result['ok'])
            self.assertIn('invalid or duplicate archive member', result['issues'])

    def test_rejects_normalized_dot_segment(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'bad.zip'
            with zipfile.ZipFile(target, 'w') as out:
                out.writestr('src/./config.json', '{}')
            self.assertIn('invalid or duplicate archive member', scan(target)['issues'])

    def test_windows_ntfs_names_and_case_collisions(self):
        for bad in ('src/CON.txt', 'NUL', 'com1.json', 'Lpt9.d',
                    'src/final. ', 'src/trailing.', 'src/hidden:stream',
                    'src/question?.md', 'src/ctrl\x01.md', 'src\\bad.md',
                    'src/../bad.md', 'src//bad.md'):
            with self.subTest(path=bad):
                self.assertFalse(windows_safe_member(bad))
        for good in ('README.md', 'src/My Module.rs', 'src/CONTRIBUTING.md'):
            self.assertTrue(windows_safe_member(good))
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'case.zip'
            with zipfile.ZipFile(target, 'w') as out:
                out.writestr('README.md', 'x')
                out.writestr('readme.md', 'y')
            self.assertIn('invalid Windows member, reserved name or case-insensitive collision', scan(target)['issues'])

    def test_rejects_missing_manifest_and_checksums(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'bad.zip'
            with zipfile.ZipFile(target, 'w') as out:
                out.writestr('README.md', 'source-only')
            self.assertFalse(scan(target)['ok'])


if __name__ == '__main__':
    unittest.main()
