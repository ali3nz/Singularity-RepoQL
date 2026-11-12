#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Make every Singularity background task run with no visible window.
.DESCRIPTION
  Console programs (rql.exe, cmd/pwsh wrappers) otherwise open a terminal window in the user's
  session. This routes them through a hidden launcher (wscript, window style 0, no flash) and
  retires the stale DashProbe test dashboard that duplicated port 18100. Idempotent.
#>
[CmdletBinding()] param([string]$Root = (Join-Path $env:LOCALAPPDATA 'Singularity\WindowsNative'))
$ErrorActionPreference = 'Stop'
$extras = Join-Path $Root 'extras'
New-Item -ItemType Directory -Force $extras | Out-Null
$vbs = Join-Path $extras 'hidden-run.vbs'
@'
' Run a command line with no window and wait for it, so the scheduled task reflects its lifetime.
Set sh = CreateObject("WScript.Shell")
c = ""
For i = 0 To WScript.Arguments.Count - 1
  a = WScript.Arguments(i)
  If InStr(a, " ") > 0 Then a = Chr(34) & a & Chr(34)
  c = c & a & " "
Next
WScript.Quit sh.Run(c, 0, True)
'@ | Set-Content -Encoding ASCII $vbs

$targets = 'Singularity-RepoQL-Host', 'Singularity-ClaudeSessionWatcher', 'Singularity-CpuHistoryCollector'
foreach ($n in $targets) {
  $t = Get-ScheduledTask $n -ErrorAction SilentlyContinue
  if (-not $t) { continue }
  $a = $t.Actions[0]
  if ($a.Execute -match 'wscript') { "$n already hidden"; continue }
  $inner = $a.Execute
  if ($n -eq 'Singularity-CpuHistoryCollector') {
    # original: cmd.exe /c ""...cpu_collector.cmd" "pythonw"" -> run the .cmd directly
    $inner = '"' + (Join-Path $extras 'cpu_collector.cmd') + '"'
    $args2 = '"' + (Join-Path $env:LOCALAPPDATA 'Singularity\Runtime\python\pythonw.exe') + '"'
  } else {
    $inner = '"' + $a.Execute.Trim('"') + '"'
    $args2 = $a.Arguments
  }
  $line = '//B //Nologo "{0}" {1} {2}' -f $vbs, $inner, $args2
  $new = if ($a.WorkingDirectory) { New-ScheduledTaskAction -Execute 'wscript.exe' -Argument $line -WorkingDirectory $a.WorkingDirectory } else { New-ScheduledTaskAction -Execute 'wscript.exe' -Argument $line }
  Set-ScheduledTask -TaskName $n -Action $new | Out-Null
  "hidden: $n"
}

# DashProbe: stale test copy of the dashboard bound to the same port as the real one.
$probe = Get-ScheduledTask SingularityDashProbe -ErrorAction SilentlyContinue
if ($probe) {
  Stop-ScheduledTask SingularityDashProbe -ErrorAction SilentlyContinue
  Disable-ScheduledTask SingularityDashProbe | Out-Null
  Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object { $_.CommandLine -match 'singularity-dashboard-probe' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  'retired: SingularityDashProbe'
}
