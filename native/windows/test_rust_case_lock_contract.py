"""Guard against reintroducing the native Rust stale-lock double-writer bug."""
from pathlib import Path
import unittest

SRC=(Path(__file__).resolve().parents[2]/'harness/rust-authority/src/case_store.rs').read_text()

class RustCaseLockContract(unittest.TestCase):
    def test_win32_atomic_existing_file_replacement_candidate(self):
        self.assertIn('#[cfg(windows)]', SRC)
        self.assertIn('fn ReplaceFileW(', SRC)
        self.assertIn('commit_temp(&temp, path)?;', SRC)
        self.assertIn('STATE_ATOMIC_REPLACE_FAILED', SRC)
        self.assertNotIn('fs::remove_file(path)', SRC)
    def test_never_steal_case_lock_by_timeout(self):
        self.assertNotIn('fn stale(',SRC)
        self.assertNotIn('LOCK_STALE',SRC)
        self.assertNotIn('owner_alive(',SRC)
        self.assertIn('std::io::ErrorKind::AlreadyExists',SRC)
        self.assertIn('Err("LOCK_TIMEOUT".to_owned())', SRC)
        acquire=SRC.split('fn acquire_lock(')[1].split('\n#[cfg(test)]')[0]
        already_exists=acquire.split('Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {')[1].split('Err(error) =>')[0]
        self.assertNotIn('remove_dir_all',already_exists)

if __name__=='__main__': unittest.main()
