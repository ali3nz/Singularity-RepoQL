"""Small focused tests with synthetic PE bytes only; not runnable binaries."""
from pathlib import Path
import hashlib,json,tempfile,unittest,zipfile,sys
sys.path.insert(0,str(Path(__file__).parent))
from build_source_variants import build
from build_option2_acceptance_bundle import assemble,BRIDGE,SUPERVISOR,BUNDLE_FILES,SOURCE
from verify_option2_expected_digest import verify_expected

def fake_pe():
    b=bytearray(512);b[:2]=b'MZ';b[0x3c:0x40]=(128).to_bytes(4,'little');b[128:132]=b'PE\0\0';b[132:134]=(0x8664).to_bytes(2,'little');return b
class DigestTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.t=tempfile.TemporaryDirectory();cls.root=Path(cls.t.name);cls.source=cls.root/SOURCE
        build(2,cls.source)
        cls.bridge=cls.root/BRIDGE;cls.supervisor=cls.root/SUPERVISOR
        cls.bridge.write_bytes(fake_pe());cls.supervisor.write_bytes(fake_pe())
        cls.bundle=cls.root/'candidate.zip';cls.commit='a'*40
        assemble(cls.source,cls.bridge,cls.supervisor,cls.bundle,native_windows=True,commit=cls.commit)
        cls.digest=hashlib.sha256(cls.bundle.read_bytes()).hexdigest()
        cls.source_digest=hashlib.sha256(cls.source.read_bytes()).hexdigest()
    @classmethod
    def tearDownClass(cls):cls.t.cleanup()
    def test_expected_digest_and_commit_match_but_never_certify(self):
        r=verify_expected(self.bundle,expected_sha256=self.digest,expected_commit=self.commit,
            expected_source_sha256=self.source_digest)
        self.assertTrue(r['artifact_content_verified']);self.assertFalse(r['production_release_ready'])
        self.assertFalse(r['publisher_signature_verified'])
        self.assertFalse(r['external_expected_hash_was_operator_authenticated'])
    def test_wrong_external_sha_rejected(self):
        with self.assertRaisesRegex(ValueError,'INDEPENDENT_BUNDLE_DIGEST_MISMATCH'):
            verify_expected(self.bundle,expected_sha256='0'*64,expected_commit=self.commit)
    def test_wrong_expected_commit_rejected(self):
        with self.assertRaisesRegex(ValueError,'CANDIDATE_GIT_COMMIT_MISMATCH'):
            verify_expected(self.bundle,expected_sha256=self.digest,expected_commit='b'*40)
    def test_wrong_expected_source_rejected(self):
        with self.assertRaisesRegex(ValueError,'INDEPENDENT_SOURCE_DIGEST_MISMATCH'):
            verify_expected(self.bundle,expected_sha256=self.digest,expected_commit=self.commit,expected_source_sha256='f'*64)
    def test_ambiguous_expected_inputs_rejected(self):
        for hash_value,commit in [('bad',self.commit),(self.digest,'branch-main')]:
            with self.assertRaises(ValueError):verify_expected(self.bundle,expected_sha256=hash_value,expected_commit=commit)
if __name__=='__main__':unittest.main()
