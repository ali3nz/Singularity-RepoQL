"""Read-only post-preparation evidence must reject drift (fake PE files only)."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).parent))
from build_source_variants import build
from build_option2_acceptance_bundle import BRIDGE, SUPERVISOR, assemble
from prepare_option2_candidate import prepare
from verify_prepared_option2_candidate import verify_prepared


def fake_pe():
    b = bytearray(512)
    b[:2] = b'MZ'
    b[0x3c:0x40] = (128).to_bytes(4, 'little')
    b[128:132] = b'PE\0\0'
    b[132:134] = (0x8664).to_bytes(2, 'little')
    return bytes(b)


class VerifyPreparedCandidate(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.temp.cleanup)
        base = Path(cls.temp.name)
        source = base / 'singularity-native-windows-option2-SOURCE-ONLY.zip'
        build(2, source)
        bridge, supervisor = base / BRIDGE, base / SUPERVISOR
        bridge.write_bytes(fake_pe())
        supervisor.write_bytes(fake_pe())
        cls.bundle = base / 'bundle.zip'
        assemble(source, bridge, supervisor, cls.bundle, native_windows=True)

    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.destination = self.root / 'prepared'
        prepare(self.bundle, self.destination, native_windows=True, preview_root=self.root)

    def verify(self):
        return verify_prepared(self.bundle, self.destination, native_windows=True, preview_root=self.root)

    def test_clean_prepared_files_pass_but_are_not_installed(self):
        r = self.verify()
        self.assertEqual(r['status'], 'PREPARED_CONTENT_VERIFIED_NOT_INSTALLED')
        self.assertEqual(r['verified_native_binaries'], 2)
        self.assertGreater(r['verified_source_files'], 200)
        for key in ('runtime_tested','publisher_identity_verified','installation_performed','release_ready'):
            self.assertFalse(r[key],key)

    def test_never_writes_to_verified_directory(self):
        before = sorted((p.relative_to(self.destination).as_posix(), p.read_bytes()) for p in self.destination.rglob('*') if p.is_file())
        self.verify()
        after = sorted((p.relative_to(self.destination).as_posix(), p.read_bytes()) for p in self.destination.rglob('*') if p.is_file())
        self.assertEqual(before, after)

    def test_changed_binary_fails(self):
        (self.destination/'bin'/BRIDGE).write_bytes(fake_pe()+b'bad')
        with self.assertRaisesRegex(ValueError,'PREPARED_FILE_SIZE_OR_TYPE_DRIFT'):
            self.verify()

    def test_changed_source_fails(self):
        p = self.destination/'source'/'README.md'
        old = p.read_bytes()
        p.write_bytes(b'!' + old[1:])
        with self.assertRaisesRegex(ValueError,'PREPARED_FILE_HASH_DRIFT'):
            self.verify()

    def test_changed_manifest_fails(self):
        p=self.destination/'source'/'NATIVE_WINDOWS_SOURCE_MANIFEST.json'
        p.write_bytes(p.read_bytes()+b' ')
        with self.assertRaisesRegex(ValueError,'PREPARED_FILE_SIZE_OR_TYPE_DRIFT'):
            self.verify()

    def test_forged_receipt_fails(self):
        p=self.destination/'PREPARATION_RECEIPT.json'
        r=json.loads(p.read_text())
        r['release_ready']=True
        p.write_text(json.dumps(r))
        with self.assertRaisesRegex(ValueError,'PREPARATION_RECEIPT_DRIFT'):
            self.verify()

    def test_extra_and_missing_files_fail(self):
        (self.destination/'source'/'unexpected.txt').write_text('x')
        with self.assertRaisesRegex(ValueError,'PREPARED_INVENTORY_DRIFT'):
            self.verify()
        (self.destination/'source'/'unexpected.txt').unlink()
        (self.destination/'source'/'README.md').unlink()
        with self.assertRaisesRegex(ValueError,'PREPARED_INVENTORY_DRIFT'):
            self.verify()

    def test_symlink_fails(self):
        link=self.destination/'source'/'hidden'
        try: link.symlink_to(self.root, target_is_directory=True)
        except OSError: self.skipTest('symlinks not permitted')
        with self.assertRaisesRegex(ValueError,'PREPARED_REPARSE_PATH_REFUSED'):
            self.verify()

    def test_outside_preview_directory_refused(self):
        with self.assertRaisesRegex(ValueError,'PREPARED_DIRECTORY_NOT_OWNED_PREVIEW_CHILD'):
            verify_prepared(self.bundle,self.destination,native_windows=True,preview_root=self.root/'other')

    def test_not_windows_refused(self):
        with self.assertRaisesRegex(ValueError,'NATIVE_WINDOWS_REQUIRED'):
            verify_prepared(self.bundle,self.destination,native_windows=False,preview_root=self.root)

    def test_bootstrap_runs_from_only_extracted_bundle(self):
        # Run without cwd or sys.path from checkout: source-import closure is complete.
        import zipfile
        isolated=self.root/'bootstrap'
        isolated.mkdir()
        with zipfile.ZipFile(self.bundle) as outer:
            for p in ('prepare_option2_candidate.py','verify_prepared_option2_candidate.py',
                      'build_option2_acceptance_bundle.py','scan_source_archive.py',
                      'windows_source_policy.py'):
                (isolated/p).write_bytes(outer.read('bootstrap/'+p))
        proc = subprocess.run([sys.executable, str(isolated/'verify_prepared_option2_candidate.py'),
                               '--bundle',str(self.bundle),'--prepared',str(self.destination),
                               '--preview-root',str(self.root)],
                              cwd=isolated, capture_output=True, text=True, timeout=40)
        # The CLI intentionally refuses Linux even though isolated test entry uses the injected flag.
        if os.name != 'nt':
            self.assertNotEqual(proc.returncode,0)
            self.assertIn('NATIVE_WINDOWS_REQUIRED',proc.stderr)
        else:
            self.assertEqual(proc.returncode,0,proc.stderr)
            self.assertEqual(json.loads(proc.stdout)['status'],'PREPARED_CONTENT_VERIFIED_NOT_INSTALLED')

if __name__=='__main__': unittest.main()
