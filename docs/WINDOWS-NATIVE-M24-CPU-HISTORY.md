# Milestone 24: native Windows Rust CPU history integration

**Release state: source-only, no native Windows execution evidence.** RepoQL Windows version remains **1.7.18 / connector ABI 1**. No Docker, Ubuntu, WSL, systemd or Claude Code background workers are required by the new collector. Claude Office server-side token-URL method is unchanged.

## Concrete implementation

- `native/desktop-bridge/src/windows_cpu.rs` now includes the process creation Windows `FILETIME`, read from the same held Win32 process handle used for CPU deltas. It is returned only when initial/final process identity match. This Rust change has **not been compiled** here.
- `dashboard/native_cpu.py` rejects attempted process attribution without the creation identity. System-only CPU readings are still valid if explicitly requested without a PID, but they do not appear as RepoQL process usage.
- `dashboard/native_cpu_history.py` is an independent collector. It obtains `host.pid` and `host.startedAt` from the configured native RepoQL 1.7.18 CLI, samples the held Win32 process through the Rust bridge, and refuses process CPU measurement unless the creation FILETIME and RepoQL startup time agree (5-second granularity tolerance). Absent, recycled or unverified identities create gaps, **never zeros**.
- The collector writes SQLite `cpu-windows-option{1,2,3,4}-v1.db` into the configured dashboard state directory. It never uses `cpu.db`, `/proc`, systemd, WSL, Docker or the legacy collector. It enforces explicit `SINGULARITY_INSTALL_VARIANT`, bounded 1–365 day retention and 5–3600 second sampling intervals.
- `dashboard/server.py` reads this separate data store for native `/api/cpu`; the dashboard chart can now display actual observations after the optional collector is installed. Empty, stale or unverified data remains unavailable. Linux chart behaviour is unchanged.
- Source-level tests cover valid observations, PID reuse, unknown start identity, missing Rust probe, retention, gaps, four-option separation, and legacy-Linux-data isolation; the tests use simulated Win32 replies and SQLite, **not live Windows telemetry**.

## Activation on an isolated native Windows installation (Codex only after native tests)

The collector is not automatically launched by the source-only package. After `singularity-desktop-bridge.exe` has been compiled and its process identity tests pass, the installed Windows supervisor can launch the existing Windows `python.exe` with the `dashboard/native_cpu_history.py --config <path-to-native-dashboard-config.json>` arguments. The supervisor must set these non-secret child environment entries: `SINGULARITY_WINDOWS_NATIVE=1`, `SINGULARITY_INSTALL_VARIANT=<1|2|3|4>`, `SINGULARITY_NATIVE_BRIDGE_EXE=<absolute-private-native-executable>`, and where needed `SINGULARITY_RQL_BIN=<absolute-rql.exe>`, `SINGULARITY_STATE_DIR=<private-local-state-directory>`. Do not insert API keys, token URLs or credentials in supervisor configuration. The Python runtime is already used by the dashboard; a version-locked, bundled runtime is still a separate installer task.

On Windows, run the read-only `--once` mode before supervising continuous collection. Run `python -m unittest discover -s dashboard -p test_native_cpu_history.py`, then launch the dashboard with each installation profile and inspect `/api/cpu?period=1h`. Compare the observed PIDs/creation FILETIMEs with the actual RepoQL process before accepting readings. Restart the RepoQL host and verify the collector records a gap until a new identity is established. Finally test restart, upgrade, rollback, per-user ACLs and SQLite writer contention. No CPU data is to be regarded as real until these live checks pass.

## Remaining gaps

Authoritative Claude Code/OpenChamber subscription limits and full-period token totals remain **unknown** until the installed GUI provides a validated authenticated usage source. Rust crate compilation, real Windows Win32 process timing, separate installation profiles, full self-learning/Tencent/RepoQL parity, and installer lifecycle are also outstanding. Windows source packages are not executable installers.
