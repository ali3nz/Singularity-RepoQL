#Requires -Version 5.1
<#
.SYNOPSIS
  Builds a clean release zip from a git working tree and writes a SHA256 manifest.

.DESCRIPTION
  Selects exactly the files that are tracked, staged, or untracked-but-intended:

      git ls-files --cached --others --exclude-standard

  so working-tree modifications and new files that are not ignored are included,
  and nothing that .gitignore excludes can leak in. On top of that selection the
  script refuses to ship build output and local state by name:

      target/  .repoql/  node_modules/  __pycache__/  evidence/  *.log

  plus *.pyc and .DS_Store/Thumbs.db. No commit, stash, or index change is made:
  the script only reads from git and copies files.

  Outputs, all inside -OutDir:
      <name>.zip            the archive
      <name>.zip.sha256     sha256sum-style line for the archive
      <name>.manifest.txt   per-file sha256 + size, plus archive metadata

  Exit codes: 0 = exported, 2 = failure.

.PARAMETER Repo
  Repository root. Defaults to two levels above this script (native/windows -> root).

.PARAMETER OutDir
  Directory that receives the zip and the manifests. Created when absent.

.PARAMETER Name
  Base name of the archive, without extension. Defaults to
  singularity-release-<UTC yyyyMMddTHHmmssZ>.

.PARAMETER KeepStaging
  Keep the staging directory for inspection instead of removing it.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File native\windows\export_release.ps1 `
      -OutDir "$env:LOCALAPPDATA\Temp\singularity-export"
#>
[CmdletBinding()]
param(
  [string]$Repo = '',
  [Parameter(Mandatory = $true)][string]$OutDir,
  [string]$Name = '',
  [switch]$KeepStaging
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Paths that must never reach an archive, matched as whole path segments.
$ExcludedSegments = @('target', '.repoql', 'node_modules', '__pycache__', 'evidence', '.venv', 'venv')
$ExcludedFilePatterns = @('*.log', '*.pyc', '.DS_Store', 'Thumbs.db')

function Write-Fail([string]$Message) {
  [Console]::Error.WriteLine('EXPORT_FAILED: ' + $Message)
  exit 2
}

function Resolve-LongPath([string]$Path) {
  # ZipFile and Copy-Item both hit MAX_PATH; the extended prefix avoids it.
  if ($Path.Length -ge 240 -and -not $Path.StartsWith('\\?\')) {
    return '\\?\' + $Path
  }
  return $Path
}

function Test-ExcludedPath([string]$RelativePath) {
  $segments = $RelativePath -split '/'
  foreach ($segment in $segments) {
    foreach ($excluded in $ExcludedSegments) {
      if ($segment -ieq $excluded) { return $true }
    }
  }
  $leaf = $segments[$segments.Length - 1]
  foreach ($pattern in $ExcludedFilePatterns) {
    if ($leaf -like $pattern) { return $true }
  }
  return $false
}

if (-not $Repo) {
  $Repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
}
$Repo = [IO.Path]::GetFullPath($Repo)
if (-not (Test-Path -LiteralPath (Join-Path $Repo '.git'))) {
  Write-Fail "not a git repository: $Repo"
}

if (-not (Test-Path -LiteralPath $OutDir)) {
  New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
}
$OutDir = [IO.Path]::GetFullPath($OutDir)

if (-not $Name) {
  $Name = 'singularity-release-' + (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
}
$zipPath = Join-Path $OutDir ($Name + '.zip')
$shaPath = $zipPath + '.sha256'
$manifestPath = Join-Path $OutDir ($Name + '.manifest.txt')

$stageRoot = Join-Path ([IO.Path]::GetTempPath()) ('export_release_stage_' + [Guid]::NewGuid().ToString('N'))
$stage = Join-Path $stageRoot 'payload'
New-Item -ItemType Directory -Path $stage -Force | Out-Null

try {
  # --- read the candidate list straight from git -----------------------------
  $listFile = Join-Path $stageRoot 'files.z'
  $gitArgs = 'git -C "' + $Repo + '" ls-files --cached --others --exclude-standard -z > "' + $listFile + '"'
  & cmd.exe /d /s /c $gitArgs
  if ($LASTEXITCODE -ne 0) { Write-Fail "git ls-files failed (exit $LASTEXITCODE)" }
  $raw = [Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($listFile))
  $candidates = @($raw.Split([char]0) | Where-Object { $_ -ne '' })
  if ($candidates.Count -eq 0) { Write-Fail 'git ls-files returned no files' }

  # --- filter ---------------------------------------------------------------
  $selected = New-Object System.Collections.Generic.List[string]
  $excluded = New-Object System.Collections.Generic.List[string]
  foreach ($rel in $candidates) {
    $normalized = $rel -replace '\\', '/'
    if (Test-ExcludedPath $normalized) { $excluded.Add($normalized) } else { $selected.Add($normalized) }
  }
  if ($selected.Count -eq 0) { Write-Fail 'every candidate was excluded; refusing to write an empty archive' }

  # --- stage ----------------------------------------------------------------
  $copied = New-Object System.Collections.Generic.List[object]
  $skipped = New-Object System.Collections.Generic.List[string]
  foreach ($rel in $selected) {
    $source = Resolve-LongPath (Join-Path $Repo ($rel -replace '/', '\'))
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
      # Tracked but deleted in the working tree: not a release file.
      $skipped.Add($rel)
      continue
    }
    $target = Resolve-LongPath (Join-Path $stage ($rel -replace '/', '\'))
    $targetDir = Split-Path -Parent $target
    if (-not (Test-Path -LiteralPath $targetDir)) {
      New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
    }
    Copy-Item -LiteralPath $source -Destination $target -Force
    $copied.Add([pscustomobject]@{ Path = $rel; Full = $source })
  }
  if ($copied.Count -eq 0) { Write-Fail 'no file could be staged' }

  # --- zip ------------------------------------------------------------------
  if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::CreateFromDirectory(
    $stage,
    $zipPath,
    [System.IO.Compression.CompressionLevel]::Optimal,
    $false
  )

  $zipHash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
  $zipSize = (Get-Item -LiteralPath $zipPath).Length

  # --- manifests ------------------------------------------------------------
  $branch = (& git -C $Repo rev-parse --abbrev-ref HEAD 2>&1 | Select-Object -First 1)
  $head = (& git -C $Repo rev-parse HEAD 2>&1 | Select-Object -First 1)

  $lines = New-Object System.Collections.Generic.List[string]
  $lines.Add('# Singularity release manifest')
  $lines.Add('generated_utc: ' + (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'))
  $lines.Add('repo: ' + $Repo)
  $lines.Add('branch: ' + $branch)
  $lines.Add('head: ' + $head)
  $lines.Add('selection: git ls-files --cached --others --exclude-standard')
  $lines.Add('excluded_segments: ' + ($ExcludedSegments -join ', '))
  $lines.Add('excluded_file_patterns: ' + ($ExcludedFilePatterns -join ', '))
  $lines.Add('file_count: ' + $copied.Count)
  $lines.Add('excluded_count: ' + $excluded.Count)
  $lines.Add('skipped_deleted_count: ' + $skipped.Count)
  $lines.Add('zip: ' + (Split-Path -Leaf $zipPath))
  $lines.Add('zip_bytes: ' + $zipSize)
  $lines.Add('zip_sha256: ' + $zipHash)
  $lines.Add('---')
  $lines.Add('sha256  bytes  path')
  foreach ($entry in ($copied | Sort-Object Path)) {
    $hash = (Get-FileHash -LiteralPath (Resolve-LongPath $entry.Full) -Algorithm SHA256).Hash.ToLowerInvariant()
    $size = (Get-Item -LiteralPath (Resolve-LongPath $entry.Full)).Length
    $lines.Add($hash + '  ' + $size + '  ' + $entry.Path)
  }
  if ($excluded.Count -gt 0) {
    $lines.Add('---')
    $lines.Add('excluded_paths:')
    foreach ($rel in ($excluded | Sort-Object)) { $lines.Add('  ' + $rel) }
  }
  if ($skipped.Count -gt 0) {
    $lines.Add('---')
    $lines.Add('skipped_deleted_in_worktree:')
    foreach ($rel in ($skipped | Sort-Object)) { $lines.Add('  ' + $rel) }
  }
  [IO.File]::WriteAllLines($manifestPath, $lines, (New-Object Text.UTF8Encoding($false)))
  [IO.File]::WriteAllText($shaPath, ($zipHash + '  ' + (Split-Path -Leaf $zipPath) + "`n"), (New-Object Text.UTF8Encoding($false)))

  Write-Output ('EXPORT_OK zip=' + $zipPath)
  Write-Output ('EXPORT_SHA256=' + $zipHash)
  Write-Output ('EXPORT_BYTES=' + $zipSize)
  Write-Output ('EXPORT_FILES=' + $copied.Count)
  Write-Output ('EXPORT_EXCLUDED=' + $excluded.Count)
  Write-Output ('EXPORT_MANIFEST=' + $manifestPath)
  exit 0
} catch {
  Write-Fail $_.Exception.Message
} finally {
  if (-not $KeepStaging -and (Test-Path -LiteralPath $stageRoot)) {
    Remove-Item -LiteralPath $stageRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
