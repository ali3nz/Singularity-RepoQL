#Requires -Version 5.1
<# Registers/removes the per-user logon task that runs claude_session_watcher.ps1 hidden. #>
[CmdletBinding()]
param([ValidateSet('Register','Remove','Status')][string]$Mode = 'Register')
$ErrorActionPreference = 'Stop'
$name = 'Singularity-ClaudeSessionWatcher'
$installed = Join-Path $env:LOCALAPPDATA 'Singularity\WindowsNative\current\bin'
$script = Join-Path $installed 'claude_session_watcher.ps1'
switch ($Mode) {
  'Remove' { Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue; 'removed'; return }
  'Status' { Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue | Select-Object TaskName, State; return }
}
New-Item -ItemType Directory -Force -Path $installed | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'claude_session_watcher.ps1') -Destination $script -Force
$pwsh = (Get-Command pwsh.exe -ErrorAction SilentlyContinue).Source
if (-not $pwsh) { $pwsh = (Get-Command powershell.exe).Source }
$action = New-ScheduledTaskAction -Execute $pwsh -Argument "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $name
Get-ScheduledTask -TaskName $name | Select-Object TaskName, State
