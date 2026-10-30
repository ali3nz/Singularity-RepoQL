"""Offline release gate fixtures only; no real Cargo toolchain or publisher."""
import tempfile
import unittest
from pathlib import Path
from check_rust_lock_provenance import inspect, CRATES


class RustLockSourceGateTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name)
        for rel,name in CRATES:
            crate=self.root/rel
            crate.mkdir(parents=True)
            (crate/'Cargo.toml').write_text(f'[package]\nname="{name}"\nversion="0.1.0"\nedition="2021"\n')

    def _lock(self, rel, name, checksum='a'*64):
        (self.root/rel/'Cargo.lock').write_text('''version = 4
[[package]]
name = "'''+name+'''"
version = "0.1.0"
[[package]]
name = "test-dependency"
version = "1.0.1"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "'''+checksum+'''"
''')

    def test_no_dependency_locks_are_never_release_evidence(self):
        result=inspect(self.root)
        self.assertFalse(result['readyForRustDependencyReview'])
        self.assertFalse(result['releaseReady'])

    def test_valid_reviewable_lockfiles_pass_source_structure_only(self):
        for rel,name in CRATES:self._lock(rel,name)
        result=inspect(self.root)
        self.assertTrue(result['readyForRustDependencyReview'])
        self.assertFalse(result['releaseReady'])
        self.assertFalse(result['nativeWindowsBuildVerified'])
        self.assertEqual(len(result['checks']),2)

    def test_missing_lockfile_fails_closed(self):
        self._lock(*CRATES[0])
        self.assertFalse(inspect(self.root)['readyForRustDependencyReview'])

    def test_unpinned_registry_checksum_fails_closed(self):
        for rel,name in CRATES:self._lock(rel,name)
        self._lock(*CRATES[0],checksum='INVALID')
        self.assertFalse(inspect(self.root)['readyForRustDependencyReview'])

    def test_wrong_root_package_fails_closed(self):
        for rel,name in CRATES:self._lock(rel,name)
        self._lock(CRATES[0][0],'wrong-name')
        self.assertFalse(inspect(self.root)['readyForRustDependencyReview'])

    def test_symlink_lockfile_fails_closed(self):
        for rel,name in CRATES:self._lock(rel,name)
        lock=self.root/CRATES[0][0]/'Cargo.lock'
        target=self.root/'foreign.lock'
        target.write_bytes(lock.read_bytes())
        lock.unlink()
        lock.symlink_to(target)
        self.assertFalse(inspect(self.root)['readyForRustDependencyReview'])


if __name__=='__main__':unittest.main()
