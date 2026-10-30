# Milestone 37: Documentation ingestion race and native installer env preservation

**Status:** SOURCE ONLY. Native Windows acceptance and release remain BLOCKED.

## Verified source defect: concurrent edit lost after a successful batch

Both `scripts/doc-policy.mjs::autoIngestChangedDocs` and `adapters/claude-code/doc-hook.mjs::runDocHook(stop)` previously refreshed the complete session documentation baseline after all observed document ingestion calls succeeded. A document edited again *during* that ingestion would appear in the new full snapshot, even though the successful acknowledgement applied to the previous revision. That newer revision could then disappear from subsequent change discovery without an independent indexing readback.

**Correction:** The baseline is advanced only for resolved documents, using the metadata snapshot captured **before** the ingestion pass. Unprocessed or failed documents are unchanged. The same policy now applies regardless of whether a batch is entirely successful or partially successful. The initial SessionStart baseline still excludes pre-existing changes.

**Regression:** `scripts/doc-policy-batch.test.mjs` simulates an ingestion callback that rewrites a document after the observation and before acknowledging a successful ingestion. The newer document is discovered on the next pass and is resolved on the subsequent successful ingestion.

**Limitation:** Change discovery uses size and filesystem mtime, not a full cryptographic census. An adversarial or filesystem-dependent same-size, same-timestamp edit remains outside this regression. Content hashing and document source integrity are separately validated by the ingestion ledger on successful readback. This checkpoint does not certify dual indexing.

## Verified source defect: empty user-provided environment override

The native Claude Code configuration installer checked existing protected environment values by truthiness. Existing empty or null values could therefore be overwritten, conflicting with the installer rule to preserve pre-existing user settings and explicitly refuse mismatches. A null/empty `REPOQL_NO_BOOTSTRAP` also allowed a silently rewritten bootstrap policy.

**Correction:** `Object.hasOwn` now detects any pre-existing key. A mismatched value is refused before writing settings, including the empty string and null. Existing identical values remain preserved, and the guarded rollback semantics are unchanged.

## Source verification

- 168 Node tests passed, 0 failures: native Windows and Claude Code suites plus documentation ingestion and batching tests.
- 82 Windows source Python tests passed, 0 failures.
- `native/windows/verify_source_release.py` passed; RepoQL 1.7.18 and ABI 1 remain pinned.
- Native Windows CI includes the documentation policy, its concurrency regression, the Claude Code documentation hook, and their changes as triggering paths.
- Native Windows execution, GUI plugin loading, Tencent/RepoQL readback and Rust build: **not performed in this environment**.

## Remaining acceptance

Use a real native Windows test installation to verify the 17 official RepoQL plugin skills and 10 Singularity skills inside Claude Desktop Code tab, native services and models, scoped agent memory capture and fresh-session recall, Ghost isolation, and independent Tencent plus RepoQL new/edit/supersede document readbacks. Continue to reject a public release until those receipts exist.
