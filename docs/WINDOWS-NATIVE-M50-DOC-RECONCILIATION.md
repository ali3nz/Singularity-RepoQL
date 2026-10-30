# Milestone 50: bounded read-only Tencent/RepoQL document reconciliation

`native/windows/claude_complete_doc_reconciliation.mjs` now performs multiple independent readbacks using the existing tested Tencent document ledger, Tencent live search and native RepoQL `rql read 'file:///... => content'` adapter. It requires a small manifest of operator-owned test Markdown documents with unique markers. **It cannot certify global indexing or automatically fix either backend.**

The pipeline rejects invalid manifests, duplicate sources, path traversal, symlinked files or ancestor directories, missing markers, and documents larger than 8 KiB. It validates the complete manifest before performing any backend requests. It checks the current local source revision again after remote readbacks, so an edit during a check does not yield false parity.

A validated test source is reported as `TEST_DOCUMENT_VERIFIED` only when the existing Tencent ledger verification, Tencent live current-revision search, RepoQL full-content readback and post-readback source recheck agree. Other results produce action codes for investigating Tencent ingestion, RepoQL indexing, or source drift. No credentials, marker values, document bodies or raw backend responses are emitted.

## Private manifest format

```json
{
  "schema": "singularity-claude-complete-reconciliation-manifest/v1",
  "documents": [
    {"file": "docs/test-parity-one.md", "marker": "DOCPARITY-EXAMPLE-2026AA11"},
    {"file": "docs/test-parity-two.md", "marker": "DOCPARITY-EXAMPLE-2026BB22"}
  ]
}
```

Both files must exist beneath the workspace root and contain their marker exactly once. Each must be a small, disposable non-sensitive Markdown document. Never commit the manifest if it contains private names or paths.

## Read-only plan

```powershell
node .\native\windows\claude_complete_doc_reconciliation.mjs --root C:\Workspace --manifest C:\Private\doc-parity-manifest.json
```

## Explicit Windows-only independent readbacks

```powershell
node .\native\windows\claude_complete_doc_reconciliation.mjs --root C:\Workspace --manifest C:\Private\doc-parity-manifest.json --rql-exe "$env:LOCALAPPDATA\rql\rql.exe" --memory-config C:\Private\memory.json --doc-data C:\Private\doc-data --live --output C:\Private\reconciliation-readback.json
```

The test documents should first be ingested through the existing, authorized document ingestion workflow, and RepoQL must already have independently indexed the workspace. Failures need an operator to review/retry the appropriate backend, followed by another independent readback. The tool does not guess a RepoQL write/indexing CLI.

## Verification and remaining work

Seven focused reconciliation tests and one new symlink regression added to the existing seven parity tests passed. A real Windows Tencent/RepoQL test, automatic dual-backend repair, full repository consistency, main-session memory, Ghost isolation, Office integration, Rust compilation and native installer lifecycle still require implementation or validation as appropriate. Release BLOCKED; broad test runs deferred by request.
