#Requires -Version 5.1
<#
Build a Windows MSI *payload* from the reviewed Singularity RepoQL v3 source.
Requires Windows x64, Rust/MSVC, Python 3, and dotnet. Builds under a new
operator-selected temporary directory, never changes the installed product.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$SourceZip,
    [Parameter(Mandatory = $true)][string]$BuildRoot,
    [string]$OutputDirectory = '',
    [string]$WxsFile = '',
    [string]$MsiFileName = 'Singularity-RepoQL-Windows-Preview-x64.msi',
    [switch]$SkipRustTests
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'NATIVE_WINDOWS_REQUIRED' }
if (-not [Environment]::Is64BitOperatingSystem) { throw 'WINDOWS_X64_REQUIRED' }
$here = Split-Path -Parent $PSCommandPath
# Optional package identity override. The default keeps the reviewed production
# WXS byte-identical; the Fleet861 RC lane passes -WxsFile/-MsiFileName so its
# package carries a separate UpgradeCode, install directory and file name while
# still using this single MSI build pipeline.
$wxs = if ($WxsFile) { [IO.Path]::GetFullPath($WxsFile) } else { Join-Path $here 'SingularityRepoQL.wxs' }
if (-not (Test-Path -LiteralPath $wxs -PathType Leaf)) { throw 'WXS_SOURCE_MISSING' }
if (-not $MsiFileName -or $MsiFileName -match '[\\/:*?"<>|]' -or -not $MsiFileName.EndsWith('.msi', [StringComparison]::OrdinalIgnoreCase)) { throw 'MSI_FILE_NAME_INVALID' }
$SourceZip = [IO.Path]::GetFullPath($SourceZip)
$BuildRoot = [IO.Path]::GetFullPath($BuildRoot)
if (-not (Test-Path -LiteralPath $SourceZip -PathType Leaf)) { throw 'SOURCE_ZIP_MISSING' }
if (Test-Path -LiteralPath $BuildRoot) { throw 'BUILD_ROOT_MUST_BE_NEW' }
if (-not $OutputDirectory) { $OutputDirectory = Split-Path -Parent $BuildRoot }
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
if ($BuildRoot.StartsWith('\\') -or $SourceZip.StartsWith('\\') -or $OutputDirectory.StartsWith('\\')) { throw 'LOCAL_FILES_REQUIRED' }
if ($OutputDirectory.Equals($BuildRoot, [StringComparison]::OrdinalIgnoreCase) -or $OutputDirectory.StartsWith($BuildRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'OUTPUT_MUST_NOT_BE_INSIDE_BUILD_ROOT' }
# Pinned to the locally generated variant-2 archive from
# native/windows/build_source_variants.py at rc-fleet893. The previous
# pin (E8392BA8...) was the 2026-11-05 snapshot, which predated the branch
# and shipped a payload without its dashboard, memory or MCP work.
$expectedSourceHash = '2AF31D675BED6BA80F0A7A851B7A239DD0BD3E407ED624986A8A842DB93BFA47'
$sourceHash = (Get-FileHash -LiteralPath $SourceZip -Algorithm SHA256).Hash
if ($sourceHash -ne $expectedSourceHash) { throw 'UNEXPECTED_SOURCE_ARCHIVE_HASH' }
$py = Get-Command py.exe -ErrorAction SilentlyContinue
if (-not $py) { throw 'PYTHON_LAUNCHER_REQUIRED' }
$cargo = Get-Command cargo.exe -ErrorAction SilentlyContinue
if (-not $cargo) { throw 'CARGO_REQUIRED' }
$dotnet = Get-Command dotnet.exe -ErrorAction SilentlyContinue
if (-not $dotnet) { throw 'DOTNET_SDK_REQUIRED' }
$rustc = Get-Command rustc.exe -ErrorAction SilentlyContinue
if (-not $rustc) { throw 'RUSTC_REQUIRED' }
$hostTriple = (& $rustc.Source -vV | Select-String '^host:\s*(.+)$').Matches.Groups[1].Value
if ($hostTriple -ne 'x86_64-pc-windows-msvc') { throw ('WINDOWS_MSVC_TOOLCHAIN_REQUIRED: ' + $hostTriple) }
New-Item -ItemType Directory -Path $BuildRoot | Out-Null
$sourceRoot = Join-Path $BuildRoot 'source'
$payload = Join-Path $BuildRoot 'payload'
$tools = Join-Path $BuildRoot 'tools'
$release = Join-Path $OutputDirectory $MsiFileName
try {
    Expand-Archive -LiteralPath $SourceZip -DestinationPath $sourceRoot -ErrorAction Stop
    # Do not run extracted scripts before validating the complete archive hash.
    $expected = @(
      @{Manifest='native/desktop-bridge/Cargo.toml'; Exe='native/desktop-bridge/target/release/singularity-desktop-bridge.exe'},
      @{Manifest='native/windows/rust-supervisor/Cargo.toml'; Exe='native/windows/rust-supervisor/target/release/singularity-windows-supervisor.exe'},
      @{Manifest='native/windows/unified-gateway-rust/Cargo.toml'; Exe='native/windows/unified-gateway-rust/target/release/unified-repoql-control.exe'}
    )
    $manifests = @($expected | ForEach-Object { Join-Path $sourceRoot $_.Manifest })
    foreach ($manifest in $manifests) {
        if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) { throw ('MISSING_CARGO_MANIFEST: ' + $manifest) }
    }
    & $py.Source -3 (Join-Path $sourceRoot 'native/windows/check_rust_lock_provenance.py')
    if ($LASTEXITCODE -ne 0) { throw 'CARGO_LOCK_PROVENANCE_FAILED' }
    if (-not $SkipRustTests) {
        foreach ($manifest in $manifests) {
            & $cargo.Source test --manifest-path $manifest --locked --all-targets
            if ($LASTEXITCODE -ne 0) { throw ('RUST_TESTS_FAILED: ' + $manifest) }
        }
    }
    & $cargo.Source build --manifest-path $manifests[0] --locked --release --no-default-features --features office,ghost
    if ($LASTEXITCODE -ne 0) { throw 'DESKTOP_BRIDGE_BUILD_FAILED' }
    foreach ($manifest in @($manifests[1], $manifests[2])) {
        & $cargo.Source build --manifest-path $manifest --locked --release --bins
        if ($LASTEXITCODE -ne 0) { throw ('RUST_RELEASE_BUILD_FAILED: ' + $manifest) }
    }
    $bridge = Join-Path $sourceRoot $expected[0].Exe
    $supervisor = Join-Path $sourceRoot $expected[1].Exe
    $gateway = Join-Path $sourceRoot $expected[2].Exe
    $auditor = Join-Path $sourceRoot 'native/windows/unified-gateway-rust/target/release/kanzo_board_audit.exe'
    & $py.Source -3 (Join-Path $here 'prepare_msi_payload.py') --source-zip $SourceZip --output $payload --bridge $bridge --supervisor $supervisor --gateway $gateway --kanzo-audit $auditor
    if ($LASTEXITCODE -ne 0) { throw 'PAYLOAD_PREPARATION_FAILED' }
    New-Item -ItemType Directory -Path $tools | Out-Null
    & $dotnet.Source tool install wix --tool-path $tools --version 6.0.2
    if ($LASTEXITCODE -ne 0) { throw 'PINNED_WIX_TOOL_INSTALL_FAILED' }
    $wix = Join-Path $tools 'wix.exe'
    if (-not (Test-Path -LiteralPath $wix -PathType Leaf)) { throw 'WIX_EXE_MISSING' }
    if (-not (Test-Path -LiteralPath $OutputDirectory -PathType Container)) { New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null }
    if (Test-Path -LiteralPath $release) { throw 'OUTPUT_MSI_ALREADY_EXISTS' }
    & $wix build -arch x64 -bindpath ('Payload=' + $payload) -out $release $wxs
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $release -PathType Leaf)) { throw 'MSI_BUILD_FAILED' }
    # A self-contained distribution: the package must carry its own CAB. An
    # external cab1.cab beside the MSI means the package cannot be installed
    # from a folder holding only the MSI, which is how it is distributed.
    $strayCab = @(Get-ChildItem -LiteralPath $OutputDirectory -Filter '*.cab' -File -ErrorAction SilentlyContinue)
    if ($strayCab.Count -gt 0) { throw ('EXTERNAL_MEDIA_EMITTED: ' + ($strayCab.Name -join ',')) }
    $receipt = [ordered]@{
        schema = 'singularity-msi-build/2'
        msi = $release
        wxs_source = $wxs
        msi_sha256 = (Get-FileHash -LiteralPath $release -Algorithm SHA256).Hash
        source_zip_sha256 = $sourceHash
        msi_bytes = (Get-Item -LiteralPath $release).Length
        media = 'embedded-cab'
        distribution_files = @((Split-Path -Leaf $release))
        distribution_sha256 = @{ (Split-Path -Leaf $release) = (Get-FileHash -LiteralPath $release -Algorithm SHA256).Hash }
        windows_msvc_host = $hostTriple
        rust_tests_skipped = [bool]$SkipRustTests
        native_host_install_tested = $false
        product_runtime_accepted = $false
    }
    $receiptPath = Join-Path $OutputDirectory 'Singularity-RepoQL-MSI-BUILD-RECEIPT.json'
    $receipt | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $receiptPath -Encoding UTF8
    $receipt | ConvertTo-Json -Depth 4
    exit 0
}
catch {
    Write-Error ('MSI_BUILD_FAILED: ' + $_.Exception.Message)
    exit 1
}
