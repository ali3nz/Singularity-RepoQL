#Requires -Version 5.1
<#
Read-only pre-install gate for the Fleet861 release candidate.

It proves, before any MSI runs, that the RC package is side-by-side with the
live product: separate MSI/Burn identity, separate per-user install directory
(%LOCALAPPDATA%\Singularity\Fleet861RC, never C:\Program Files, no elevation),
separate state root, separate loopback port, and an untouched production task
set.
It installs nothing, stops nothing and only writes its JSON receipt if
-ReceiptPath is given. Exit 0 = isolation demonstrated; exit 1 = do not install.
#>
[CmdletBinding()]
param(
    [string]$InstallerDir = "",
    [string]$InstallRoot = "",
    [string]$StateRoot = "",
    [int]$Port = 18200,
    [string]$ReceiptPath = ""
)
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# $PSScriptRoot is not reliably populated inside a param default block.
if (-not $InstallerDir) {
    $InstallerDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
}
if (-not $InstallerDir -or -not (Test-Path -LiteralPath $InstallerDir -PathType Container)) { throw "INSTALLER_DIR_UNRESOLVED" }

# Non-login SSH sessions can arrive without ProgramFiles/LOCALAPPDATA.
$programFiles = if ($env:ProgramFiles) { $env:ProgramFiles } elseif ($env:ProgramW6432) { $env:ProgramW6432 } else { "C:\Program Files" }
$localAppData = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } elseif ($env:USERPROFILE) { Join-Path $env:USERPROFILE "AppData\Local" } else { "" }
if (-not $localAppData) { throw "LOCALAPPDATA_UNRESOLVED" }
if (-not $InstallRoot) { $InstallRoot = Join-Path $localAppData "Singularity\Fleet861RC" }
if (-not $StateRoot) { $StateRoot = Join-Path $localAppData "Singularity\Fleet861RC\state" }

$checks = [ordered]@{}
function Add-Check([string]$name, [bool]$ok, [string]$detail) {
    $script:checks[$name] = [ordered]@{ ok = $ok; detail = $detail }
}

$productionInstall = Join-Path $programFiles "Singularity RepoQL"
$productionState = Join-Path $localAppData "Singularity\WindowsNative"

# 1. Package identities must differ from the production package.
$prodMsi = Join-Path $InstallerDir "SingularityRepoQL.wxs"
$rcMsi = Join-Path $InstallerDir "SingularityRepoQLRC.wxs"
$prodBundle = Join-Path $InstallerDir "SingularityRepoQLBundle.wxs"
$rcBundle = Join-Path $InstallerDir "SingularityRepoQLRCBundle.wxs"
$missingSources = @()
foreach ($f in @($prodMsi, $rcMsi, $prodBundle, $rcBundle)) {
    if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { $missingSources += $f }
}
Add-Check "package_sources_present" ($missingSources.Count -eq 0) ("missing=" + ($missingSources -join ";"))
if ($missingSources.Count -eq 0) {
    $prodMsiDoc = ([xml](Get-Content -LiteralPath $prodMsi -Raw)).Wix.Package
    $rcMsiDoc = ([xml](Get-Content -LiteralPath $rcMsi -Raw)).Wix.Package
    $prodBundleDoc = ([xml](Get-Content -LiteralPath $prodBundle -Raw)).Wix.Bundle
    $rcBundleDoc = ([xml](Get-Content -LiteralPath $rcBundle -Raw)).Wix.Bundle
    $prodUpgrade = [string]$prodMsiDoc.UpgradeCode
    $rcUpgrade = [string]$rcMsiDoc.UpgradeCode
    Add-Check "msi_upgradecode_distinct" ($prodUpgrade -ne $rcUpgrade) ("production=" + $prodUpgrade + " rc=" + $rcUpgrade)
    $rcProduct = [string]$rcMsiDoc.ProductCode
    Add-Check "msi_productcode_pinned" ($rcProduct -match "^[0-9A-Fa-f]{8}-([0-9A-Fa-f]{4}-){3}[0-9A-Fa-f]{12}$") ("rc_productcode=" + $rcProduct)
    $prodDirName = [string]$prodMsiDoc.StandardDirectory.Directory.Name
    $rcDirName = [string]$rcMsiDoc.StandardDirectory.Directory.Name
    Add-Check "msi_install_dir_name_distinct" ($prodDirName -ne $rcDirName) ("production=" + $prodDirName + " rc=" + $rcDirName)
    Add-Check "bundle_upgradecode_distinct" (([string]$prodBundleDoc.UpgradeCode) -ne ([string]$rcBundleDoc.UpgradeCode)) ("production=" + [string]$prodBundleDoc.UpgradeCode + " rc=" + [string]$rcBundleDoc.UpgradeCode)
    $rcScope = [string]$rcMsiDoc.Scope
    Add-Check "rc_package_scope_per_user" ($rcScope -eq "perUser") ("rc_scope=" + $rcScope + " production_scope=" + [string]$prodMsiDoc.Scope)
    $rcStdDir = [string]$rcMsiDoc.StandardDirectory.Id
    Add-Check "rc_install_root_under_localappdata" (($rcStdDir -eq "LocalAppDataFolder") -and $InstallRoot.StartsWith($localAppData + "\", [StringComparison]::OrdinalIgnoreCase)) ("standard_directory=" + $rcStdDir + " install_root=" + $InstallRoot)
    $rcLaunch = [string]$rcBundleDoc.BootstrapperApplication.WixStandardBootstrapperApplication.LaunchTarget
    Add-Check "rc_bundle_launch_is_readonly_probe" ($rcLaunch -like "*]Singularity\Fleet861RC\Readiness.ps1") ("launchtarget=" + $rcLaunch)
}

# 2. The RC must not own or target the live product directories.
# Director decision 2026-11-05: the RC stays per-user under %LOCALAPPDATA%; it is
# never installed to C:\Program Files, so no elevation is requested and no
# per-machine component can collide with a real installation product.
Add-Check "rc_install_root_not_under_program_files" (-not $InstallRoot.StartsWith($programFiles + "\", [StringComparison]::OrdinalIgnoreCase)) ("install_root=" + $InstallRoot + " program_files=" + $programFiles)
Add-Check "rc_install_root_disjoint_from_live_roots" (($InstallRoot -ne $productionInstall) -and ($InstallRoot -ne $productionState) -and (-not $InstallRoot.StartsWith($productionState + "\", [StringComparison]::OrdinalIgnoreCase)) -and (-not $productionInstall.StartsWith($InstallRoot + "\", [StringComparison]::OrdinalIgnoreCase))) ("rc=" + $InstallRoot + " prod_install=" + $productionInstall + " live_state=" + $productionState)
Add-Check "rc_state_root_absent" (-not (Test-Path -LiteralPath $StateRoot)) $StateRoot
$nested = $StateRoot.StartsWith($productionState + "\", [StringComparison]::OrdinalIgnoreCase) -or
          $productionState.StartsWith($StateRoot + "\", [StringComparison]::OrdinalIgnoreCase) -or
          $StateRoot.Equals($productionState, [StringComparison]::OrdinalIgnoreCase)
Add-Check "rc_state_root_disjoint_from_live_state" (-not $nested) ("rc=" + $StateRoot + " live=" + $productionState)
Add-Check "live_install_present_untouched" (Test-Path -LiteralPath $productionState) $productionState
Add-Check "production_install_dir_untouched" ((Test-Path -LiteralPath $productionInstall) -eq $false -or $productionInstall -ne $InstallRoot) ("production=" + $productionInstall)

# 3. The RC loopback port must be free and must not be a production port.
$productionPorts = @(18100, 18101, 18128)
Add-Check "rc_port_not_a_production_port" (-not ($productionPorts -contains $Port)) ("port=" + $Port + " production=" + ($productionPorts -join ","))
# Occupancy is decided by connecting, not by the socket table. After a process
# exits, Windows can still list a LISTENING row for the port with owning pid 0;
# Get-NetTCPConnection reported one here for a port that refused every
# connection, which failed the gate for an install that was actually safe.
$portClient = $null
$portListening = $false
try {
    $portClient = New-Object System.Net.Sockets.TcpClient
    $portConnect = $portClient.BeginConnect('127.0.0.1', $Port, $null, $null)
    if ($portConnect.AsyncWaitHandle.WaitOne(700)) {
        $portClient.EndConnect($portConnect)
        $portListening = $true
    }
} catch {
    $portListening = $false
} finally {
    if ($null -ne $portClient) { $portClient.Close() }
}
Add-Check "rc_port_free" (-not $portListening) ("port=" + $Port + " listening=" + $portListening)

# 4. No ARP product for the RC yet.
$arpKeys = @(
    "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*"
)
$arp = @(Get-ItemProperty $arpKeys -ErrorAction SilentlyContinue | Where-Object { $_.PSObject.Properties['DisplayName'] -and $_.DisplayName })
$rcArp = @($arp | Where-Object { $_.PSObject.Properties['DisplayName'] -and $_.DisplayName -like "*Fleet861*" })
Add-Check "rc_not_already_in_arp" ($rcArp.Count -eq 0) ("Fleet861 ARP entries=" + $rcArp.Count)

# 5. The seven live scheduled tasks must still exist.
$liveTasks = @(
    "Singularity-ClaudeComplete-Dashboard", "Singularity-ClaudeComplete-Office",
    "Singularity-Ghost-Scheduler", "Singularity-Kanzo", "Singularity-RepoQL-Host",
    "Singularity-Rust-Native-Supervisor", "Singularity-Windows-Unified-Gateway"
)
$present = @()
$missingTasks = @()
foreach ($name in $liveTasks) {
    $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if ($task) { $present += $name } else { $missingTasks += $name }
}
Add-Check "live_tasks_present" ($missingTasks.Count -eq 0) ("present=" + $present.Count + "/" + $liveTasks.Count + " missing=" + ($missingTasks -join ","))

$failed = @($checks.Keys | Where-Object { -not $checks[$_].ok })
$report = [ordered]@{
    schema        = "singularity-rc-isolation/1"
    checked_at    = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    host          = $env:COMPUTERNAME
    installer_dir = $InstallerDir
    install_root  = $InstallRoot
    state_root    = $StateRoot
    port          = $Port
    checks        = $checks
    failed        = $failed
    isolation_ok  = ($failed.Count -eq 0)
    installer_run = $false
}
$json = $report | ConvertTo-Json -Depth 6
if ($ReceiptPath) { Set-Content -LiteralPath $ReceiptPath -Value $json -Encoding UTF8 }
$json
if ($failed.Count -eq 0) { exit 0 } else { exit 1 }
