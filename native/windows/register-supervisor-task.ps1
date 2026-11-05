#Requires -Version 5.1
<#
Register a per-user logon startup task for the native Rust supervisor.
PREVIEW is the default; no silent task creation, service install or admin rights.
Not an accepted Windows installer. Only register after the Rust binary and its
configuration have passed Windows testing and have an operator-owned backup.
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
  [string]$SupervisorExe = '',
  [string]$ConfigPath = '',
  [switch]$Apply,
  [switch]$Remove
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'NATIVE_WINDOWS_REQUIRED' }
$taskName = 'Singularity-Rust-Native-Supervisor'
$user = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $user -or -not $user.User) { throw 'WINDOWS_USER_IDENTITY_UNAVAILABLE' }
if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) { throw 'LOCALAPPDATA_REQUIRED' }
$base = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Singularity'))
$userIds=@($user.Name,[string]$user.User.Value,(($user.Name -split '\\')[-1])) # USER_ID_ALIASES
function Test-LocalPath([string]$Value) {
  if (-not [IO.Path]::IsPathRooted($Value) -or $Value.StartsWith('\\')) { throw 'ABSOLUTE_LOCAL_PATH_REQUIRED' }
  $full = [IO.Path]::GetFullPath($Value)
  if ($full.Contains('"') -or $full.Contains("`n") -or $full.Contains("`r")) { throw 'INVALID_FILE_PATH' }
  $cursor = $full
  while ($cursor) {
    if (Test-Path -LiteralPath $cursor) {
      if (((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'REPARSE_PATH_REFUSED' }
    }
    $parent = [IO.Path]::GetDirectoryName($cursor)
    if (-not $parent -or $parent -eq $cursor) { break }
    $cursor = $parent
  }
  return $full
}
if (-not $SupervisorExe -or -not $ConfigPath) { throw 'EXPLICIT_SUPERVISOR_EXE_AND_CONFIG_REQUIRED' }
$exe = Test-LocalPath $SupervisorExe
$runtimeExe = Test-LocalPath (Join-Path (Split-Path -Parent $exe) 'singularity-windows-supervisorw.exe')
$config = Test-LocalPath $ConfigPath
if (-not $Remove -and -not ([IO.File]::Exists($exe) -and [IO.File]::Exists($runtimeExe) -and [IO.File]::Exists($config))) { throw 'SUPERVISOR_OR_CONFIG_MISSING' }
if (-not $exe.StartsWith($base + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'SUPERVISOR_EXE_MUST_BE_IN_PRIVATE_LOCALAPPDATA_SINGULARITY' }
if (-not $exe.EndsWith('.exe', [StringComparison]::OrdinalIgnoreCase)) { throw 'WINDOWS_EXE_REQUIRED' }
if (-not $config.StartsWith($base + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'CONFIG_MUST_BE_IN_PRIVATE_LOCALAPPDATA_SINGULARITY' }
# Windows config must live in the protected, per-user staged directory.
if (-not $Remove -and -not (Get-Acl -LiteralPath (Split-Path -Parent $config)).AreAccessRulesProtected) { throw 'CONFIG_DIRECTORY_ACL_NOT_PRIVATE' }
# Never show any config content or credential in output.
$arguments = 'run "' + $config + '"'
# Never confuse scheduler access failure with an absent task.  This registrar
# must be safe as a standalone entrypoint, not only when called by installer.
try { $allTasks = @(Get-ScheduledTask -ErrorAction Stop) }
catch { throw 'SUPERVISOR_SCHEDULER_UNAVAILABLE_REFUSE_MUTATION' }
$matchesName = @($allTasks | Where-Object { $_.TaskName -eq $taskName })
if ($matchesName.Count -gt 1) { throw 'AMBIGUOUS_SUPERVISOR_TASK_REFUSED' }
$existing = if ($matchesName.Count -eq 1) { $matchesName[0] } else { $null }
if ($existing) {
  $actions = @($existing.Actions)
  $triggers = @($existing.Triggers)
  $matches = ($actions.Count -eq 1 -and $actions[0].Execute -ieq $runtimeExe -and
              $actions[0].Arguments -ceq $arguments)
  $principalMatches = ($userIds -contains [string]$existing.Principal.UserId)
  $triggerMatches = ($triggers.Count -eq 1 -and
                     $triggers[0].CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger')
  $limited = ($existing.Principal.RunLevel -eq 'Limited')
  $enabled = ($existing.Settings.Enabled -eq $true)
  $legacyOwnedForRemoval = ($Remove -and $actions.Count -eq 1 -and $actions[0].Execute -ieq $exe -and
                            $actions[0].Arguments -ceq $arguments)
  if (-not (($matches -or $legacyOwnedForRemoval) -and $principalMatches -and $triggerMatches -and $limited -and $enabled)) {
    throw 'FOREIGN_OR_CHANGED_TASK_REFUSED'
  }
}
if ($Remove) {
  if (-not $existing) { '{"state":"not_registered","changed":false}'; return }
  if ($existing.State -eq 'Running') { throw 'TASK_RUNNING_STOP_ONLY_WITH_MANUAL_OWNER_VERIFICATION' }
  $changed = $false
  if ($Apply -and $PSCmdlet.ShouldProcess($taskName, 'Remove exactly this registered user task')) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction Stop
    try { $remaining = @(Get-ScheduledTask -ErrorAction Stop | Where-Object { $_.TaskName -eq $taskName }) }
    catch { throw 'TASK_UNREGISTER_VERIFICATION_UNAVAILABLE' }
    if ($remaining.Count -ne 0) { throw 'TASK_UNREGISTER_NOT_VERIFIED' }
    $changed = $true
  }
  '{"state":"remove_planned_or_applied","changed":' + $changed.ToString().ToLowerInvariant() + '}'
  return
}
if ($existing) { '{"state":"already_registered","changed":false}'; return }
# A validated config is a necessary but not sufficient test: real service
# health and GUI capture still require Windows acceptance before deployment.
& $exe check $config | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'RUST_SUPERVISOR_CONFIG_CHECK_FAILED' }
$changed = $false
if ($Apply -and $PSCmdlet.ShouldProcess($taskName, 'Register current-user logon native supervisor task')) {
  $action = New-ScheduledTaskAction -Execute $runtimeExe -Argument $arguments
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user.Name
  $principal = New-ScheduledTaskPrincipal -UserId $user.Name -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -ErrorAction Stop | Out-Null
  $after = @(Get-ScheduledTask -ErrorAction Stop | Where-Object { $_.TaskName -eq $taskName })
  if ($after.Count -ne 1) { throw 'TASK_REGISTRATION_NOT_VERIFIED' }
  $check = $after[0]
  $afterActions = @($check.Actions)
  $afterTriggers = @($check.Triggers)
  if ($afterActions.Count -ne 1 -or $afterActions[0].Execute -ine $runtimeExe -or
      $afterActions[0].Arguments -cne $arguments -or $afterTriggers.Count -ne 1 -or
      $afterTriggers[0].CimClass.CimClassName -ne 'MSFT_TaskLogonTrigger' -or
      (-not ($userIds -contains [string]$check.Principal.UserId)) -or
      $check.Principal.RunLevel -ne 'Limited' -or -not $check.Settings.Enabled) {
    throw 'TASK_REGISTRATION_NOT_VERIFIED'
  }
  $changed = $true
}
'{"state":"registration_planned_or_applied","changed":' + $changed.ToString().ToLowerInvariant() + '}'
