# Milestone 72 — Owner-safe native uninstall planning (source only)

The first-install uninstall coordinator previously called `Get-ScheduledTask -TaskName ... -ErrorAction SilentlyContinue`, including after task removal. A scheduler error could therefore be interpreted as task absence, contradicting the fail-closed lower-level registrar added earlier.

The coordinator now enumerates scheduler tasks with `-ErrorAction Stop`, distinguishes `ABSENT`, `PRESENT`, `UNKNOWN` and `AMBIGUOUS`, and refuses to mutate when scheduler state cannot be established. A read-only plan may report `UNKNOWN` and an unset `supervisorPresent` instead of falsely recording `false`. After task removal, a fresh fail-closed enumeration is required.

Uninstall also refuses a `current` staging directory without an owned `STAGING_RECEIPT.json`, rather than declaring an incomplete retirement successful. Existing owner-checking delegates and order of removal are unchanged. The README now points Codex to the newest internally consistent saved source and test receipt instead of a hard-coded old release URL.

## Evidence and limitations

Targeted source-contract tests pass in Linux. No PowerShell interpreter or real Windows task scheduler was available; these tests cannot prove the Windows cmdlet semantics, task identity, ACLs, or safe runtime uninstall. No user configuration or services were changed. Release readiness remains **BLOCKED**. The next native acceptance should test scheduler access failure, duplicate task names in distinct task paths, missing staging receipt and normal task removal on a disposable Windows account.
