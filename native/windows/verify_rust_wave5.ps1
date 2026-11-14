# Source-only Windows verification; never writes to services, registry or agent state.
# The native binary MUST pass independent differential tests before the switch
# can be considered for acceptance. Missing/reviewed locks block production use.
param([switch] $RequireReviewedLocks)
$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
foreach ($Executable in @('cargo','python','node')) {
    if (-not (Get-Command $Executable -ErrorAction SilentlyContinue)) { throw "$Executable is required for Rust validation" }
}
$Crates = @(
    'native/windows/memory-parity-rust',
    'native/windows/source-packager-rust',
    'native/windows/rc-stack-rust',
    'native/windows/release-evidence-rust'
)
$MissingLocks = @()
foreach ($Crate in $Crates) {
    $Manifest = Join-Path $Root (Join-Path $Crate 'Cargo.toml')
    $Lock = Join-Path $Root (Join-Path $Crate 'Cargo.lock')
    $LockedArgs = @()
    if (Test-Path $Lock) { $LockedArgs = @('--locked') }
    else { $MissingLocks += $Crate }
    & cargo fmt --manifest-path $Manifest --all -- --check
    if ($LASTEXITCODE -ne 0) { throw "Rust formatting failed: $Crate" }
    & cargo test --manifest-path $Manifest @LockedArgs
    if ($LASTEXITCODE -ne 0) { throw "Rust tests failed: $Crate" }
    & cargo clippy --manifest-path $Manifest @LockedArgs --all-targets -- -D warnings
    if ($LASTEXITCODE -ne 0) { throw "Rust Clippy failed: $Crate" }
    & cargo build --manifest-path $Manifest @LockedArgs --release
    if ($LASTEXITCODE -ne 0) { throw "Rust release build failed: $Crate" }
}
$Binary = Join-Path $Root 'native/windows/memory-parity-rust/target/release/singularity-memory-parity.exe'
if (-not (Test-Path $Binary)) { throw 'Compiled Rust memory policy binary is missing' }
$PolicyCrate = Join-Path $Root 'native/windows/memory-parity-rust'
foreach ($Suite in @('differential.py','differential_v2.py','differential_v3.py')) {
    $Script = Join-Path (Join-Path $PolicyCrate 'tests') $Suite
    # The reference runners independently disable the Rust switch.
    & python $Script --repo $Root --rust-cli $Binary
    if ($LASTEXITCODE -ne 0) { throw "Rust/JS differential mismatch: $Suite" }
}
$Previous = $env:SINGULARITY_RUST_MEMORY_POLICY_BIN
try {
    $env:SINGULARITY_RUST_MEMORY_POLICY_BIN = $Binary
    & node (Join-Path $PolicyCrate 'tests/native-runtime-smoke.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Actual Rust policy integration smoke test failed' }
} finally {
    $env:SINGULARITY_RUST_MEMORY_POLICY_BIN = $Previous
}
$env:SINGULARITY_RUST_MEMORY_POLICY_BIN = $null
try {
    & node --test (Join-Path $Root 'harness/kit/tests/native-memory-policy.test.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'JS-native boundary tests failed' }
    & node (Join-Path $Root 'harness/kit/v46-memory-retrieval-truth-test.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Memory retrieval regressions failed' }
} finally {
    $env:SINGULARITY_RUST_MEMORY_POLICY_BIN = $Previous
}
if ($MissingLocks.Count) {
    Write-Warning ('Cargo.lock missing or unreviewed for: ' + ($MissingLocks -join ', '))
    if ($RequireReviewedLocks) { throw 'Release acceptance requires reviewed Cargo.lock for every migrated crate' }
}
Write-Host 'RUST_WAVE5_SOURCE_PARITY_CHECKS_PASSED'
Write-Host 'This does not authorize a live service switch or establish Kanzo, Tencent or Windows deployment parity.'
