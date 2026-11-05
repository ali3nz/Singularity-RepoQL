# Singularity RepoQL native Windows — Milestone 8 release audit

Date: 2026-10-29 (NZDT). **RELEASE VERDICT: BLOCKED.** Source-only development checkpoint; **not** a native Windows installer and **not** proof that any of the four Windows GUI variants operates. Baseline: GitHub `ali3nz/Singularity-RepoQL` commit `4f3d0f971f09ec677e7d4e5e49147476c054b311`. Supersedes Milestone 7 as source handoff; does not overwrite earlier audit evidence. Exact external RepoQL version **1.7.15**, connector ABI 1. Do not update to 1.7.17.

## Completed in Milestone 8 (source-level)

1. **Scoped authentication across embedded panels**: dashboard signed launch cookies have separate cryptographic audiences for RepoQL, Tencent, Kanzo and Claude Office. Cookies from one panel cannot authorize a different panel. Existing authenticated dashboard and CSRF/Origin gates remain in place; there is NO unauthenticated bypass.
2. **Windows RepoQL login security**: native Windows dashboard retains the *official RepoQL-issued* short-lived login capability in process memory rather than storing it with POSIX 0600 permissions in a Windows path. Requests reuse it for 30 seconds; process restart discards it. The Linux private-file behaviour is unchanged. The actual `rql.exe dashboard --url` 1.7.15 output and real GUI iframe still require live acceptance.
3. **Office native credential boundary**: the Windows Office panel requires `SINGULARITY_OFFICE_PANEL_KEY_FILE`. It will not take the Office API key from an embed-URL query. The file must receive owner/service-SID-only Windows ACLs at install time, which is NOT yet implemented. Existing legacy Linux URL behaviour is preserved.
4. **Rust native Windows CPU measurement source**: new `native/desktop-bridge/src/windows_cpu.rs` calls Win32 `GetSystemTimes`, `GetProcessTimes` and `OpenProcess` directly, no Linux `/proc`, WSL, PowerShell or shell command. Measures wall-time deltas and returns both system usage and RepoQL per-core/host-normalized process usage. `dashboard/native_cpu.py` validates the executable and bounds/matches returned data; otherwise returns unavailable, never fictional zeroes. This new Rust module has **not compiled** here.
5. **Rust Ghost control client source (2/4 only)**: `native/desktop-bridge/src/ghost.rs` uses a fixed loopback HTTP origin with a private key from configuration, no redirects/proxy, bounded JSON and a strict action allowlist including `set-prompt` and `revert-prompt`. `dashboard/native_ghost.py` invokes the Rust EXE with no shell, sends action payload through stdin, and refuses to report successful mutations without an explicit upstream acknowledgment. Windows `ghost_bridge.py` now routes to this client; legacy Unix-socket Linux remains unchanged. **A native Windows Ghost daemon implementing authenticated GET /state and POST /action is still missing** and no prompt/task edit can yet be shown to work end-to-end. Rust `ghost` is a complete-option-only build feature and source exclusion; lean variants exclude its source/client.
6. **Per-component readiness API**: authenticated `GET /api/native/windows/readiness` probes RepoQL version, Tencent identity, Kanzo ping, Agent Chat inbox state, the unified Rust graph gateway and (only options 2/4) Office/Ghost health. Public response never exposes keys, tokens or private upstream errors. A reachable service **does not** mean GUI/connector/indexing/subscription/Windows service acceptance. Those stay `unverified` and release_ready is always false.
7. **Native GUI and source variant hardening**: four variant packages remain exactly scoped, dashboard Ghost/Office routes excluded for 1/3, strict RepoQL 1.7.15 check continues, and packaging verification now covers the new Rust files and Python adapters. CI source now calls auth, CPU, Ghost and readiness tests, and builds complete Rust with `--features office,ghost` (lean uses no default features).

## Cross-environment source tests completed here

- Dashboard Python test discovery: **31 passed** including auth-cookie audience, Windows in-memory RepoQL issuance, Office file-source credential, CPU response contract, Ghost action/mutation safety, readiness matrix, variants and existing checks.
- Focused Node test suite (bundle classifier, document ingest, Claude documentation policy, OpenChamber GUI adapter): **37 passed**.
- Native Windows Python static/RepoQL compatibility suite: **6 passed**.
- Static release verifier: all **4 option profiles** checked, **40 source files** explicitly checked, **RepoQL exact 1.7.15 / connector ABI 1** policy confirmed. These are offline tests using source/fixtures and do not prove actual Windows services.
- Final complete source ZIP and all four variant ZIPs: **ZIP CRC PASS and per-file SHA256 PASS**. Lean options 1/3: extracted package import smoke **PASS** without Ghost/Office source files. The cumulative patch applied cleanly to the archived original baseline (Git apply emitted pre-existing trailing whitespace warnings from documentation). Rust has **not** been compiled, formatted with rustfmt, clippy-checked or exercised on Windows because no Rust toolchain is installed here.

## Option acceptance (no WSL)

| Option | GUI | Baseline | Optional features | Offline source | Clean Windows install | GUI hooks/MCP | Live service E2E |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Claude Desktop Code tab (not terminal CLI) | Tencent, RepoQL 1.7.15, dashboard, Agent Chat, Kanzo | No Ghost/Office | source verified | NOT RUN | NOT RUN | NOT RUN |
| 2 | Claude Desktop Code tab | Same | Ghost and Office | source verified | NOT RUN | NOT RUN | NOT RUN |
| 3 | OpenChamber native desktop GUI (not OpenCode CLI) | Same | No Ghost/Office | source verified | NOT RUN | NOT RUN | NOT RUN |
| 4 | OpenChamber native desktop GUI | Same | Ghost and Office | source verified | NOT RUN | NOT RUN | NOT RUN |

## Critical outstanding work possible without access to the user's Windows machine

A. **Compile and lint Rust in an environment with a toolchain** (Linux test runner or GitHub Windows Actions) and resolve all compiler/rustfmt/clippy issues; regenerate locked Cargo dependency graph, produce dependency SBOM and signed/hashed build artifacts. Current environment has no `cargo`, `rustc` or `rustfmt`. A Windows runner is necessary to compile and execute the Win32-specific FFI section.
B. **Write/verify a native Windows installer and safe upgrade/uninstall path** with 4 exact options, minimum OS/runtime prerequisite checks, clean per-user installation, service owner/PID and start-time verification, ACL-deny tests, backup and reversible rollback. Avoid WSL, Docker and manual terminal-only setup as prerequisites. Treat altered existing GUI settings and user prompts as sensitive; no silent overwrites.
C. **Port backend services to Rust**: memory write capture and verified recall, retry/replay/idempotency, durable Agent Chat mailbox and cursor storage, authenticated native Ghost server (not merely client), live memory graph streaming/identity filters, dashboard HTTP/auth/proxy backend, typed connector health and eventual native OS service manager. Retain only mandatory JS/TS plugin glue for host GUI APIs.
D. **Create hermetic synthetic E2E fixtures and browser tests** for `GET /api/native/windows/readiness`, same-origin auth sessions, panel cookie replay/CSRF, Tencent session, RepoQL-issued login, Kanzo board edits and prohibited `/mcp` external access, Ghost prompt/task changes, Office event/iframe/WS, graph refresh/reconnect, multi-agent chat isolation and subscription-usage attribution. Existing tests mostly assert source boundaries and response mapping.
E. **Native credentials**: service-specific Windows ACLs or Windows Credential Manager; secure dashboard bearer persistence/rotation and Office/Tencent/Ghost keys. The in-memory RepoQL issuer fix does NOT solve all other stored credentials. Verify all token exchanges have a single intended audience, no secrets in browser JS, URL logs, metadata or published archives.
F. **Release hygiene**: third-party licenses, RepoQL redistribution/licensing check (externally installed, not bundled), secret/PII scan, dependency vulnerability and Windows SmartScreen/code-signing guidance, reproducible build and release notes. Source-only packages are not sufficient.

## Required Windows machine and native-GUI acceptance

1. Actual `rql.exe --version` is 1.7.15. Install/activate both Tencent and Kanzo connectors, verify ABI 1, index/sweep/refresh, actual query and content provenance. Never accept 1.7.17 as automatic fallback.
2. Start native MemoryCore, MemoryKnowledge and MemoryProxy without WSL; prove scoped capture, extraction, long-term ingestion, isolation and cross-session recall in **the actual Claude Desktop Code tab and OpenChamber Desktop GUIs**.
3. Test all four clean-machine options independently: setup, first launch, auto-start, logout/login, restart, upgrade, uninstall/rollback, Windows Defender/ACL failures and backup restoration.
4. Native Kanzo board CRUD, Agent Chat cursor delivery/retry, Ghost task/prompt edit commands (2/4), Claude Office events/renderer and WebSocket (2/4), RepoQL iframe single-sign-on and token rotation, graph freshness/reconnect, correctly scoped CPU reading and real Claude/OpenChamber subscription token receipts.
5. Confirm no WSL/Linux `/proc`/Docker/systemd/unix sockets/CLI-only demonstration is being mistaken for a native Windows GUI implementation.

## Priority release decision

**NOT READY**. All 4 source variants are reviewable, not installed/executable releases. The strongest source advances are auth isolation, Windows credential safety, Rust CPU and Ghost control *client*, and actionable per-component diagnostics. The primary blocker is still a functioning, installed native Windows dependency/service stack and real GUI acceptance. Do not merge to main or market a ready public Windows release until the independent Windows evidence passes.
