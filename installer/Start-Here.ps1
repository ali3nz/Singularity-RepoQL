#Requires -Version 5.1
<# Read-only installed payload and local dependency check. No host mutations. #>
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSCommandPath
$source = Join-Path $root 'source'
Write-Host 'Singularity RepoQL Windows (Preview): installed file readiness' -ForegroundColor Cyan
$checks = [ordered]@{
  'Desktop bridge binary' = (Test-Path -LiteralPath (Join-Path $root 'bin\singularity-desktop-bridge.exe') -PathType Leaf)
  'Windows supervisor binary' = (Test-Path -LiteralPath (Join-Path $root 'bin\singularity-windows-supervisor.exe') -PathType Leaf)
  'Local memory gateway binary' = (Test-Path -LiteralPath (Join-Path $root 'bin\unified-repoql-control.exe') -PathType Leaf)
  'Kanzo audit binary' = (Test-Path -LiteralPath (Join-Path $root 'bin\kanzo_board_audit.exe') -PathType Leaf)
  'Windows lifecycle entrypoint' = (Test-Path -LiteralPath (Join-Path $source 'native\windows\manage_native_windows.ps1') -PathType Leaf)
  'Claude Code workflow' = (Test-Path -LiteralPath (Join-Path $source 'adapters\claude-code\singularity-workflow.md') -PathType Leaf)
  'RepoQL local binary' = (Test-Path -LiteralPath (Join-Path $env:LOCALAPPDATA 'rql\rql.exe') -PathType Leaf)
  'Node installed' = [bool]((Test-Path -LiteralPath (Join-Path $env:LOCALAPPDATA 'Singularity\Runtime\node\node.exe') -PathType Leaf) -or (Get-Command node -ErrorAction SilentlyContinue))
  'Python installed' = [bool](Get-Command py -ErrorAction SilentlyContinue)
}
foreach ($item in $checks.GetEnumerator()) {
  Write-Host ('{0,-34} {1}' -f $item.Key, $(if ($item.Value) { 'FOUND' } else { 'MISSING' }))
}
Write-Host ''
Write-Host 'Run Configure-Singularity.cmd to enter provider API keys and verify Tencent owner sign-in.'
Write-Host 'Use Readiness.ps1 for the read-only native Windows acceptance inventory.'
Write-Host 'Existing Windows lifecycle scripts remain authoritative for native service and Claude Code setup.'
Write-Host 'Read README-MSI.md. Use the existing project lifecycle commands for configuration after prerequisite verification.'
Write-Host ('Source: ' + $source)
