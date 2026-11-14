# Wave 13: native Claude Code memory capture preparation

Status: **SOURCE ONLY, uncompiled, not deployment-approved**.

## Scope of this migration

- `native/windows/memory-parity-rust/src/hook_capture.rs` implements the
  ordered secret-shape redactor and deterministic SHA256 capture identifiers.
- `singularity-memory-parity hook-redact` accepts a JSON object with `text`,
  and `hook-capture-id` accepts exactly three string `parts` plus a string
  `sessionKey`. Requests and responses use bounded standard input and output.
- The existing `adapters/claude-code/memory-hook.mjs` uses these commands only
  when `SINGULARITY_RUST_MEMORY_POLICY_BIN` is configured. It compares the
  native result with an independently calculated JavaScript result. Native
  disagreement or executable failure produces an uncaptured, nonblocking
  hook result; it never triggers a second write or substitutes a guessed ID.
- The same native switch already selects other memory policies including
  reconciliation. It MUST NOT be enabled on an installed environment until
  every enabled call site passes compiled Rust differential testing.
- No Rust code can read transcripts, identity maps, credentials, memory
  configuration, Kanzo, RepoQL or MemoryCore. The existing trusted caller
  retains all data access, authorization, readback and persistence.

## Validation performed in the source environment

- `node --test adapters/claude-code/memory-hook.test.mjs adapters/claude-code/memory-hook-rust-boundary.test.mjs adapters/claude-code/memory-hook-process.test.mjs scripts/memory-reconcile-core.test.mjs`.
- `node harness/kit/v46-memory-retrieval-truth-test.mjs`.
- `python native/windows/memory-parity-rust/tests/differential_hook_capture.py --repo .`
  executes 290 synthetic JavaScript reference cases but **does not** establish
  Rust behavioral equivalence unless `--rust-cli` points to compiled Rust.
- Source ZIP integrity, patch application and Windows source archive scans
  are evaluated by the release packaging stage separately.

## Required native Windows gate

In an **isolated checkout**, generate and review missing Cargo.lock files
before using `--locked`; then run:

```powershell
pwsh -File .\native\windows\prepare_rust_locks.ps1 -GenerateMissing
pwsh -File .\native\windows\verify_rust_upgrade.ps1 -Native
```

The native script runs the new `differential_hook_capture.py --rust-cli` test
against the compiled memory binary, alongside existing policy tests.
The GitHub Windows CI workflow also includes an explicit binary differential.
Review the four missing lockfiles and crate provenance, and resolve compiler,
Clippy and reference mismatches before attempting opt-in activation.

## Explicit limitations and release boundary

This does not rewrite the full Claude Code memory hook. Its transcript access,
role resolution, memory transport, parent/delegated namespace separation, and
reconciliation remain in JavaScript. The default JavaScript behavior is
intentionally unchanged. A malformed non-string session ID on an explicitly
native-enabled subagent hook is rejected rather than assigned a new ID.

The Rust redactor reproduces the **existing shape rules**, which are not a
comprehensive credential detector. Never feed actual credentials to test
fixtures or publish them as evidence. No installed service has been changed.

Native Rust compilation, lockfile review, Tencent backend verification, real
Windows agent memory readback, dashboard, upgrade, uninstall and rollback
receipts remain **NOT_RUN**. Do not treat these source artifacts as installers.
