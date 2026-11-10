#Requires -Version 5.1
<# Registers/removes the per-user logon task that runs the native CPU history
   collector (dashboard\native_cpu_history.py) so the Diagnostics CPU panel has data.
   Without it /api/cpu reports native_windows_cpu_history_collector_not_installed. #>
[CmdletBinding()]
param([ValidateSet('Register','Remove','Status','Once')][string]$Mode = 'Register',
      [ValidateSet(1,2,3,4)][int]$Variant = 2)
$ErrorActionPreference = 'Stop'
$name = 'Singularity-CpuHistoryCollector'
$root = Join-Path $env:LOCALAPPDATA 'Singularity'
$cur  = Join-Path $root 'WindowsNative\current'
$py   = Join-Path $root 'Runtime\python\pythonw.exe'
$pyc  = Join-Path $root 'Runtime\python\python.exe'
$state = Join-Path $root 'Dashboard'
$cfg  = Join-Path $state 'cpu-collector.json'
$script = Join-Path $cur 'source\dashboard\native_cpu_history.py'
$extras = Join-Path $root 'WindowsNative\extras'   # outside the staged tree, which refuses unowned files
New-Item -ItemType Directory -Force -Path $extras | Out-Null
$wrapper = Join-Path $extras 'cpu_collector.cmd'
$launcher = Join-Path $extras 'cpu_collector_launch.py'
switch ($Mode) {
  'Remove' { Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue; 'removed'; return }
  'Status' { Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue | Select-Object TaskName, State; return }
}
if (-not (Test-Path -LiteralPath $script)) { throw "collector source missing: $script" }
if (-not (Test-Path -LiteralPath $cfg)) { Set-Content -LiteralPath $cfg -Value '{}' -Encoding ascii }
$env_lines = @(
  '@echo off',
  'set SINGULARITY_WINDOWS_NATIVE=1',
  "set SINGULARITY_INSTALL_VARIANT=$Variant",
  "set SINGULARITY_STATE_DIR=$state",
  "set SINGULARITY_WORKSPACE=$(Join-Path $root 'Workspace')",
  "set SINGULARITY_RQL_BIN=$(Join-Path $root 'Runtime\repoql\rql.exe')",
  "set SINGULARITY_RQL_EXE=$(Join-Path $root 'Runtime\repoql\rql.exe')",
  'set PYTHONDONTWRITEBYTECODE=1',
  "set PYTHONPATH=$(Join-Path $cur 'source\dashboard')",
  "cd /d `"$(Join-Path $cur 'source\dashboard')`"",
  "`"%~1`" -s -B `"$launcher`" --config `"$cfg`" %2"
)
Set-Content -LiteralPath $launcher -Value @('import sys, runpy', "sys.path.insert(0, r'$(Join-Path $cur 'source\dashboard')')", "sys.argv[0] = r'$script'", "runpy.run_path(r'$script', run_name='__main__')") -Encoding ascii
Set-Content -LiteralPath $wrapper -Value $env_lines -Encoding ascii
if ($Mode -eq 'Once') { & cmd.exe /c "`"$wrapper`" `"$pyc`" --once"; "exit=$LASTEXITCODE"; return }
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"`"$wrapper`" `"$py`"`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $name
Get-ScheduledTask -TaskName $name | Select-Object TaskName, State
