# Windows Singularity RepoQL: Rust Wave 8 source handover

Date: 2026-11-12 NZDT. Starting source: Wave 7 source-only candidate built from Windows V2. This is a patchable source candidate, not an installer, compiled release or native Windows acceptance.

## Added source

- `native/windows/memory-parity-rust/src/conflict_signals.rs`: Rust equivalents of four pure functions in `concept-conflict-gate.mjs` for contradiction, changed numeric values, invariant extraction and restricted capsule frontmatter.
- `harness/kit/lib/concept-conflict-gate.mjs`: the existing conflict gate invokes the Rust CLI only if `SINGULARITY_RUST_MEMORY_POLICY_BIN` was explicitly configured, preserving its review, provenance, routing and escalation decisions.
- `harness/kit/lib/native-memory-policy.mjs`: validates native JSON responses, command allowlist, input caps, executable path and process outcome. Failed native selection never silently falls back to JavaScript.
- `harness/kit/tests/native-conflict-signals.test.mjs`: verifies default behavior, real opt-in call sites, malformed native response refusal and unavailable executable refusal.
- `native/windows/memory-parity-rust/tests/differential_conflict.py`: 265 deterministic reference fixtures and a compiled-Rust comparison mode.
- Updated Windows upgrade script, memory crate script and CI workflow to include the new command and verification suite.

## Existing authority preserved

The conflict gate does not become an autonomous adjudicator. It is still the only code that decides `NO_CONFLICT`, `DUPLICATE`, `SUPERSEDES`, `CONTRADICTS` and `UNCERTAIN` and when a human or Sol review is required. This wave does not change orchestration stages, role assignment, task claims, Kanzo authorization, Tencent L1 writers, RepoQL data, or installed service configuration.

## Additional closeout source port

- `native/windows/release-evidence-rust/src/doc_impact.rs` contains the full
  restricted source-to-document impact classification and closeout report renderer.
- `harness/kit/lib/doc-impact.mjs` uses an explicit
  `SINGULARITY_RUST_EVIDENCE_POLICY_BIN` switch, validates the native process,
  and refuses any output that disagrees with the existing JS contract.
- The new `differential_doc_impact.py` covers 78 reference cases and can run
  against the compiled release-evidence binary on Windows.
- No automatic approval is granted for an unclassified changed file.

## Local results

- Existing JavaScript and Python harness tests: see `singularity-rust-wave8-validation.json` and evidence ZIP.
- Source fixtures for new conflict signals: 265 reference cases passed.
- New opt-in bridge test passed locally using a stub executable. This validates JS transport, not the Rust implementation.
- No `rustc`, `cargo`, Rust registry access or native Windows host was available. Rust compilation, Clippy and the actual Rust differential were **NOT RUN**.
- Four source-only variant packages are intended solely for engineering review. They contain no accepted Rust build.

## Onsite native Windows verification in an isolated checkout

Verify the actual source checkout, binary paths and tool versions. Commands below compile and test source but do not install, restart or reconfigure services.

```powershell
cargo fmt --manifest-path .\native\windows\memory-parity-rust\Cargo.toml --all
cargo fmt --manifest-path .\native\windows\release-evidence-rust\Cargo.toml --all
pwsh -File .\native\windows\prepare_rust_locks.ps1 -GenerateMissing
pwsh -File .\native\windows\verify_rust_upgrade.ps1 -Native
```

The Cargo formatting commands affect only the two source crates in the isolated checkout and require review of their diffs. The lock preparation command changes only missing Cargo lockfiles in that checkout. Independently review and commit those lockfiles before treating a release as eligible. The second command fails closed on lock provenance, formatting, compilation, Clippy errors, source tests and actual Rust differential mismatches. It is not proof of live behavior.

Only after native parity acceptance should the operator select the compiled binary through the existing explicit `SINGULARITY_RUST_MEMORY_POLICY_BIN` environment variable on a controlled test instance. Preserve the old JS implementation for differential rollback. Do not enable it globally on production from this source package.

## Still unresolved

- The remaining hundreds of JavaScript and Python modules, particularly orchestration, active connector transport, interactive UI and host-specific service management, are not a Rust-only application.
- Four migration crates lack generated/reviewed lockfiles in this source baseline; their genuine resolution requires Cargo and registry access.
- Pinned Tencent MemoryCore `v2.0.2` upstream source and its accumulated overlay must pass exact SHA256, patch, compile and backend replay/supersession tests before a Windows Core upgrade.
- `recoverBoundTask` still needs the real Kanzo authorized agent surface. A local ledger selector cannot authorize access to task history.
- Native Windows authority directories, RepoQL `file:///` conventions, retrieval invalidation, MemoryCore L0/L1 and agent impact testing require actual execution and receipts.
- The original embedded `bootstrapper/source.zip` is from an older source candidate. It is not refreshed into a Rust release installer until compiled native acceptance and a reviewed bootstrapper rebuild.

Release verdict: **SOURCE_ONLY_NOT_RELEASE_APPROVED**. No live installed Windows system, GitHub repository, or persistent Google Drive project was modified.
