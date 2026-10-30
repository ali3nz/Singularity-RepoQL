# Milestone 53: operator-gated first-install uninstall coordination

`native/windows/uninstall_claude_complete.ps1` adds an **explicit** Option 2 native Windows uninstall coordinator that invokes only existing receipt-owned install/rollback operations. It does not install new software or touch machine-wide services. The default `Plan` is read-only and requires explicit user-local paths; `Uninstall` requires `-Apply` and PowerShell `ShouldProcess` approval.

The coordinator executes in the safe order: remove exactly the owned current-user supervisor scheduled task; roll back receipt-owned Claude and Kanzo project configuration; retire the first staged source/binaries to the existing protected `held-retired` folder (no deletion). Each step is checked for success before advancing. A failed step can leave a **partially uninstalled state**, so the operator must inspect receipts and recover manually.

Before mutation, it refuses if the staged directory contains a `previous` upgrade snapshot or an occupied `held-retired` destination. Upgrade rollback must be managed separately; this coordinator is **only for a first-time staged installation**. The script does not claim deletion, Ghost/Office deprovisioning, service health, or runtime acceptance.

Example read-only preview on an approved Windows test account:

```powershell
.\native\windows\uninstall_claude_complete.ps1 -Mode Plan -InstallRoot "$env:LOCALAPPDATA\Singularity\WindowsNativePreview" -ClaudeHome "$HOME" -Workspace C:\Workspace -NodeExe C:\Tools\node.exe -SupervisorConfig "$env:LOCALAPPDATA\Singularity\Private\stack.json"
```

After checking task ownership, independent backups, and rollback consequences, the operator may run the same command with `-Mode Uninstall -Apply`. Never run this blindly against the production profile. The `-Apply` flow has **not been executed on Windows**; six focused source-contract tests passed. Broad regression is deferred as requested. Release BLOCKED.
