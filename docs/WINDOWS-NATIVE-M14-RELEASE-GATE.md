# Windows native Milestone 14: Rust process ownership and release safety

**Status:** DEVELOPMENT SOURCE ONLY. This is neither a working installer nor an approved public release. Do not deploy the task or run the supervisor on a production Windows machine. This branch is derived from the archived Milestone 13 snapshot, not from an independently tested GitHub release. No changes are made to the working Docker/Linux deployment.

## What was implemented

- `native/windows/rust-supervisor` is a new Rust binary and library for *explicitly listed* native Windows service processes. Its format is `singularity-rust-supervisor/v1` with exact RepoQL **1.7.15**. It validates options 1–4, limits to 16 components, rejects duplicate names and ports, rejects Office/Ghost components in lean variants, requires absolute executable and working-directory paths, denies shell-style credential arguments and secret environment variables, and checks that executable paths exist. The configuration reader tolerates the Windows UTF-8 BOM.
- The owner uses an anonymous Windows Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, assigns every launched process handle, and closes the job on failure. Exit/failure causes owned children to terminate; there is **no PID-based killing**, opportunistic port takeover, untrusted TCP administration endpoint, WSL or Docker dependency. The supervision loop is deliberately fail-closed: no unproven automatic respawn. Child environments start empty and receive only a limited Windows runtime allowlist plus explicitly configured nonsecret fields.
- Optional loopback-only HTTP 200 startup probes use a 450ms per-socket timeout and a bounded startup deadline. The probe is **not** proof of listener ownership or service authentication; actual authenticated readiness is still an installer acceptance gate.
- `native/windows/stage-native.ps1` can optionally stage an explicitly provided compiled supervisor with a SHA256 receipt, but never registers or launches the task automatically. Its RepoQL version probe is now bounded to 10 seconds and rejects mixed/ambiguous version banners.
- `native/windows/register-supervisor-task.ps1` provides a **preview-first, explicit opt-in** per-user Task Scheduler registration with a protected `%LOCALAPPDATA%\Singularity` configuration, non-elevated `Limited` principal and current-user logon trigger. It will not replace an existing foreign task. Removal requires matching task identity, and refuses to stop a running task or destroy its owned processes implicitly.
- `native/windows/preflight.ps1` now displays separate supervisor binary/configuration presence and leaves Job Object and Task Scheduler runtime acceptance false. Its RepoQL version probe is also bounded and unambiguous.
- CI source adds a Windows/Linux cargo fmt/test/Clippy/build matrix for the new Rust crate and a Windows Job Object close/owned-child termination regression test. These **have not been run** here. No prebuilt binary is included in source-only variants.

## Preserved product constraints

- Four options remain Claude Desktop Code lean/complete and OpenChamber Desktop lean/complete, with dashboard, Tencent, RepoQL, Agent Chat, Kanban and memory core in all packages. Options 1/3 continue to exclude Ghost/Office modules. Options 2/4 include both.
- RepoQL engine **1.7.15** and Kanzo/Tencent connector ABI **1** are exact mandatory pins; 1.7.17 is unsupported until a compatible connector is established.
- Claude Office options 2/4 retain the existing known-working token-URL exchange through the server-side dashboard proxy, not a browser-visible token. No auth method or live deployment was changed here.
- The GUI must be the **native desktop app**, not a CLI-only workflow; JavaScript/TypeScript may remain as a thin host-plugin adapter where the GUI requires it. No WSL dependency is allowed.

## Offline evidence

See `M14_TEST_RECEIPTS.json` next to the archive. The verification suite includes Python Windows source/variant tests; Python dashboard and Ghost prompt-store tests; Node authority, ingest, supervisor and native GUI plugin tests; SHA256 checked full source and four ZIPs. The new Rust executable has **not** been compiled, formatted or run in this environment because rustc/cargo and Windows are unavailable. Source tests are NOT evidence that Rust APIs, Job Object ownership or Task Scheduler registration work.

## Priority gates not yet met

**P0: can be written or examined from a non-Windows machine, but require Rust-capable execution**

1. Compile and lint `native/windows/rust-supervisor` and existing Rust `native/desktop-bridge`/`harness/rust-authority` using Windows CI, resolve compiler warnings and cross-platform FFI errors. Test the Windows Job Object child test and named-pipe ACL/stall/revision tests; do not mark pass from CI YAML alone.
2. Eliminate spawn-before-AssignProcessToJobObject race by assigning at process creation using native Windows supported attribute lists or a verified suspended-process creation/resume protocol. This is an outstanding process-tree containment risk in the M14 supervisor.
3. Build a deliberate transactional installer/uninstaller to install/restart/stop actual services and preserve GUI config, credentials, dashboard and native profile selections. Stage-only rollback is not service/GUI rollback.
4. Finish a Windows-native service controller for Ghost tasks and prompt editing, durable Agent Chat delivery, Kanban changes, Tencent/MemoryKnowledge, Rust graph/stream processing and browser dashboard lifecycle. The new supervisor is process ownership infrastructure only.
5. Build compiled per-option artifacts and independent full-chain tests (MCP JSON-RPC, memory capture/recall, cross-session isolation, source-authoritative subscription metering, CPU, Ghost prompt edits, Office event delivery and authenticated proxy without token leak).
6. Security/legal gates: complete dependency/SBOM scan, third-party RepoQL licence and upstream binaries, code signing, secret scanning, full CI receipts, and release manifest provenance.

**P0: requires a native Windows test host or Windows CI runner**

- Test normal and unexpected supervisor exits/reboots/stop/upgrade, per-user ACLs, process ownership, service port conflicts, user session logoff, scheduled task registration/removal, and the Job Object close semantics.
- Verify official `rql.exe 1.7.15` plus actual Tencent and Kanzo connector ABI 1, indexing/write and readback. Do not treat a successful `--version` as proof of connector compatibility.
- Four fresh native desktop GUI installs, rollback/uninstall and prompt/Office/graph/Agent Chat/kanban/dashboard acceptance; screenshots and evidence, including both lean and full variants.

**Release decision:** BLOCKED. No GitHub main, Docker, Windows installation, GUI configuration or production service was modified by this milestone.
