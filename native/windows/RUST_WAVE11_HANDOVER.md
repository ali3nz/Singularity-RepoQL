# Windows Singularity Rust Wave 11: MemOS answerability

## Scope

Based on the read-only Windows Rust Wave 10 source candidate. This change
ports the pure evidence-sufficiency and validity-conflict detection in
`harness/kit/lib/memory-orchestra/answerability.mjs` to the existing
`native/windows/memory-parity-rust` crate. It does not port the async LLM judge,
retrieval planner, memory reader, storage owner, or orchestration coordinator.

The Rust CLI accepts these JSON commands on stdin and emits `{ "ok": true,
"value": ... }`:

- `answerability-packet`
- `answerability-expanded`
- `answerability-conflicts`

The Node layer enables Rust only if the existing
`SINGULARITY_RUST_MEMORY_POLICY_BIN` switch names an absolute executable path.
It compares the Rust JSON output with the independently computed JavaScript
reference. Any disagreement, missing binary, malformed response, nonzero exit,
or timeout raises an error and prevents the caller from accepting a verdict.
Rust cannot grant evidence authority or change LLM decisions.

The `buildVerdict` DEEP-tier call site now imports its existing `llmRefine`
function, so it no longer throws a missing-binding ReferenceError when the
explicit judge option is used. The optional judge still only downgrades.

## Source-only validation

- `node --test harness/kit/tests/native-answerability.test.mjs` exercises the
  opt-in transport with a synthetic executable and malformed/fabricated results.
- `python native/windows/memory-parity-rust/tests/differential_answerability.py
  --repo .` runs 210 JavaScript reference cases, without claiming Rust parity.
- `native/windows/verify_rust_upgrade.ps1 -Native` and the Windows CI workflow
  call the differential suite with the actual compiled Rust binary, after the
  existing Cargo lockfile gate.

## Native Windows acceptance

The source candidate is not an installed Windows upgrade. The following
criteria remain outstanding and must be evidenced independently:

1. Generate and review the absent Cargo.lock files, then run native Cargo
   formatting, compilation, tests, Clippy and all compiled differentials.
2. Verify the pinned Tencent MemoryCore overlay against its exact upstream
   sources, and run backend replay/supersession tests.
3. Verify the real Kanzo authorization path, RepoQL concept URIs, native
   tombstone/lineage authority, memory capture/readback, and agent-level recall.
4. Review the existing Windows installer/upgrade and rollback receipts, then
   explicitly authorize any service changes in the deployment workflow.

The four Windows source variants are SOURCE-ONLY packages, not installers.
Do not turn on the native switch on a live Windows installation based solely
on this source candidate.
