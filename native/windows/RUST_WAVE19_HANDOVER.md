# Windows engineering handover: Wave 19

**Do not install or restart production services from this source candidate.** All packages are source-only.

## New Rust work

`native/windows/memory-parity-rust/src/doc_ingest.rs` is integrated with the canonical `scripts/memory-doc-ingest.py` under `SINGULARITY_DOC_RUST_BIN`. The three commands are `doc-index-chunks`, `doc-index-plan` and `doc-index-select`. All native results are compared against the independently evaluated Python reference. Credentials and live service ownership stay in Python. The retrieval command receives only metadata.

## Isolated checkout validation

```powershell
pwsh -File .\native\windows\prepare_rust_locks.ps1 -GenerateMissing
pwsh -File .\native\windows\verify_rust_upgrade.ps1 -Native
```

Review and commit real Cargo lockfile provenance separately. The native gate must compile and run all crates, including the 840-case documentation Rust differential, and may not claim full Windows acceptance just because source tests pass.

## Live acceptance needs

1. Run the native binary on a Windows engineering host; ensure Rust chunk text, SHA256 markers, and revision identities agree byte-for-byte with Python.
2. Exercise authorized documentation ingest, retry, failure, concurrent Node/Python ledger writers, supersession and current-only retrieval against a permitted MemoryCore test scope.
3. Revalidate Windows option 1 through 4 source distribution closure. Do not treat these ZIPs as installers.
4. Confirm rollback simply disables the opt-in native executable without damaging current ledger or source documents.
5. Independently complete pinned Tencent overlay/backend acceptance, Kanzo authorization and the remaining runtime migration.

No credentials, live memory, installed services, current user shell configuration or GitHub branches were altered by this authoring pass.

## Windows Node entry point

The canonical Windows writer, `scripts/doc-ingest-node.mjs`, uses the same optional `SINGULARITY_DOC_RUST_BIN` switch and validates Rust output against the JavaScript reference. It imports the already-distributed `scripts/document-learning-rust.mjs` transport. Run `node --test tests/doc-ingest-rust-boundary.test.mjs tests/doc-ingest-chunk-parity.test.mjs` and the full cross-runtime `tests/doc-ingest-parity.test.mjs` suite. The opt-in environment variable must stay unset until compiled parity and test-scope end-to-end ingestion are accepted.
