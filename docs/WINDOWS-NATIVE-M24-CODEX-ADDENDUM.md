# Codex native Windows handover addendum — Milestone 24

Read `docs/WINDOWS-NATIVE-M23-CODEX-HANDOVER.md` and `docs/WINDOWS-NATIVE-M24-CPU-HISTORY.md` together. Do not substitute M23 source for M24. M24 **does not** certify a public release.

## Required native acceptance before enabling Windows CPU chart

1. Build all Rust crates on Windows (stable release, `cargo fmt --check`, `cargo test`, `cargo clippy -D warnings`) and run Windows process-identity tests. M24 changed `native/desktop-bridge/src/windows_cpu.rs` to output `process_created_filetime`.
2. Install RepoQL **1.7.18** and verify its `host status --json --all` emits a PID and `startedAt` consistent with the *actual* Windows process creation time; if it does not, adapt the identity verifier using authoritative Win32 process identification, not a PID-only shortcut. Keep the collector fail closed.
3. Use the compiled `singularity-desktop-bridge.exe cpu-sample --pid <actual RepoQL PID> --sample-ms 250` to validate JSON against the real running RepoQL process. Test PID reuse, process exit between polls, access denied and restart.
4. For each option 1–4, configure `SINGULARITY_WINDOWS_NATIVE=1`, `SINGULARITY_INSTALL_VARIANT=<option>`, the Rust bridge executable location, the RepoQL binary, the private state directory and approved Python runtime; invoke `dashboard/native_cpu_history.py --config <dashboard-config> --once` without needing Docker/WSL.
5. Verify that `/api/cpu?period=1h` returns actual Windows process measurements, `cpu-windows-option{N}-v1.db` is isolated from other options, `cpu.db` does not leak Linux measurements, sample gaps remain unknown, retention is bounded and the dashboard chart labels the unit as percent of one logical core.
6. Supervise the collector using Rust Job Object lifecycle only after the Windows Rust supervisor has compiled and passed its ownership tests. Verify reboot, upgrade/rollback and user ACLs. The source ZIP does not automatically register a task or install Python.
7. Repeat the complete product parity matrix: Tencent, capture/recall/self-learning, RepoQL indexes, Kanzo, Agent Chat, usage receipts, graph, optional Ghost/Office, and all four GUI installation/upgrade/uninstall paths. Never mark working based on health responses alone.

## Explicit limitations

- Native Windows Rust code was not compiled in the Linux build environment. Simulated Win32 replies and live dashboard HTTP tests were exercised; no real Win32 process test is claimed.
- Dashboard subscription quotas and full-period GUI usage totals remain **Unknown**. Do not infer them from local model token counters or provider-wide traffic. The native GUI receipt source isolation from M23 is preserved.
- Preserve Claude Office's working token-in-server-URL credential sourcing. Keep a working OpenChamber/OpenCode worker transport without Claude Code free workers. Do not change the Linux production host or GitHub main without explicit approval.
