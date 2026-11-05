# Windows native dashboard: windowless startup and recovery source changes

Date: 2 November 2026 (NZDT). **SOURCE ONLY. Not deployed, built on Windows, or accepted.** Installer, MSI/EXE packaging, GitHub release and publication remain blocked until the user personally approves the live Windows dashboard.

## Scope of corrections

* Existing Option 2 Dashboard, Agent Office and Ghost Scheduler logon tasks use Python's `pythonw.exe` without allocating a console. Dashboard and Ghost use `silent_python_host.py`, redirect stdout and stderr to project-owned, private rotating logs. Office's existing runner already redirects both streams before starting uvicorn.
* Ghost's individual scheduled jobs use the matching windowless Python interpreter and private job log. Task action and readback contracts agree; historical registered tasks require explicit owner-verified migration and must not be overwritten.
* Native Rust `unified-repoql-control.exe` accepts the existing ACL-protected `windows-unified-gateway.json` directly through `--config`, so the Windows scheduled task no longer launches PowerShell. It binds `127.0.0.1:18101`, checks the exact configured binary, retains private credential-file paths, rejects non-loopback RepoQL/Tencent URLs, and logs startup/failure to its existing private state directory. The old PowerShell task is recognized for scoped removal only, not restart.
* A `singularity_dashboard_open.exe` GUI-subsystem Rust binary opens the existing local dashboard with the current user's private key. The desktop shortcut points to it, not `powershell.exe`; the token remains off the shortcut command line.
* A `singularity_windows_supervisorw.exe` GUI-subsystem Rust binary invokes the existing supervisor library with private logs. It is only for installations where this existing supervisor is already the authoritative process owner; never run it alongside duplicate component tasks. The console `singularity-windows-supervisor.exe` remains the explicit CLI `check` tool. Stage the companion binary next to it before registering.
* Existing Windows scheduled task registrations have 3 retries at 1-minute intervals and `StartWhenAvailable` where appropriate. Repeated failures remain failed, never silently switch to Dockerhost, and require visible diagnostics.
* Other dashboard request-time subprocesses (RepoQL login, native Ghost control, CPU, allowance and Windows scheduler telemetry) use `CREATE_NO_WINDOW`. The earlier graph gateway ownership probe and supervised children already had the same correction.

## Onsite execution and non-goals

1. **Read-only first:** enumerate actual `Get-ScheduledTask` actions, startup triggers, running process owners, listening PIDs, service authentication and current source hashes. Determine which existing authority owns each port. Do not infer installed state from these source files. Reject mixed/duplicate owners.
2. Reconcile the candidate `WINDOWLESS-RUNTIME-DELTA.json` against the actual installed source preimage. Different hashes are a stop for targeted review, not permission to overwrite newer changes. Run the existing unit/contract tests and the locked native Windows Rust/MSVC builds. Copy *standalone runtime binaries only* into the existing private project-owned staging location after ownership verification. Do **not** touch installers.
3. Stop and remove **only verified project-owned legacy task actions** and register the updated windowless action under the same user and protected state. Existing managers refuse foreign actions. Do not remove credential, MemoryCore, RepoQL index, Kanzo or Ghost state. Verify task XML and binary path readback, and ensure old and new owners never run simultaneously.
4. Independently verify `RepoQL 1.7.18` and the official plugin, local RepoQL index, local Tencent metadata/core/MemoryPanel identity and automatic embedded sign-in, local Office session/WebSocket, native Kanzo lifecycle/connector, and Ghost scheduler. Use unique Windows-only positive markers and a Dockerhost-only negative marker. Check Task Scheduler parent PID and listener binary; loopback alone cannot prove data locality.
5. Logon, dashboard launch, graph refresh, RepoQL login, Office iframe, Tencent iframe, Kanzo task, Ghost schedule, background CPU probe, failed service restart, sleep/resume and Windows reboot must show **zero CMD/PowerShell/terminal windows, including flashes**. Record actual interactive desktop video/screen capture and Windows Task Scheduler History. Source tests cannot prove this.
6. Kill one project-owned component under a controlled test, observe bounded restart and authenticated recovery without false green status or old graph data; leave an intentionally unavailable service visibly unavailable with no Dockerhost fallback. Confirm private logs contain diagnostic metadata but no secrets or personal memory content.
7. Leave a real authenticated Windows dashboard running for the user's personal inspection; report full function/connection matrix. **STOP. No installer or release work until explicit user approval.**

## Build commands for existing agent on the confirmed Windows checkout

```powershell
cargo test --locked --all-targets --manifest-path .\native\windows\unified-gateway-rust\Cargo.toml
cargo build --locked --release --bins --manifest-path .\native\windows\unified-gateway-rust\Cargo.toml
cargo test --locked --all-targets --manifest-path .\native\windows\rust-supervisor\Cargo.toml
cargo build --locked --release --bins --manifest-path .\native\windows\rust-supervisor\Cargo.toml
python -m unittest -q native.windows.test_silent_runtime_contract native.windows.test_ghost_scheduler_host
```

These are **not verified on Windows from this review environment**. The actual versions, paths, binary hashes, task readbacks, browser screenshots and restart outcomes must be logged by the existing Windows agent. Do not use `-Apply` before reconciling task ownership and current installed source.

## Precise evidence still missing

Native Rust MSVC compile/test results, Pythonw/PowerShell task execution under the user's Windows session, zero-console visual capture, all embedded services signed in and operational, native RepoQL/Tencent data provenance, Kanzo actual task mutation and closure, Office live WebSocket event, independent service restart after crash/reboot, and user's personal dashboard approval.
