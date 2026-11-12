#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Install, repair or remove the SingularitySupervisor Windows service.

.DESCRIPTION
  Runs the fail-closed Rust supervisor as a real Windows service that starts at boot
  (delayed automatic), before anyone signs in, and is restarted by the Service Control
  Manager if it fails. The service owns the session-0-safe stack (memory, gateway,
  Knowledge Service, panel). The RepoQL host is NOT part of it: a session-0 host blocks
  the interactive host Claude Code needs, so it stays an AtLogOn task.

  Account: by default the service runs as the installing user, so file ownership under
  %LOCALAPPDATA%\Singularity stays theirs. Windows requires that user's password to do
  this; it is requested with Get-Credential in this console and never written to disk or
  logs. -LocalSystem installs without a password but files the stack creates are then
  owned by SYSTEM.

  Installing the service disables (does not delete) the Singularity-Rust-Native-Supervisor
  task so two owners never start the same ports. -Uninstall removes the service and
  re-enables the task.
#>
[CmdletBinding()]
param(
  [string]$Root = (Join-Path $env:LOCALAPPDATA 'Singularity\WindowsNative'),
  [string]$Config,
  [string]$Binary,
  [pscredential]$Credential,
  [switch]$RunAsUser,   # advanced: run the stack inside the service as the user (needs their password)
  [switch]$LocalSystem, # kept for compatibility; this is now the default
  [switch]$Uninstall,
  [int[]]$HealthPorts = @(18431, 18421, 18126),
  [int]$HealthTimeoutSec = 120
)
$ErrorActionPreference = 'Stop'
$name = 'SingularitySupervisor'
$legacyTask = 'Singularity-Rust-Native-Supervisor'
if (-not $Config) { $Config = Join-Path $Root 'supervisor.json' }
if (-not $Binary) { $Binary = Join-Path $Root 'current\bin\singularity_windows_supervisor_service.exe' }

function Grant-LogonAsService([string]$account) {
  $sid = (New-Object System.Security.Principal.NTAccount($account)).Translate([System.Security.Principal.SecurityIdentifier]).Value
  $tmp = Join-Path $env:TEMP "svc-right-$PID"
  secedit /export /cfg "$tmp.inf" /areas USER_RIGHTS | Out-Null
  $inf = Get-Content "$tmp.inf"
  $line = $inf | Where-Object { $_ -like 'SeServiceLogonRight*' }
  if ($line -and $line -match [regex]::Escape("*$sid")) { Remove-Item "$tmp.*" -ea 0; return }
  $new = if ($line) { "$line,*$sid" } else { "SeServiceLogonRight = *$sid" }
  if ($line) { $inf = $inf -replace [regex]::Escape($line), $new } else { $inf += $new }
  Set-Content "$tmp.inf" $inf -Encoding Unicode
  secedit /configure /db "$tmp.sdb" /cfg "$tmp.inf" /areas USER_RIGHTS | Out-Null
  Remove-Item "$tmp.*" -ea 0
}

if ($Uninstall) {
  if (Get-Service $name -ErrorAction SilentlyContinue) {
    Stop-Service $name -Force -ErrorAction SilentlyContinue
    sc.exe delete $name | Out-Null
    Write-Host "removed service $name"
  }
  if (Get-ScheduledTask $legacyTask -ErrorAction SilentlyContinue) {
    Enable-ScheduledTask $legacyTask | Out-Null
    Write-Host "re-enabled task $legacyTask (start it or sign in again)"
  }
  return
}

foreach ($p in @($Binary, $Config)) { if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { throw "missing: $p" } }
if (-not [IO.Path]::IsPathRooted($Config)) { throw 'Config must be an absolute path' }

$watchdog = -not ($RunAsUser -or $Credential)
if ($watchdog) { $acct = $null }
else {
  if (-not $Credential) { $Credential = Get-Credential -UserName ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -Message 'Windows password for the service account (not stored)' }
  $acct = $Credential.UserName
  Grant-LogonAsService $acct
}

# Stop whoever else owns the stack ports before the service takes over.
if (-not $watchdog -and (Get-ScheduledTask $legacyTask -ErrorAction SilentlyContinue)) {
  Stop-ScheduledTask $legacyTask -ErrorAction SilentlyContinue
  Disable-ScheduledTask $legacyTask | Out-Null
}
$existing = Get-Service $name -ErrorAction SilentlyContinue
if ($existing) { Stop-Service $name -Force -ErrorAction SilentlyContinue; sc.exe delete $name | Out-Null; Start-Sleep 2 }

$mode = if ($watchdog) { 'watchdog' } else { 'service' }
$bin = "`"$Binary`" $mode `"$Config`""
if ($acct) {
  New-Service -Name $name -BinaryPathName $bin -DisplayName 'Singularity Supervisor' `
    -Description 'Singularity RepoQL memory stack supervisor (fail-closed, restarts on failure).' `
    -StartupType Automatic -Credential $Credential | Out-Null
} else {
  New-Service -Name $name -BinaryPathName $bin -DisplayName 'Singularity Supervisor' `
    -Description 'Singularity RepoQL memory stack supervisor (fail-closed, restarts on failure).' `
    -StartupType Automatic | Out-Null
}
sc.exe config $name start= delayed-auto | Out-Null
sc.exe failure $name reset= 86400 actions= restart/5000/restart/30000/restart/60000 | Out-Null
sc.exe failureflag $name 1 | Out-Null   # also restart on non-zero exit, not only crashes

function Test-Stack {
  foreach ($port in $HealthPorts) {
    try { $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 "http://127.0.0.1:$port/health"; if ($r.StatusCode -ne 200) { return $false } }
    catch { return $false }
  }
  return $true
}

Start-Service $name
$deadline = (Get-Date).AddSeconds($HealthTimeoutSec)
$healthy = $false
while ((Get-Date) -lt $deadline) {
  Start-Sleep 3
  if ((Get-Service $name).Status -eq 'Running' -and (Test-Stack)) { $healthy = $true; break }
}
Get-Service $name | Format-Table Name, Status, StartType -AutoSize | Out-String | Write-Host
$logDir = Split-Path $Config
if ($healthy) {
  Write-Host "OK: the Singularity stack is running under the $name service."
  Write-Host "logs: $logDir\supervisor-service.log and $logDir\component-*.log"
} else {
  # Never leave the user without a working stack: put the old scheduled task back.
  Write-Host 'The service did not bring the stack up. Rolling back to the previous scheduled task.' -ForegroundColor Yellow
  foreach ($f in 'supervisor-service.log', 'component-memory.log') {
    $path = Join-Path $logDir $f
    if (Test-Path $path) { Write-Host "--- $f (last 15 lines)"; Get-Content $path -Tail 15 }
  }
  Stop-Service $name -Force -ErrorAction SilentlyContinue
  Set-Service $name -StartupType Disabled
  if (Get-ScheduledTask $legacyTask -ErrorAction SilentlyContinue) {
    Enable-ScheduledTask $legacyTask | Out-Null
    Start-ScheduledTask $legacyTask
  }
  throw 'Service install rolled back; the previous setup was restored.'
}
