# Milestone 54: fail-closed stage replacement when managed references remain

The Option 2 phased installer previously checked live Claude/Kanzo configuration receipts and the current-user supervisor task before `RollbackStage`, `RetireStage` and `RestoreRetired`, but not before `Stage` replaced an existing `current` directory. That mismatch could move a directory that owned GUI hooks or scheduled-task paths still referenced.

`native/windows/install_claude_complete.ps1` now refuses an **existing-stage replacement** unless it can inspect the explicit Claude user home and project workspace and establish that no owned Claude journal, Kanzo MCP receipt or supervisor startup task remains. It does so before invoking the underlying staging script. A first-time stage with no `current` directory retains the existing manual flow.

This does not claim a complete safe upgrade of a running process, and direct use of the lower-level shared `stage-native.ps1` is not covered by this Option 2-specific guard. Operator should quiesce processes, back up and verify rollback before upgrading; refresh configuration and rerun acceptance after staging.

Focused source-contract checks: seven passed. PowerShell was not executed on Windows. Full regression deferred until the explicitly requested Codex handover. Release BLOCKED.
