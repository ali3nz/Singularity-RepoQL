#Requires -Version 5.1
<#
Option 2 native dashboard per-user startup. No service elevation, no secrets in
Task Scheduler, no shell evaluation, no remote download and no automatic start.
Plan/Verify are read-only; Register/Remove/Start require explicit -Apply.
Windows runtime acceptance still requires independent browser authentication.
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact='High')]
param(
  [ValidateSet('Plan','Register','Verify','Start','Stop','Remove')][string]$Mode='Plan',
  [string]$StagedSource='', [string]$PythonExe='', [string]$RepoqlExe='',
  [string]$NativeBridgeExe='', [string]$GhostControlConfig='',
  [string]$Workspace='', [ValidateRange(1,4)][int]$Variant=2,
  [int]$Port=18100, [switch]$Apply
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'NATIVE_WINDOWS_REQUIRED' }
$writes=$Mode -in @('Register','Remove','Start','Stop')
if ($writes -and -not $Apply) { throw 'DASHBOARD_EXPLICIT_APPLY_REQUIRED' }
if (-not $writes -and $Apply) { throw 'DASHBOARD_READ_ONLY_REFUSES_APPLY' }
if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA_REQUIRED' }
$taskName=if ($Variant -eq 2) { 'Singularity-ClaudeComplete-Dashboard' } else { "Singularity-WindowsNative-Option$Variant-Dashboard" }
$stateRelative=if ($Variant -eq 2) { 'Singularity\Dashboard' } else { "Singularity\Dashboard\Option$Variant" }
$state=Join-Path $env:LOCALAPPDATA $stateRelative
$receiptFile=Join-Path $state 'task-ownership.json'
$receiptSchema=if ($Variant -eq 2) { 'singularity-option2-dashboard-task/v1' } else { 'singularity-native-dashboard-task/v1' }
function Assert-ReceiptAcl {
  $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
  if (-not $identity -or -not $identity.User) { throw 'DASHBOARD_WINDOWS_IDENTITY_UNAVAILABLE' }
  $allowed=@($identity.User.Value,'S-1-5-18')
  $rules=@((Get-Acl -LiteralPath $receiptFile -ErrorAction Stop).GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
  $seen=@{}
  foreach ($rule in $rules) {
    $sid=[string]$rule.IdentityReference.Value
    if ($sid -notin $allowed -or $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { throw 'DASHBOARD_RECEIPT_ACL_PRINCIPAL_UNEXPECTED' }
    $seen[$sid]=$true
  }
  foreach ($sid in $allowed) { if (-not $seen.ContainsKey($sid)) { throw 'DASHBOARD_RECEIPT_ACL_PRINCIPAL_MISSING' } }
}
function Assert-Path([string]$PathValue,[string]$Description,[bool]$Directory=$false) {
  if (-not $PathValue -or -not [IO.Path]::IsPathRooted($PathValue) -or $PathValue.StartsWith('\\')) { throw "${Description}_LOCAL_ABSOLUTE_PATH_REQUIRED" }
  $path=[IO.Path]::GetFullPath($PathValue)
  for ($cursor=$path; $cursor; $cursor=[IO.Path]::GetDirectoryName($cursor)) {
    if (Test-Path -LiteralPath $cursor) {
      if (((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'DASHBOARD_REPARSE_PATH_REFUSED' }
    }
    if ([IO.Path]::GetDirectoryName($cursor) -eq $cursor) { break }
  }
  if ($Directory -and -not [IO.Directory]::Exists($path)) { throw "${Description}_DIRECTORY_MISSING" }
  if (-not $Directory -and -not [IO.File]::Exists($path)) { throw "${Description}_FILE_MISSING" }
  return $path
}
function Get-TaskCandidates {
  try { $all=@(Get-ScheduledTask -ErrorAction Stop) }
  catch { throw 'DASHBOARD_SCHEDULER_UNAVAILABLE' }
  return @($all | Where-Object { $_.TaskName -eq $taskName })
}
function Get-OwnedReceipt {
  if (-not (Test-Path -LiteralPath $receiptFile -PathType Leaf)) { throw 'DASHBOARD_OWNERSHIP_RECEIPT_MISSING' }
  Assert-ReceiptAcl
  $receipt=Get-Content -LiteralPath $receiptFile -Raw -Encoding UTF8 | ConvertFrom-Json
  $receiptVariant=if ($null -eq $receipt.variant) { 2 } else { [int]$receipt.variant }
  $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
  if (-not $identity -or -not $identity.User -or [string]$receipt.userId -notin @($identity.Name,$identity.User.Value)) { throw 'DASHBOARD_OWNERSHIP_RECEIPT_OWNER_MISMATCH' }
  if ($receipt.schema -ne $receiptSchema -or $receipt.taskName -ne $taskName -or
      $receipt.option -ne $Variant -or $receiptVariant -ne $Variant) {
    throw 'DASHBOARD_OWNERSHIP_RECEIPT_INVALID'
  }
  if ($Variant -in @(2,4)) {
    $expectedGhostConfig=[IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Singularity/GhostScheduler/native-bridge-client.json'))
    if (-not $receipt.nativeBridgeExe -or [IO.Path]::GetFileName([string]$receipt.nativeBridgeExe) -ine 'singularity-desktop-bridge.exe' -or
        -not ([IO.Path]::IsPathRooted([string]$receipt.nativeBridgeExe)) -or
        -not ([string]$receipt.ghostControlConfig).Equals($expectedGhostConfig,[StringComparison]::OrdinalIgnoreCase)) { throw 'DASHBOARD_NATIVE_GHOST_RECEIPT_INVALID' }
    $null=Assert-Path ([string]$receipt.nativeBridgeExe) 'NATIVE_BRIDGE'
    $null=Assert-Path ([string]$receipt.ghostControlConfig) 'GHOST_CLIENT_CONFIG'
  }
  return $receipt
}
function Assert-TaskOwned($task,$receipt) {
  $actual=@($task.Actions)
  $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
  $userIds=@($identity.Name,[string]$identity.User.Value,(($identity.Name -split '\\')[-1]))
  if ([string]$task.TaskPath -cne '\' -or $actual.Count -ne 1 -or [string]$actual[0].Execute -ne [string]$receipt.pythonExe -or
      [string]$actual[0].Arguments -ne [string]$receipt.arguments -or
      ($receipt.workspace -and [string]$actual[0].WorkingDirectory -ne [string]$receipt.workspace) -or
      -not ($userIds -contains [string]$task.Principal.UserId) -or
      [string]$task.Principal.RunLevel -notin @('Limited', 'LeastPrivilege') -or
      -not $task.Settings.Enabled -or
      @($task.Triggers | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger' }).Count -ne 1) {
    throw 'DASHBOARD_TASK_OWNERSHIP_DRIFT'
  }
}
$existing=@(Get-TaskCandidates)
if ($existing.Count -gt 1) { throw 'AMBIGUOUS_DASHBOARD_TASK_REFUSED' }
$hasReceipt=Test-Path -LiteralPath $receiptFile -PathType Leaf
$orphanReceipt=$false
if ($existing.Count -eq 1 -or $hasReceipt) {
  if ($existing.Count -eq 1 -and $hasReceipt) {
    $owned=Get-OwnedReceipt
    Assert-TaskOwned $existing[0] $owned
  } elseif ($existing.Count -eq 0 -and $hasReceipt -and $Mode -eq 'Remove') {
    # Registration writes the private receipt before Task Scheduler. Remove
    # may clean that exact receipt after a failed registration, preserving data.
    $owned=Get-OwnedReceipt
    $orphanReceipt=$true
  } else { throw 'DASHBOARD_PARTIAL_REGISTRATION_REFUSED' }
}
if ($Mode -in @('Verify','Start','Stop','Remove')) {
  if (-not $hasReceipt) { throw 'DASHBOARD_NOT_REGISTERED' }
  if ($Mode -eq 'Remove' -and $orphanReceipt) {
    if (-not $PSCmdlet.ShouldProcess($receiptFile,'Remove orphaned dashboard ownership receipt only')) {
      [ordered]@{schema='singularity-native-dashboard-registration/v1';option=$Variant;variant=$Variant;mode=$Mode;
        taskRegistered=$false;orphanReceiptPresent=$true;guiIntegrationInstalled=$false;dashboardListenerVerified=$false;
        connectorCallsVerified=$false;guiAuthenticatedVerified=$false;releaseReady=$false} | ConvertTo-Json -Compress
      return
    }
    Remove-Item -LiteralPath $receiptFile -Force -ErrorAction Stop
    if (@(Get-TaskCandidates).Count -ne 0 -or (Test-Path -LiteralPath $receiptFile -PathType Leaf)) { throw 'DASHBOARD_ORPHAN_RECEIPT_REMOVAL_UNVERIFIED' }
    [ordered]@{schema='singularity-native-dashboard-registration/v1';option=$Variant;variant=$Variant;mode=$Mode;
      taskRegistered=$false;orphanReceiptPresent=$false;guiIntegrationInstalled=$false;dashboardListenerVerified=$false;
      connectorCallsVerified=$false;guiAuthenticatedVerified=$false;releaseReady=$false} | ConvertTo-Json -Compress
    return
  }
  if ($Mode -eq 'Start' -and $PSCmdlet.ShouldProcess($taskName,'Start exact owned dashboard task')) {
    Start-ScheduledTask -TaskName $taskName -ErrorAction Stop
  }
  if ($Mode -eq 'Stop') {
    $task=@(Get-TaskCandidates)
    if ($task.Count -ne 1) { throw 'DASHBOARD_TASK_OWNERSHIP_DRIFT' }
    if ([string]$task[0].State -eq 'Running') {
      if ($PSCmdlet.ShouldProcess($taskName,'Stop exact owned dashboard task')) {
        Stop-ScheduledTask -TaskName $taskName -ErrorAction Stop
        $deadline=[DateTime]::UtcNow.AddSeconds(10)
        do {
          Start-Sleep -Milliseconds 250
          $task=@(Get-TaskCandidates)
          if ($task.Count -ne 1) { throw 'DASHBOARD_TASK_STOP_READBACK_FAILED' }
          Assert-TaskOwned $task[0] $owned
        } while ([string]$task[0].State -eq 'Running' -and [DateTime]::UtcNow -lt $deadline)
        if ([string]$task[0].State -eq 'Running') { throw 'DASHBOARD_TASK_STOP_READBACK_FAILED' }
      }
    }
  }
  if ($Mode -eq 'Remove' -and $PSCmdlet.ShouldProcess($taskName,'Remove exact owned dashboard logon task only')) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction Stop
    if (@(Get-TaskCandidates).Count -ne 0) { throw 'DASHBOARD_TASK_REMOVAL_UNVERIFIED' }
    # The receipt is removed only after independent scheduler readback.
    Remove-Item -LiteralPath $receiptFile -Force -ErrorAction Stop
    $hasReceipt=$false
  }
} elseif ($Mode -eq 'Register') {
  if ($existing.Count -ne 0 -or $hasReceipt) { throw 'DASHBOARD_ALREADY_REGISTERED' }
  $StagedSource=Assert-Path $StagedSource 'STAGED_SOURCE' $true
  $PythonExe=Assert-Path $PythonExe 'PYTHON'
  $RepoqlExe=Assert-Path $RepoqlExe 'REPOQL'
  $Workspace=Assert-Path $Workspace 'WORKSPACE' $true
  if ($Variant -in @(2,4)) {
    $NativeBridgeExe=Assert-Path $NativeBridgeExe 'NATIVE_BRIDGE'
    $GhostControlConfig=Assert-Path $GhostControlConfig 'GHOST_CLIENT_CONFIG'
    $expectedBridge=[IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $StagedSource) 'bin/singularity-desktop-bridge.exe'))
    $expectedGhostConfig=[IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Singularity/GhostScheduler/native-bridge-client.json'))
    if (-not $NativeBridgeExe.Equals($expectedBridge,[StringComparison]::OrdinalIgnoreCase) -or
        -not $GhostControlConfig.Equals($expectedGhostConfig,[StringComparison]::OrdinalIgnoreCase)) { throw 'DASHBOARD_NATIVE_GHOST_PATH_INVALID' }
  } elseif ($NativeBridgeExe -or $GhostControlConfig) { throw 'DASHBOARD_NATIVE_GHOST_PATH_NOT_ALLOWED' }
  if ([IO.Path]::GetFileName($PythonExe) -notin @('python.exe','python3.exe')) { throw 'DASHBOARD_PYTHON_EXE_REQUIRED' }
  if ([IO.Path]::GetFileName($RepoqlExe) -ne 'rql.exe' -or $Port -lt 1024 -or $Port -gt 65535) { throw 'DASHBOARD_DEPENDENCY_INVALID' }
  $entry=Assert-Path (Join-Path $StagedSource 'native/windows/claude_complete_dashboard_host.py') 'DASHBOARD_ENTRY'
  foreach ($relative in @('dashboard/server.py','dashboard/native_repoql_gate.py','connectors/memorycore/manifest.yaml','connectors/kanzo/manifest.yaml')) {
    $null=Assert-Path (Join-Path $StagedSource $relative) 'DASHBOARD_SOURCE'
  }
  # Before registering a persistent task verify the real pinned executable and
  # connector source contract. Merely checking its basename is not enough.
  $compat=Assert-Path (Join-Path $StagedSource 'native/windows/repoql_compat.py') 'REPOQL_COMPAT'
  & $PythonExe $compat '--rql' $RepoqlExe | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'DASHBOARD_REPOQL_VERSION_OR_CONTRACT_REFUSED' }
  $user=[Security.Principal.WindowsIdentity]::GetCurrent().Name
  $pythonw=Assert-Path (Join-Path (Split-Path -Parent $PythonExe) 'pythonw.exe') 'DASHBOARD_PYTHONW'
  $silentHost=Assert-Path (Join-Path $StagedSource 'native/windows/silent_python_host.py') 'DASHBOARD_SILENT_HOST'
  $arguments='-B "'+$silentHost+'" --log "'+(Join-Path $state 'dashboard-runtime.log')+'" -- "'+$entry+'" --source-root "' +$StagedSource+'" --rql-exe "'+$RepoqlExe+'" --workspace "'+$Workspace+'" --state-dir "'+$state+'" --port '+$Port+' --variant '+$Variant
  if ($Variant -in @(2,4)) { $arguments+=' --native-bridge-exe "'+$NativeBridgeExe+'" --ghost-control-config "'+$GhostControlConfig+'"' }
  $arguments+=' --mode serve'
  foreach ($value in @($entry,$silentHost,$pythonw,$StagedSource,$RepoqlExe,$Workspace,$state,$NativeBridgeExe,$GhostControlConfig)) {
    if ($value.Contains('"') -or $value.Contains([char]10) -or $value.Contains([char]13)) {
      throw 'DASHBOARD_ARGUMENTS_INVALID'
    }
  }
  if ($PSCmdlet.ShouldProcess($taskName,'Register current-user dashboard task without starting it')) {
    if (-not (Test-Path -LiteralPath $state)) { New-Item -ItemType Directory -Path $state -Force | Out-Null }
    $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
    $acl=[System.Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true,$false)
    $inherit=[System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    foreach ($sid in @($identity.User,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
      $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::FullControl,$inherit,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow))
    }
    Set-Acl -LiteralPath $state -AclObject $acl
    $action=New-ScheduledTaskAction -Execute $pythonw -Argument $arguments -WorkingDirectory $Workspace
    $trigger=New-ScheduledTaskTrigger -AtLogOn -User $user
    $principal=New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    $settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -MultipleInstances IgnoreNew -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    # Write the ownership receipt BEFORE registration. On interruption, an
    # orphaned receipt/task blocks further changes for manual reconciliation.
    $receipt=[ordered]@{schema=$receiptSchema;option=$Variant;variant=$Variant;taskName=$taskName;pythonExe=$pythonw;arguments=$arguments;
      workspace=$Workspace;userId=$user;nativeBridgeExe=$NativeBridgeExe;ghostControlConfig=$GhostControlConfig}
    $receipt | ConvertTo-Json -Compress | Set-Content -LiteralPath $receiptFile -Encoding UTF8 -NoNewline
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -ErrorAction Stop | Out-Null
    $result=@(Get-TaskCandidates)
    if ($result.Count -ne 1) { throw 'DASHBOARD_TASK_REGISTRATION_UNVERIFIED' }
    Assert-TaskOwned $result[0] (Get-OwnedReceipt)
  }
} else {
  if ($existing.Count -eq 0) {
    # Planning is still truthful when the dashboard has not been configured.
  }
}
# Always report the observed scheduler/receipt state, never the requested action:
# -Apply -WhatIf and a denied ShouldProcess leave the task unregistered.
$finalTasks=@(Get-TaskCandidates)
if ($finalTasks.Count -gt 1) { throw 'AMBIGUOUS_DASHBOARD_TASK_REFUSED' }
$finalReceiptExists=Test-Path -LiteralPath $receiptFile -PathType Leaf
if (($finalTasks.Count -eq 1) -ne [bool]$finalReceiptExists) { throw 'DASHBOARD_PARTIAL_REGISTRATION_REFUSED' }
if ($finalTasks.Count -eq 1) { Assert-TaskOwned $finalTasks[0] (Get-OwnedReceipt) }
[ordered]@{schema='singularity-native-dashboard-registration/v1';option=$Variant;variant=$Variant;mode=$Mode;
  taskRegistered=($finalTasks.Count -eq 1 -and $finalReceiptExists);
  guiIntegrationInstalled=$false;dashboardListenerVerified=$false;connectorCallsVerified=$false;guiAuthenticatedVerified=$false;
  releaseReady=$false} | ConvertTo-Json -Compress
