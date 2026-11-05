# Milestone 19: Native Windows release and production parity gate

Date: 2026-10-29. This is an evidence report for a source-only checkpoint, **not** a release approval.

## Decisions retained

- Four installer profiles remain: Claude Desktop GUI lean/complete and OpenChamber Desktop GUI lean/complete. Only complete profiles contain Ghost/Office code.
- Native Windows requires **RepoQL 1.7.18** and connector ABI 1; do not upgrade or rewrite the production Linux installation as part of this work.
- Claude Office keeps the **previously working token-URL authentication** by default in complete profiles. The token is read server-side and must not be returned as part of a browser iframe URL.
- Native operation must not require Ubuntu, WSL, Docker or Claude Code free-worker slots. OpenChamber/OpenCode dispatch is opt-in, must use an explicitly selected model and capacity/billing policy and cannot claim completed work merely from session acceptance.
- Preserve Linux production sources in the full development snapshot for regression comparisons. Exclude Linux deployment assets from Windows option ZIPs.

## Changes made in this milestone

1. **Process containment:** Windows Rust supervisor now uses `CREATE_SUSPENDED`, discovers the single primary thread owned by the newly created PID, assigns the child process to the Windows Job Object and resumes it only after successful containment. Failure kills and waits on the owned child handle. Bounded thread enumeration fails closed. This removes the known run-before-assignment window *at source level*. Windows compilation and runtime behaviour have not been verified here.
2. **Win32 regression:** Windows-only test asserts a suspended PowerShell child cannot write a marker until assignment and resume, then confirms normal exit. The existing kill-on-Job-close test now also uses contained launch. These tests **must actually run** on a native Windows CI runner.
3. **Release closure:** `native/windows/runtime_closure.py` audits the actual four ZIP profiles against every required service (RepoQL, bridge, Rust authority, supervisor, Tencent, memory/self-learning, Agent Chat, Kanzo, dashboard, live graph, telemetry, selected GUI, plus Ghost/Office). It declares the packages `BLOCKED_UNVERIFIED` regardless of source hints. It never treats a health listener or source file as evidence of feature parity.
4. **CI:** Added manual `workflow_dispatch` entry, source/runtime closure report, and separate named Windows binary artifact uploads. These outputs are explicitly labelled *unreleased* and do not constitute installers.

## Release criteria that remain unfulfilled

- Compile and `cargo fmt`, `cargo clippy`, `cargo test` all Rust crates on Windows and Linux. This environment has neither Rust nor access to its distribution host (DNS resolution failed). The new FFI must be reviewed using actual Win32 runtime tests; source tests are insufficient.
- Stage actual Windows executables, secure per-user storage and credential files with NTFS ACLs, and implement complete install/uninstall/upgrade/rollback including GUI configuration, task/service lifecycle, state migration and backups. A source-only staging script does not meet this requirement.
- Obtain real Windows `rql.exe` 1.7.18 and verify both Tencent and Kanzo connector ABI 1 by indexing, querying, writing and reading back data.
- Implement and validate a native Windows Tencent MemoryCore/MemoryKnowledge runtime. The original `memory/upstream/` contains Linux/Compose deployment and is excluded from option source ZIPs. Merely shipping connector adapter source is not a native service.
- Validate automatic capture, scoped recall, documentation assessment and ingestion, gated self-learning, conflict correction and accurate provenance. Compare independent receipts against production.
- Exercise native Rust Harness authority and worker queue/lease recovery, Agent Chat durable delivery, Kanzo task lifecycle, Ghost prompt revisions and dream recovery, Office events/iframe, live memory graph refresh, Windows CPU and GUI-sourced token usage. No invented metrics or worker capacity.
- Verify every variant on a clean Windows machine: initial install, cold restart, recover from interrupted install, upgrade, rollback and uninstall without Docker/WSL and without unrelated process termination.
- Compare live and fresh production/Windows receipts using `compare_production_parity.py`; no synthetic self-attestation, and mixed RepoQL 1.7.15 production/1.7.18 Windows versions are permitted when connector semantics are independently validated.

## Evidence categories

- **Observed here:** source archive hashes/CRC, static compatibility/feature separation, Python/Node tests, deterministic reproduction from M18.
- **Only source-authored:** Rust Win32 thread/Job-Object implementation, Windows CI workflow, Windows staging/PowerShell behaviour.
- **Not observed:** Cargo compilation, Windows runtime execution, real GUI sessions, RepoQL connectors, end-to-end self-learning and production equivalence.

Release decision: **BLOCKED**. Do not label these files a native Windows public installer.
