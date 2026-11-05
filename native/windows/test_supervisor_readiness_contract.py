"""Source contracts, NOT Rust compilation or Win32 acceptance evidence."""
from pathlib import Path
import unittest

SOURCE=(Path(__file__).resolve().parent/'rust-supervisor/src/lib.rs').read_text()

class SupervisorReadinessSourceTests(unittest.TestCase):
    def test_local_windows_drive_paths_only(self):
        self.assertIn('Prefix::Disk(_)',SOURCE)
        self.assertIn('remote or relative path refused',SOURCE)
        self.assertIn('FILE_ATTRIBUTE_REPARSE_POINT',SOURCE)
        self.assertIn('assert_existing_path_safe(path, true)',SOURCE)
        self.assertIn('assert_existing_path_safe(&c.executable, true)',SOURCE)
        self.assertIn('assert_existing_path_safe(&c.working_dir, false)',SOURCE)
        self.assertIn('assert_existing_path_safe(&c.executable, true).is_err()',SOURCE)
    def test_identity_not_http_status_only(self):
        self.assertIn('health_reply_matches(&bytes[..len], component)',SOURCE)
        self.assertIn('x-singularity-component',SOURCE)
        self.assertIn('if matched || value.trim() != component',SOURCE)
        self.assertIn('health_header_requires_exact_unambiguous_component',SOURCE)
        self.assertIn('if health_probe(h.port, &h.path, &c.id)',SOURCE)
        self.assertNotIn('if health_probe(h.port, &h.path) { break; }',SOURCE)
    def test_total_read_deadline_not_only_per_read_timeout(self):
        self.assertIn('let deadline = Instant::now() + Duration::from_millis(1200);',SOURCE)
        self.assertIn('deadline.saturating_duration_since(Instant::now())',SOURCE)
        self.assertIn('if remaining.is_zero() { return false; }',SOURCE)
    def test_real_rust_units_registered_and_windows_still_unverified(self):
        self.assertIn('fn health_header_requires_exact_unambiguous_component()',SOURCE)
        self.assertIn('fn rejects_symlinked_executable_and_config_ancestor()',SOURCE)

if __name__=='__main__':unittest.main()
