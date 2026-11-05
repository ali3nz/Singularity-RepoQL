# Milestone 62 — Independent RepoQL indexed-file proof

The earlier Claude Code Complete parity checker required a Tencent verified
ledger record, Tencent live marker search and `rql read` full content. A file
being readable is not independently sufficient evidence of its indexed status.

M62 also requires a **unique** row in the RepoQL 1.7.18 `Files` view for the
exact approved test file URI. The check invokes the CLI without a shell using
`rql query`, executes in the approved document root, and escapes SQL literals.
It accepts only a strict two-line `exact_indexed_files` integer count and
requires exactly one matching row before executing `rql read`.

This is a fail-closed contract based on the published RepoQL `Files` schema:
https://repoql.com/docs/tools/query/

Actual installed 1.7.18 formatting must be independently reviewed on Windows.
An unexpected output format is an unresolved failure, not a reason to make
parity reporting permissive. The existing full-document readback may also
need version-specific presentation normalization after native acceptance.

Passing this check establishes **one selected disposable test document only**;
it is not proof of repository-wide indexing, live Claude plugin MCP connection
or stale revision exclusion across the index. Nothing is reindexed, modified,
or auto-repaired. CLI still needs explicit operator approval and credentials
where required. **SOURCE ONLY — RELEASE BLOCKED**.
