#Requires -Version 5.1
<#
Starts Claude-bound Singularity services (Office, unified gateway) while Claude
(desktop app or CLI) is running and stops them after Claude has been closed for
-GraceSeconds. Infrastructure Claude itself depends on (Kanzo, RepoQL host,
supervisor, dashboard) is left alone. Runs hidden as a per-user logon task.
#>
[CmdletBinding()]
param(
  [string[]]$BoundTasks = @('Singularity-ClaudeComplete-Office', 'Singularity-Windows-Unified-Gateway'),
  [int]$PollSeconds = 10,
  [int]$GraceSeconds = 60,
  [string]$ProcessName = 'claude',
  [switch]$Once
)
$ErrorActionPreference = 'Continue'
$log = Join-Path $env:LOCALAPPDATA 'Singularity\WindowsNative\logs\claude-session-watcher.log'
New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null
function Write-Log($m) { try { "{0:o} {1}" -f (Get-Date), $m | Add-Content -LiteralPath $log } catch {} }
function Test-ClaudeOpen { [bool](Get-Process -Name $ProcessName -ErrorAction SilentlyContinue) }
function Set-Bound([bool]$Up) {
  foreach ($n in $BoundTasks) {
    $t = Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue
    if (-not $t) { continue }
    if ($Up -and $t.State -ne 'Running') { Start-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue; Write-Log "started $n" }
    if (-not $Up -and $t.State -eq 'Running') { Stop-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue; Write-Log "stopped $n" }
  }
}
$lastSeen = Get-Date
$wasUp = $null
do {
  if (Test-ClaudeOpen) {
    $lastSeen = Get-Date
    Set-Bound $true; $wasUp = $true
  } elseif (((Get-Date) - $lastSeen).TotalSeconds -ge $GraceSeconds -or $null -eq $wasUp) {
    if ($null -eq $wasUp) { $lastSeen = (Get-Date).AddSeconds(-$GraceSeconds) }
    Set-Bound $false; $wasUp = $false
  }
  if (-not $Once) { Start-Sleep -Seconds $PollSeconds }
} while (-not $Once)
