# Wave 19: native documentation memory ingestion and retrieval policy

Status: **source candidate only, not compiled, not installed, not accepted on native Windows**.

This pass moves three deterministic operations in the only approved MemoryCore documentation ingestion path to `native/windows/memory-parity-rust/src/doc_ingest.rs`:

1. `doc-index-chunks`: Markdown heading and fenced-block aware chunking, maximum 7,000 Unicode code points per chunk, maximum 64 chunks. An oversized physical line is now split into independently bounded chunks instead of being silently collected into an oversized chunk. Source bytes are never truncated.
2. `doc-index-plan`: task IDs, chunk hashes, exact revision markers and original MemoryCore documentation write text. It does not write anything.
3. `doc-index-select`: retrieved documentation selection by verified active revision, workspace scope, supersession and duplicate identity. The native command sees only source metadata and index numbers, never retrieved message bodies.

The existing `scripts/memory-doc-ingest.py` remains the trusted coordinator of source path allowlists, sensitive-content rejection, credentials, lock ownership, MemoryCore writes, search readback, supersession and atomic ledger activation. A native command runs **only** when `SINGULARITY_DOC_RUST_BIN` is set to an absolute compiled `singularity-memory-parity.exe` path. It must match the independent Python result exactly; mismatch, missing binary or execution failure blocks the operation. There is no silent fallback after selecting Rust.

The source-only default path is backward compatible. Re-chunking does not mutate existing indexed revisions; the ingester still returns UNCHANGED when the verified current source hash matches. A later source revision is indexed and verified through the existing current-revision gate.

## Source checks run in the authoring environment

- `python tests/test-memory-doc-ingest-rust.py`: mock native boundary tests, including forged chunk, forged write envelope, forged retrieval selection, secret screening and long-line splitting.
- `python tests/test-memory-doc-ingest.py`: 14 end-to-end MemoryCore stub tests, including eventual indexing, failed add and supersession. No live Tencent service contacted.
- `node --test tests/doc-ingest-parity.test.mjs`: 11 documentation parity tests, including mixed Node/Python ledger locking.
- `python native/windows/memory-parity-rust/tests/differential_doc_ingest.py --repo .`: 840 independently generated Python reference cases. This is **not** compiled Rust parity.
- `node harness/kit/v46-memory-retrieval-truth-test.mjs`: 43 memory retrieval regressions.

## Native Windows evidence still required

The onsite engineer must build and test the native CLI with reviewed Cargo lockfile provenance. In an isolated checkout, run `native/windows/verify_rust_upgrade.ps1 -Native`; the gate includes `differential_doc_ingest.py --rust-cli <compiled executable>` for the same 840 cases. Verify a real installation's approved document ingest, current revision retrieval, supersession, retry, file change, and rollback. Do not enable the native environment variable in production before those checks pass.

Full Rust replacement of the orchestration engine, dashboard, live provider connectors and Windows service management remains outstanding. Tencent pinned source, Kanzo authorization and production Windows acceptance remain separate release blockers. The embedded bootstrapper remains historical source, not an upgrade installer.

## Native Windows Node ingestion closure

The Windows/Claude/OpenChamber documentation writer is `scripts/doc-ingest-node.mjs`. Wave 19 aligns its chunk preparation with Python by counting Unicode code points, fixes oversized physical lines and connects the same three Rust commands under the explicit `SINGULARITY_DOC_RUST_BIN` switch. The already-installed sibling `scripts/document-learning-rust.mjs` supplies the bounded native transport; it is part of the existing OpenChamber and Claude source import closure.

`tests/fixtures/doc-ingest/wave19-chunk-golden.json` contains 80 Python-generated reference cases that Windows Node can check without Python. `tests/doc-ingest-rust-boundary.test.mjs` asserts a fabricated native chunk, write envelope or current-revision selector cannot bypass the Node owner. Native write-plan errors are converted to `DOC_INGEST_BLOCKED` before any API call. Both language implementations share the same authoritative revision and lock directory semantics.
