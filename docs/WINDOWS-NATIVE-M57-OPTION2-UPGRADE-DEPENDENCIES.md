# Milestone 57: Native Claude Code Complete upgrade dependency planner

Read-only dependency discovery. This tool is **not** an upgrade action, installer,
rollback authorization, task owner verification or release acceptance. It does
not start processes or touch secrets. It uses receipt presence as a conservative
indicator of installed references, never as proof of healthy software.

## On native Windows

From a verified source checkout or prepared source directory, with operator
approved paths:

```powershell
.\native\windows\install_claude_complete.ps1 -Mode UpgradePlan `
  -PythonExe 'C:\Approved\python.exe' `
  -ClaudeHome 'C:\Users\Operator' `
  -Workspace 'C:\Workspace' `
  -InstallRoot "$env:LOCALAPPDATA\Singularity\WindowsNativePreview"
```

The wrapper queries the Windows scheduler. An inaccessible scheduler yields
`UNKNOWN`, which blocks a claim that replacement dependencies are cleared.
It refuses reparse/symlinked evidence paths, malformed receipts, and staged
folders without an owned receipt. It reports ordered recovery work: remove a
verified owned supervisor task, rollback owned parent proxy, rollback owned
Claude/Kanzo configuration, then inspect snapshots before promoting a new stage.

`existing_owned_stage_can_be_replaced:true` means only that *presence-based
static dependencies* appear cleared. It does not authenticate files, prove the
supervisor is stopped, prove that no foreign process is using the directory,
or authorize `Stage -Apply`. Follow the separate source verification and
operator approval process. Keep release status **BLOCKED** until Windows GUI,
service, Tencent/RepoQL, Office and Ghost integration tests pass.
