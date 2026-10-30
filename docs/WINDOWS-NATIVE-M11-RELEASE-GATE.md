# Singularity RepoQL Windows native milestone 11 — release gates

Date: 2026-10-29 NZDT. Baseline: Milestone 10 cumulative source, ultimately based on Git `4f3d0f971f09ec677e7d4e5e49147476c054b311`. This is **source-only work**; not installable public binaries, no WSL allowed. RepoQL must remain exactly **1.7.15 / connector ABI 1**. Claude Office stays on the established token-URL mode by default for options 2/4, with a documented key-file alternative. No production settings or secrets are included.

## Improvements made in Milestone 11

1. **Unified graph/usage/Tencent gateway credential isolation.** `dashboard/unified_bridge.py` now uses `http.client` to a validated literal loopback IP with explicit port, rather than an HTTP client that can automatically follow upstream redirects. It refuses redirects without contacting their destination, suppresses upstream error bodies, preserves bounded payloads and disallows malformed multi-line tokens. This is important for the graph and usage panels because the gateway authorization key is sent with every request. New `dashboard/test_unified_windows_proxy.py` uses an actual local HTTP server (not mocked `urlopen`) for GET, POST, redirect, 401, oversized data, invalid origins, malformed token and cache recovery.
2. **Native Rust case writer safety.** Removed timeout/PID-based deletion of `case.lock` in `harness/rust-authority/src/case_store.rs`. A writer holding its lock for longer than a timeout must not be displaced. Acquisition times out safely, requiring separately verified ownership before manual recovery. This removes an unsafe two-writer race but does not implement automatic crash recovery.
3. **Win32 Rust file replacement candidate.** `harness/rust-authority/src/case_store.rs` now uses `ReplaceFileW` for a previously existing state or journal target on Windows, instead of `std::fs::rename` which cannot reliably overwrite an existing file. The temporary file is synced before replacement; failure preserves the original file and is returned rather than deleting the destination. Existing Rust CAS/journal tests are intended to exercise the path once Windows CI compiles and runs them. **Uncompiled, unexecuted here.**
4. **Read-only-first native Windows staging script.** `native/windows/stage-native.ps1` validates an extracted option-specific source manifest, every file hash, exact RepoQL 1.7.15, local executable paths and basic Windows PE format. It refuses symlinks/reparse points and path traversal, stages source and a precompiled bridge under the current user's `%LOCALAPPDATA%\Singularity` with protected NTFS ACLs, verifies copied hashes, and retains one immutable `previous` rollback snapshot. Default mode is preview; `-Apply` requires explicit consent. `-Rollback` refuses to overwrite `current` and can run without needing a now-missing executable or source archive. **It intentionally does not configure GUI hooks, launch services, install third-party RepoQL, edit credentials, set Windows services, or claim release acceptance.** This is a staging component, not a finished installer.
5. **Windows release gating.** `.github/workflows/native-desktop-rust.yml` now includes native Windows staging smoke scenarios (preview, apply, upgrade, backup conflict, manual rollback), plus a separate Rust Harness build/test gate on Windows and Ubuntu. The latter should currently expose the remaining Unix-only authority APIs until a Windows transport is implemented. Source contract tests run offline on Linux; true PowerShell and Rust execution still require CI.

## Offline evidence in this turn

- Existing dashboard suite plus new loopback-protocol tests: see receipts and invocation logs.
- Windows source compatibility and case-lock policy source contracts: see receipts and invocation logs.
- Node tests and deterministic option ZIP validation: see receipts and invocation logs.
- No Rust compiler, Windows host, PowerShell runtime, cloud CI logs or live installed services were available in the local execution environment. **Do not call any Rust or Windows integration verified.**

## Remaining work that *can still be developed without a Windows machine*

**P0:** Implement a Windows-compatible Rust Harness run-state authority. Existing Unix socket transport, `libc::SO_PEERCRED`, `/proc` liveness and legacy worker integration are not Windows native. Use an OS-verified Windows named pipe with appropriately restricted DACL and process identity (or a documented, tested security-equivalent authority) before enabling state mutation. Do not simply replace the socket with unauthenticated loopback TCP. Preserve revision/CAS and journal recovery, and test multi-writer crash/restart scenarios.

**P0:** Finish Rust native service manager and lifecycle: per-user service identity, process tree termination, PID creation-time proof, code-signing policy, install/upgrade/restart, data preservation and rollback. Stage script is intentionally not service provisioning.

**P0:** Compile and test the new `ReplaceFileW` candidate on Windows against repeated updates and crash injection, then audit *all other* atomic file swap paths. Ensure interrupted writes do not corrupt authoritative state. The new source path is not yet runtime-verified.

**P0:** Obtain Rust toolchain in CI, compile both crates on Linux+Windows, require formatting/lint/unit and integration tests, generate/pin `Cargo.lock` for desktop bridge and preserve dependency/SBOM evidence. Windows-source Rust code has not been compiled in this environment.

**P0:** Finish a true four-option Windows installer with standalone Rust executables, connector configuration, non-admin/ACL and native service registration, verified GUI hooks/plugins, disjoint Ghost/Office profiles, upgrade/uninstall receipt, and rollback. Current source ZIPs and staging script must not be promoted as installers.

**P1:** Implement native Ghost task control and prompt edit/revert server with revision-safe Rust storage, audit and authenticated IPC. Keep proven Office token URL authentication as default and verify both the Office dashboard iframe and GUI event delivery separately. Preserve the server-side token proxy; no private token should enter the source ZIP.

**P1:** Establish real native MemoryCore + MemoryKnowledge lifecycle, RepoQL 1.7.15 connector ABI/index/search, Tencent owner-scoped memory capture+recall, Kanban create/update/ack, Agent Chat durable events, live memory graph streaming and reconnects, and dashboard health readiness with authenticated end-to-end checks.

**P1:** Replace remaining Linux `/proc`, systemd and Unix-socket dependencies in the dashboard, Rust Harness, Ghost and supporting modules. CPU is Rust Win32 candidate only; actual CPU sampling and authoritative Claude Desktop/OpenChamber subscription token receipts are still pending.

**P1:** Public provenance/license audit including third-party Office fork, secrets and logs scan, dependency locking, reproducible packaging, SBOM and published release checklist.

## Checks genuinely requiring Windows/real GUIs

- Windows MSVC Rust compilation, binary launch and OS ACL/process identity tests, native service start/reboot/restart/logoff, and Defender/firewall policy; execute smoke-stage Windows test via CI.
- Four clean GUI installs and remove/reinstall cycles: options 1/2 Claude Desktop Code tab and options 3/4 OpenChamber Desktop; verify native GUI sessions rather than a CLI-only substitute.
- Actual RepoQL `rql.exe --version` 1.7.15 with both ABI1 connectors; real Tencent memory/write/read and Kanban operations.
- Office production-compatible token URL/iframe/WebSocket and events, Ghost prompt edits/tasks, Agent Chat, live graph and reconnects, Windows CPU, and truly sourced subscription usage.

**Current release decision: BLOCKED.** All outputs remain source review and staging material. Existing production Office authentication is unchanged.
