<#
.SYNOPSIS
  Open the local Singularity dashboard in the default browser.
.DESCRIPTION
  Opens the private loopback dashboard in the default browser. The browser
  signs in with the local username/password chosen on first launch. No
  capability token is sent to the browser or stored in browser storage.
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
Start-Process $target
