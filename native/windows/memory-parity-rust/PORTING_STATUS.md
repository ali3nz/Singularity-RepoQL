# Windows Singularity RepoQL Rust migration status

## Exact status

This directory is a **source candidate**, not an active Rust replacement. The
Windows V2 source archive is the baseline. Its existing JavaScript/Python
runtime, Kanzo authorization path and orchestrator are unchanged. No Rust
compiler or registry access was available in the authoring environment, so
none of the Rust code has passed a build. This is not a completed migration.

## What is implemented in Rust

| Module | Source policy | Scope |
|---|---|---|
| authority | Windows memory_authority_preflight.py | Read-only directory and configuration preflight |
| ranking | repoql-client.mjs | Live source ordering and exact-name preference |
| temporal | memory-temporal.mjs | Three-valued current/historical/belief time rules |
| tombstone | memory-tombstone.mjs | Exact claim rejection and scope matching |
| source_policy | Windows source policy and source scanner | Filename classification and archive member safety |
| task_recovery | portable/task-recovery.mjs | In-memory bound ledger selection and row filtering |
| lineage | memory-lineage.mjs | In-memory current-truth exclusion and bounded graph traversal |
| payload_budget | payload-budget.mjs | UTF-8 byte caps, SHA256 receipts and safe splitting |
| memory_impact | memory-impact.mjs | Read-only impact candidate ranking on supplied file snapshots |
| candidate_policy | memory-candidate-v2.mjs | Provenance anchors, independence, derivation and precedence |

The second wave adds `lineage.rs`, `payload_budget.rs`, `memory_impact.rs`,
`candidate_policy.rs`, a read-only CLI and comparative fixture tests.

## Not ported or authorized for replacement

- Native Kanzo authorization and live task recovery transport. In-memory
  graph checks are NOT a substitute for authorized identity and task ownership.
- MemoryCore database writer, L1 replay/supersession overlay, or upstream
  Tencent dependencies. That upstream code is not part of this crate.
- RepoQL live I/O, concept store, adapters, remote sources, indexed search,
  process lifecycle, asynchronous orchestration or provider routing.
- Windows supervisor, service manager, native gateway, GUI, Node connectors,
  existing integration and installer scripts. Several already have Rust
  implementations with different runtime contracts.
- Full memory candidate validation, TTL handling, lineage capture/invalidation
  writes, file lock/reconciliation logic and telemetry I/O.
- Every unrelated JavaScript, TypeScript and Python module. There are hundreds
  of them in the V2 snapshot. Automated translation without a Rust compiler,
  end-to-end tests and native service authority would be misleading.

## Known V2 acceptance defects, not fixed by this source candidate

1. The live V2 `context-pack.mjs` uses subject-only tombstone rejection.
   A corrected value can be rejected alongside an older tombstoned claim.
   `tombstone.rs` instead models exact rejected values. It is NOT currently
   wired into the live retrieval path.
2. The live V2 `context-pack.mjs` applies the lineage filter in historical
   and REVIEW paths. `lineage.rs` models the documented bypass correctly,
   but does NOT alter the live JavaScript runtime.

These are blocking integration defects. They cannot be counted as fixed until
implemented and tested in the authoritative Windows path.

## Verification and release boundary

1. `python tests/differential.py --repo <Windows-V2-source>` exercises the
   original JavaScript/Python reference fixtures. The baseline has 20 checks.
2. `python tests/differential_v2.py --repo <Windows-V2-source>` exercises 22
   additional source reference fixtures. Without `--rust-cli` these are
   **reference tests only**, not Rust tests.
3. On native Windows with Cargo, run `verify-windows.ps1` from this directory.
   It fails closed on fmt/test/clippy/build or any reference/Rust mismatch.
4. Review Rust source, pin dependency provenance with a generated `Cargo.lock`,
   complete edge-case differential checks, then perform native Windows service
   and Kanzo/MemoryCore end-to-end acceptance before changing any runtime path.
5. Regenerate official Windows source-only variants and manifests if this
   candidate is kept. SOURCE-ONLY is not a deployable binary or installer.

No installed service, GitHub repository or live memory store is modified.

## Wave 8 port

Added four pure conflict-gate functions to `conflict_signals.rs` with a
real opt-in Node dispatch, 265 JavaScript reference fixtures, native differential
script, and Windows CI gate. There is no automatic deployment, approval, or
replacement of authoritative Kanzo/Tencent paths. Rust build and differential
acceptance remain unverified until the compiled binary is available.

Wave 8 note: Wave 7 staged source already contains JavaScript corrections for the two original V2 retrieval defects, with regression coverage. The historical V2 defect list above refers only to the original V2 baseline and must not be read as the current Wave 8 candidate state.
