<#
.SYNOPSIS
  Open the local Singularity dashboard in the default browser.
.DESCRIPTION
  Reads the dashboard's private capability key from the current user's own state folder and
  opens the loopback dashboard link in the browser. The key is never printed, logged or
  written anywhere else. If the key file does not exist yet, the plain dashboard address is
  opened, which shows the page that explains how to get a fresh link.
#>
[CmdletBinding()]
param(
  [ValidateRange(1024,65535)][int]$DashboardPort=18100,
  [string]$StateDir=''
)
$ErrorActionPreference='Stop'
if (-not $StateDir) { $StateDir=Join-Path $env:LOCALAPPDATA 'Singularity\Dashboard' }
$base="http://127.0.0.1:$DashboardPort/"
$target=$base
$tokenFile=Join-Path $StateDir 'token'
if (Test-Path -LiteralPath $tokenFile -PathType Leaf) {
  $key=(Get-Content -LiteralPath $tokenFile -Raw).Trim()
  if ($key -match '^[A-Za-z0-9_\-]{16,128}$') { $target=$base+'#k='+$key }
}
Start-Process $target
