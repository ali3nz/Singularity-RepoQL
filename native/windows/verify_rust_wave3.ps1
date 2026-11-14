# Read-only source verification and isolated ZIP construction.
# No runtime, registry, service or production data changes.
$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$Crates = @('native/windows/memory-parity-rust', 'native/windows/source-packager-rust', 'native/windows/rc-stack-rust')
foreach ($Crate in $Crates) {
    $Manifest = Join-Path $Root (Join-Path $Crate 'Cargo.toml')
    & cargo fmt --manifest-path $Manifest --all -- --check
    if ($LASTEXITCODE -ne 0) { throw "Rust fmt failed: $Crate" }
    & cargo test --manifest-path $Manifest
    if ($LASTEXITCODE -ne 0) { throw "Rust test failed: $Crate" }
    & cargo clippy --manifest-path $Manifest --all-targets -- -D warnings
    if ($LASTEXITCODE -ne 0) { throw "Rust clippy failed: $Crate" }
    & cargo build --manifest-path $Manifest --release
    if ($LASTEXITCODE -ne 0) { throw "Rust release build failed: $Crate" }
}
$Packager = Join-Path $Root 'native/windows/source-packager-rust/target/release/singularity-source-packager.exe'
if (-not (Test-Path $Packager)) { throw 'Rust source packager executable not found' }
$Scratch = Join-Path ([System.IO.Path]::GetTempPath()) ('singularity-rust-parity-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $Scratch | Out-Null
$NativeDir = Join-Path $Scratch 'rust'
$LegacyDir = Join-Path $Scratch 'legacy'
New-Item -ItemType Directory -Path $NativeDir,$LegacyDir | Out-Null
& $Packager build $Root $NativeDir
if ($LASTEXITCODE -ne 0) { throw 'Native Rust ZIP builder failed' }
$Zips = @(Get-ChildItem $NativeDir -Filter '*.zip' | Select-Object -ExpandProperty FullName)
if ($Zips.Count -ne 4) { throw 'Expected exactly four Rust source ZIPs' }
& $Packager scan @Zips
if ($LASTEXITCODE -ne 0) { throw 'Native Rust ZIP scan failed' }
& python (Join-Path $Root 'native/windows/build_source_variants.py') --output-dir $LegacyDir
if ($LASTEXITCODE -ne 0) { throw 'Legacy source ZIP builder failed' }
foreach ($Variant in 1..4) {
    $Name = "singularity-native-windows-option$Variant-SOURCE-ONLY.zip"
    & python (Join-Path $Root 'native/windows/source-packager-rust/tests/compare_legacy_release.py') (Join-Path $LegacyDir $Name) (Join-Path $NativeDir $Name)
    if ($LASTEXITCODE -ne 0) { throw "Rust/legacy package parity failed for variant $Variant" }
}
Write-Host "Rust builds, source packaging and legacy parity passed. Isolated artifacts: $Scratch"
Write-Host 'Native runtime, Kanzo, Tencent MemoryCore and installer acceptance NOT RUN.'
