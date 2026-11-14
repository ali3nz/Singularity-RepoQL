# Windows Singularity Rust and memory migration: Wave 6 source handover

Baseline: consolidated Windows V2 plus Rust Waves 1 through 5. All work is in an
isolated source checkout. **This is not a Rust-only product, Windows installer,
accepted memory backend, or authorization to switch installed services.**

## What is newly implemented

| Target | Rust implementation | Existing caller integration |
| --- | --- | --- |
| Memory candidate lifecycle transitions | `native/windows/memory-parity-rust/src/candidate_lifecycle.rs` | `harness/kit/lib/memory-candidate-v2.mjs` opt-in via `SINGULARITY_RUST_MEMORY_POLICY_BIN` |
| Verified-memory TTL revalidation | Same Rust module | Same opt-in memory candidate caller, with explicit caller timestamp |
| Native memory authority preflight | Existing `authority.rs` CLI | `native/windows/memory_authority_preflight.py --rust-binary` checks the Rust result for exact JSON value equality with the original Python result |
| Connector inventory policy | Existing `release-evidence-rust` policy | New `connector-evaluate-stdin` CLI; actual Windows Python collector remains the trusted source, passes JSON over stdin, and rejects any Rust mismatch |
| RepoQL 1.7.18 connector preflight | Existing `native/desktop-bridge/src/repoql_compat.rs` | Optional `native/windows/repoql_compat.py --rust-binary` requires both Python source and native Rust contract approval |
| Production/Windows release evidence comparison | Existing `release-evidence-rust` comparator | Optional `native/windows/compare_production_parity.py --rust-binary` computes using one shared UTC instant and fails closed on disagreement |
| Rust dependency lock provenance | Existing Python and Rust gates | Both now check all **eight** project crates rather than only three historical crates |
| Release verification | Existing per-wave scripts | New `native/windows/verify_rust_upgrade.ps1` runs source regression gates or, with `-Native`, the all-crate locked build and differential acceptance |

All current executable integrations are **explicitly opt-in**. Without the
specified Rust binary path, original behavior remains intact. The coordinator,
model selection, Kanzo task ownership, installed service state and Tencent
MemoryCore data were not modified by Wave 6.

## Source validation performed outside Windows

* JavaScript harness: **72 passed, 1 skipped, 0 failed**.
* Memory current-truth retrieval: **43 passed, 0 failed**.
* Windows Python checks: **61 passed, 1 skipped, 0 failed** across the native bridges, memory authority, lock gate, source builder, connector provisioning and RepoQL policies.
* Windows memory configuration Node tests: **30 passed, 0 failed**.
* RC stack Python tests: **11 passed, 0 failed**; Tencent overlay structural tests: **3 passed, 0 failed**. These are not native backend tests.
* New candidate lifecycle/TTL reference fixtures: **132 passed** against the original JavaScript implementation. **No Rust execution occurred**.
* Release evidence reference fixtures: **30 passed**, using original Python policies. **No Rust execution occurred**.
* All four source-only Windows variants built and passed the original archive scanner.

The test totals in this section describe the named executed commands only. The
complete final evidence bundle contains exact logs and results.

## Actual blockages

1. `rustc` and `cargo` are not installed in this authoring environment; Rust
   builds, Clippy and true Rust-versus-source differential tests are **NOT_RUN**.
2. Four newly introduced first-party crates have no Cargo.lock in the supplied
   source: `memory-parity-rust`, `rc-stack-rust`, `source-packager-rust`, and
   `release-evidence-rust`. Do not forge lockfiles. On Windows, let Cargo
   resolve dependencies, independently review and commit them, then use
   `--locked` in every acceptance build. Until then the all-crate release gate
   correctly returns `readyForRustDependencyReview: false`.
3. The pinned upstream Tencent MemoryCore v2.0.2 source tree was not supplied.
   The fleet#1175 idempotency/supersession overlay remains staged, not compiled
   or applied to Windows. Validate exact pinned source hashes first.
4. Real Kanzo claim authorization, registered MemoryCore role isolation,
   native service startup, cross-session capture/recall, RepoQL MCP source
   indices, and agent outcome improvement require an actual Windows system.
5. The broad application still uses JavaScript/TypeScript/Python. The Rust
   migration only covers the specified components. The RepoQL and MemoryCore
   third-party binaries are external products; this source cannot silently
   rewrite or replace them.

## Native Windows engineer sequence

Use an isolated Windows engineering checkout and preserve an existing
pre-upgrade snapshot/ownership receipts before any later installation. The
commands below only build and test source and create local compiler output.

```powershell
pwsh -File .\native\windows\verify_rust_upgrade.ps1
```

This first pass does not need Rust. To begin native acceptance, generate and
review the four missing Cargo.lock files using Cargo in the isolated checkout,
verify their versions and checksums independently, then run:

```powershell
pwsh -File .\native\windows\verify_rust_upgrade.ps1 -Native
```

`-Native` intentionally stops immediately if any lockfile is missing or invalid.
It compiles all eight project Rust crates, runs Clippy, checks memory and
release-policy differential fixtures and tests the Rust memory preflight call
site. It does **not** start, install, update, restart or stop services.

For a read-only authority check with a verified compiled binary:

```powershell
$RustPolicy = (Resolve-Path .\native\windows\memory-parity-rust\target\release\singularity-memory-parity.exe).Path
python .\native\windows\memory_authority_preflight.py --root . --rust-binary $RustPolicy
```

A missing native authority directory should remain an explicit `UNVERIFIED`
result. It must not be treated as a healthy MemoryCore service. The feature
switch stays unset until real Windows parity tests pass:

```powershell
Remove-Item Env:SINGULARITY_RUST_MEMORY_POLICY_BIN -ErrorAction SilentlyContinue
```

After separately approved native integration, the operator may enable the
absolute Rust binary path only in a controlled test process, compare a real
memory workload against the existing implementation, and unset the variable
on failure. Do not change the installed orchestrator or Kanzo service just
because the source tests pass.

The independent remaining acceptance requirements are maintained in
`native/windows/claude_complete_acceptance_matrix.py`, the V2 handover and
`AGENTS.md`. The source artifacts provide no live acceptance receipts.
