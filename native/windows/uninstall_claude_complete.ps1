#Requires -Version 5.1
<#
.SYNOPSIS
Read-only preview and explicit, owner-checked first-install cleanup for Claude Code Complete.
.DESCRIPTION
Coordinates existing M46-M48 steps in the only safe direction:
remove owned dashboard -> remove owned supervisor -> restore owned configuration -> retire stage (preserve files).
Does not delete user data, install services, stop arbitrary tasks, or perform
machine-wide changes. Failure can leave a partial uninstall; inspect receipts.
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
  [ValidateSet('Plan','Uninstall')][string]$Mode = 'Plan',
  [string]$InstallRoot = '',
  [string]$ClaudeHome = '',
  [string]$Workspace = '',
  [string]$NodeExe = '',
  [string]$SupervisorConfig = '',
  [switch]$Apply
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'NATIVE_WINDOWS_REQUIRED' }
if ($Mode -eq 'Uninstall' -and -not $Apply) { throw 'EXPLICIT_UNINSTALL_APPLY_REQUIRED' }
if ($Mode -eq 'Plan' -and $Apply) { throw 'PLAN_REFUSES_APPLY' }
if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA_REQUIRED' }
$trustedRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Singularity'))
if (-not $InstallRoot) { $InstallRoot = Join-Path $trustedRoot 'WindowsNativePreview' }
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot)
if (-not $InstallRoot.StartsWith($trustedRoot + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) {
  throw 'INSTALL_ROOT_OUTSIDE_PRIVATE_LOCALAPPDATA'
}
function Assert-LocalPath([string]$Path, [string]$Label) {
  if (-not $Path -or -not [IO.Path]::IsPathRooted($Path) -or $Path.StartsWith('\\')) { throw "${Label}_ABSOLUTE_LOCAL_PATH_REQUIRED" }
  $full=[IO.Path]::GetFullPath($Path)
  $cursor=$full
  while ($cursor) {
    if (Test-Path -LiteralPath $cursor) {
      if (((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'REPARSE_PATH_REFUSED'
      }
    }
    $parent=[IO.Path]::GetDirectoryName($cursor)
    if (-not $parent -or $parent -eq $cursor) { break }
    $cursor=$parent
  }
  return $full
}
$ClaudeHome=Assert-LocalPath $ClaudeHome 'CLAUDE_HOME'
$Workspace=Assert-LocalPath $Workspace 'WORKSPACE'
$NodeExe=Assert-LocalPath $NodeExe 'NODE_EXE'
$SupervisorConfig=Assert-LocalPath $SupervisorConfig 'SUPERVISOR_CONFIG'
$installer=Join-Path $PSScriptRoot 'install_claude_complete.ps1'
if (-not [IO.File]::Exists($installer)) { throw 'OWNER_INSTALLER_MISSING' }
$hasParent=Test-Path -LiteralPath (Join-Path $ClaudeHome '.claude/.singularity-parent-memory-proxy-receipt.json')
$hasClaude=Test-Path -LiteralPath (Join-Path $ClaudeHome '.claude/.singularity-native-claude-journal.json')
$hasMcp=Test-Path -LiteralPath (Join-Path $Workspace '.singularity-native-mcp-receipt.json')
$stageDirectoryPresent=Test-Path -LiteralPath (Join-Path $InstallRoot 'current')
$hasStage=Test-Path -LiteralPath (Join-Path $InstallRoot 'current/STAGING_RECEIPT.json')
# A current directory without an owned receipt is NOT evidence of a safe
# first-install stage. Do not report successful retirement of unknown bytes.
if ($Mode -eq 'Uninstall' -and $stageDirectoryPresent -and -not $hasStage) {
  throw 'UNRECOGNIZED_CURRENT_STAGE_REFUSED'
}
# An upgraded stage has a previous snapshot: first-install RetireStage is not
# valid. Refuse BEFORE touching task or configuration; require explicit upgrade
# rollback planning instead of leaving a misleading partial uninstall.
if ($Mode -eq 'Uninstall' -and $hasStage -and (Test-Path -LiteralPath (Join-Path $InstallRoot 'previous'))) {
  throw 'UPGRADE_SNAPSHOT_REQUIRES_EXPLICIT_ROLLBACK_PLAN'
}
if ($Mode -eq 'Uninstall' -and $hasStage -and (Test-Path -LiteralPath (Join-Path $InstallRoot 'held-retired'))) {
  throw 'RETIRED_SNAPSHOT_COLLISION_REFUSED'
}
# Inspect the scheduler with fail-closed errors. A scheduler error
# cannot establish that a task is absent, and multiple matching task paths are
# ambiguous. Preview reports UNKNOWN but a mutation must fail closed.
function Get-SupervisorTaskCandidates {
  try {
    return @(Get-ScheduledTask -ErrorAction Stop | Where-Object {
      $_.TaskName -eq 'Singularity-Rust-Native-Supervisor'
    })
  } catch {
    throw 'SUPERVISOR_SCHEDULER_UNAVAILABLE_REFUSE_MUTATION'
  }
}
$taskState='UNKNOWN'
$hasTask=$null
try {
  $taskMatches = @(Get-SupervisorTaskCandidates)
  if ($taskMatches.Count -gt 1) { $taskState='AMBIGUOUS' }
  elseif ($taskMatches.Count -eq 1) { $taskState='PRESENT'; $hasTask=$true }
  else { $taskState='ABSENT'; $hasTask=$false }
} catch {
  if ($Mode -eq 'Uninstall') { throw }
}
if ($Mode -eq 'Uninstall' -and $taskState -eq 'AMBIGUOUS') {
  throw 'AMBIGUOUS_SUPERVISOR_TASK_REFUSED'
}
# Dashboard has its own receipt and exact task identity. A scheduler failure is
# never treated as absence, including when uninstalling a stage without a UI.
$dashboardReceipt=Join-Path $env:LOCALAPPDATA 'Singularity/Dashboard/task-ownership.json'
$dashboardMatches=@()
$dashboardState='UNKNOWN'
try {
  $allTasks=@(Get-ScheduledTask -ErrorAction Stop)
  $dashboardMatches=@($allTasks | Where-Object { $_.TaskName -eq 'Singularity-ClaudeComplete-Dashboard' })
  $dashboardState=if ($dashboardMatches.Count -gt 1) {'AMBIGUOUS'} elseif ($dashboardMatches.Count -eq 1) {'PRESENT'} else {'ABSENT'}
} catch { if ($Mode -eq 'Uninstall') { throw 'DASHBOARD_SCHEDULER_UNAVAILABLE_REFUSE_MUTATION' } }
$dashboardReceiptPresent=Test-Path -LiteralPath $dashboardReceipt -PathType Leaf
if ($Mode -eq 'Uninstall' -and (($dashboardState -eq 'PRESENT') -ne $dashboardReceiptPresent -or $dashboardState -eq 'AMBIGUOUS')) {
  throw 'DASHBOARD_TASK_RECEIPT_OR_STATE_CONFLICT'
}
$report=[ordered]@{
  schema='singularity-option2-reversible-uninstall/v1';mode=$Mode;option=2;
  dashboardTaskState=$dashboardState;dashboardReceiptPresent=$dashboardReceiptPresent;supervisorPresent=$hasTask;supervisorTaskState=$taskState;unknownCurrentStagePresent=($stageDirectoryPresent -and -not $hasStage);parentProxyReceiptPresent=$hasParent;claudeReceiptPresent=$hasClaude;kanzoReceiptPresent=$hasMcp;
  stagedReceiptPresent=$hasStage;changeRequested=($Mode -eq 'Uninstall');
  action='remove-owned-dashboard-then-remove-owned-task-then-rollback-parent-proxy-then-owned-config-then-retire-owned-stage';
  userDataDeleted=$false;runtimeAccepted=$false;releaseReady=$false;
}
if ($Mode -eq 'Plan') { $report | ConvertTo-Json -Compress;return }
# Only receipt-owned operations are allowed. The underlying component must
# establish ownership before mutation. Do not skip past a failed substep.
if ($PSCmdlet.ShouldProcess($InstallRoot,'Owner-checked Claude Code Complete cleanup and stage retirement')) {
  if ($dashboardReceiptPresent) {
    & $installer -Mode DashboardRemove -InstallRoot $InstallRoot -Apply -Confirm:$false | Out-Null
    if (@(Get-ScheduledTask -ErrorAction Stop | Where-Object { $_.TaskName -eq 'Singularity-ClaudeComplete-Dashboard' }).Count -ne 0 -or
        (Test-Path -LiteralPath $dashboardReceipt)) { throw 'DASHBOARD_REMOVAL_NOT_VERIFIED' }
  }
  if ($hasTask) {
    & $installer -Mode RemoveSupervisor -InstallRoot $InstallRoot -SupervisorConfig $SupervisorConfig -Apply -Confirm:$false | Out-Null
    if (@(Get-SupervisorTaskCandidates).Count -ne 0) {
      throw 'OWNED_SUPERVISOR_REMOVAL_NOT_VERIFIED'
    }
  }
  if ($hasParent) {
    & $installer -Mode RollbackParent -InstallRoot $InstallRoot -ClaudeHome $ClaudeHome -NodeExe $NodeExe -Apply -Confirm:$false | Out-Null
    if (Test-Path -LiteralPath (Join-Path $ClaudeHome '.claude/.singularity-parent-memory-proxy-receipt.json')) {
      throw 'PARENT_PROXY_ROLLBACK_NOT_VERIFIED'
    }
  }
  if ($hasClaude -or $hasMcp) {
    & $installer -Mode RollbackConfig -InstallRoot $InstallRoot -ClaudeHome $ClaudeHome -Workspace $Workspace -NodeExe $NodeExe -Apply -Confirm:$false | Out-Null
    if ((Test-Path -LiteralPath (Join-Path $ClaudeHome '.claude/.singularity-native-claude-journal.json')) -or
        (Test-Path -LiteralPath (Join-Path $Workspace '.singularity-native-mcp-receipt.json'))) {
      throw 'OWNED_CONFIGURATION_ROLLBACK_NOT_VERIFIED'
    }
  }
  if ($hasStage) {
    & $installer -Mode RetireStage -InstallRoot $InstallRoot -ClaudeHome $ClaudeHome -Workspace $Workspace -Apply -Confirm:$false | Out-Null
    if (Test-Path -LiteralPath (Join-Path $InstallRoot 'current/STAGING_RECEIPT.json')) {
      throw 'STAGING_RETIRE_NOT_VERIFIED'
    }
  }
  $report['state']='OWNED_COMPONENTS_REMOVED_STAGE_RETIRED'
  $report['retainedStageMayBeRestorable']=$hasStage
} else {
  $report['state']='OPERATOR_DECLINED_NO_CHANGES'
}
$report | ConvertTo-Json -Compress
