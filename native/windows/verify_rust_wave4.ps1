# Read-only validation of Rust Wave 4 release evidence ports on native Windows.
# Does not install, stop, restart, or modify any services or orchestration settings.
$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$Crate = Join-Path $PSScriptRoot 'release-evidence-rust'
$Manifest = Join-Path $Crate 'Cargo.toml'
$Lock = Join-Path $Crate 'Cargo.lock'
$Binary = Join-Path $Crate 'target/release/singularity-release-evidence.exe'
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) { throw 'Cargo is not available on this machine' }
if (-not (Get-Command python -ErrorAction SilentlyContinue)) { throw 'Python is required for the reference differential comparisons' }
$Locked = Test-Path $Lock
if (-not $Locked) { Write-Warning 'Cargo.lock absent. Test build may generate one. Release provenance is NOT approved.' }
& cargo fmt --manifest-path $Manifest --all -- --check
if ($LASTEXITCODE -ne 0) { throw 'Wave 4 Rust formatting failed' }
if ($Locked) {
    & cargo test --manifest-path $Manifest --locked
} else {
    & cargo test --manifest-path $Manifest
}
if ($LASTEXITCODE -ne 0) { throw 'Wave 4 Rust tests failed' }
if ($Locked) {
    & cargo clippy --manifest-path $Manifest --locked --all-targets -- -D warnings
} else {
    & cargo clippy --manifest-path $Manifest --all-targets -- -D warnings
}
if ($LASTEXITCODE -ne 0) { throw 'Wave 4 Rust Clippy failed' }
if ($Locked) {
    & cargo build --manifest-path $Manifest --locked --release
} else {
    & cargo build --manifest-path $Manifest --release
}
if ($LASTEXITCODE -ne 0) { throw 'Wave 4 Rust release build failed' }
if (-not (Test-Path $Binary)) { throw 'Wave 4 Rust binary not found' }
& python (Join-Path $Crate 'tests/differential.py') --repo $Root --rust-cli $Binary
if ($LASTEXITCODE -ne 0) { throw 'Wave 4 Rust versus Python differential testing failed' }
Write-Host 'Wave 4 Rust local compilation, tests, and differential comparisons passed.'
if (-not $Locked) { Write-Warning 'Release remains BLOCKED until Cargo.lock has been independently reviewed and committed.' }
Write-Host 'This does NOT establish deployment, GUI, connector, Kanzo, Tencent or runtime parity.'
