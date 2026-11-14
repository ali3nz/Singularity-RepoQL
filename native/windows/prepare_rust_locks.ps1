# Source-only Rust dependency preparation for the Windows engineer.
# Generate lockfiles only in an ISOLATED checkout, after an explicit switch.
# No application/service installation, network policy, live memory or runtime change.
param([switch]$GenerateMissing)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$Root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$Crates = @(
    'harness/rust-authority',
    'native/desktop-bridge',
    'native/windows/rust-supervisor',
    'native/windows/unified-gateway-rust',
    'native/windows/memory-parity-rust',
    'native/windows/rc-stack-rust',
    'native/windows/source-packager-rust',
    'native/windows/release-evidence-rust'
)
if ($GenerateMissing -and -not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    throw 'Cargo is needed to generate actual dependency resolution. Never hand-author Cargo.lock.'
}
if (-not (Get-Command python -ErrorAction SilentlyContinue)) { throw 'Python 3.11+ is required' }
foreach ($relative in $Crates) {
    $manifest = Join-Path $Root (Join-Path $relative 'Cargo.toml')
    $lock = Join-Path $Root (Join-Path $relative 'Cargo.lock')
    if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) { throw "Manifest missing: $manifest" }
    if (-not (Test-Path -LiteralPath $lock -PathType Leaf)) {
        if (-not $GenerateMissing) {
            Write-Host "LOCK_REQUIRED $relative"
            continue
        }
        Write-Host "Generating previously missing lockfile in isolated source: $relative"
        & cargo generate-lockfile --manifest-path $manifest
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $lock -PathType Leaf)) {
            throw "Cargo did not produce a lockfile for $relative"
        }
        Write-Host "UNREVIEWED_NEW_LOCKFILE $relative"
    }
    Write-Host "LOCK_HASH $relative $((Get-FileHash -LiteralPath $lock -Algorithm SHA256).Hash)"
}
& python (Join-Path $PSScriptRoot 'check_rust_lock_provenance.py') --source-root $Root
if ($LASTEXITCODE -ne 0) { throw 'Dependency lock gate remains blocked' }
Write-Host 'ALL_LOCKS_STRUCTURALLY_VALID: Dependency sources, versions, licenses and hashes still require independent human review.'
Write-Host 'No Rust binary, Windows memory service or installed application has been changed.'
