#Requires -Version 5.1
<#
.SYNOPSIS
Builds a clean Claude Code Windows release archive from a git worktree.

.DESCRIPTION
Copies the candidate's tracked files into a staging directory and writes one zip. Untracked files are
never selected unless -IncludeUntracked is given; ignored paths are never
selected either. Build output and local state are never shipped: target/, node_modules/,
.repoql/, __pycache__/, venv/ and .venv/ are excluded by name, and ignored
paths are never selected. The archive is scanned for secrets and private paths;
matches are reported as file:line plus a pattern label, never the value.

Exit codes: 0 = exported, scan clean; 3 = exported, scan findings; 2 = export
or scan failed.

.EXAMPLE
powershell -NoProfile -File scripts\export-release.ps1 -Out "$env:TEMP\singularity-release.zip"
#>
[CmdletBinding()]
param(
  [string]$Repo = '',
  [string]$Out = '',
  [switch]$IncludeUntracked,
  [switch]$SkipScan
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $Repo) {
  $Repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
}
$Repo = [IO.Path]::GetFullPath($Repo)
if (-not (Test-Path -LiteralPath (Join-Path $Repo '.git'))) {
  Write-Error "NOT_A_GIT_REPO: $Repo"
  exit 2
}
if (-not $Out) {
  $Out = Join-Path $env:TEMP ('singularity-release-' + (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ') + '.zip')
}
$Out = [IO.Path]::GetFullPath($Out)
$outDir = Split-Path -Parent $Out
if (-not (Test-Path -LiteralPath $outDir)) {
  New-Item -ItemType Directory -Path $outDir -Force | Out-Null
}
if (Test-Path -LiteralPath $Out) {
  Remove-Item -LiteralPath $Out -Force
}

function Invoke-GitList([string[]]$Arguments) {
  $lines = @(& git -C $Repo @Arguments 2>&1)
  if ($LASTEXITCODE -ne 0) {
    throw ('GIT_FAILED: git ' + ($Arguments -join ' ') + ' :: ' + ($lines -join ' '))
  }
  return $lines
}

$head = (Invoke-GitList @('rev-parse','HEAD') | Select-Object -First 1)
$branch = (Invoke-GitList @('rev-parse','--abbrev-ref','HEAD') | Select-Object -First 1)
$tracked = @(Invoke-GitList @('ls-files'))
$untracked = @()
if ($IncludeUntracked) {
  $untracked = @(Invoke-GitList @('ls-files','--others','--exclude-standard'))
}
$all = @($tracked + $untracked | Where-Object { $_ -and $_.Trim() } | Sort-Object -Unique)
$exclude = '(?i)(^|/)(target|node_modules|\.repoql|__pycache__|\.venv|venv|\.git)(/|$)|(?i)\.pyc$'

$stage = Join-Path $env:TEMP ('singularity-export-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage | Out-Null
$copied = 0
$skipped = 0
$hits = New-Object System.Collections.Generic.List[string]
$result = [ordered]@{
  schema = 'singularity-release-export/v1'
  repo = $Repo
  branch = $branch
  head = $head
  archive = $Out
  files = 0
  skipped = 0
  tracked = $tracked.Count
  untrackedIncluded = $untracked.Count
  trackedOnly = (-not [bool]$IncludeUntracked)
  scanHits = -1
  exportedAtUtc = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
}
try {
  foreach ($raw in $all) {
    $rel = ([string]$raw).Trim().Replace('\','/')
    if (-not $rel) { continue }
    if ($rel -match $exclude) { $skipped++; continue }
    $src = Join-Path $Repo ($rel.Replace('/', [IO.Path]::DirectorySeparatorChar))
    if (-not (Test-Path -LiteralPath $src -PathType Leaf)) { $skipped++; continue }
    $dst = Join-Path $stage ($rel.Replace('/', [IO.Path]::DirectorySeparatorChar))
    $parent = Split-Path -Parent $dst
    if (-not (Test-Path -LiteralPath $parent)) {
      New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    Copy-Item -LiteralPath $src -Destination $dst -Force
    $copied++
  }

  $zipOk = $true
  if (Get-Command tar.exe -ErrorAction SilentlyContinue) {
    & tar.exe -a -c -f $Out -C $stage .
    if ($LASTEXITCODE -ne 0) { $zipOk = $false }
  } else {
    Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $Out -CompressionLevel Optimal
  }
  if (-not $zipOk -or -not (Test-Path -LiteralPath $Out)) {
    throw 'EXPORT_ZIP_FAILED'
  }

  $result.files = $copied
  $result.skipped = $skipped
  $result.archiveBytes = (Get-Item -LiteralPath $Out).Length
  $result.archiveSha256 = (Get-FileHash -LiteralPath $Out -Algorithm SHA256).Hash.ToLowerInvariant()

  if (-not $SkipScan) {
    $patterns = [ordered]@{
      'private-path-user' = 'C:\\Users\\Ben'
      'private-handle' = '(?i)\bali3nz\b'
      'private-ip' = '\b192\.168\.[0-9]{1,3}\.[0-9]{1,3}\b'
      'internal-host' = '(?i)\b(dockerhost|windows241|proxmox-web|proxmox)\b'
      'github-token' = '\b(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b'
      'cloud-key' = '\bAKIA[0-9A-Z]{16}\b'
      'api-key' = '(?i)\bsk-[A-Za-z0-9_-]{20,}'
      'private-key' = '-----BEGIN [A-Z ]*PRIVATE KEY-----'
      'slack-token' = 'xox[baprs]-[A-Za-z0-9-]{10,}'
      'jwt' = 'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}'
    }
    $skipExt = '(?i)\.(png|jpe?g|gif|webp|ico|zip|exe|dll|so|woff2?|ttf|bin|db|sqlite|pyc|pdf|mp4|webm)$'
    $count = 0
    foreach ($file in (Get-ChildItem -LiteralPath $stage -Recurse -File -Force | Sort-Object FullName)) {
      if ($file.Name -match $skipExt -or $file.Length -gt 4MB) { continue }
      try {
        $lines = [IO.File]::ReadAllLines($file.FullName)
      } catch {
        continue
      }
      for ($i = 0; $i -lt $lines.Length; $i++) {
        $line = $lines[$i]
        if (-not $line) { continue }
        foreach ($name in $patterns.Keys) {
          if ($line -match $patterns[$name]) {
            $relHit = $file.FullName.Substring($stage.Length + 1).Replace('\','/')
            if ($relHit -eq 'scripts/export-release.ps1') { continue }
            $hits.Add(('{0}:{1}:{2}' -f $relHit, ($i + 1), $name))
            $count++
            break
          }
        }
        if ($count -ge 5000) { break }
      }
      if ($count -ge 5000) { break }
    }
    $result.scanHits = $hits.Count
  }
} finally {
  if (Test-Path -LiteralPath $stage) {
    Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
  }
}

$result | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath ($Out + '.receipt.json') -Encoding UTF8
if (-not $SkipScan) {
  $report = @(
    'Clean release export scan',
    ('archive: ' + $Out),
    ('sha256: ' + $result.archiveSha256),
    ('files: ' + $result.files),
    ('hits: ' + $result.scanHits + ' (file:line:pattern; values deliberately omitted)'),
    ''
  ) + $hits
  $report | Set-Content -LiteralPath ($Out + '.scan.txt') -Encoding UTF8
}

Write-Output ('EXPORT ' + $Out)
Write-Output ('sha256=' + $result.archiveSha256 + ' bytes=' + $result.archiveBytes + ' files=' + $result.files + ' skipped=' + $result.skipped)
Write-Output ('tracked=' + $result.tracked + ' untrackedIncluded=' + $result.untrackedIncluded + ' trackedOnly=' + $result.trackedOnly)
Write-Output ('scanHits=' + $result.scanHits + ' report=' + $Out + '.scan.txt')
if ($hits.Count -gt 0) {
  $hits | Select-Object -First 25 | ForEach-Object { Write-Output ('HIT ' + $_) }
  exit 3
}
exit 0
