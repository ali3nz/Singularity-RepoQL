# Milestone 73 — interrupted Windows staging and rollback (source only)

`stage-native.ps1` previously used best-effort, silently ignored restoration on two failure branches and deleted the local pending stage with `Remove-Item -Recurse -ErrorAction SilentlyContinue`. This made a failed recovery difficult to distinguish from successful cleanup and could discard useful evidence.

The script now retains a `.pending-<32 hex>` staging directory on failure, refuses another stage while such a pending directory exists, and uses `-ErrorAction Stop` plus explicit error codes when recovering `previous` or `held-current` fails. Normal successful promotion still atomically renames pending to `current`; rollback still preserves existing current as `held-current`.

These changes deliberately **do not** provide automatic disaster recovery or clear unresolved snapshots. Operators must inspect and preserve backup evidence, then explicitly reconcile pending or held directories on a disposable Windows account. Never remove or move unknown contents automatically.

Targeted source-contract tests pass; PowerShell staging, ACL behavior, actual Windows file locks and crash-recovery transitions have not been executed. Full regression deferred. RELEASE BLOCKED.
