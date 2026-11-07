#Requires -Version 5.1
<#
Per-user lifecycle owner for the long-running Ghost scheduler host.
Registration is disabled by default; Start/Stop/Remove require -Apply. The
control key is generated in-process, stored only in the protected config, and
never emitted. The host's scheduled job tasks remain owned by ghost_task_scheduler.ps1.
#>
[CmdletBinding(SupportsShouldProcess=$true, ConfirmImpact='High')]
param(
  [ValidateSet('Plan','Register','Verify','Start','Stop','Remove')][string]$Mode='Plan',
  [string]$InstallRoot='',
  [string]$HostScript='', [string]$PythonExe='', [string]$RunnerExe='',
  [string]$Workspace='', [string]$DraftStateDirectory='',
  [ValidateRange(1024,65535)][int]$Port=18473,
  [ValidateSet('read-only','workspace-write')][string]$Sandbox='read-only',
  [ValidateRange(1,86400)][int]$RunTimeoutSeconds=3600,
  [switch]$Apply
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'NATIVE_WINDOWS_REQUIRED' }
$writes=$Mode -in @('Register','Start','Stop','Remove')
if ($writes -and -not $Apply) { throw 'GHOST_EXPLICIT_APPLY_REQUIRED' }
if (-not $writes -and $Apply) { throw 'GHOST_READ_ONLY_REFUSES_APPLY' }
if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA_REQUIRED' }

$base=[IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Singularity'))
$installRoot=if ($InstallRoot) { [IO.Path]::GetFullPath($InstallRoot) } else { Join-Path $base 'WindowsNative' }
if (-not $installRoot.StartsWith($base+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'GHOST_INSTALL_ROOT_OUTSIDE_PRIVATE_ROOT' }
$privateRoot=Join-Path $base 'GhostScheduler'
$stateDirectory=Join-Path $privateRoot 'state'
$configPath=Join-Path $privateRoot 'config.json'
$configPendingPath=Join-Path $privateRoot 'config.pending.json'
$clientConfigPath=Join-Path $privateRoot 'native-bridge-client.json'
$clientConfigPendingPath=Join-Path $privateRoot 'native-bridge-client.pending.json'
$receiptPath=Join-Path $privateRoot 'task-ownership.json'
$receiptPendingPath=Join-Path $privateRoot 'task-ownership.pending.json'
$taskName='Singularity-Ghost-Scheduler'
$taskPath='\'
$taskSchema='singularity-ghost-scheduler-host-task/v2'
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $identity -or -not $identity.User) { throw 'GHOST_WINDOWS_IDENTITY_UNAVAILABLE' }
$ownerSid=$identity.User.Value
$allowedSids=@($ownerSid,'S-1-5-18')

function Assert-LocalPath([string]$Value,[string]$Name,[bool]$MustExist=$true,[bool]$Directory=$false) {
  if (-not $Value -or -not [IO.Path]::IsPathRooted($Value) -or $Value.StartsWith('\\')) { throw "${Name}_LOCAL_ABSOLUTE_PATH_REQUIRED" }
  $full=[IO.Path]::GetFullPath($Value)
  if ($full.Contains('"') -or $full.Contains([char]10) -or $full.Contains([char]13)) { throw "${Name}_PATH_INVALID" }
  for ($cursor=$full;$cursor;$cursor=[IO.Path]::GetDirectoryName($cursor)) {
    if (Test-Path -LiteralPath $cursor) {
      if (((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'GHOST_REPARSE_PATH_REFUSED' }
    }
    if ([IO.Path]::GetDirectoryName($cursor) -eq $cursor) { break }
  }
  if ($MustExist) {
    if ($Directory -and -not [IO.Directory]::Exists($full)) { throw "${Name}_DIRECTORY_MISSING" }
    if (-not $Directory -and -not [IO.File]::Exists($full)) { throw "${Name}_FILE_MISSING" }
  }
  return $full
}
function Assert-PrivateAcl([string]$PathValue) {
  $acl=Get-Acl -LiteralPath $PathValue -ErrorAction Stop
  if (-not $acl.AreAccessRulesProtected) { throw 'GHOST_ACL_NOT_PROTECTED' }
  $rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
  if ($rules.Count -lt 2) { throw 'GHOST_ACL_INCOMPLETE' }
  $seen=@{}
  foreach ($rule in $rules) {
    $sid=[string]$rule.IdentityReference.Value
    if ($rule.IsInherited -or $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or $sid -notin $allowedSids -or
        (($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne [Security.AccessControl.FileSystemRights]::FullControl)) {
      throw 'GHOST_ACL_PRINCIPAL_UNEXPECTED'
    }
    $seen[$sid]=$true
  }
  foreach ($sid in $allowedSids) { if (-not $seen.ContainsKey($sid)) { throw 'GHOST_ACL_PRINCIPAL_MISSING' } }
}
function Test-DashboardStatePath([string]$PathValue,[string]$DashboardRoot) {
  $fullPath=[IO.Path]::GetFullPath($PathValue)
  $fullRoot=[IO.Path]::GetFullPath($DashboardRoot)
  return $fullPath.Equals($fullRoot,[StringComparison]::OrdinalIgnoreCase) -or
    $fullPath.StartsWith($fullRoot + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)
}
function Set-PrivateDirectoryAcl([string]$PathValue) {
  if (-not (Test-Path -LiteralPath $PathValue -PathType Container)) { New-Item -ItemType Directory -Path $PathValue -Force | Out-Null }
  $acl=[System.Security.AccessControl.DirectorySecurity]::new()
  $acl.SetAccessRuleProtection($true,$false)
  $inherit=[System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
  foreach ($sidText in $allowedSids) {
    $sid=[Security.Principal.SecurityIdentifier]::new($sidText)
    $rule=[System.Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::FullControl,$inherit,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
    $acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $PathValue -AclObject $acl
  Assert-PrivateAcl $PathValue
}
function Set-PrivateFileAcl([string]$PathValue) {
  $acl=[System.Security.AccessControl.FileSecurity]::new()
  $acl.SetAccessRuleProtection($true,$false)
  foreach ($sidText in $allowedSids) {
    $sid=[Security.Principal.SecurityIdentifier]::new($sidText)
    $rule=[System.Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.AccessControlType]::Allow)
    $acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $PathValue -AclObject $acl
  Assert-PrivateAcl $PathValue
}
function Read-JsonFile([string]$PathValue,[string]$ErrorCode) {
  try { return (Get-Content -LiteralPath $PathValue -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop) }
  catch { throw $ErrorCode }
}
function Get-TaskCandidates {
  try { $all=@(Get-ScheduledTask -ErrorAction Stop) }
  catch { throw 'GHOST_SCHEDULER_UNAVAILABLE' }
  return @($all | Where-Object { $_.TaskName -ceq $taskName })
}
function Get-ScheduleTaskCount {
  try { $all=@(Get-ScheduledTask -ErrorAction Stop) }
  catch { throw 'GHOST_SCHEDULER_UNAVAILABLE' }
  return @($all | Where-Object { $_.TaskName -like 'Singularity-Ghost-Schedule-*' }).Count
}
function Get-OwnedReceipt([bool]$AllowConfigMissing=$false,[bool]$AllowClientConfigMissing=$false) {
  if (-not (Test-Path -LiteralPath $receiptPath -PathType Leaf)) { throw 'GHOST_OWNERSHIP_RECEIPT_MISSING' }
  Assert-PrivateAcl (Split-Path -Parent $receiptPath)
  Assert-PrivateAcl $receiptPath
  $receipt=Read-JsonFile $receiptPath 'GHOST_OWNERSHIP_RECEIPT_INVALID'
  if ($receipt.schema -ne $taskSchema -or $receipt.taskName -cne $taskName -or $receipt.ownerSid -cne $ownerSid -or
      $receipt.taskPath -cne $taskPath -or $receipt.pythonExe -notmatch '^[A-Za-z]:\\' -or
      $receipt.hostScript -notmatch '^[A-Za-z]:\\' -or $receipt.configPath -cne $configPath -or
      $receipt.arguments -notmatch '^(-B ".*" --config ".*"|-B ".*silent_python_host\.py" --log ".*" -- ".*" --config ".*")$' -or $receipt.port -lt 1024 -or $receipt.port -gt 65535 -or
      $receipt.configSha256 -notmatch '^[0-9a-f]{64}$' -or $receipt.draftStateDirectory -notmatch '^[A-Za-z]:\\' -or
      $receipt.clientConfigPath -cne $clientConfigPath -or $receipt.clientConfigSha256 -notmatch '^[0-9a-f]{64}$' -or
      $receipt.workspace -notmatch '^[A-Za-z]:\\' -or $receipt.sandbox -notin @('read-only','workspace-write') -or
      $receipt.runTimeoutSeconds -lt 1 -or $receipt.runTimeoutSeconds -gt 86400 -or $receipt.installRoot -cne $installRoot) { throw 'GHOST_OWNERSHIP_RECEIPT_INVALID' }
  foreach ($entry in @(@($receipt.pythonExe,'GHOST_PYTHON_MISSING'),@($receipt.hostScript,'GHOST_HOST_SCRIPT_MISSING'))) {
    $null=Assert-LocalPath ([string]$entry[0]) ([string]$entry[1]) $true $false
  }
  if (Test-Path -LiteralPath $configPath -PathType Leaf) { $null=Assert-LocalPath $configPath 'GHOST_CONFIG_MISSING' $true $false }
  elseif (-not $AllowConfigMissing) { throw 'GHOST_CONFIG_MISSING' }
  if (Test-Path -LiteralPath $configPath -PathType Leaf) {
    if ((Get-FileHash -LiteralPath $configPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne [string]$receipt.configSha256) { throw 'GHOST_CONFIG_HASH_MISMATCH' }
    Assert-PrivateAcl $configPath
  } elseif (-not $AllowConfigMissing) { throw 'GHOST_CONFIG_MISSING' }
  if (Test-Path -LiteralPath $clientConfigPath -PathType Leaf) {
    $null=Assert-LocalPath $clientConfigPath 'GHOST_CLIENT_CONFIG_MISSING' $true $false
    if ((Get-FileHash -LiteralPath $clientConfigPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne [string]$receipt.clientConfigSha256) { throw 'GHOST_CLIENT_CONFIG_HASH_MISMATCH' }
    Assert-PrivateAcl $clientConfigPath
  } elseif (-not $AllowClientConfigMissing) { throw 'GHOST_CLIENT_CONFIG_MISSING' }
  return $receipt
}
function Assert-TaskOwned($task,$receipt) {
  $actions=@($task.Actions); $triggers=@($task.Triggers)
  $principalSid=Convert-PrincipalSid ([string]$task.Principal.UserId)
  if ([string]$task.TaskPath -cne $taskPath -or $actions.Count -ne 1 -or
      [string]$actions[0].Execute -ine $(if ($receipt.PSObject.Properties.Name -contains 'taskExe') { [string]$receipt.taskExe } else { [string]$receipt.pythonExe }) -or
      [string]$actions[0].Arguments -cne [string]$receipt.arguments -or
      [string]$actions[0].WorkingDirectory -ine [string]$receipt.workingDirectory -or
      $principalSid -cne $ownerSid -or
      [string]$task.Principal.LogonType -notin @('InteractiveToken','Interactive') -or
      [string]$task.Principal.RunLevel -notin @('Limited','LeastPrivilege') -or
      -not $task.Settings.Enabled -or
      [string]$task.Settings.MultipleInstances -ine 'IgnoreNew' -or
      -not $task.Settings.StartWhenAvailable -or
      $triggers.Count -ne 1 -or
      [string]$triggers[0].CimClass.CimClassName -ne 'MSFT_TaskLogonTrigger') { throw 'GHOST_TASK_OWNERSHIP_DRIFT' }
}
function Get-ConfigKey($config) {
  if ($config.schema -ne 'singularity-ghost-scheduler-config/v1' -or $config.ownerSid -cne $ownerSid -or
      $config.executionIdentitySid -cne $ownerSid -or $config.listenHost -cne '127.0.0.1' -or
      [int]$config.listenPort -ne [int]$receipt.port -or
      [string]$config.stateDirectory -ine [string]$receipt.stateDirectory -or
      [string]$config.draftStateDirectory -ine [string]$receipt.draftStateDirectory -or
      [string]$config.pythonExe -ine [string]$receipt.pythonExe -or
      $config.runnerExecutable -ine [string]$receipt.runnerExe -or
      [string]$config.workspace -ine [string]$receipt.workspace -or
      [string]$config.sandbox -cne [string]$receipt.sandbox -or
      [int]$config.runTimeoutSeconds -ne [int]$receipt.runTimeoutSeconds -or
      (@($config.runnerArguments).Count -ne 0)) { throw 'GHOST_CONFIG_CONTRACT_INVALID' }
  Assert-ClientConfig $config
  return [string]$config.controlKey
}
function Assert-ClientConfig($config) {
  if (-not (Test-Path -LiteralPath $clientConfigPath -PathType Leaf)) { throw 'GHOST_CLIENT_CONFIG_MISSING' }
  Assert-PrivateAcl $clientConfigPath
  $client=Read-JsonFile $clientConfigPath 'GHOST_CLIENT_CONFIG_INVALID'
  $names=@($client.PSObject.Properties.Name)
  $expectedEndpoint='http://127.0.0.1:{0}' -f [int]$receipt.port
  if ($client -isnot [pscustomobject] -or $names.Count -ne 2 -or
      @($names | Where-Object { $_ -notin @('endpoint','controlKey') }).Count -gt 0 -or
      $client.endpoint -cne $expectedEndpoint -or [string]$client.controlKey -cne [string]$config.controlKey -or
      [string]$client.controlKey -notmatch '^[A-Za-z0-9+/]{64}$') { throw 'GHOST_CLIENT_CONFIG_CONTRACT_INVALID' }
}
function Get-HostReadback($receipt,$config) {
  $task=@(Get-TaskCandidates)
  if ($task.Count -ne 1) { return [ordered]@{taskRegistered=$false;taskRunning=$false;hostReady=$false;state='not_running';activeScheduleTaskCount=(Get-ScheduleTaskCount)} }
  Assert-TaskOwned $task[0] $receipt
  $running=([string]$task[0].State -eq 'Running')
  $scheduleCount=Get-ScheduleTaskCount
  if (-not $running) { return [ordered]@{taskRegistered=$true;taskRunning=$false;hostReady=$false;state='not_running';activeScheduleTaskCount=$scheduleCount} }
  try {
    $headers=@{'X-Ghost-Control-Key'=(Get-ConfigKey $config)}
    $response=Invoke-RestMethod -Uri ('http://127.0.0.1:{0}/state' -f [int]$receipt.port) -Headers $headers -Method Get -TimeoutSec 3 -ErrorAction Stop
    $ready=($response.ok -eq $true -and $response.state -ceq 'ready' -and
      $response.ownerSid -ceq $ownerSid -and $response.executionIdentitySid -ceq $ownerSid)
    return [ordered]@{taskRegistered=$true;taskRunning=$true;hostReady=$ready;state=$(if ($ready) {'ready'} else {'unknown'});activeScheduleTaskCount=$scheduleCount}
  } catch {
    return [ordered]@{taskRegistered=$true;taskRunning=$true;hostReady=$false;state='unverified';activeScheduleTaskCount=$scheduleCount}
  }
}
function Convert-PrincipalSid([string]$PrincipalValue) {
  if (-not $PrincipalValue -or $PrincipalValue.Length -gt 256) { throw 'GHOST_TASK_PRINCIPAL_INVALID' }
  if ($PrincipalValue -match '^S-1-[0-9]+(-[0-9]+)+$') { return $PrincipalValue }
  try {
    $resolved=([Security.Principal.NTAccount]::new($PrincipalValue)).Translate(
      [Security.Principal.SecurityIdentifier]
    ).Value
  } catch { throw 'GHOST_TASK_PRINCIPAL_INVALID' }
  if ([string]$resolved -notmatch '^S-1-[0-9]+(-[0-9]+)+$') { throw 'GHOST_TASK_PRINCIPAL_INVALID' }
  return [string]$resolved
}
function Emit-Status([string]$StateName,$Readback) {
  [ordered]@{schema='singularity-ghost-scheduler-installation/v1';mode=$Mode;state=$StateName;
    taskRegistered=[bool]$Readback.taskRegistered;taskRunning=[bool]$Readback.taskRunning;
    hostReady=[bool]$Readback.hostReady;activeScheduleTaskCount=[int]$Readback.activeScheduleTaskCount;
    configContainsControlKey=$false;secretsPrinted=$false;releaseReady=$false} | ConvertTo-Json -Compress
}

$existing=@(Get-TaskCandidates)
if ($existing.Count -gt 1) { throw 'GHOST_AMBIGUOUS_TASK_REFUSED' }
$hasReceipt=Test-Path -LiteralPath $receiptPath -PathType Leaf
$hasConfig=Test-Path -LiteralPath $configPath -PathType Leaf
$hasClientConfig=Test-Path -LiteralPath $clientConfigPath -PathType Leaf
$hasPending=Test-Path -LiteralPath $receiptPendingPath -PathType Leaf
$hasConfigPending=Test-Path -LiteralPath $configPendingPath -PathType Leaf
 $hasClientConfigPending=Test-Path -LiteralPath $clientConfigPendingPath -PathType Leaf
if (($hasPending -or $hasConfigPending -or $hasClientConfigPending) -and $Mode -ne 'Remove') { throw 'GHOST_PARTIAL_REGISTRATION_REFUSED' }
if ($Mode -eq 'Remove' -and ($hasPending -or $hasConfigPending -or $hasClientConfigPending)) {
  if ($existing.Count -ne 0 -or (Get-ScheduleTaskCount) -gt 0) { throw 'GHOST_PENDING_REGISTRATION_TASKS_PRESENT' }
  Assert-PrivateAcl $privateRoot
  $pendingReceipt=$null
  if ($hasPending) {
    Assert-PrivateAcl $receiptPendingPath
    $pendingReceipt=Read-JsonFile $receiptPendingPath 'GHOST_PENDING_RECEIPT_INVALID'
    if ($pendingReceipt.schema -ne $taskSchema -or $pendingReceipt.taskName -cne $taskName -or $pendingReceipt.ownerSid -cne $ownerSid -or
        $pendingReceipt.configPath -cne $configPath -or $pendingReceipt.configSha256 -notmatch '^[0-9a-f]{64}$' -or
        $pendingReceipt.clientConfigPath -cne $clientConfigPath -or $pendingReceipt.clientConfigSha256 -notmatch '^[0-9a-f]{64}$') { throw 'GHOST_PENDING_RECEIPT_INVALID' }
  }
  if ($hasConfigPending) {
    Assert-PrivateAcl $configPendingPath
    $pendingConfig=Read-JsonFile $configPendingPath 'GHOST_PENDING_CONFIG_INVALID'
    if ($pendingConfig.schema -ne 'singularity-ghost-scheduler-config/v1' -or $pendingConfig.ownerSid -cne $ownerSid -or
        $pendingConfig.executionIdentitySid -cne $ownerSid -or $pendingConfig.stateDirectory -cne $stateDirectory -or
        $pendingConfig.listenHost -cne '127.0.0.1' -or [string]$pendingConfig.runnerExecutable -notmatch '^[A-Za-z]:\\.*\\codex\.exe$' -or
        @($pendingConfig.runnerArguments).Count -ne 0) { throw 'GHOST_PENDING_CONFIG_INVALID' }
    if (-not $pendingReceipt -and $hasReceipt) { $pendingReceipt=Get-OwnedReceipt $true $true }
    if ($pendingReceipt) {
      $pendingBytes=[IO.File]::ReadAllBytes($configPendingPath); $sha=[Security.Cryptography.SHA256]::Create()
      try { $pendingHash=([BitConverter]::ToString($sha.ComputeHash($pendingBytes))).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }
      if ($pendingHash -cne [string]$pendingReceipt.configSha256) { throw 'GHOST_PENDING_CONFIG_HASH_MISMATCH' }
    }
  }
  if ($hasClientConfigPending) {
    Assert-PrivateAcl $clientConfigPendingPath
    $pendingClient=Read-JsonFile $clientConfigPendingPath 'GHOST_PENDING_CLIENT_CONFIG_INVALID'
    if ($pendingClient -isnot [pscustomobject] -or @($pendingClient.PSObject.Properties.Name).Count -ne 2 -or
        [string]$pendingClient.endpoint -notmatch '^http://127\.0\.0\.1:(?:[1-9][0-9]{3,4})$' -or
        [string]$pendingClient.controlKey -notmatch '^[A-Za-z0-9+/]{64}$') { throw 'GHOST_PENDING_CLIENT_CONFIG_INVALID' }
    if (-not $pendingReceipt -and $hasReceipt) { $pendingReceipt=Get-OwnedReceipt $true $true }
    if ($pendingReceipt) {
      $pendingBytes=[IO.File]::ReadAllBytes($clientConfigPendingPath); $sha=[Security.Cryptography.SHA256]::Create()
      try { $pendingHash=([BitConverter]::ToString($sha.ComputeHash($pendingBytes))).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }
      if ($pendingHash -cne [string]$pendingReceipt.clientConfigSha256) { throw 'GHOST_PENDING_CLIENT_CONFIG_HASH_MISMATCH' }
    }
  }
  if (-not $PSCmdlet.ShouldProcess($taskName,'Remove only verified abandoned Ghost registration files')) {
    Emit-Status 'pending_registration_cleanup_planned' ([ordered]@{taskRegistered=$false;taskRunning=$false;hostReady=$false;activeScheduleTaskCount=0})
    return
  }
  if ($hasPending) { Remove-Item -LiteralPath $receiptPendingPath -Force -ErrorAction Stop }
  if ($hasConfigPending) { Remove-Item -LiteralPath $configPendingPath -Force -ErrorAction Stop }
  if ($hasClientConfigPending) { Remove-Item -LiteralPath $clientConfigPendingPath -Force -ErrorAction Stop }
  if (-not $hasReceipt -and -not $hasConfig -and -not $hasClientConfig) {
    Emit-Status 'partial_registration_files_removed_state_preserved' ([ordered]@{taskRegistered=$false;taskRunning=$false;hostReady=$false;activeScheduleTaskCount=0})
    return
  }
}
if ($Mode -eq 'Remove' -and $existing.Count -eq 0 -and -not $hasReceipt -and -not $hasConfig -and $hasClientConfig) {
  Assert-PrivateAcl $privateRoot
  Assert-PrivateAcl $clientConfigPath
  $orphanClient=Read-JsonFile $clientConfigPath 'GHOST_CLIENT_CONFIG_INVALID'
  if ($orphanClient -isnot [pscustomobject] -or @($orphanClient.PSObject.Properties.Name).Count -ne 2 -or
      [string]$orphanClient.endpoint -notmatch '^http://127\.0\.0\.1:(?:[1-9][0-9]{3,4})$' -or
      [string]$orphanClient.controlKey -notmatch '^[A-Za-z0-9+/]{64}$' -or (Get-ScheduleTaskCount) -gt 0) { throw 'GHOST_ORPHAN_CLIENT_CONFIG_REFUSED' }
  if (-not $PSCmdlet.ShouldProcess($clientConfigPath,'Remove only the abandoned private Ghost client configuration')) {
    Emit-Status 'orphan_client_config_cleanup_planned' ([ordered]@{taskRegistered=$false;taskRunning=$false;hostReady=$false;activeScheduleTaskCount=0})
    return
  }
  Remove-Item -LiteralPath $clientConfigPath -Force -ErrorAction Stop
  Emit-Status 'orphan_client_config_removed_state_preserved' ([ordered]@{taskRegistered=$false;taskRunning=$false;hostReady=$false;activeScheduleTaskCount=0})
  return
}
if ($existing.Count -ne 0 -or $hasReceipt -or $hasConfig -or $hasClientConfig) {
  if ($existing.Count -eq 1 -and $hasReceipt -and $hasConfig -and $hasClientConfig) {
    $receipt=Get-OwnedReceipt
    Assert-TaskOwned $existing[0] $receipt
    $config=Read-JsonFile $configPath 'GHOST_CONFIG_INVALID'
    $null=Get-ConfigKey $config
  } elseif ($Mode -eq 'Remove' -and $existing.Count -eq 0 -and $hasReceipt) {
    $receipt=Get-OwnedReceipt (-not $hasConfig) (-not $hasClientConfig)
    $config=if ($hasConfig) { Read-JsonFile $configPath 'GHOST_CONFIG_INVALID' } else { $null }
    if ($config -and $hasClientConfig) { $null=Get-ConfigKey $config }
  } else { throw 'GHOST_PARTIAL_REGISTRATION_REFUSED' }
} else { $receipt=$null; $config=$null }

if ($Mode -in @('Plan','Verify')) {
  if (-not $receipt) {
    if ($Mode -eq 'Plan') {
      $null=Assert-LocalPath $PythonExe 'GHOST_PYTHON' $true $false
      $null=Assert-LocalPath $RunnerExe 'GHOST_RUNNER' $true $false
      $null=Assert-LocalPath $HostScript 'GHOST_HOST_SCRIPT' $true $false
      $null=Assert-LocalPath $Workspace 'GHOST_WORKSPACE' $true $true
      $null=Assert-LocalPath $DraftStateDirectory 'GHOST_DRAFT_STATE' $false $true
      $dashboardRoot=[IO.Path]::GetFullPath((Join-Path $base 'Dashboard'))
      if (-not (Test-DashboardStatePath $DraftStateDirectory $dashboardRoot)) { throw 'GHOST_DRAFT_STATE_OUTSIDE_PRIVATE_DASHBOARD_ROOT' }
      if ([IO.Path]::GetFileName($PythonExe) -notin @('python.exe','python3.exe') -or [IO.Path]::GetFileName($RunnerExe) -ine 'codex.exe' -or
          [IO.Path]::GetFileName($HostScript) -ine 'ghost_scheduler_host.py') { throw 'GHOST_DEPENDENCY_INVALID' }
    }
    Emit-Status 'not_registered' ([ordered]@{taskRegistered=$false;taskRunning=$false;hostReady=$false;activeScheduleTaskCount=(Get-ScheduleTaskCount)})
    return
  }
  $readback=Get-HostReadback $receipt $config
  Emit-Status $(if ($readback.hostReady) {'ready'} elseif ($readback.taskRegistered) {'registered_not_ready'} else {'not_registered'}) $readback
  return
}

if ($Mode -eq 'Register') {
  if ($receipt -or $existing.Count -ne 0 -or $hasConfig -or $hasClientConfig) { throw 'GHOST_ALREADY_REGISTERED' }
  if (-not $PSCmdlet.ShouldProcess($taskName,'Create protected Ghost configuration and register the host without starting it')) {
    Emit-Status 'registration_planned' ([ordered]@{taskRegistered=$false;taskRunning=$false;hostReady=$false;activeScheduleTaskCount=(Get-ScheduleTaskCount)})
    return
  }
  $PythonExe=Assert-LocalPath $PythonExe 'GHOST_PYTHON' $true $false
  $RunnerExe=Assert-LocalPath $RunnerExe 'GHOST_RUNNER' $true $false
  $HostScript=Assert-LocalPath $HostScript 'GHOST_HOST_SCRIPT' $true $false
  $Workspace=Assert-LocalPath $Workspace 'GHOST_WORKSPACE' $true $true
  $DraftStateDirectory=Assert-LocalPath $DraftStateDirectory 'GHOST_DRAFT_STATE' $false $true
  $dashboardRoot=[IO.Path]::GetFullPath((Join-Path $base 'Dashboard'))
  if (-not (Test-DashboardStatePath $DraftStateDirectory $dashboardRoot)) { throw 'GHOST_DRAFT_STATE_OUTSIDE_PRIVATE_DASHBOARD_ROOT' }
  if ([IO.Path]::GetFileName($PythonExe) -notin @('python.exe','python3.exe') -or [IO.Path]::GetFileName($RunnerExe) -ine 'codex.exe' -or
      [IO.Path]::GetFileName($HostScript) -ine 'ghost_scheduler_host.py' -or
      -not (Test-Path -LiteralPath (Join-Path (Split-Path -Parent $HostScript) 'ghost_task_scheduler.ps1') -PathType Leaf)) { throw 'GHOST_DEPENDENCY_INVALID' }
  $expectedHost=[IO.Path]::GetFullPath((Join-Path $installRoot 'current/source/native/windows/ghost_scheduler_host.py'))
  if (-not $HostScript.Equals($expectedHost,[StringComparison]::OrdinalIgnoreCase)) { throw 'GHOST_HOST_SCRIPT_NOT_FROM_OWNED_STAGE' }
  $null=Assert-LocalPath $privateRoot 'GHOST_PRIVATE_ROOT' $false $true
  if (-not (Test-Path -LiteralPath $privateRoot)) { Set-PrivateDirectoryAcl $privateRoot }
  else { Assert-PrivateAcl $privateRoot }
  if (-not (Test-Path -LiteralPath $stateDirectory)) { Set-PrivateDirectoryAcl $stateDirectory }
  else { Assert-PrivateAcl $stateDirectory }
  if (-not (Test-Path -LiteralPath $DraftStateDirectory)) { Set-PrivateDirectoryAcl $DraftStateDirectory }
  else { Assert-PrivateAcl $DraftStateDirectory }
  $random=[byte[]]::new(48); $rng=[Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($random); $controlKey=[Convert]::ToBase64String($random) } finally { $rng.Dispose(); [Array]::Clear($random,0,$random.Length) }
  $configObject=[ordered]@{
    schema='singularity-ghost-scheduler-config/v1';stateDirectory=$stateDirectory;draftStateDirectory=$DraftStateDirectory;
    controlKey=$controlKey;ownerSid=$ownerSid;executionIdentitySid=$ownerSid;pythonExe=$PythonExe;
    runnerExecutable=$RunnerExe;runnerArguments=@();workspace=$Workspace;listenHost='127.0.0.1';listenPort=$Port;
    sandbox=$Sandbox;runTimeoutSeconds=$RunTimeoutSeconds
  }
  $configJson=$configObject | ConvertTo-Json -Depth 4 -Compress
  $configBytes=[Text.UTF8Encoding]::new($false).GetBytes($configJson)
  $clientConfigObject=[ordered]@{endpoint=('http://127.0.0.1:{0}' -f $Port);controlKey=$controlKey}
  $clientConfigJson=$clientConfigObject | ConvertTo-Json -Depth 3 -Compress
  $clientConfigBytes=[Text.UTF8Encoding]::new($false).GetBytes($clientConfigJson)
  $sha=[Security.Cryptography.SHA256]::Create()
  try {
    $configHash=([BitConverter]::ToString($sha.ComputeHash($configBytes))).Replace('-','').ToLowerInvariant()
    $clientConfigHash=([BitConverter]::ToString($sha.ComputeHash($clientConfigBytes))).Replace('-','').ToLowerInvariant()
  } finally { $sha.Dispose() }
  $pythonw=Assert-LocalPath (Join-Path (Split-Path -Parent $PythonExe) 'pythonw.exe') 'GHOST_PYTHONW' $true $false
  $silentHost=Assert-LocalPath (Join-Path (Split-Path -Parent $HostScript) 'silent_python_host.py') 'GHOST_SILENT_HOST' $true $false
  $arguments='-B "'+$silentHost+'" --log "'+(Join-Path $privateRoot 'ghost-runtime.log')+'" -- "'+$HostScript+'" --config "'+$configPath+'"' 
  $principalUser=$identity.Name
  $receiptObject=[ordered]@{schema=$taskSchema;taskName=$taskName;taskPath=$taskPath;ownerSid=$ownerSid;
    pythonExe=$PythonExe;taskExe=$pythonw;runnerExe=$RunnerExe;hostScript=$HostScript;configPath=$configPath;arguments=$arguments;
    workingDirectory=(Split-Path -Parent $HostScript);port=$Port;configSha256=$configHash;clientConfigPath=$clientConfigPath;
    clientConfigSha256=$clientConfigHash;stateDirectory=$stateDirectory;
    draftStateDirectory=$DraftStateDirectory;workspace=$Workspace;sandbox=$Sandbox;runTimeoutSeconds=$RunTimeoutSeconds;installRoot=$installRoot}
  if ((Test-Path -LiteralPath $receiptPendingPath) -or (Test-Path -LiteralPath $configPendingPath) -or
      (Test-Path -LiteralPath $clientConfigPendingPath)) { throw 'GHOST_OWNERSHIP_RECEIPT_PENDING_EXISTS' }
  [IO.File]::WriteAllText($configPendingPath,$configJson,[Text.UTF8Encoding]::new($false)); Set-PrivateFileAcl $configPendingPath
  [IO.File]::WriteAllText($clientConfigPendingPath,$clientConfigJson,[Text.UTF8Encoding]::new($false)); Set-PrivateFileAcl $clientConfigPendingPath
  [IO.File]::WriteAllText($receiptPendingPath,($receiptObject | ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false)); Set-PrivateFileAcl $receiptPendingPath
  Move-Item -LiteralPath $receiptPendingPath -Destination $receiptPath -ErrorAction Stop
  Move-Item -LiteralPath $configPendingPath -Destination $configPath -ErrorAction Stop
  Move-Item -LiteralPath $clientConfigPendingPath -Destination $clientConfigPath -ErrorAction Stop
  Assert-PrivateAcl $configPath
  Assert-PrivateAcl $clientConfigPath
  Set-PrivateFileAcl $receiptPath
  $action=New-ScheduledTaskAction -Execute $pythonw -Argument $arguments -WorkingDirectory (Split-Path -Parent $HostScript)
  $trigger=New-ScheduledTaskTrigger -AtLogOn -User $principalUser
  $principal=New-ScheduledTaskPrincipal -UserId $ownerSid -LogonType Interactive -RunLevel Limited
  $settings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskName $taskName -TaskPath $taskPath -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description $taskSchema -ErrorAction Stop | Out-Null
  $after=@(Get-TaskCandidates)
  if ($after.Count -ne 1) { throw 'GHOST_TASK_REGISTRATION_UNVERIFIED' }
  $receipt=Get-OwnedReceipt
  Assert-TaskOwned $after[0] $receipt
  $readback=[ordered]@{taskRegistered=$true;taskRunning=$false;hostReady=$false;state='registered_not_started';activeScheduleTaskCount=(Get-ScheduleTaskCount)}
  Emit-Status 'registered_not_started' $readback
  return
}

if (-not $receipt) { throw 'GHOST_NOT_REGISTERED' }
$readback=Get-HostReadback $receipt $config
if ($Mode -eq 'Start') {
  if (-not $readback.taskRegistered) { throw 'GHOST_NOT_REGISTERED' }
  if (-not $readback.taskRunning) {
    if (-not $PSCmdlet.ShouldProcess($taskName,'Start exact owned Ghost scheduler task')) {
      Emit-Status 'start_planned' $readback
      return
    }
    Start-ScheduledTask -TaskName $taskName -TaskPath $taskPath -ErrorAction Stop
  }
  $deadline=[DateTime]::UtcNow.AddSeconds(15)
  do {
    Start-Sleep -Milliseconds 250
    $readback=Get-HostReadback $receipt $config
    if ($readback.hostReady) { break }
  } while ([DateTime]::UtcNow -lt $deadline)
  if (-not $readback.hostReady) { throw 'GHOST_HOST_READBACK_NOT_READY' }
  Emit-Status 'ready' $readback
  return
}
if ($Mode -eq 'Stop') {
  if (-not $readback.taskRegistered) { throw 'GHOST_NOT_REGISTERED' }
  if ((Get-ScheduleTaskCount) -gt 0) { throw 'GHOST_SCHEDULE_TASKS_REMAIN_REFUSE_STOP' }
  if ($readback.taskRunning) {
    if (-not $PSCmdlet.ShouldProcess($taskName,'Stop exact owned Ghost scheduler task')) {
      Emit-Status 'stop_planned' $readback
      return
    }
    Stop-ScheduledTask -TaskName $taskName -TaskPath $taskPath -ErrorAction Stop
  }
  $deadline=[DateTime]::UtcNow.AddSeconds(10)
  do {
    Start-Sleep -Milliseconds 250
    $after=@(Get-TaskCandidates)
    if ($after.Count -ne 1) { throw 'GHOST_TASK_STOP_READBACK_FAILED' }
    Assert-TaskOwned $after[0] $receipt
    if ([string]$after[0].State -ne 'Running') { break }
  } while ([DateTime]::UtcNow -lt $deadline)
  if ([string]$after[0].State -eq 'Running') { throw 'GHOST_TASK_STOP_READBACK_FAILED' }
  Emit-Status 'stopped' ([ordered]@{taskRegistered=$true;taskRunning=$false;hostReady=$false;activeScheduleTaskCount=(Get-ScheduleTaskCount)})
  return
}
if ($Mode -eq 'Remove') {
  if ((Get-ScheduleTaskCount) -gt 0) { throw 'GHOST_SCHEDULE_TASKS_REMAIN_REFUSE_UNINSTALL' }
  if ($readback.taskRunning) { throw 'GHOST_TASK_RUNNING_REFUSE_UNINSTALL' }
  if ($hasConfig -and (Get-FileHash -LiteralPath $configPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne [string]$receipt.configSha256) { throw 'GHOST_CONFIG_HASH_MISMATCH' }
  if ($hasClientConfig -and (Get-FileHash -LiteralPath $clientConfigPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne [string]$receipt.clientConfigSha256) { throw 'GHOST_CLIENT_CONFIG_HASH_MISMATCH' }
  if (-not $PSCmdlet.ShouldProcess($taskName,'Remove exact owned Ghost configuration and host task')) {
    Emit-Status 'remove_planned' $readback
    return
  }
  if ($readback.taskRegistered) {
    Unregister-ScheduledTask -TaskName $taskName -TaskPath $taskPath -Confirm:$false -ErrorAction Stop
    if (@(Get-TaskCandidates).Count -ne 0) { throw 'GHOST_TASK_REMOVAL_UNVERIFIED' }
  }
  if (Test-Path -LiteralPath $configPath -PathType Leaf) {
    if ((Get-FileHash -LiteralPath $configPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne [string]$receipt.configSha256) { throw 'GHOST_CONFIG_HASH_MISMATCH' }
  }
  if (Test-Path -LiteralPath $clientConfigPath -PathType Leaf) {
    if ((Get-FileHash -LiteralPath $clientConfigPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne [string]$receipt.clientConfigSha256) { throw 'GHOST_CLIENT_CONFIG_HASH_MISMATCH' }
  }
  Remove-Item -LiteralPath $receiptPath -Force -ErrorAction Stop
  if (Test-Path -LiteralPath $configPath -PathType Leaf) { Remove-Item -LiteralPath $configPath -Force -ErrorAction Stop }
  if (Test-Path -LiteralPath $clientConfigPath -PathType Leaf) { Remove-Item -LiteralPath $clientConfigPath -Force -ErrorAction Stop }
  Assert-PrivateAcl $privateRoot
  Emit-Status 'uninstalled_state_preserved' ([ordered]@{taskRegistered=$false;taskRunning=$false;hostReady=$false;activeScheduleTaskCount=0})
  return
}
throw 'GHOST_MODE_INVALID'
