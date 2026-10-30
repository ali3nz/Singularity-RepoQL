# Singularity RepoQL Windows Native: Milestone 7 continuity and correctness

**Date:** 29 October 2026 NZDT. **Release verdict remains BLOCKED.** Milestone 7 supersedes Milestone 6 for the latest development source, without replacing the archived evidence of earlier milestones. Original Git baseline: `4f3d0f971f09ec677e7d4e5e49147476c054b311`.

## Changes verified in Milestone 7

1. **Shared documentation ledger concurrency** (`scripts/doc-ingest-node.mjs`, `scripts/memory-doc-ingest.py`): replaced age-based deletion of the lock directory with owner-tagged atomic lock directories. Node and Python both wait boundedly, refuse to delete a lock held by another runtime, verify the token before release, and never automatically reap a lock just because its mtime is old. The former 120-second stale threshold could delete a live writer after a slow MemoryCore call and lose ledger updates.
2. **Crash safety trade-off:** a crashed writer can leave `.ledger.lock.d` behind. This blocks new ingestion rather than silently risking corruption. **Operator recovery is manual and must happen only after verifying all Node/Python ingesters have stopped and backing up the ledger.** A Rust Windows supervisor with PID/start-time verification and documented recovery procedure is still needed.
3. **Cross-platform revision hashing:** Node now normalizes CRLF/CR to LF at all authoritative document hashing/ingestion boundaries (including status/verification), matching Python's text reading semantics. An unchanged runbook checked out with Windows CRLF no longer creates a false new revision or stale status.
4. **Windows documentation root allowlist:** `SINGULARITY_DOC_ROOTS` now uses the platform path separator (`;` on Windows, `:` on POSIX) consistently in Node and Python, so `C:\docs;D:\runbooks` does not split at drive letters.
5. **Native Claude documentation hook:** counter state uses `dirname()` instead of slicing at `/`, which was incorrect for `C:\...` Windows paths. This retains the existing bounded stop-gate policy.

## Confirmed testing and limits

- Node ingestion regression suite: **13 passed**, including old-dated lock ownership, LF/CRLF hash parity, and path list tests.
- Node Claude documentation policy suite: run alongside ingestion; no failures in the previous 21-test combined run before the final path-list addition.
- Python cross-runtime lock safety: **3 passed**, including an actual Python-held lock blocking a Node process with forced old mtime.
- RepoQL pin remains **exact 1.7.15, connector ABI 1** with Python/Rust preflight source and native dashboard startup gate (Milestone 6).
- All 4 options and lean package import smoke tests must be re-run on the exact final archive. Rust compilation, Windows service lifecycle, real GUI sessions, live RepoQL binary and connectors, Office/Ghost/Kanzo graph usage and permissions remain **NOT TESTED**.

## Remaining public Windows blockers, priority order

1. Compile, format, lint and unit-test Rust; build and sign two Windows binaries (`--no-default-features` lean and `--features office` complete). No binary has been compiled in this environment.
2. True native Windows service bootstrap (MemoryCore/MemoryKnowledge/MemoryProxy, RepoQL 1.7.15, Kanzo, Agent Chat, dashboard; Office/Ghost for 2/4), ACL-sealed keys, crash restart, ownership, upgrades and rollback. Do not use WSL, Linux Docker or systemd as substitutes.
3. Direct GUI acceptance for Claude Desktop Code tab and OpenChamber Desktop: load plugins/hooks, record actual automatic new-session scoped recall and capture, RepoQL MCP tools, dashboard launch and token renewal. CLI-only usage is insufficient.
4. Actual RepoQL 1.7.15 connector installation/sweep/indexing for Kanzo and Tencent; no 1.7.17 fallback. Maintain read-only connector and provenance boundaries.
5. Native Ghost task/prompt edit control transport (legacy uses Unix socket), Office native renderer/session events, Agent Chat durable and isolated delivery, live memory graph Rust endpoint, CPU via native Rust process telemetry, and source-attested Claude/OpenChamber subscription metrics. Source adapters alone are insufficient.
6. Independent public release review: third-party licences, PII/secrets, SBOM, end-to-end clean VM install for **each** of 1/2/3/4, browser auth/privacy, uninstall and rollback.

**Decision:** preserve as non-production, reviewable source. No user account, native Windows GUI, live service or GitHub main has been modified. Full dashboard/auth and component checklist: `WINDOWS_NATIVE_RELEASE_MILESTONE6_20261029.md`; this document records the subsequent correctness fixes.
