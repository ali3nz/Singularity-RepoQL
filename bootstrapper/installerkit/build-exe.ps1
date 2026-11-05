#Requires -Version 5.1
<#
Build a real WiX Burn Setup.exe around the source-verified Windows MSI.
The build requires a Windows x64 MSVC toolchain and is never a claim that
Tencent/RepoQL/Kanzo/Claude native runtime acceptance has passed.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$SourceZip,
    [Parameter(Mandatory=$true)][string]$BuildRoot,
    [Parameter(Mandatory=$true)][string]$OutputDirectory,
    [switch]$SkipRustTests
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or -not [Environment]::Is64BitOperatingSystem) { throw 'WINDOWS_X64_REQUIRED' }
$BuildRoot=[IO.Path]::GetFullPath($BuildRoot)
$OutputDirectory=[IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $BuildRoot) { throw 'BUILD_ROOT_MUST_BE_NEW' }
$exe=Join-Path $OutputDirectory 'Singularity-RepoQL-Setup-x64.exe'
if (Test-Path -LiteralPath $exe) { throw 'SETUP_EXE_ALREADY_EXISTS' }
$msiBuilder=Join-Path $PSScriptRoot 'build-msi.ps1'
$bundle=Join-Path $PSScriptRoot 'SingularityRepoQLBundle.wxs'
if (-not (Test-Path -LiteralPath $msiBuilder -PathType Leaf) -or -not (Test-Path -LiteralPath $bundle -PathType Leaf)) { throw 'INSTALLER_SOURCE_MISSING' }
$msiRoot=Join-Path $BuildRoot 'msi-build'
# The existing MSI builder creates a new build root. The parent must be new.
New-Item -ItemType Directory -Path $BuildRoot -ErrorAction Stop | Out-Null
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$msiArgs=@('-NoProfile','-ExecutionPolicy','Bypass','-File',$msiBuilder,
    '-SourceZip',$SourceZip,'-BuildRoot',$msiRoot,'-OutputDirectory',$OutputDirectory)
if ($SkipRustTests) { $msiArgs+= '-SkipRustTests' }
& powershell.exe @msiArgs
if ($LASTEXITCODE -ne 0) { throw 'PINNED_MSI_BUILD_FAILED' }
$msi=Join-Path $OutputDirectory 'Singularity-RepoQL-Windows-Preview-x64.msi'
if (-not (Test-Path -LiteralPath $msi -PathType Leaf)) { throw 'BUILT_MSI_MISSING' }
$dotnet=Get-Command dotnet.exe -ErrorAction Stop
$tools=Join-Path $BuildRoot 'wix-tools'
New-Item -ItemType Directory -Path $tools -ErrorAction Stop | Out-Null
& $dotnet.Source tool install wix --tool-path $tools --version '6.0.2'
if ($LASTEXITCODE -ne 0) { throw 'WIX6_INSTALL_FAILED' }
$wix=Join-Path $tools 'wix.exe'
if (-not (Test-Path -LiteralPath $wix -PathType Leaf)) { throw 'WIX_EXE_MISSING' }
# Pin the matching v6 bootstrapper extension. The extension cache is shared
# for the current build user, not for application runtime configuration.
& $wix extension add 'WixToolset.BootstrapperApplications.wixext/6.0.2'
if ($LASTEXITCODE -ne 0) { throw 'WIX_BOOTSTRAPPER_EXTENSION_UNAVAILABLE' }
& $wix build -arch x64 -ext WixToolset.BootstrapperApplications.wixext `
    -bindpath ('Msi='+$OutputDirectory) -out $exe $bundle
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'BURN_EXE_BUILD_FAILED' }
$receipt=[ordered]@{
    schema='singularity-windows-setup-build/1'
    setup_filename=(Split-Path -Leaf $exe)
    setup_sha256=(Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash
    msi_sha256=(Get-FileHash -LiteralPath $msi -Algorithm SHA256).Hash
    source_sha256=(Get-FileHash -LiteralPath $SourceZip -Algorithm SHA256).Hash
    wix_version='6.0.2'
    rust_tests_skipped=[bool]$SkipRustTests
    windows_install_uninstall_tested=$false
    tencent_dashboard_live_tested=$false
    release_accepted=$false
}
$receipt | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $OutputDirectory 'SETUP-BUILD-RECEIPT.json') -Encoding UTF8
$receipt | ConvertTo-Json -Depth 5
