# M41: Independent Tencent/RepoQL documentation readback (SOURCE ONLY)

## What is implemented

`native/windows/claude_complete_doc_parity.mjs` adds a deliberately bounded,
**read-only** acceptance workflow for one local Markdown test file in native
Claude Code Complete, Option 2.

1. Resolve the document beneath an explicitly chosen workspace root, reject
   escaping paths, require a single unique operator-added benign marker and
   a document no larger than 8 KiB.
2. Read the existing Tencent documentation ledger and require a verified
   current revision equal to the current source's normalized SHA-256 prefix.
3. Query Tencent MemoryCore independently using that marker and require
   exactly one returned `source`/`root`/`revision` matching the ledger.
4. Query an explicitly supplied native RepoQL `rql.exe` **directly**, pinned
   to 1.7.18, using `rql read 'file:///... => content'`. Require that output
   contain the **entire current normalized Markdown document**, not merely
   a search snippet, filename, symbol or marker.
5. Return a credential- and content-free result that distinguishes Tencent
   ledger verification, Tencent live search and RepoQL full-content readback.

This test does not trigger new ingestion, modify files, query a different
workspace, install the RepoQL plugin, or validate the native Claude Desktop
Code-tab integration. RepoQL CLI output formatting and native indexing are
**not** established by these offline tests. False negatives are possible if
RepoQL decorates/reformats the returned file; a partial read never passes.

## Windows-only acceptance example (after services are installed)

Create or edit a disposable Markdown file inside the indexed workspace that
contains a unique `DOCPARITY-...` marker (only once), and run the documented
Tencent ingestion path first. Use a temporary test file without credentials.
Then, from a controlled PowerShell terminal:

```powershell
node .\native\windows\claude_complete_doc_parity.mjs --root C:\Workspace --file docs\test-parity.md --marker DOCPARITY-2026SESSION-ABCD1234 --rql-exe "$env:LOCALAPPDATA\rql\rql.exe" --memory-config C:\Private\memory.json --doc-data C:\Private\doc-data --live
```

The command reads live services and produces only a scoped test receipt. It
requires native Windows, an explicit live flag, the operator-supplied approved
`rql.exe`, and credentials in a private file. Never upload those credentials.

For supersession acceptance, edit the *same* test file and confirm the tool
**fails before re-ingestion**, then ingest the new revision and require both
backends to return the newer complete document. Afterwards inspect that the
older revision is not surfaced as current; a single-file readback is not an
exhaustive stale-result exclusion proof.

## Remaining release blockers

- Native Windows execution, exact RepoQL CLI behavior and version, GUI plugin
  binary ownership and skills loaded in native Code tab remain unverified.
- Persistent Tencent agent memory and main-session recall are separate from
  documentation ingestion and are not proven by this tool.
- Ghost isolation, Office runtime, service reboot and recovery, secure update,
  native Rust integration and full repository-wide indexing are not accepted.
- The tool is a small Node integration shim sharing the existing JS ingestion
  semantics. Rust migration of operational logic remains a release design goal;
  the source-only package is not yet a native installer.

Offline tests use fake backend adapters only. No real Tencent or RepoQL service
was contacted during source verification.
