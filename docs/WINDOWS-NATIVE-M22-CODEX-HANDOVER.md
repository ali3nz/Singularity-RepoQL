# Native Windows Codex handover — Milestone 22

**Verdict: NOT RELEASE-READY. This is an evidence-backed source checkpoint, not a native Windows installer.** No WSL or Docker may be used to fulfil the Windows release requirement. Do not change a working production Linux host during acceptance. All four profiles require **RepoQL 1.7.18 exactly / connector ABI 1**. The complete profiles (2 and 4) retain the production-compatible Claude Office **server-side token-URL mode**; do not replace it without successful real GUI evidence and a rollback. Claude Code has **zero required free worker seats**: use an explicitly configured, capacity/billing-approved native OpenChamber/OpenCode backend.

## What was actually exercised before handover

Milestone 22 includes `dashboard/test_native_e2e_server.py`, which starts the actual Python dashboard HTTP server and three isolated local HTTP services and exercises the **real listener**. It verifies bearer-only handshakes, panel-specific signed-cookie audiences, Office GET/token forwarding, Tencent owner-key authentication and sanitized session data, Kanzo MCP route denial, Origin checks on Office writes, and Office redirect normalization. The redirect implementation in `dashboard/native_panel_proxy.py` now rewrites safe upstream redirects to the correct `/embed/{panel}/` origin, drops token/key parameters and drops all redirect bodies; remote redirects return a sanitized 502. This test uses synthetic local services, not actual production or Windows apps.

Run the full offline test suites again on Windows (no Docker needed):

```powershell
py -3 -m unittest discover -s dashboard -p 'test_*.py'
py -3 -m unittest discover -s native/windows -p 'test_*.py'
py -3 -m unittest discover -s ghost/prompt-store -p 'test_*.py'
node --test harness/kit/lib/native-opencode-worker.test.mjs harness/kit/lib/native-managed-seat.test.mjs
node --test scripts/doc-ingest-node.test.mjs adapters/claude-code/doc-hook.test.mjs
py -3 -m unittest discover -s scripts -p test_doc_ledger_lock.py
```

Also run `python native/windows/verify_source_release.py`; build and scan all four source variants using `native/windows/build_source_variants.py` and `native/windows/scan_source_archive.py`. These are *source checks only*.

## First priority: native Rust compilation and real IPC

Use Windows `cargo`/`rustc` with a locked dependency set where possible; keep detailed stdout/stderr, toolchain version and SHA256 of each compiled binary. Run `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, and `cargo test --all-targets` separately for:

- `native/desktop-bridge/Cargo.toml` (without and with `office,ghost` features)
- `harness/rust-authority/Cargo.toml` (named-pipe authentication, owner identity, bounded I/O, revision and concurrent-client cases)
- `native/windows/rust-supervisor/Cargo.toml` (suspended launch, Job Object assignment before resume, automatic cleanup, exact readiness identity)

The authored `.github/workflows/native-desktop-rust.yml` has matching Windows CI gates, **but it has not run against this milestone**. If a compiled crate fails, fix that first, before touching GUI installations.

## Second priority: stage safely, without changing the existing GUI

Run `native/windows/preflight.ps1` using the exact native `rql.exe`, desktop GUI, bridge and supervisor paths. It should report status, not modify state. `native/windows/stage-native.ps1` is **preview by default**; it can stage an explicitly compiled bridge/supervisor with `-Apply` after path, manifest and checksum validation, and supports `-Rollback`. It does **not** install/start services, inject GUI hooks, set user tokens or verify production parity. Do not describe it as the finished installer. Capture its stdout/stderr and a post-operation file inventory.

Read-only `native/windows/native_runtime_acceptance.py` can observe installed PE identities and component health with a data-only JSON configuration. Do not confuse `OBSERVED_IDENTITY_SHAPED_HTTP` with end-to-end functionality.

## Third priority: actual integration and release acceptance

For *each* of the four installation profiles, validate with real native services, a durable disk state directory, real GUI clients, and before/after restart tests. Attach independent production and Windows receipts to `native/windows/compare_production_parity.py` (example receipts are explicitly synthetic and MUST NOT be used to approve release):

1. RepoQL 1.7.18 exact version; ABI 1; Tencent and Kanzo connector install, index, query and readback from clean state.
2. Tencent MemoryCore/MemoryKnowledge native process startup, data persistence, identity isolation and semantic recall, with no Linux service or container dependency.
3. End-to-end self-learning capture, candidate assessment, knowledge promotion, conflict correction, verified documentation ingestion and cross-session recall.
4. Rust Harness authority ownership and concurrency, native OpenChamber task submission with **no Claude worker slots**, explicit billing/capacity limits, acknowledgment vs completion, durable queue/lease and process-restart recovery.
5. Agent Chat durable dispatch, delivery acknowledgment and replay; Kanzo create/update/readback; live memory graph updates and reconnect; real Windows process CPU; GUI-attributed subscription metrics (not mixed Freebuff or arbitrary provider usage).
6. Complete options only: Ghost task lifecycle and prompt edit/revert/audit, Claude Office token-URL embed, room/sprite assets, events/presence, redirects and token non-disclosure to browser. Confirm Office from the actual GUI; keep `SINGULARITY_OFFICE_NATIVE_AUTH_MODE=legacy_url` unless a change is separately authorized and proven.
7. Four native GUI installations, version upgrade, clean uninstall, rollback, service restarts and ACL validation. Record `Get-Process`, Task Scheduler, binary hashes, service identities and any native Windows failures. No WSL, Docker, Ubuntu daemon or shell launcher may be required for runtime.

## Evidence contract and release decision

Do not fabricate parity receipts or mark an endpoint green solely because it answered HTTP 200. Keep all the original evidence from Windows and production, redact tokens/secrets/user content, and attribute each result to the actual machine and binary version. If a component lacks a native service implementation or fails real operation, mark it **BLOCKED** rather than inventing an equivalent. `native/windows/runtime_closure.py` is deliberately source-only and remains blocked until the complete native service and behaviour layer exists.

**Known remaining P0 gaps:** native Rust executable compilation; complete Tencent/MemoryKnowledge runtime; full transactional installer + service ownership and rollback; real Windows GUI acceptance; production parity. The source-only artifact is not a public release.
