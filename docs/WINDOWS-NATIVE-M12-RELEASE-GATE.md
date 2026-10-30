# Native Windows Milestone 12: authority IPC prototype and safe staging

Status: **SOURCE-ONLY / NOT A PUBLIC RELEASE**. Base: Milestone 11, not upstream Git main. Date: 2026-10-29 NZDT. RepoQL is pinned to **1.7.15 / connector ABI 1**. Options 1/3 are lean; options 2/4 contain Ghost and Claude Office. The existing Claude Office server-side token-URL integration stays the default; no working production settings are changed.

## What changed

1. **Rust Harness Windows authority candidate.** Added `harness/rust-authority/src/authority_windows.rs` behind `#[cfg(windows)]`; Unix socket implementation is retained behind `#[cfg(unix)]`. Named pipe is local (`\\.\pipe\...`), refuses remote pipe clients, restricts the DACL to the launching Windows user and LocalSystem, then impersonates the caller and compares the OS-issued user SID. Shared token and RunStore protocol remain mandatory, with no fallback to unauthenticated loopback TCP. This is NOT compiled or live-tested in this environment.
2. **Native JavaScript authority client.** Recognizes Windows pipe names rather than checking filesystem existence; requires an explicitly local Windows runs directory, never infers run roots or reads token files from pipe path strings, and uses proper `fileURLToPath` for the CLI path. Unauthorized and unavailable authority calls fail closed; local JS state writes are not silently substituted. Added ten targeted Node protocol/adapter tests (three Windows contract tests).
3. **Windows authority integration CI.** Added a Windows-only Node test intended to compile and launch the actual Rust authority and execute pipe health, run-state CAS, authenticated write/read and negative-token operations. This test is **skipped outside Windows without a compiled Rust executable**, not a pass on Windows.
4. **Source archive gate.** Rejects Windows device names, reserved characters, trailing dots/spaces, casefold collisions, archive traversal, encrypted members, oversized uncompressed total and unallowlisted compression. Builder now runs the same scanner immediately after generating an option ZIP.
5. **Windows staging/rollback.** Rollback no longer requires the original bridge/RepoQL/GUI executables or source root, and validates the snapshot receipt before restoring. Option 1-4 is required for *staging*, not rollback. PowerShell smoke scenario exercises rollback without those arguments. Staging also validates Windows-safe source names and case-insensitive uniqueness.

## Known release blockers and correctness risks

- **P0: Rust compiler and Win32 tests not run.** `authority_windows.rs` needs Windows MSVC compilation, `cargo fmt --check`, clippy, live IPC tests, DACL inspection, cross-logon/SID refusal, token rejection and service crash recovery. No Windows CI result is available here. The new code is a candidate, not accepted runtime.
- **P0: Named pipe synchronous-client starvation.** Current first-pass Win32 transport handles clients sequentially and a connected client that never sends its request could occupy the server indefinitely. Implement bounded overlapped `ReadFile` / cancellation and concurrent bounded clients before production enablement. Do not deploy the mutating authority until this is fixed and the relevant stress cases pass.
- **P0: Windows service manager, installer, upgrade and uninstall are not implemented.** `stage-native.ps1` stages source and a separately provided executable only, by deliberate design. No daemon is registered or GUI configured.
- **P0: Native Tencent MemoryCore and MemoryKnowledge service lifecycle and RepoQL 1.7.15 connectors remain unproven on Windows.** Source manifests and ABI checks are not real installed-binary checks.
- **P1: Dashboard end-to-end wiring remains unverified** for Claude Office iframe/WebSocket/event receipt; Ghost tasks, revisioned prompt editing and audit; Agent Chat/Kanban persistent operations; graph streaming/reconnect; process CPU and subscription-only GUI token receipts.
- **P1: Rust-first migration still incomplete:** JS coordinator and Node hooks, Python dashboard and Ghost prompt store, native agent office frontend and integration shims remain. The OpenChamber host's required plugin entry point will remain a thin JavaScript adapter unless upstream changes.
- **P0: Public provenance/license/security review** (third-party components, token handling, dependency locking/SBOM, no credentials/logs in artifacts) is still required.

## Tests and acceptance interpretation

Source-level Linux checks executed: 51 dashboard Python tests, 9 Ghost prompt-store tests, 24 Windows source-contract tests, 31 passing targeted Node tests with one *Windows live* test skipped, static RepoQL/variant verification, four source ZIP integrity and SHA256 checks. This proves packaging and existing source contracts, not Rust compile or GUI runtime functionality. Do not add overlap counts or mark any source-only package `release-ready`.

## Windows Codex first-run sequence (read-only, no installation mutations)

1. Preserve installed config + Claude Office token URL **locally in an access-controlled backup**, without placing the secret in logs, chats, GitHub or Drive.
2. On a Windows MSVC toolchain, run `cargo fmt --manifest-path harness/rust-authority/Cargo.toml --check` and `cargo test --manifest-path harness/rust-authority/Cargo.toml --all-targets`; fix compile/format errors before going further.
3. Run the named-pipe Windows test after compiling the Rust binary. Verify a wrong token and another Windows logon session cannot mutate state; test a connected client that never sends data and fix starvation before enabling the real writer.
4. Test `native/windows/smoke-stage.ps1` against disposable source variants, then the read-only preflight and actual installed `rql.exe --version` (exact 1.7.15).
5. Only after these gates pass, design and approve reversible service/GUI integration tests for all options and compare the Office iframe with the known working token-URL path.

**Decision: BLOCKED.** No modification to public GitHub main, production GUI, credentials or running services.
