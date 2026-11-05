# Singularity RepoQL / Windows native GUI Rust port: Milestone 4

Captured 28 October 2026 NZDT. Authoritative working source: the milestone 4
source ZIP and same-name patch in the dedicated Google Drive Windows development
folder. This document is included in both. **Not a release.**

## Source baseline and ownership

- Base: `singularity-repoql-git-latest.zip`, source Git commit
  `4f3d0f971f09ec677e7d4e5e49147476c054b311`.
- Base archive SHA256: `bf782f51cdf983feb5828853fc31289b334404d2532d44d680001e214d2c6757`.
- Target: actual native Windows **OpenChamber Desktop GUI** and **Claude Desktop Code tab GUI**;
  *not* CLI sessions or WSL Docker UI masquerading as native acceptance.
- Develop separately from production, any user GUI configuration and GitHub main.
- Existing RepoQL binary remains authoritative; no MEX.

## Milestone work, implemented as source

1. Rust `native/desktop-bridge` stdio MCP search, explicitly scoped L0/L1
   lookup, bounded read and loopback-only MemoryCore endpoint (milestones 1–3).
2. Rust `plan` read-only host MCP config proposals with mandatory team/user/agent
   identity, explicit schema v1/v2 and conflicting entry guard (milestones 1–3).
3. New Rust `office-claude KIND` and `office-opencode` entrypoints accept
   bounded JSON stdin, enforce a strict metadata whitelist, validate a local
   authenticated Claude Office event endpoint and never forward prompts,
   tool I/O, transcript paths or exception text. Office is best-effort and
   explicitly separate from memory capture/recall.
4. New `native/gui-plugins/openchamber/singularity-office.mjs`, an opt-in,
   thin native OpenCode GUI hook adapter. It subscribes to documented
   OpenCode events and calls the Rust executable without starting CLI sessions.
   JavaScript is unavoidable at this host API boundary; network, secrets and
   event mapping live in Rust. Existing Docker `product-office` is unchanged.
5. Rust read-only GUI planner now understands JSONC comments/trailing commas
   without rewriting or echoing user settings. Malformed files still fail.
6. Added `docs/WINDOWS-GUI-OFFICE-INTEGRATION.md`, updated GUI docs and a
   Windows/Ubuntu source CI workflow. No GUI settings or services modified.

## Evidence available in this offline environment

- Node targeted test command:
  `node --test native/gui-plugins/openchamber/*.test.mjs adapters/claude-code/settings-windows.test.mjs adapters/claude-code/doc-hook.test.mjs scripts/native-memory-supervisor.test.mjs openchamber/plugins/product-office/{office-events,office-transport,memory-reconcile}.test.mjs`
- Outcome: **63 passed, 0 failed, 0 skipped** (local Node 22).
- The Rust host has no `cargo`, `rustc` or `rustfmt` and Rust distribution
  downloads are unreachable. Rust compile, fmt, clippy and Rust unit tests:
  **NOT RUN**, **NOT PASS**. The CI workflow is source-only, not executed.
- The targeted Node tests do not prove native GUI plugin activation, Claude
  Code tab hook dispatch, Office backend receipt, or memory capture.
- No production installation, backup, authentication, or service was changed.

## Actual state by capability

| Capability | Current status |
| --- | --- |
| Rust bounded MemoryCore MCP search | Source implemented; uncompiled, GUI unverified |
| Rust read-only MCP config planning and JSONC support | Source implemented; uncompiled |
| OpenChamber Desktop plugin to Rust Office transport | Source and Node adapter tests; GUI unverified |
| Claude Desktop Code tab direct Rust Office hooks | Rust source and documented settings proposal; GUI unverified |
| Running authenticated Claude Office backend in Windows | Not installed or verified |
| Native Windows MemoryCore and MemoryKnowledge services | Not verified |
| Automatic session capture + durable cross-session recall | **Not implemented in native GUI flow** |
| Rust Windows supervisor, persistence and credentials ACL | Not implemented |
| Rust doc ledger locking and cross-runtime line-endings | Not implemented; known critical blockers |
| Full RepoQL MCP parity and agent modes | Existing upstream implementation; native GUI unverified |
| Real GUI integration acceptance | Not tested |
| Release decision | **BLOCKED** |

## What Codex must do FIRST on Windows

1. Extract the milestone 4 ZIP to a disposable development directory and
   confirm archive manifest and patch target against baseline SHA/commit.
2. Inspect installed application names, versions and actual GUI configuration
   scopes, without printing credential values; separately identify the Claude
   Desktop Code tab project and OpenChamber's underlying OpenCode schema.
3. Build and test Rust with `cargo fmt --check`, `cargo test --all-targets`,
   `cargo clippy --all-targets -- -D warnings` and a release build. Fix compiler
   issues in the working branch, not GitHub main or installed user config.
4. Add a regression for the actual Claude Desktop hook payload and exact
   OpenChamber plugin event shape, using synthetic data and captured version.
5. Confirm the Office backend is loopback reachable, auth works and test event
   appears visually in Claude Office. Use synthetic fixtures first.
6. Then, with backups and explicit approval, opt into the native OpenCode
   plugin and Claude Desktop Code tab hooks. Ensure legacy hook paths do not
   duplicate Office events. Verify with real GUI sessions, close/restart,
   fail-open Office outage and telemetry, never a CLI-only acceptance run.
7. Subsequent phases: Rust memory capture reconciliation and scoped recall;
   native Rust service supervision, durable queue and ACLs; RepoQL adapter;
   installer, upgrade/rollback, concurrent lock correctness, then production
   acceptance tests. Each phase needs objective evidence.

## Safety

Do not deploy the legacy Node Windows supervisor until PID ownership and
cleanup defects are corrected. Do not run document writers in parallel across
old fcntl and new lock-directory implementations. Do not copy the Docker
plugin or Linux `rql` config onto the native desktop's own config directory.
Office keys and MemoryCore secrets must remain on the test Windows machine
with enforced ACLs and never be included in a ZIP, logs or chat transcript.

Detailed setup: `docs/WINDOWS-GUI-RUST.md` and
`docs/WINDOWS-GUI-OFFICE-INTEGRATION.md`.
