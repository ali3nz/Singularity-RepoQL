## Milestone 22 (2026-10-29)

Added a real HTTP dashboard listener integration test with synthetic Office/Tencent/Kanzo services and corrected safe panel redirect forwarding with server-side token protection. See `docs/WINDOWS-NATIVE-M22-CODEX-HANDOVER.md`. This proves local Python integration boundaries but NOT native Windows runtime parity. Native Rust compilation, service lifecycle, GUI acceptance and the full installer remain blocked.

## Milestone 21 (2026-10-29)

Added native Windows read-only runtime observations (strict binary and loopback component checks) and Agent Chat inbox file-identity race rejection. Neither constitutes feature parity, full runtime ownership, or Windows build acceptance. RepoQL 1.7.18 and Office legacy server-side token URL retained. See `docs/WINDOWS-NATIVE-M21-RELEASE-GATE.md`. All previously listed P0 tasks remain unresolved.



## Milestone 20 (2026-10-29)
Native supervisor path/reparse checks, identity-specific readiness, bounded health probe and authenticated Harness redirect controls added. See docs/WINDOWS-NATIVE-M20-RELEASE-GATE.md. Real Rust compilation and Windows end-to-end parity remain BLOCKED.

## Milestone 23 dashboard source checks (2026-10-29)
See `docs/WINDOWS-NATIVE-M23-DASHBOARD-MATRIX.md`. Native usage is now filtered by the *selected* GUI, not by the union of both desktop sources; full-period tokens and subscription quotas stay unknown. Windows CPU history no longer uses Linux samples or 4-core systemd labels. The native readiness panel is diagnostic only. Authoritative desktop subscription/quota ingestion, real Windows Rust CPU history, and live component/GUI acceptance remain blocked pending the installed runtime.

M24: Native CPU history collector and SQLite dashboard consumption have offline tests, but Win32 Rust process creation identity still needs compilation, live sampling, supervisor activation, reboot and rollback acceptance. GUI subscription quota collectors still absent.

### Milestone 25 (2026-10-29)
CPU collector supervisor-component preview and lifecycle integration added with tested PID-source validation; real Rust compilation, native runtime packaging, status/restart/rollback/ACL verification still required. See docs/WINDOWS-NATIVE-M25-CPU-COLLECTOR-SUPERVISION.md.
