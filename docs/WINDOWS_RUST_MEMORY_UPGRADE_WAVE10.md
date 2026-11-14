# Windows Singularity: Rust Wave 10 engineering handover

Date: 2026-11-12. Source baseline: Windows V2 with Rust Waves 1 through 9.

## Decision and product scope

**SOURCE CANDIDATE ONLY.** This wave does not establish a compiled Rust binary,
a native Windows release, authorization integration, signed installer, or complete
Rust runtime. The default JavaScript memory path remains in place. No live data,
service, GitHub branch, or existing installed product was changed.

The change is limited to the existing read-only, task-bound history recovery
helper and its previously staged Rust formatter. It does not change Kanzo claim
semantics, agent identity ownership, stages, source write/capture paths, or
coordinator behavior. No new service, database, task registry or retrieval API
is introduced.

## Changes

1. `native/windows/memory-parity-rust/src/main.rs` exposes a **pure**
   `task-recovery-snapshot` JSON command for the previously written
   `recover_from_verified_snapshots` library function. It wraps its data result
   in a successful transport envelope even when the valid business result is
   `NO_TASK_LINKED_EVIDENCE`. The CLI has no Kanzo verifier, MemoryCore client,
   credential source, ledger file reader or independent authorization authority.
2. `harness/kit/lib/native-memory-policy.mjs` strictly allows and validates
   this command under the existing explicit Rust binary switch.
3. `memory/portable/task-recovery.mjs` retains independent Kanzo verification
   **before** reading the ledger, verifies registered MemoryCore identity, reads
   task-scoped L1 and L0 responses, and rechecks task/session/identity on each
   server row. When Rust is opted in, both its selected task-link units and its
   final filtered references must be deeply identical to the incumbent
   JavaScript computation. Any disagreement or native failure yields zero refs.
   The secondary Rust formatter receives only the verified task-linked ledger
   subset and the two already-read server snapshots. The earlier task-link
   selector still receives the local ledger to perform its independent selection.
4. `memory/portable/task-recovery-rust-boundary.test.mjs` exercises exact
   agreement, forged sessions, mismatched refs, failing subprocesses and
   authorization-before-read behavior using a synthetic executable. It does
   **not** test a compiled Rust executable.
5. `native/windows/memory-parity-rust/tests/differential_task_recovery.py`
   runs 64 synthetic scenarios against the real JavaScript oracle. With
   `--rust-cli` it compares those results against an actual compiled Rust CLI.
6. The existing Windows verification script and read-only Windows CI job now
   include this differential. Rust is not enabled in any installed configuration.

## Locally validated

- Task-bound recovery Node tests: 16 passing, 0 failing.
- Node harness and direct task recovery batch: 82 passing, 1 skipped.
- Windows Node tests: 30 passing.
- Current-truth retrieval regressions: 43 passing.
- Selected Windows Python source tests: 30 passing.
- RC stack tests: 11 passing.
- Task recovery JavaScript oracle: 64 reference cases passing.
- Cargo fmt, Cargo test, Clippy, release compilation, compiled Rust differential:
  **NOT RUN** because Rust and Cargo are not installed and download is blocked.
- Real Kanzo claim readback, native Windows MemoryCore, Windows source/install,
  upgraded service, agent-level memory parity: **NOT RUN**.

## Onsite validation, no deployment

In an isolated Windows checkout after reviewing source and generating/reviewing
missing dependency lockfiles:

```powershell
pwsh -File .\native\windows\prepare_rust_locks.ps1 -GenerateMissing
pwsh -File .\native\windows\verify_rust_upgrade.ps1 -Native
```

The native gate must execute `differential_task_recovery.py --rust-cli` using the
new compiled `singularity-memory-parity.exe`; reference-only success is not
Rust parity. Test with a real authorized Kanzo claim in a dedicated, disposable
Windows test environment. Include an unauthorized claim, wrong task ID, wrong
agent ID, unlinked session, L0/L1 failures, partial results, duplicate rows,
empty evidence and a native mismatch. Do not install, restart or enable a Rust
binary just because the synthetic tests pass.

## Independent blockers unchanged

- Four migration crates still lack reviewed Cargo.lock resolutions. Do not
  manufacture lockfiles; Cargo must generate them and the resolved packages,
  sources and checksums require review.
- Tencent fleet#1175's exact pinned upstream source chain remains unverified in
  this environment. No MemoryCore backend upgrade is approved.
- The real Windows Kanzo authorization and registered MemoryCore identity
  integration require native execution evidence; a synthetic callback is not
  proof of either.
- RepoQL source/URI conventions, tombstone and lineage authority directories,
  parent/delegated memory scopes, native agent recall, installer/bootstrapper
  replacement, upgrade, rollback, UI, connector and feature acceptance remain
  separate product requirements.
- Most JavaScript and Python runtime code is still present and no full Rust
  application conversion is claimed. The browser frontend and external
  Tencent, RepoQL, Kanzo and Office software are not candidates for silent
  replacement by an application-owned Rust patch.

## Rollback of this source-only selection

The default JavaScript policy is selected whenever
`SINGULARITY_RUST_MEMORY_POLICY_BIN` is unset. Do not modify a production
service configuration or trigger a restart without separate approved native
acceptance and a verified rollback plan. Rust errors fail closed while opted in.
