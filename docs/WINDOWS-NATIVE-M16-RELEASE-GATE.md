# Singularity RepoQL Windows-native milestone 16 — verified source changes and gates

Release verdict: **BLOCKED**. Windows GUI, Rust binaries, Tencent/MemoryKnowledge, RepoQL 1.7.15 connectors, Agent Chat/Kanban and Office/Ghost parity remain **unverified in a real native Windows runtime**. This is a source checkpoint and not an installer.

## Implemented and tested in this milestone

- `harness/kit/lib/run-health.mjs`: fixed a CommonJS `require()` inside an ES module. `deriveFleetHealth()` can now enumerate real run directories in Node ESM.
- `harness/kit/lib/consult-liveness.mjs`: an unavailable Linux `/proc` can no longer classify a Windows coordinator as dead or orphaned. Windows returns `UNVERIFIED`; legacy orphan closure refuses mutation until Rust authority owner proof is available. A detected metadata race no longer writes the rejected candidate back over the newer owner's state. Linux's existing `/proc` liveness rules are retained. Note: legacy Linux orphan-close still lacks a globally coordinated CAS/lock with every other writer and is not an adequate native-Windows mutation path.
- `harness/kit/lib/start-guard.mjs`: Linux `/proc` scan returns an explicit error on native Windows rather than an empty list that might permit a second coordinator start. Windows orchestration needs the Rust authority's verified run ownership.
- `dashboard/harness_telemetry.py`: native Windows telemetry defaults to `%LOCALAPPDATA%/Singularity/Dashboard`. Windows nannies show an observed Task Scheduler registration as `registered-unverified` and service runtime as `unverified`, rather than presenting Linux systemd timers as functional Windows services.
- `.github/workflows/native-desktop-rust.yml`: source tests and CI triggers now include the shared Harness liveness and telemetry paths, and run new tests on Windows and Linux.
- `native/windows/trace_linux_assumptions.py`: source-only evidence inventory of remaining Linux `/proc`, systemd, container-runtime, shell, SSH and Unix-socket references in each ZIP. Reports paths, line numbers and counts only. These are *candidates*, not execution traces; platform-gated code and fixtures may appear. It never promotes a package to release-ready.

## Tests actually executed here

- 51 Windows/source Python tests passed.
- 54 dashboard Python tests passed.
- 9 Ghost prompt-store Python tests passed.
- 45 focused Node tests passed, including 5 new Harness portability regression cases.
- Four Windows option source ZIPs rebuilt and passed source-archive checks for version pin, checksums, optional feature separation, unsafe NTFS names, forbidden binaries and Linux deployment assets.
- Full source ZIP and staged patch checked against the preceding milestone.

No Rust compiler was available locally. Windows-specific Rust authority, Job Object supervisor and desktop bridge compilation and live tests were **not run**. Newly authored CI jobs have not been observed to pass.

## Mandatory Windows feature acceptance still missing

1. **Core native services:** a real Windows runner must build `native/desktop-bridge`, `harness/rust-authority` and `native/windows/rust-supervisor` and execute Rust unit/integration tests. Close the supervisor spawn-to-job assignment race before allowing destructive operations.
2. **Memory:** launch native Tencent MemoryCore/MemoryKnowledge, verify durable ingestion, extracted knowledge, scoped recall, graph updates and restart recovery. No Docker, WSL, systemd, Unix socket, shell script or remote Linux dependency can appear in the live process trace.
3. **RepoQL:** install and execute `rql.exe` **exactly 1.7.15** with connector ABI 1, index/query/read-back with both Tencent and Kanzo connectors.
4. **Desktop surfaces:** prove hooks and MCP tools in **Claude Desktop Code tab** and **OpenChamber Desktop GUI**, not CLI substitutes. Prove new-session recall and capture in both.
5. **Harness:** replace the remaining Linux `/proc` and Docker/SSH orchestrator paths with native Rust-owned process identity and state transitions before enabling a native Windows coordinator. A fail-closed probe is a safety improvement, not complete parity.
6. **Agent Chat / Kanban:** native relay/service, durable delivery, board CRUD, idempotency and reboot recovery. Do not infer full functionality from one HTTP `200`.
7. **Optional option 2/4 features:** native Ghost task lifecycle, prompt revisions/rollback and dream cycle; Claude Office event delivery and real dashboard rendering. Keep the proven **server-side token-URL Office authentication** default; no credential in browser URL.
8. **Dashboard:** authenticated same-origin RepoQL/Tencent/Office/Kanzo panels, live graph, native CPU process attribution, only verified Claude/OpenChamber subscription metrics; unknown usage must remain unknown.
9. **Distribution:** four clean machine installs, upgrade, rollback, uninstallation, reboot and recovery, Win32 ACLs, signed/native binaries, SBOM and license review, two-environment semantic parity receipts against the existing Docker host.

## How to interpret platform scans

The four option ZIPs exclude known Linux *deployment artifacts*. They still contain shared source that may have Linux-dependent execution paths. `native/windows/trace_linux_assumptions.py` is a triage inventory. Do **not** claim no Docker/WSL/Ubuntu dependency until a clean Windows installation succeeds and process/dependency tracing verifies it. Do not treat source-file presence or test mocks as runtime acceptance.

Rust-first rule: persistent native Windows services, state, process lifecycle, identity and network boundaries belong in Rust. OpenCode's thin plugin adapter may remain JS/TS; existing Linux production code must not be deleted or changed merely to make a Windows package look clean.

Production Docker services, GitHub main and working Office authentication were not modified.
