#Requires -Version 5.1
<#
Build the reviewed Dockerhost unified Rust graph gateway for native Windows.
Read-only preflight by default; -Apply compiles with the lockfile and stages
ONLY the project-owned binary. No service or scheduled task is changed.
#>
[CmdletBinding()]
param(
    [string]$StagedSource = '',
    [switch]$Apply
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'WINDOWS_ONLY' }
if (-not $StagedSource) { $StagedSource = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path }
$StagedSource = [IO.Path]::GetFullPath($StagedSource)
if (-not [IO.Path]::IsPathRooted($StagedSource) -or $StagedSource.StartsWith('\\')) { throw 'SOURCE_MUST_BE_LOCAL' }
$crate = Join-Path $StagedSource 'native\windows\unified-gateway-rust'
$manifest = Join-Path $crate 'Cargo.toml'
$lock = Join-Path $crate 'Cargo.lock'
$target = Join-Path (Split-Path -Parent $StagedSource) 'bin\unified-repoql-control.exe'
if (-not (Test-Path -LiteralPath $manifest -PathType Leaf) -or -not (Test-Path -LiteralPath $lock -PathType Leaf)) { throw 'RUST_SOURCE_OR_LOCK_MISSING' }
$source = Get-Item -LiteralPath $crate -Force
if ($source.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'REPARSE_SOURCE_REFUSED' }
$cargo = Get-Command cargo.exe -CommandType Application -ErrorAction SilentlyContinue
if (-not $cargo) { throw 'PINNED_WINDOWS_CARGO_REQUIRED' }
$details = [ordered]@{mode=($(if($Apply){'build'}else{'plan'}));crate=$crate;cargo=$cargo.Source;destination=$target;lockSha256=(Get-FileHash -LiteralPath $lock -Algorithm SHA256).Hash.ToLowerInvariant()}
if (-not $Apply) { $details | ConvertTo-Json; exit 0 }
Push-Location $crate
try {
    & $cargo.Source build --locked --release --bins
    if ($LASTEXITCODE -ne 0) { throw 'CARGO_LOCKED_RELEASE_BUILD_FAILED' }
} finally { Pop-Location }
$built = Join-Path $crate 'target\release\unified-repoql-control.exe'
if (-not (Test-Path -LiteralPath $built -PathType Leaf)) { throw 'RUST_BINARY_NOT_FOUND' }
$openBuilt=Join-Path $crate 'target\release\singularity_dashboard_open.exe'
$openTarget=Join-Path (Split-Path -Parent $target) 'singularity-dashboard-open.exe'
if (-not (Test-Path -LiteralPath $openBuilt -PathType Leaf)) { throw 'WINDOWLESS_DASHBOARD_OPENER_BINARY_MISSING' }
if (Test-Path -LiteralPath $openTarget -PathType Leaf) { throw 'EXISTING_OPENER_BINARY_REQUIRES_RECONCILIATION' }
$targetDir = Split-Path -Parent $target
if (-not (Test-Path -LiteralPath $targetDir -PathType Container)) { New-Item -ItemType Directory -Path $targetDir -Force | Out-Null }
if (Test-Path -LiteralPath $target -PathType Leaf) { throw 'EXISTING_GATEWAY_BINARY_REQUIRES_RECONCILIATION' }
Copy-Item -LiteralPath $built -Destination $target -ErrorAction Stop
$details.binarySha256=(Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
$details.binaryBytes=(Get-Item -LiteralPath $target).Length
# Stage the standalone Windows GUI opener into the same owned bin directory.
# This does not create an installer or register any task/shortcut.
Copy-Item -LiteralPath $openBuilt -Destination $openTarget -ErrorAction Stop
$details.openerExe=$openTarget
$details.openerSha256=(Get-FileHash -LiteralPath $openTarget -Algorithm SHA256).Hash.ToLowerInvariant()

$auditor=Join-Path $crate 'target\release\kanzo_board_audit.exe'
if (-not (Test-Path -LiteralPath $auditor -PathType Leaf)) { throw 'KANZO_NATIVE_AUDITOR_BINARY_MISSING' }
$details.kanzoAuditExe=$auditor
$details.kanzoAuditSha256=(Get-FileHash -LiteralPath $auditor -Algorithm SHA256).Hash.ToLowerInvariant()
$details | ConvertTo-Json
