"""Source gates only. These do not establish a passing Win32 compile/runtime."""
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
WIN = (ROOT / 'harness/rust-authority/src/authority_windows.rs').read_text()
SHARED = (ROOT / 'harness/rust-authority/src/authority.rs').read_text()
ADAPTER = (ROOT / 'harness/kit/lib/rust-authority.mjs').read_text()

class WindowsAuthoritySourceGates(unittest.TestCase):
    def test_native_pipe_has_explicit_identity_and_remote_rejection(self):
        for symbol in ('PIPE_REJECT_REMOTE_CLIENTS', 'ConvertStringSecurityDescriptorToSecurityDescriptorW',
                       'OpenThreadToken', 'ImpersonateNamedPipeClient', 'RevertToSelf',
                       'peer_is_current_user', 'token_matches', 'FIRST_PIPE_INSTANCE'):
            with self.subTest(symbol=symbol): self.assertIn(symbol, WIN)
        self.assertNotIn('TcpListener', WIN)
    def test_unix_retained_and_windows_transport_isolated(self):
        self.assertIn('#[cfg(unix)]', SHARED)
        self.assertIn('#[cfg(windows)]', SHARED)
        self.assertIn('mod windows;', SHARED)
        self.assertIn('WINDOWS_RUNS_DIR_REQUIRED', ADAPTER)
        self.assertIn('isWindowsAuthorityPipe', ADAPTER)
    def test_platform_acceptance_is_not_mistaken_for_source_gates(self):
        workflow = (ROOT / '.github/workflows/native-desktop-rust.yml').read_text()
        self.assertIn('rust-authority-windows.test.mjs', workflow)
        self.assertIn('cargo test --manifest-path harness/rust-authority/Cargo.toml', workflow)

if __name__ == '__main__': unittest.main()

class WindowsAuthorityBoundedTransport(unittest.TestCase):
    def test_all_pipe_io_uses_overlapped_deadlines(self):
        for symbol in ('FILE_FLAG_OVERLAPPED', 'CreateEventW', 'WaitForSingleObject',
                       'GetOverlappedResult', 'CancelIoEx', 'timed_read', 'timed_write_all',
                       'CONNECT_TIMEOUT_MS', 'REQUEST_BUDGET', 'REPLY_BUDGET'):
            with self.subTest(symbol=symbol): self.assertIn(symbol, WIN)
        self.assertNotIn('fn FlushFileBuffers(', WIN)
        self.assertNotIn('OpenOptions::new().read(true).write(true).open(name)', WIN)

    def test_overlapped_timeout_never_drops_pending_stack_state(self):
        self.assertIn('WaitForSingleObject(event.0, CANCEL_DRAIN_MS)', WIN)
        self.assertIn('std::process::abort()', WIN)
        self.assertIn('let _ = unsafe { GetOverlappedResult', WIN)
        self.assertIn('remaining_ms(deadline)', WIN)
        self.assertIn('DisconnectNamedPipe discards unread replies', WIN)
        self.assertIn('wait up to three seconds', WIN)

    def test_fixed_pool_and_no_remote_network_fallback(self):
        self.assertIn('const PIPE_WORKERS: u32 = 4;', WIN)
        self.assertIn('std::thread::scope(', WIN)
        self.assertIn('PIPE_REJECT_REMOTE_CLIENTS', WIN)
        self.assertNotIn('TcpListener', WIN)
        self.assertIn('peer_is_current_user(pipe, sid)', WIN)

    def test_acceptance_stalled_client_probes_exist(self):
        probe = (ROOT / 'harness/kit/tests/rust-authority-windows.test.mjs').read_text()
        self.assertIn('stalled', probe)
        self.assertIn('healthy while', probe)
