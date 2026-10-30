# Milestone 13 — Windows IPC reliability and non-destructive rollback

Status: **SOURCE ONLY — NOT A PUBLIC RELEASE OR INSTALLER**. This milestone builds on M12; RepoQL **exactly 1.7.15** with connector **ABI 1** remains mandatory. Native Windows GUI use (Claude Desktop Code tab and OpenChamber Desktop), Tencent, Kanban, Agent Chat, dashboard, Ghost, live graph and Claude Office still require on-machine acceptance. No WSL is intended. Claude Office retains the known working token-URL mode for options 2 and 4. Nothing here changes production or GitHub main.

## Implemented here

1. `harness/rust-authority/src/authority_windows.rs`: Windows named-pipe operations use Win32 overlapped I/O with bounded connect (5 seconds), request (8 seconds) and reply (3 seconds) budgets. `CancelIoEx` is drained before the OVERLAPPED structure/buffer may be released. If a driver cannot acknowledge cancellation in the 2-second emergency window, the authority aborts rather than risking use-after-free. That termination behaviour must be tested on Windows and is **not** a replacement for service recovery.
2. Four fixed named-pipe workers bound concurrent stalled clients; no unbounded thread spawning or remote TCP fallback. Windows peer SID and existing authority token remain mandatory. `FIRST_PIPE_INSTANCE` and restricted pipe DACL are preserved.
3. The authority waits for the one-shot client to consume the response and close before calling `DisconnectNamedPipe`, which otherwise discards unread response data. The wait is bounded and client mutation outcomes still require revision reconciliation if delivery fails.
4. `native/windows/stage-native.ps1` can now rollback without manually removing the current stage. It preserves current files under `held-current`, restores `previous`, and makes a best-effort restoration if the move fails. It fails closed if `held-current` already exists. This is only **source staging rollback**, not service/configuration rollback.
5. Windows CI acceptance source now attempts a real three-stalled-client / one-health-client round trip against the compiled authority. A PowerShell smoke test checks the non-destructive rollback. Those tests have not been executed here.

## Offline evidence

- Windows source-gate and staging-contract tests: performed via Python unittest, not executable acceptance.
- Node authority adapter tests: performed; Windows-specific live Rust test skipped on non-Windows.
- Dashboard, Ghost and packaging verification: see milestone receipt JSON.
- Source ZIP checksum and source variant exclusion checks: see receipts.
- Rust `cargo test`, `cargo fmt` and Windows full integration: **not run** (no local Rust/Windows toolchain).

## Known constraints and remaining work

**P0**: Windows compile and formatting of Rust authority; named-pipe ACL/SID verification with different users, stalled clients and repeated reconnects; test the cancellation-abort case; verify no response loss under concurrent revision writes. Need review whether the 3-second client-close grace is sufficient and whether a message-ack protocol should supersede it.

**P0**: Implement and test native Rust Windows service supervision with ownership-proven PIDs/start times and crash recovery, full four-option installer/uninstaller and GUI configuration rollback. The current source-staging workflow does not install or own services.

**P0**: Validate RepoQL 1.7.15 binary/connector ABI 1 against real Tencent, Kanzo and MCP; verify Windows memory ingestion/recall, index durability, native MemoryKnowledge services, ownership/ACLs and restart recovery.

**P1**: End-to-end dashboard authentication and cross-service readiness (RepoQL, Tencent, Claude Office via established token URL, Agent Chat, Kanban, Ghost task/prompt writes and live graph). A loopback HTTP simulation does not establish real GUI availability.

**P1**: Complete Rust Ghost control server, Rust Agent Chat delivery, Kanban event durability, live graph stream, Windows process CPU telemetry and trusted Claude/OpenChamber subscription token metrics. Thin JS/TS GUI adapters may remain where the native host requires them; leave all service logic in Rust where possible.

**P1**: Public release checks for code signing, dependency and licence notices, secrets scanning, clean installation/upgrade/uninstall on supported Windows versions, release provenance and reproducible signed artifact manifests.

Release decision: **BLOCK**. No release claim should be made on the basis of static gates or ZIP checks.
