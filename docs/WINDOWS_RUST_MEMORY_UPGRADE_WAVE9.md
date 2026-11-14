# Windows Singularity: Rust Wave 9 source and memory upgrade handover

Date: 2026-11-12. Baseline: Windows V2 source candidate plus Rust Waves 1 through 8.

## Status

SOURCE ONLY. **Not a compiled installer, approved memory upgrade or accepted Windows deployment.**
No running MemoryCore, Kanzo, RepoQL, agent services, source GitHub repository or user memory data were changed. The incumbent JavaScript implementation remains the default.

## Implemented in this wave

1. `native/windows/memory-parity-rust/src/reconcile.rs`: a read-only multiset reconciliation selector that returns indexes of missing conversation messages, preserving message order, duplicate multiplicity and the `recorded_at ?? timestamp` identity contract. It receives rows already read through the existing trusted MemoryCore transport. It does not authorize a task, call the network, write messages or declare persistence verified. Non-scalar identity fields fail closed in Rust; the existing JavaScript mode remains unchanged.
2. `scripts/memory-reconcile-core.mjs`: optional native execution through `SINGULARITY_RUST_MEMORY_POLICY_BIN`, with original JavaScript index computation retained for *every* call as an authoritative comparison. A mismatch fails before the HTTP write. The existing post-write readback remains mandatory. One concrete pagination fix ensures an all-unrelated but full query page does not suppress searching later pages for the authorized task.
3. `native/windows/memory-parity-rust/src/synthesis_spec.rs`: read-only proposed synthesis spec validation. It cannot generate or approve claims or alter lineage, source authority or persistence.
4. `harness/kit/lib/memory-synthesis.mjs`: optional Rust spec validation, compared with the original JavaScript validator. Any disagreement fails closed. The feature's existing gates and sidecar ownership remain unchanged.
5. `harness/kit/lib/native-memory-policy.mjs`: allowlisted Rust CLI operations and exact response shape and input-index validation.
6. `native/windows/memory-parity-rust/tests/differential_reconcile_synthesis.py`: 320 deterministic reference fixtures. With `--rust-cli`, compare every result to the real compiled Rust CLI, without any memory writes.
7. Native upgrade script and Windows CI acceptance workflow now include these tests. None of the new Rust paths are implicitly activated by installation.

## Verified in the authoring environment

- Changed-component JavaScript boundary tests: 6 passed, 0 failed.
- Memory current-truth retrieval regression: 43 passed, 0 failed.
- Windows Python source tests: 18 passed, 0 failed.
- Reconciliation and synthesis JavaScript reference cases: 320 passed.
- Rust binary comparison: **NOT RUN** (Rust/Cargo absent and compiler download unreachable).
- Native Windows and installed agent-memory tests: **NOT RUN**.

Results above are from this source candidate, not an installed Windows system. The Rust source is uncompiled and must not be represented as build verified.

## Isolated Windows validation sequence

1. Use a new isolated checkout of the V2 source at the documented baseline, then apply the cumulative patch. Verify the source archive checksum and review the patch before copying the files into a product install location.
2. Review all eight crate dependency manifests and generate missing Cargo lockfiles in that isolated checkout; do not invent a `Cargo.lock` file or accept unexpected dependency changes. The previous four missing lockfiles remain a release blocker until real resolution and review.
3. Run the no-mutation source gate:

   ```powershell
   pwsh -File .\native\windows\verify_rust_upgrade.ps1
   ```

4. Once lockfile and dependency review is complete, run the native gate in a Windows engineering checkout:

   ```powershell
   pwsh -File .\native\windows\verify_rust_upgrade.ps1 -Native
   ```

   This must compile, lint and test the Rust crate and execute `differential_reconcile_synthesis.py` against the actual `singularity-memory-parity.exe` binary. A passing JavaScript reference run alone is not parity evidence.
5. Exercise bounded task-specific MemoryCore query pagination, duplicate replay, new message write and post-write readback using dedicated disposable data. Include a full unrelated-task query page followed by an authorized-task page. A failed or mismatched native response must perform **zero** writes.
6. For proposed synthesis, test valid source claims, missing claim IDs, duplicate claim IDs, invalid types and invalid/stale lineage states. The Rust validator cannot substitute for the lineage or operator-approval gates.
7. Separately validate native authority directories and RepoQL URIs, the pinned Tencent overlay hash/typecheck and Kanzo claim authorization. These are independent release blockers. Do not enable the Rust environment setting on an installed service until these boundaries and the Rust differentials are accepted.
8. For rollback, leave the old JavaScript path present. Removing `SINGULARITY_RUST_MEMORY_POLICY_BIN` in a controlled, approved service configuration returns this opt-in bridge to the default JavaScript policy. Do not perform an unapproved service restart or data rollback.

## Known boundaries

The source still contains existing JavaScript and Python runtimes, transport connectors, dashboard, installer and Windows management surfaces. This wave does not replace any third-party Tencent, RepoQL, Kanzo or Office binary. It does not produce an installable or signed Windows release. The outer source ZIP carries an old `bootstrapper/source.zip` only as historical context, **not** as a regenerated Rust upgrade installer.

The exact pinned Tencent upstream tarball and native Windows services are not accessible in the authoring environment. Native release approval remains blocked.
