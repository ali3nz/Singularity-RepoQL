#Requires -Version 5.1
<#
Read-only native Windows scheduled-task ownership and configuration acceptance.
This is NOT a process health, reboot recovery, or release approval receipt.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$SupervisorExe,
  [Parameter(Mandatory=$true)][string]$ConfigPath
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'NATIVE_WINDOWS_REQUIRED' }
if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA_REQUIRED' }
$user = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $user -or -not $user.User) { throw 'WINDOWS_IDENTITY_REQUIRED' }
$base = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Singularity'))
$userIds=@($user.Name,[string]$user.User.Value,(($user.Name -split '\\')[-1])) # USER_ID_ALIASES
function Assert-PrivatePath([string]$Value) {
  if (-not [IO.Path]::IsPathRooted($Value) -or $Value.StartsWith('\\')) { throw 'TASK_LOCAL_ABSOLUTE_PATH_REQUIRED' }
  $full=[IO.Path]::GetFullPath($Value)
  if (-not $full.StartsWith($base + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) {
    throw 'TASK_PATH_OUTSIDE_PRIVATE_ROOT'
  }
  for ($at=$full;$at;$at=[IO.Path]::GetDirectoryName($at)) {
    if (Test-Path -LiteralPath $at) {
      $item=Get-Item -LiteralPath $at -Force
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'TASK_REPARSE_PATH_REFUSED' }
    }
  }
  return $full
}
$exe=Assert-PrivatePath $SupervisorExe
$config=Assert-PrivatePath $ConfigPath
if ([IO.Path]::GetFileName($exe) -ine 'singularity-windows-supervisor.exe') { throw 'TASK_EXE_IDENTITY_INVALID' }
$taskName='Singularity-Rust-Native-Supervisor'
$task=@(Get-ScheduledTask -ErrorAction Stop | Where-Object { $_.TaskName -eq $taskName })
if ($task.Count -gt 1) { throw 'TASK_AMBIGUOUS_IDENTITY' }
if ($task.Count -eq 0) {
  [ordered]@{schema='singularity-option2-task-readback/v1';option=2;present=$false;
    registeredOwnedAndConfigured=$false;processHealthVerified=$false;rebootRecoveryVerified=$false;releaseReady=$false} | ConvertTo-Json -Compress
  exit 1
}
$t=$task[0]
$expectedArgs='run "' + $config + '"'
$actions=@($t.Actions)
$filesPresent=([IO.File]::Exists($exe) -and [IO.File]::Exists($config))
$correctAction=($actions.Count -eq 1 -and $actions[0].Execute -ieq $exe -and $actions[0].Arguments -ceq $expectedArgs)
$correctPrincipal=($userIds -contains [string]$t.Principal.UserId)
$limited=($t.Principal.RunLevel -eq 'Limited')
# Scheduled-task logon trigger is a distinct requirement from TaskName or
# exe/action matching; an event/boot trigger is not this user logon task.
$triggers=@($t.Triggers)
$logon=($triggers.Count -eq 1 -and $triggers[0].CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger')
$enabled=($t.Settings.Enabled -eq $true)
$owned=($filesPresent -and $correctAction -and $correctPrincipal -and $limited -and $logon -and $enabled)
# No raw XML, task arguments, username, token or private config is emitted.
[ordered]@{schema='singularity-option2-task-readback/v1';option=2;present=$true;
  registeredOwnedAndConfigured=$owned;processHealthVerified=$false;rebootRecoveryVerified=$false;
  releaseReady=$false;issues=@(
    if (-not $filesPresent) { 'OWNED_FILE_MISSING' }
    if (-not $correctAction) { 'ACTION_MISMATCH' }
    if (-not $correctPrincipal) { 'PRINCIPAL_MISMATCH' }
    if (-not $limited) { 'RUNLEVEL_MISMATCH' }
    if (-not $logon) { 'LOGON_TRIGGER_MISMATCH' }
    if (-not $enabled) { 'TASK_DISABLED' }
  )} | ConvertTo-Json -Compress
if (-not $owned) { exit 1 }
exit 0
