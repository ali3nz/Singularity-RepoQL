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
  [switch]$LocalSystem,
  [switch]$Uninstall
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

if ($LocalSystem) { $acct = $null }
else {
  if (-not $Credential) { $Credential = Get-Credential -UserName "$env:USERDOMAIN\$env:USERNAME" -Message 'Windows password for the service account (not stored)' }
  $acct = $Credential.UserName
  Grant-LogonAsService $acct
}

# Stop whoever else owns the stack ports before the service takes over.
if (Get-ScheduledTask $legacyTask -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask $legacyTask -ErrorAction SilentlyContinue
  Disable-ScheduledTask $legacyTask | Out-Null
}
$existing = Get-Service $name -ErrorAction SilentlyContinue
if ($existing) { Stop-Service $name -Force -ErrorAction SilentlyContinue; sc.exe delete $name | Out-Null; Start-Sleep 2 }

$bin = "`"$Binary`" service `"$Config`""
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

Start-Service $name
Start-Sleep 5
Get-Service $name | Format-Table Name, Status, StartType -AutoSize | Out-String | Write-Host
Write-Host "service log: $(Join-Path (Split-Path $Config) 'supervisor-service.log')"
