#Requires -Version 5.1
<#
Scoped source-only merge for an EXACT source tree matching the synced Git ZIP.
The user's installed Windows application is NOT restarted, installed, or modified
unless Mode=Apply with -Apply. Plan, Apply and Rollback preserve unrelated files.
A differing/newer source refuses rather than overwriting its changes.
#>
[CmdletBinding()]
param(
    [ValidateSet('Plan','Apply','Rollback')][string]$Mode='Plan',
    [switch]$Apply,
    [Parameter(Mandatory=$true)][string]$CandidateSource,
    [Parameter(Mandatory=$true)][string]$InstalledSource,
    [Parameter(Mandatory=$true)][string]$BackupDir
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'WINDOWS_ONLY' }
$CandidateSource=[IO.Path]::GetFullPath($CandidateSource)
$InstalledSource=[IO.Path]::GetFullPath($InstalledSource)
$BackupDir=[IO.Path]::GetFullPath($BackupDir)
if (@($CandidateSource,$InstalledSource,$BackupDir) | Where-Object { $_.StartsWith('\\') }) { throw 'UNC_PATH_REFUSED' }
if ($CandidateSource -ieq $InstalledSource) { throw 'CANDIDATE_MUST_DIFFER_FROM_INSTALLED' }
foreach ($path in @($CandidateSource,$InstalledSource)) {
    if (-not (Test-Path -LiteralPath $path -PathType Container)) { throw 'SOURCE_ROOT_MISSING' }
}
if ($BackupDir.StartsWith($CandidateSource+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or
    $BackupDir.StartsWith($InstalledSource+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) {
    throw 'BACKUP_INSIDE_SOURCE_REFUSED'
}
function Assert-NoReparse([string]$path) {
    $cursor=[IO.Path]::GetFullPath($path)
    while ($true) {
        if (Test-Path -LiteralPath $cursor) {
            $item=Get-Item -LiteralPath $cursor -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'SOURCE_REPARSE_REFUSED' }
        }
        $parent=Split-Path -Parent $cursor
        if (-not $parent -or $parent -eq $cursor) { break }
        $cursor=$parent
    }
}
function Digest([string]$path) {
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    Assert-NoReparse $path
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'EXPECTED_REGULAR_FILE' }
    return (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
}
$manifest=Join-Path $CandidateSource 'PORT-DELTA.json'
Assert-NoReparse $manifest
$doc=Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
if ($doc.schema -ne 'singularity-native-source-port/v1' -or @($doc.files).Count -gt 150) { throw 'UNSUPPORTED_PORT_MANIFEST' }
$receipt=Join-Path $BackupDir 'PORT-RECEIPT.json'
if ($Mode -eq 'Rollback') {
    if (-not $Apply) { throw 'ROLLBACK_REQUIRES_APPLY' }
    if (-not (Test-Path -LiteralPath $receipt -PathType Leaf)) { throw 'NO_PORT_ROLLBACK_RECEIPT' }
    Assert-NoReparse $receipt
    $saved=Get-Content -LiteralPath $receipt -Raw | ConvertFrom-Json
    if ($saved.schema -ne $doc.schema -or $saved.installedSource -ine $InstalledSource -or
        $saved.baselineSha256 -ne $doc.baselineArchiveSha256) { throw 'PORT_RECEIPT_WRONG_TARGET' }
    $selected=@($doc.files | Where-Object { @($saved.appliedPaths) -contains $_.path })
    foreach ($row in $selected) {
        $rel=[string]$row.path
        if ($rel -notmatch '^[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*$' -or $rel.Contains('..')) { throw 'INVALID_RECEIPT_RELATIVE_PATH' }
    }
    if ($selected.Count -ne @($saved.appliedPaths).Count) { throw 'PORT_RECEIPT_PATH_MISMATCH' }
    foreach ($row in $selected) {
        $rel=[string]$row.path
        $target=Join-Path $InstalledSource ($rel -replace '/','\')
        $back=Join-Path $BackupDir ($rel -replace '/','\')
        $current=Digest $target
        if ($current -ne [string]$row.afterSha256 -and $current -ne $row.beforeSha256) { throw "PORT_ROLLBACK_DRIFT: $rel" }
        if ($row.beforeSha256 -ne $null -and (Digest $back) -ne [string]$row.beforeSha256) { throw "PORT_BACKUP_HASH_INVALID: $rel" }
    }
    foreach ($row in $selected) {
        $rel=[string]$row.path
        $target=Join-Path $InstalledSource ($rel -replace '/','\')
        $back=Join-Path $BackupDir ($rel -replace '/','\')
        if ($row.beforeSha256 -ne $null) { Copy-Item -LiteralPath $back -Destination $target -Force -ErrorAction Stop }
        elseif ((Digest $target) -eq [string]$row.afterSha256) { Remove-Item -LiteralPath $target -Force -ErrorAction Stop }
        if ((Digest $target) -ne $row.beforeSha256) { throw "PORT_ROLLBACK_VERIFY_FAILED: $rel" }
    }
    Write-Host 'PORT_ROLLBACK_VERIFIED. Services and runtime state were not changed.'
    exit 0
}
if (Test-Path -LiteralPath $receipt -PathType Leaf) { throw 'OUTSTANDING_PORT_RECEIPT_REFUSED' }
$changeCount=0
$selectedRows=@()
foreach ($row in @($doc.files)) {
    $rel=[string]$row.path
    if ($rel -notmatch '^[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*$' -or $rel.Contains('..')) { throw 'INVALID_MANIFEST_RELATIVE_PATH' }
    $new=Join-Path $CandidateSource ($rel -replace '/','\')
    $old=Join-Path $InstalledSource ($rel -replace '/','\')
    Assert-NoReparse $new
    Assert-NoReparse $old
    if ((Digest $new) -ne [string]$row.afterSha256) { throw "CANDIDATE_SHA_DRIFT: $rel" }
    $found=Digest $old
    if ($found -ne $null -and $found -eq [string]$row.afterSha256) { continue }
    if ($found -ne $row.beforeSha256) { throw "INSTALLED_SOURCE_DRIFT_RECONCILE: $rel" }
    $changeCount++
    $selectedRows+=,$row
}
if (@($doc.files | Group-Object path | Where-Object { $_.Count -ne 1 }).Count -gt 0) { throw 'DUPLICATE_PORT_MANIFEST_PATH' }
if ($Mode -eq 'Plan') {
    [ordered]@{schema=$doc.schema;mode='read-only';installSource=$InstalledSource;plannedFileChanges=$changeCount;totalPortPaths=@($doc.files).Count;rollbackDirectory=$BackupDir;status='BASELINE_MATCHED_SOURCE_NOT_INSTALLED'} | ConvertTo-Json
    exit 0
}
if (-not $Apply) { throw 'APPLY_REQUIRES_EXPLICIT_SWITCH' }
if (Test-Path -LiteralPath $BackupDir) { throw 'BACKUP_DIRECTORY_MUST_BE_NEW' }
New-Item -ItemType Directory -Path $BackupDir -ErrorAction Stop | Out-Null
foreach ($row in $selectedRows) {
    if ($null -eq $row.beforeSha256) { continue }
    $rel=[string]$row.path
    $original=Join-Path $InstalledSource ($rel -replace '/','\')
    $backup=Join-Path $BackupDir ($rel -replace '/','\')
    if ((Digest $original) -eq [string]$row.beforeSha256) {
        New-Item -ItemType Directory -Path (Split-Path -Parent $backup) -Force | Out-Null
        Copy-Item -LiteralPath $original -Destination $backup -ErrorAction Stop
        if ((Digest $backup) -ne [string]$row.beforeSha256) { throw "BACKUP_FAILED: $rel" }
    }
}
$receiptData=[ordered]@{schema=$doc.schema;installedSource=$InstalledSource;candidateSource=$CandidateSource;
    baselineSha256=$doc.baselineArchiveSha256;plannedFiles=@($doc.files).Count;appliedPaths=@($selectedRows | ForEach-Object { $_.path });createdAt=[DateTime]::UtcNow.ToString('o');status='IN_PROGRESS'}
[IO.File]::WriteAllText($receipt,($receiptData | ConvertTo-Json -Depth 4),[Text.Encoding]::UTF8)
foreach ($row in $selectedRows) {
    $rel=[string]$row.path
    $src=Join-Path $CandidateSource ($rel -replace '/','\')
    $dst=Join-Path $InstalledSource ($rel -replace '/','\')
    if ((Digest $dst) -eq [string]$row.afterSha256) { continue }
    New-Item -ItemType Directory -Path (Split-Path -Parent $dst) -Force | Out-Null
    Copy-Item -LiteralPath $src -Destination $dst -Force -ErrorAction Stop
    if ((Digest $dst) -ne [string]$row.afterSha256) { throw "PORT_COPY_VERIFY_FAILED: $rel" }
}
$receiptData.status='SOURCE_FILES_APPLIED_NOT_RUNNING'
[IO.File]::WriteAllText($receipt,($receiptData | ConvertTo-Json -Depth 4),[Text.Encoding]::UTF8)
Write-Host "SOURCE_PORT_APPLIED_VERIFIED ($changeCount changes). No service, token or scheduled task touched."
