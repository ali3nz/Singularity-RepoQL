# Singularity RepoQL Native Windows — Milestone 17 release gate

**Release decision: BLOCKED.** This checkpoint is a SOURCE-ONLY patch, not an installed product. No Rust compiler or native Windows GUI/service was available for this run. None of the four variants is certified working end-to-end.

## Purpose

The operator confirmed Claude Code has **zero free implementation workers**. This milestone does not infer Claude worker capacity from the presence of the Claude Code tab. It adds an explicitly opted-in local OpenChamber/OpenCode HTTP worker transport that can serve either desktop installation profile without SSH, Docker or WSL.

## Implemented

- `harness/kit/lib/native-opencode-worker.mjs`: local-only HTTP, password authentication, bounded requests and responses, redirect refusal, session creation, async prompt submission, uncertain-delivery receipt, status inspection and bounded response observation. It never asserts completion merely from a 204 acknowledgement.
- `harness/kit/lib/openchamber-managed-seat.mjs`: Windows routes managed seats through the native HTTP client when explicitly configured; Windows never invokes its legacy SSH/Docker execution path. Configuration requires a provider/model match, approved billing class, capacity inputs, writable workspace identity and write approval.
- `harness/kit/orchestrate.mjs`: passes explicit Windows configuration into managed seats; telemetry reports the selected configured billing class rather than claiming that every managed seat is subscription-funded.
- `native/windows/rust-supervisor/src/backend_capacity.rs`: pure Rust admission decision source (zero Claude worker dependency; rejects unconfigured, unknown-capacity and unapproved paid models); Rust source is uncompiled, pending CI.
- `.github/workflows/native-desktop-rust.yml`: Windows/Linux test step for native HTTP worker adapter; the workflow is not yet executed.
- `harness/kit/lib/native-opencode-worker.test.mjs` and `native-managed-seat.test.mjs`: local HTTP contract/injection tests for the alternative worker path.
- `docs/WINDOWS-NATIVE-OPENCHAMBER-WORKERS-NO-CLAUDE.md`: explicit configuration, isolation and remaining acceptance requirements.

## Preserved invariants

- RepoQL exactly 1.7.15 and connector ABI 1.
- Claude Office established server-side token-URL method, unchanged.
- Lean variants 1/3 exclude Ghost/Office. Variants 2/4 include them.
- No automatic model/provider or metered upgrade. No credential in URLs, JSON source configuration or server response.
- No production Docker/SSH/service or GitHub main-branch modification.

## Offline evidence collected

- Native OpenCode adapter tests: 8 passed, real loopback HTTP simulations.
- Native managed-seat integration tests: 4 passed, including Windows-selected protocol and refusal.
- Selected combined Node platform/packaging tests: 35 passed.
- Dashboard Python tests: 54 passed.
- Ghost version-history Python tests: 9 passed.
- Windows source/contract tests: 51 passed.
- Exact version/static source check: passed.
- Rust build, formatting and lint: NOT RUN; toolchain unavailable.
- Real native Windows GUI execution and subscription capacity: NOT RUN.

## Remaining blocking tasks, possible outside Windows GUI

1. Rust authority must persist encrypted/ACL-protected task metadata and reserve capacity atomically, with durable queues and backpressure; the current JS admission counts are operator-configured and may race. **Not implemented.**
2. Native Rust scheduler must reconcile an uncertain `prompt_async` submission, capture actual tool/output receipts, and pass the production self-learning acceptance gate. **Not implemented.**
3. Rust-first HTTP worker execution should replace the thin JavaScript implementation when an appropriate library and CI toolchain are available. **Not implemented.**
4. Windows Rust compile/format/lint via CI and real Service/Task Scheduler startup; Win32 Job assignment race must be resolved. **Not run.**
5. Complete Windows independence audit for remaining Linux/Docker/SSH code in Harness orchestrator and all memory services. A Windows-safe worker bridge alone is not full dependency closure.
6. Native Windows verification: OpenChamber server address/password, actual installed model and billing entitlement, worktree identity, session status transitions, output retrieval and task acceptance, restart replay, cross-provider failover, audit telemetry and zero-capacity deferral.
7. Verify all four options, Tencent MemoryCore/MemoryKnowledge, RepoQL 1.7.15 real connectors, Agent Chat, Kanban, dashboard authentication, live memory graph, Ghost task/prompt editing, Claude Office token flow, Windows CPU and GUI subscription metrics, self-learning parity with production.

**Do not ship** until those gates pass with real Windows and production receipts. A backend marked `free` in a source configuration is not proof the real account has a free entitlement, and a text response is not evidence that code changes or tests were performed.
