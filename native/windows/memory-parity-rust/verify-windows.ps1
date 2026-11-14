# Read-only validation of the staged Rust policy crate on Windows.
# This does not edit installed services, source authority, or GitHub.
$ErrorActionPreference = 'Stop'
$crate = $PSScriptRoot
$repo = (Resolve-Path (Join-Path $crate '../../..')).Path
$manifest = Join-Path $crate 'Cargo.toml'
$binary = Join-Path $crate 'target/release/singularity-memory-parity.exe'
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) { throw 'Rust Cargo toolchain is required' }
if (-not (Get-Command python -ErrorAction SilentlyContinue)) { throw 'Python is required for differential fixtures' }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js is required for reference fixtures' }
& cargo fmt --manifest-path $manifest -- --check
if ($LASTEXITCODE -ne 0) { throw 'cargo fmt failed' }
& cargo test --manifest-path $manifest
if ($LASTEXITCODE -ne 0) { throw 'cargo test failed' }
& cargo clippy --manifest-path $manifest --all-targets -- -D warnings
if ($LASTEXITCODE -ne 0) { throw 'cargo clippy failed' }
& cargo build --release --manifest-path $manifest
if ($LASTEXITCODE -ne 0) { throw 'cargo build failed' }
& python (Join-Path $crate 'tests/differential.py') --repo $repo --rust-cli $binary
if ($LASTEXITCODE -ne 0) { throw 'first differential suite failed' }
& python (Join-Path $crate 'tests/differential_v2.py') --repo $repo --rust-cli $binary
if ($LASTEXITCODE -ne 0) { throw 'second differential suite failed' }
& python (Join-Path $crate 'tests/differential_conflict.py') --repo $repo --rust-cli $binary
if ($LASTEXITCODE -ne 0) { throw 'memory conflict differential failed' }
Write-Output 'RUST_POLICY_SOURCE_PARITY_CHECKS_PASSED (native Windows service acceptance still required)'
