"""Offline packaging tests. Fake PE fixtures must never be distributed as real builds."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile
import io

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('assembler',Path(__file__).with_name('build_option2_acceptance_bundle.py'))
import sys
import subprocess
sys.path.insert(0,str(Path(__file__).parent))
assembler=importlib.util.module_from_spec(spec)
spec.loader.exec_module(assembler)
from build_source_variants import build


def pe(machine=0x8664):
    data=bytearray(512)
    data[:2]=b'MZ'
    data[0x3c:0x40]=(128).to_bytes(4,'little')
    data[128:132]=b'PE\x00\x00'
    data[132:134]=machine.to_bytes(2,'little')
    return bytes(data)


class CandidateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root=tempfile.TemporaryDirectory()
        cls.base=Path(cls.root.name)
        cls.src=cls.base/'singularity-native-windows-option2-SOURCE-ONLY.zip'
        build(2,cls.src)

    @classmethod
    def tearDownClass(cls):
        cls.root.cleanup()

    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.dir=Path(self.temp.name)
        self.bridge=self.dir/assembler.BRIDGE
        self.supervisor=self.dir/assembler.SUPERVISOR
        self.bridge.write_bytes(pe())
        self.supervisor.write_bytes(pe())
        self.out=self.dir/'candidate.zip'

    def assembled(self):
        return assembler.assemble(self.src,self.bridge,self.supervisor,self.out,native_windows=True)

    def test_deterministic_and_no_release_claims(self):
        first=self.assembled()
        self.assertEqual(first['files'],8)
        self.assertFalse(first['release_ready'])
        self.assertTrue(assembler.check_acceptance_bundle(self.out)['ok'])
        with zipfile.ZipFile(self.out) as z:
            manifest=json.loads(z.read('ACCEPTANCE_BUNDLE_MANIFEST.json'))
            self.assertFalse(manifest['installer_included'])
            self.assertFalse(manifest['production_release_ready'])
            self.assertFalse(manifest['native_gui_accepted'])
            self.assertEqual(manifest['repoql_required_version'],'1.7.18')
        digest=first['sha256']
        self.out.unlink()
        self.assertEqual(digest,self.assembled()['sha256'])

    def test_refuses_non_windows_and_never_writes(self):
        with self.assertRaisesRegex(ValueError,'NATIVE_WINDOWS_BUILD_REQUIRED'):
            assembler.assemble(self.src,self.bridge,self.supervisor,self.out,native_windows=False)
        self.assertFalse(self.out.exists())

    def test_refuses_existing_output(self):
        self.out.write_text('private content',encoding='utf-8')
        with self.assertRaisesRegex(ValueError,'OUTPUT_EXISTS_REFUSED'):
            self.assembled()
        self.assertEqual(self.out.read_text(),'private content')

    def test_rejects_invalid_binary_or_architecture(self):
        for binary in (b'not an exe',pe(0x14c)):
            self.bridge.write_bytes(binary)
            with self.assertRaises(ValueError):
                self.assembled()
            self.assertFalse(self.out.exists())

    def test_rejects_invalid_optional_windowless_binary(self):
        windowless = self.dir / assembler.SUPERVISORW
        windowless.write_bytes(pe(0x14c))
        with self.assertRaisesRegex(ValueError, 'NOT_AMD64_PE'):
            assembler.assemble(self.src, self.bridge, self.supervisor, self.out,
                               native_windows=True, supervisorw_exe=windowless)
        self.assertFalse(self.out.exists())

    def test_rejects_symlink_input(self):
        other=self.dir/'real.exe'
        other.write_bytes(pe())
        self.bridge.unlink()
        try:
            self.bridge.symlink_to(other)
        except OSError:
            self.skipTest('symlinks require privileges on this Windows runner')
        with self.assertRaisesRegex(ValueError,'INPUT_REPARSE_REFUSED'):
            self.assembled()

    def test_rejects_wrong_filename(self):
        wrong=self.dir/'bridge.exe'
        wrong.write_bytes(pe())
        with self.assertRaisesRegex(ValueError,'UNEXPECTED_INPUT_FILENAME'):
            assembler.assemble(self.src,wrong,self.supervisor,self.out,native_windows=True)

    def test_rejects_bad_commit_provenance(self):
        with self.assertRaisesRegex(ValueError,'INVALID_COMMIT_ID'):
            assembler.assemble(self.src,self.bridge,self.supervisor,self.out,native_windows=True,commit='unverified')

    def test_bundled_tamper_detected(self):
        self.assembled()
        with zipfile.ZipFile(self.out) as z:
            entries={name:z.read(name) for name in z.namelist()}
        entries['bin/'+assembler.BRIDGE]=b'bad!'
        self.out.unlink()
        with zipfile.ZipFile(self.out,'w') as z:
            for name,data in entries.items():z.writestr(name,data)
        with self.assertRaisesRegex(ValueError,'BUNDLE_DIGEST_MISMATCH'):
            assembler.check_acceptance_bundle(self.out)

    def test_bootstrap_matches_verified_nested_source(self):
        self.assembled()
        with zipfile.ZipFile(self.out) as outer:
            with zipfile.ZipFile(io.BytesIO(outer.read(assembler.BUNDLE_FILES[assembler.SOURCE]))) as inner:
                for path in assembler.BOOTSTRAP_SOURCES:
                    self.assertEqual(outer.read(assembler.BUNDLE_FILES[path]),inner.read(path))

    def test_bootstrap_runs_read_only_without_repository_checkout(self):
        self.assembled()
        isolated=self.dir/'isolated-bootstrap'
        isolated.mkdir()
        with zipfile.ZipFile(self.out) as z:
            for name in assembler.BOOTSTRAP_SOURCES:
                (isolated / Path(name).name).write_bytes(z.read(assembler.BUNDLE_FILES[name]))
        script=isolated/'prepare_option2_candidate.py'
        result=subprocess.run([sys.executable,str(script),'--bundle',str(self.out)],
                              cwd=isolated,capture_output=True,text=True,timeout=30)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(json.loads(result.stdout)['status'],'INSPECTED_NOT_INSTALLED')
        self.assertEqual(sorted(p.name for p in isolated.iterdir() if p.is_file()),
                         sorted(Path(p).name for p in assembler.BOOTSTRAP_SOURCES))

    def test_rejects_bootstrap_divergence_even_if_receipt_rehashed(self):
        self.assembled()
        with zipfile.ZipFile(self.out) as z:
            contents={name:z.read(name) for name in z.namelist()}
        target=assembler.BUNDLE_FILES[assembler.BOOTSTRAP_SOURCES[0]]
        altered=b'# dangerous drift\n'
        contents[target]=altered
        receipt=json.loads(contents['ACCEPTANCE_BUNDLE_MANIFEST.json'])
        for row in receipt['files']:
            if row['path']==target:
                row['sha256']=assembler.sha256(altered)
                row['bytes']=len(altered)
        contents['ACCEPTANCE_BUNDLE_MANIFEST.json']=json.dumps(receipt).encode()
        self.out.unlink()
        with zipfile.ZipFile(self.out,'w') as z:
            for name,data in contents.items(): z.writestr(name,data)
        with self.assertRaisesRegex(ValueError,'BOOTSTRAP_SOURCE_DRIFT'):
            assembler.check_acceptance_bundle(self.out)

    def test_rejects_wrong_source_profile(self):
        variant_one=self.dir/'singularity-native-windows-option2-SOURCE-ONLY.zip'
        with self.assertRaisesRegex(ValueError,'only Claude Code Full'):
            build(1,variant_one)
        self.assertFalse(variant_one.exists())


if __name__=='__main__':unittest.main()
