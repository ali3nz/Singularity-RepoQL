# Milestone 63 — Explicit bounded Tencent test-document repair

**SOURCE ONLY — RELEASE BLOCKED.** This is a narrowly scoped **operator-approved
replay of Tencent ingestion for disposable, marked Markdown TEST documents**
(up to 12) after a read-only parity check establishes exactly one Tencent stale
ledger issue. It never modifies RepoQL or the Markdown source and never
performs an unapproved background repair.

The shared `ingestFile` engine now accepts an optional `expectedRevision` and
refuses a changed document revision before ledger mutation or network calls.
The recovery command also re-reads the local marked source immediately before
ingestion. After an attempted Tencent write, it independently reruns Tencent
ledger/search and RepoQL indexed-row/full-content readback. A write receipt
alone is not success.

On an operator-approved Windows test workspace with previously reviewed real
credentials and RepoQL 1.7.18:

```powershell
node .\native\windows\claude_complete_tencent_recovery.mjs `
  --root C:\TestWorkspace `
  --manifest C:\Private\disposable-docs.json `
  --rql-exe "$env:LOCALAPPDATA\rql\rql.exe" `
  --memory-config C:\Private\memory.json `
  --doc-data C:\Private\doc-data `
  --apply-tencent `
  --output C:\Private\test-recovery-report.json
```

Use the read-only `claude_complete_doc_reconciliation.mjs` beforehand to
inspect issues. Only rows with the exact Tencent-stale-ledger issue are
eligible; RepoQL-only or other backend errors never trigger Tencent writes.
Source changes invalidate the initial expected revision. The command outputs
no service secrets, document contents or raw backend messages, and refuses to
overwrite an existing report.

Real Tencent/RepoQL service semantics, the exact RepoQL CLI output format and
native Code-tab behavior remain unverified until an authorized Windows run.
This is not a general production document migration or a dual-backend
transaction. No automatic RepoQL indexing call is invented or made.
