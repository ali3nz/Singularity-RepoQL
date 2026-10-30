"""Offline guarded extraction tests. Synthetic PE fixtures are never distributed."""
from pathlib import Path
import json
import sys
import tempfile
import unittest
import zipfile

sys.path.insert(0, str(Path(__file__).parent))
from build_source_variants import build
from build_option2_acceptance_bundle import BRIDGE, SUPERVISOR, assemble
from prepare_option2_candidate import prepare, inspect


def fake_pe():
    header = bytearray(512)
    header[:2] = b'MZ'
    header[0x3c:0x40] = (128).to_bytes(4, 'little')
    header[128:132] = b'PE\0\0'
    header[132:134] = (0x8664).to_bytes(2, 'little')
    return bytes(header)


class PrepareTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.work = Path(cls.temp.name)
        cls.source = cls.work / 'singularity-native-windows-option2-SOURCE-ONLY.zip'
        build(2, cls.source)
        cls.bridge = cls.work / BRIDGE
        cls.supervisor = cls.work / SUPERVISOR
        cls.bridge.write_bytes(fake_pe())
        cls.supervisor.write_bytes(fake_pe())
        cls.bundle = cls.work / 'candidate.zip'
        assemble(cls.source, cls.bridge, cls.supervisor, cls.bundle, native_windows=True)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.out = self.root / 'new-preview'

    def run_prepare(self, *, output=None, root=None, native_windows=True):
        return prepare(self.bundle, output or self.out, preview_root=root or self.root,
                       native_windows=native_windows)

    def test_inspection_only_no_side_effects(self):
        state = inspect(self.bundle)
        self.assertEqual(state['status'], 'INSPECTED_NOT_INSTALLED')
        self.assertFalse(state['release_ready'])
        self.assertFalse(state['runtime_tested'])
        self.assertFalse(self.out.exists())

    def test_prepares_exact_staging_inputs_and_keeps_release_blocked(self):
        state = self.run_prepare()
        self.assertEqual(state['status'], 'PREPARED_ONLY_NOT_STAGED_NOT_INSTALLED')
        self.assertFalse(state['installation_performed'])
        self.assertTrue((self.out / 'bin' / BRIDGE).is_file())
        self.assertTrue((self.out / 'bin' / SUPERVISOR).is_file())
        self.assertTrue((self.out / 'source' / 'native/windows/stage-native.ps1').is_file())
        self.assertEqual(json.loads((self.out / 'PREPARATION_RECEIPT.json').read_text()), state)
        self.assertFalse((self.out / 'source' / 'NATIVE_WINDOWS_SOURCE_MANIFEST.json').is_symlink())
        self.assertEqual(sorted(x.name for x in self.root.iterdir()), ['new-preview'])

    def test_requires_native_windows(self):
        with self.assertRaisesRegex(ValueError, 'NATIVE_WINDOWS_REQUIRED'):
            self.run_prepare(native_windows=False)
        self.assertFalse(self.out.exists())

    def test_refuses_existing_destination_without_changes(self):
        self.out.mkdir()
        marker = self.out / 'preserve.txt'
        marker.write_text('private existing file')
        with self.assertRaisesRegex(ValueError, 'DESTINATION_EXISTS_REFUSED'):
            self.run_prepare()
        self.assertEqual(marker.read_text(), 'private existing file')

    def test_refuses_arbitrary_or_nested_output(self):
        for output in (self.root / 'child' / 'nested', self.root.parent / 'outside', self.root / 'CON.', self.root / 'NUL', self.root / 'COM1.txt'):
            with self.assertRaisesRegex(ValueError, 'DESTINATION_MUST_BE_NEW_PREVIEW_CHILD'):
                self.run_prepare(output=output)

    def test_refuses_symlinked_destination_parent(self):
        with tempfile.TemporaryDirectory() as other:
            link = self.root / 'link'
            try:
                link.symlink_to(other, target_is_directory=True)
            except OSError:
                self.skipTest('symlinks require privileges on this Windows runner')
            with self.assertRaisesRegex(ValueError, 'REPARSE_PATH_REFUSED'):
                self.run_prepare(output=link / 'folder', root=link)
            self.assertFalse((Path(other) / 'folder').exists())

    def test_bundle_corruption_fails_without_creating_staging(self):
        changed = self.root / 'tampered.zip'
        with zipfile.ZipFile(self.bundle) as z:
            contents = {n:z.read(n) for n in z.namelist()}
        contents['bin/' + BRIDGE] = b'malicious'
        with zipfile.ZipFile(changed, 'w') as z:
            for n,v in contents.items(): z.writestr(n,v)
        with self.assertRaises(ValueError):
            prepare(changed, self.out, native_windows=True, preview_root=self.root)
        self.assertEqual(list(self.root.iterdir()), [changed])

    def test_rejects_missing_preview_root(self):
        with self.assertRaisesRegex(ValueError, 'PREVIEW_ROOT_MUST_EXIST'):
            self.run_prepare(root=self.root / 'absent', output=self.root / 'absent' / 'new-preview')


if __name__ == '__main__': unittest.main()
