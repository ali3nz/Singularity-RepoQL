# Review-first official RepoQL Windows bootstrap. No silent update or remote IEX.
# No action by default except downloading the installer to a temporary file and
# reporting its hash. For -Apply, explicitly supply the SHA256 of the reviewed
# installer. The app may offer its own interactive agent-registration prompts.
[CmdletBinding()]
param(
  [switch]$Apply,
  [string]$InstallerSha256 = ''
)
$ErrorActionPreference = 'Stop'
$uri = 'https://downloads.repoql.ai/latest/install-rql.ps1'
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("singularity-rql-installer-" + [guid]::NewGuid().ToString('N') + '.ps1')
try {
  if ($env:OS -ne 'Windows_NT') { throw 'WINDOWS_REQUIRED' }
  Invoke-WebRequest -Uri $uri -OutFile $tmp -UseBasicParsing -TimeoutSec 30
  $info = Get-Item -LiteralPath $tmp
  if ($info.Length -le 64 -or $info.Length -gt 1048576) { throw 'INSTALLER_SIZE_REFUSED' }
  $hash = (Get-FileHash -LiteralPath $tmp -Algorithm SHA256).Hash.ToLowerInvariant()
  $report = [ordered]@{installerUrl=$uri; sha256=$hash; bytes=$info.Length; reviewed=$false; applied=$false; releaseReady=$false}
  if (-not $Apply) {
    $report.reviewFile = $tmp
    $report | ConvertTo-Json
    Write-Warning 'Review the official installer and its hash before applying. Source is external and not bundled in Singularity.'
    return
  }
  if ($InstallerSha256 -notmatch '^[a-fA-F0-9]{64}$' -or $InstallerSha256.ToLowerInvariant() -cne $hash) { throw 'REVIEWED_INSTALLER_SHA256_REQUIRED_OR_CHANGED' }
  # No Invoke-Expression and no shell-string construction. Operator explicitly
  # approves executing this pinned-on-this-run reviewed downloaded file.
  & $tmp
  if (-not $?) { throw 'REPOQL_INSTALLER_FAILED' }
  $rql = Get-Command rql.exe -CommandType Application -ErrorAction SilentlyContinue
  if (-not $rql) {
    $candidate = Join-Path $env:LOCALAPPDATA 'rql\rql.exe'
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { $rql = @{Source=$candidate} }
  }
  if (-not $rql) { throw 'NATIVE_RQL_EXE_NOT_FOUND_AFTER_INSTALL' }
  $version = & $rql.Source --version
  if (-not $?) { throw 'REPOQL_VERSION_PROBE_FAILED' }
  $versionText = $version -join "`n"
  $bare = [regex]::Match($versionText.Trim(), '^(?i:v)?(\d+\.\d+\.\d+)$')
  if ($bare.Success) { $versions = @($bare.Groups[1].Value) }
  else {
    $bareLines = @($versionText -split "`r?`n" | Where-Object { $_.Trim() -match '^(?i:v)?\d+\.\d+\.\d+$' })
    if ($bareLines.Count -gt 0) { throw 'AMBIGUOUS_INSTALLED_RQL_VERSION' }
    $found = [regex]::Matches($versionText, '(?i)\b(?:repoql|rql)\b[^\r\n]{0,64}?\bv?(\d+\.\d+\.\d+)\b')
    $versions = @($found | ForEach-Object { $_.Groups[1].Value } | Select-Object -Unique)
  }
  if ($versions.Count -ne 1) { throw 'AMBIGUOUS_INSTALLED_RQL_VERSION' }
  $report.applied = $true
  $report.installedVersion = $versions[0]
  $report.binary = $rql.Source
  $report.releaseReady = $false
  $report | ConvertTo-Json
  if ($versions[0] -ne '1.7.18') {
    throw 'LATEST_INSTALLED_BUT_RELEASE_PIN_MIGRATION_AND_CONNECTOR_TESTS_REQUIRED'
  }
  Write-Warning 'Version pin verified; Tencent/Kanzo connector indexing, MCP discovery and live readback are still REQUIRED.'
}
finally { if ($Apply -and (Test-Path -LiteralPath $tmp)) { Remove-Item -LiteralPath $tmp -Force } }
