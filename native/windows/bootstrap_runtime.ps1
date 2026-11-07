#Requires -Version 5.1
<#
Plan-first runtime bootstrap for the native Windows option-2 install.
Plan (default) only resolves and reports. -Apply installs the pinned runtime
pieces this project owns (Node, the Ghost runner, RepoQL) with SHA256 or exact
version checks, then optionally calls manage_native_windows.ps1 Install with
every path it resolved. It never installs an unpinned Python; it resolves an
existing 3.12/3.13 interpreter and fails closed otherwise.
#>
[CmdletBinding()]
param(
  [switch]$Apply,
  [string]$SourceRoot='',
  [string]$InstallRoot='',
  [string]$BridgeExe='',
  [string]$SupervisorExe='',
  [string]$Python312Exe='',
  [string]$Python313Exe='',
  [string]$RepoqlExe='',
  [string]$RunnerExe='',
  [string]$Workspace='',
  [string]$SupervisorConfig='',
  [string]$OfficeSource='',
  [string]$OfficeWheelhouse='',
  [switch]$OfficeAllowNetwork,
  [switch]$InstallProduct,
  [switch]$ProvisionConnectors
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'NATIVE_WINDOWS_REQUIRED' }
if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA_REQUIRED' }
$scriptDir=$PSScriptRoot
$pinsPath=Join-Path $scriptDir 'runtime-pins.json'
if (-not (Test-Path -LiteralPath $pinsPath -PathType Leaf)) { throw 'RUNTIME_PINS_MISSING' }
$pins=Get-Content -LiteralPath $pinsPath -Raw | ConvertFrom-Json
$runtimeRoot=Join-Path $env:LOCALAPPDATA 'Singularity\runtime'
$changes=New-Object System.Collections.ArrayList
$missing=New-Object System.Collections.ArrayList

function Get-VersionText([string]$Exe,[string[]]$Arguments) {
  try { return (@(& $Exe @Arguments 2>&1) -join ' ').Trim() } catch { return '' }
}
function Test-FileSha([string]$Path,[string]$Expected) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
  return ((Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() -eq $Expected.ToLowerInvariant())
}
function Resolve-Node {
  $dir=Join-Path $runtimeRoot ('node-v' + $pins.node.version)
  $exe=Join-Path $dir 'node.exe'
  if (Test-Path -LiteralPath $exe -PathType Leaf) {
    $v=(Get-VersionText $exe @('--version'))
    if ($v -eq ('v' + $pins.node.version)) { return [ordered]@{state='present'; path=$exe; version=$v} }
  }
  $onPath=Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue
  if ($onPath) {
    $v=(Get-VersionText $onPath.Source @('--version'))
    if ($v -eq ('v' + $pins.node.version)) { return [ordered]@{state='present_on_path'; path=$onPath.Source; version=$v} }
  }
  if (-not $Apply) { return [ordered]@{state='missing'; wouldInstall=(Join-Path $dir 'node.exe'); url=$pins.node.url} }
  New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
  $zip=Join-Path $runtimeRoot ('node-v' + $pins.node.version + '-win-x64.zip')
  if (-not (Test-Path -LiteralPath $zip -PathType Leaf)) {
    $ProgressPreference='SilentlyContinue'
    Invoke-WebRequest -Uri $pins.node.url -OutFile $zip -UseBasicParsing -TimeoutSec 600
  }
  if (-not (Test-FileSha $zip $pins.node.sha256)) { throw 'NODE_ZIP_SHA256_MISMATCH' }
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
  Expand-Archive -LiteralPath $zip -DestinationPath $dir -Force
  $inner=Join-Path $dir ('node-v' + $pins.node.version + '-win-x64')
  if (Test-Path -LiteralPath $inner -PathType Container) {
    Get-ChildItem -LiteralPath $inner -Force | Move-Item -Destination $dir -Force
    Remove-Item -LiteralPath $inner -Recurse -Force
  }
  $v=(Get-VersionText $exe @('--version'))
  if ($v -ne ('v' + $pins.node.version)) { throw 'NODE_VERSION_UNEXPECTED' }
  [void]$changes.Add("node $v -> $exe")
  return [ordered]@{state='installed'; path=$exe; version=$v}
}
function Resolve-Codex([string]$NodeExe) {
  if ($RunnerExe) {
    $v=(Get-VersionText $RunnerExe @('--version'))
    return [ordered]@{state='explicit'; path=$RunnerExe; version=$v}
  }
  $prefix=Join-Path $runtimeRoot 'npm-global'
  $exe=Join-Path $prefix ($pins.ghostRunner.binaryRelPath -replace '/','\')
  if (Test-Path -LiteralPath $exe -PathType Leaf) {
    $v=(Get-VersionText $exe @('--version'))
    if ($v -match [regex]::Escape($pins.ghostRunner.version)) { return [ordered]@{state='present'; path=$exe; version=$v} }
  }
  if (-not $Apply) { return [ordered]@{state='missing'; wouldInstall=$exe; package=($pins.ghostRunner.package + '@' + $pins.ghostRunner.version)} }
  $npm=Join-Path (Split-Path -Parent $NodeExe) 'npm.cmd'
  if (-not (Test-Path -LiteralPath $npm -PathType Leaf)) { throw 'NPM_NOT_FOUND_BESIDE_NODE' }
  New-Item -ItemType Directory -Path $prefix -Force | Out-Null
  $env:Path=(Split-Path -Parent $NodeExe) + ';' + $env:Path
  & $npm install -g ($pins.ghostRunner.package + '@' + $pins.ghostRunner.version) --prefix $prefix --no-fund --no-audit | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'GHOST_RUNNER_NPM_INSTALL_FAILED' }
  if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'GHOST_RUNNER_BINARY_NOT_FOUND' }
  $v=(Get-VersionText $exe @('--version'))
  [void]$changes.Add("ghost runner $v -> $exe")
  return [ordered]@{state='installed'; path=$exe; version=$v}
}
function Resolve-Repoql {
  $exe=if ($RepoqlExe) { $RepoqlExe } else { Join-Path $env:LOCALAPPDATA 'rql\rql.exe' }
  if (Test-Path -LiteralPath $exe -PathType Leaf) {
    $v=(Get-VersionText $exe @('--version'))
    if ($v -eq $pins.repoql.version) { return [ordered]@{state='present'; path=$exe; version=$v} }
  }
  if (-not $Apply) { return [ordered]@{state='missing'; wouldInstall=$exe; version=$pins.repoql.version} }
  $provision=Join-Path $scriptDir 'provision_repoql.ps1'
  if (-not (Test-Path -LiteralPath $provision -PathType Leaf)) { throw 'PROVISION_REPOQL_MISSING' }
  $oldVersion=$env:REPOQL_INSTALL_VERSION; $oldNon=$env:REPOQL_INSTALL_NONINTERACTIVE
  try {
    $env:REPOQL_INSTALL_VERSION=$pins.repoql.version
    $env:REPOQL_INSTALL_NONINTERACTIVE='1'
    $raw=& powershell -NoProfile -ExecutionPolicy Bypass -File $provision -Apply -InstallerSha256 $pins.repoql.installerSha256 2>&1
    $out=($raw -join "`n")
    if ($out -notmatch '"applied"\s*:\s*true') { throw ('REPOQL_PROVISION_FAILED: ' + ($out -replace '\s+',' ')) }
  } finally {
    $env:REPOQL_INSTALL_VERSION=$oldVersion; $env:REPOQL_INSTALL_NONINTERACTIVE=$oldNon
  }
  if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'REPOQL_BINARY_NOT_FOUND_AFTER_INSTALL' }
  $v=(Get-VersionText $exe @('--version'))
  if ($v -ne $pins.repoql.version) { throw 'REPOQL_VERSION_UNEXPECTED' }
  [void]$changes.Add("repoql $v -> $exe")
  return [ordered]@{state='installed'; path=$exe; version=$v}
}
function Set-RepoqlPin([string]$Exe) {
  if (-not $Apply) { return [ordered]@{applied=$false; reason='plan'} }
  $before=(Get-VersionText $Exe @('config','read','update.pin'))
  & $Exe config set update.pin $pins.repoql.version --scope user 2>&1 | Out-Null
  & $Exe config set update.check false --scope user 2>&1 | Out-Null
  if ($before -notmatch [regex]::Escape($pins.repoql.version)) { [void]$changes.Add('repoql update pin set to ' + $pins.repoql.version + ' (user scope)') }
  return [ordered]@{applied=$true; pin=$pins.repoql.version; check=$false}
}
function Resolve-Python([string]$Explicit,[string]$Minimum,[string]$Code) {
  $candidates=New-Object System.Collections.ArrayList
  if ($Explicit) { [void]$candidates.Add($Explicit) }
  $minor=$Minimum.Split('.')[1]
  $candidates.Add((Join-Path $env:LOCALAPPDATA ('Programs\Python\Python' + $Minimum.Replace('.','') + '\python.exe'))) | Out-Null
  $candidates.Add((Join-Path $runtimeRoot ('python' + $Minimum.Replace('.','') + '\python.exe'))) | Out-Null
  $py=Get-Command py.exe -CommandType Application -ErrorAction SilentlyContinue
  if ($py) {
    $out=Get-VersionText $py.Source @('-3.' + $minor,'-c','import sys;print(sys.executable)')
    if ($out -and (Test-Path -LiteralPath $out -PathType Leaf)) { [void]$candidates.Add($out) }
  }
  foreach ($candidate in $candidates) {
    if (-not $candidate) { continue }
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
    $probe=Get-VersionText $candidate @('-c','import sys;print(sys.version_info[0],sys.version_info[1],sys.version_info[2])')
    if ($probe -match ('^' + [regex]::Escape(($Minimum -replace '\.',' ')) + ' \d+$')) {
      $v=($probe -replace ' ','.')
      return [ordered]@{state='present'; path=$candidate; version=$v}
    }
  }
  return [ordered]@{state='missing'; error=$Code; minimum=$Minimum; hint='pass an explicit interpreter path or install a pinned build; bootstrap will not install unpinned Python'}
}

if (-not $SourceRoot) { $SourceRoot=Split-Path -Parent (Split-Path -Parent $scriptDir) }
$node=Resolve-Node
$nodePath=if ($node.PSObject.Properties.Name -contains 'path') { [string]$node.path } else { '' }
$codex=Resolve-Codex $nodePath
$repoql=Resolve-Repoql
$repoqlPin=if ($repoql.state -eq 'missing') { [ordered]@{applied=$false; reason='repoql missing'} } else { Set-RepoqlPin $repoql.path }
$py312=Resolve-Python $Python312Exe '3.12' 'PYTHON_312_REQUIRED'
$py313=Resolve-Python $Python313Exe '3.13' 'PYTHON_313_REQUIRED'

if (-not $BridgeExe) {
  foreach ($c in @((Join-Path $SourceRoot 'bin\singularity-desktop-bridge.exe'),(Join-Path (Split-Path -Parent $SourceRoot) 'WindowsNativePreview\m76-buffy-20261029\bin\singularity-desktop-bridge.exe'))) {
    if (Test-Path -LiteralPath $c -PathType Leaf) { $BridgeExe=$c; break }
  }
}
if (-not $SupervisorExe) {
  foreach ($c in @((Join-Path $SourceRoot 'bin\singularity-windows-supervisor.exe'),(Join-Path (Split-Path -Parent $SourceRoot) 'WindowsNativePreview\m76-buffy-20261029\bin\singularity-windows-supervisor.exe'))) {
    if (Test-Path -LiteralPath $c -PathType Leaf) { $SupervisorExe=$c; break }
  }
}
if (-not $OfficeSource) {
  foreach ($c in @((Join-Path (Split-Path -Parent $SourceRoot) 'office-source'),(Join-Path $SourceRoot 'office'))) {
    if (Test-Path -LiteralPath (Join-Path $c 'backend') -PathType Container) { $OfficeSource=$c; break }
  }
}
if (-not $InstallRoot) { $InstallRoot=Join-Path $env:LOCALAPPDATA 'Singularity\WindowsNative' }

$problems=New-Object System.Collections.ArrayList
foreach ($pair in @(@('node',$node),@('ghostRunner',$codex),@('repoql',$repoql),@('python312',$py312),@('python313',$py313))) {
  if ($pair[1].state -eq 'missing') {
    $detail=if ($pair[1].PSObject.Properties.Name -contains 'error') { [string]$pair[1].error } else { 'missing' }
    [void]$problems.Add(($pair[0] + ':' + $detail))
  }
}
foreach ($pair in @(@('bridgeExe',$BridgeExe),@('supervisorExe',$SupervisorExe),@('officeSource',$OfficeSource),@('workspace',$Workspace),@('supervisorConfig',$SupervisorConfig))) {
  if (-not $pair[1]) { [void]$problems.Add(($pair[0] + ':missing')) }
}
foreach ($pair in @(@('bridgeExe',$BridgeExe),@('supervisorExe',$SupervisorExe),@('supervisorConfig',$SupervisorConfig))) {
  if ($pair[1] -and -not (Test-Path -LiteralPath $pair[1] -PathType Leaf)) { [void]$problems.Add(($pair[0] + ':not_a_file')) }
}
foreach ($pair in @(@('officeSource',$OfficeSource),@('workspace',$Workspace))) {
  if ($pair[1] -and -not (Test-Path -LiteralPath $pair[1] -PathType Container)) { [void]$problems.Add(($pair[0] + ':not_a_directory')) }
}

$installCommand=$null
$installResult=$null
if ($problems.Count -eq 0) {
  $manager=Join-Path $scriptDir 'manage_native_windows.ps1'
  $quoted=@('-Mode','Install','-Apply','-SourceRoot',('"' + $SourceRoot + '"'),'-BridgeExe',('"' + $BridgeExe + '"'),'-SupervisorExe',('"' + $SupervisorExe + '"'),'-InstallRoot',('"' + $InstallRoot + '"'),'-RepoqlExe',('"' + $repoql.path + '"'),'-PythonExe',('"' + $py312.path + '"'),'-RunnerExe',('"' + $codex.path + '"'),'-Workspace',('"' + $Workspace + '"'),'-SupervisorConfig',('"' + $SupervisorConfig + '"'),'-OfficeSource',('"' + $OfficeSource + '"'),'-OfficePythonExe',('"' + $py313.path + '"'))
  if ($OfficeWheelhouse) { $quoted += @('-OfficeWheelhouse',('"' + $OfficeWheelhouse + '"')) }
  if ($OfficeAllowNetwork) { $quoted += '-OfficeAllowNetwork' }
  $installCommand='powershell -NoProfile -ExecutionPolicy Bypass -File "' + $manager + '" ' + ($quoted -join ' ')
  if ($Apply -and $InstallProduct) {
    $argv=@('-NoProfile','-ExecutionPolicy','Bypass','-File',$manager,'-Mode','Install','-Apply','-SourceRoot',$SourceRoot,'-BridgeExe',$BridgeExe,'-SupervisorExe',$SupervisorExe,'-InstallRoot',$InstallRoot,'-RepoqlExe',$repoql.path,'-PythonExe',$py312.path,'-RunnerExe',$codex.path,'-Workspace',$Workspace,'-SupervisorConfig',$SupervisorConfig,'-OfficeSource',$OfficeSource,'-OfficePythonExe',$py313.path)
    if ($OfficeWheelhouse) { $argv += @('-OfficeWheelhouse',$OfficeWheelhouse) }
    if ($OfficeAllowNetwork) { $argv += '-OfficeAllowNetwork' }
    $raw=& powershell @argv 2>&1
    $installResult=($raw -join "`n")
    [void]$changes.Add('manage_native_windows Install invoked')
  }
} else {
  $installResult=$null
}

$connectorProvisioning=$null
if ($ProvisionConnectors) {
  $connectorProvisioning=[ordered]@{requested=$true;invoked=$false;action='build';state='planned';exitCode=$null;result=$null;error='';installCommand=''}
  if ($repoql.state -eq 'missing') {
    $connectorProvisioning.state='blocked'
    $connectorProvisioning.error='REPOQL_MISSING'
  }
  elseif ($py312.state -eq 'missing') {
    $connectorProvisioning.state='blocked'
    $connectorProvisioning.error='PYTHON_312_REQUIRED'
  }
  else {
    $manager=Join-Path $scriptDir 'manage_native_windows.ps1'
    if (-not (Test-Path -LiteralPath $manager -PathType Leaf)) {
      $connectorProvisioning.state='blocked'
      $connectorProvisioning.error='NATIVE_CONNECTOR_MANAGER_MISSING'
    }
    else {
      $connectorProvisioning.installCommand='powershell -NoProfile -ExecutionPolicy Bypass -File "' + $manager + '" -ConnectorAction install -Apply -RepoqlExe "' + [string]$repoql.path + '" -PythonExe "' + [string]$py312.path + '"'
      if ($Apply) {
        $argv=@('-NoProfile','-ExecutionPolicy','Bypass','-File',$manager,'-ConnectorAction','build','-RepoqlExe',[string]$repoql.path,'-PythonExe',[string]$py312.path,'-Apply')
        $raw=& powershell @argv 2>&1
        $connectorExit=$LASTEXITCODE
        $connectorProvisioning.invoked=$true
        $connectorProvisioning.action='build'
        $connectorProvisioning.exitCode=$connectorExit
        $text=($raw -join "`n").Trim()
        try {
          $connectorProvisioning.result=$text | ConvertFrom-Json -ErrorAction Stop
          $connectorProvisioning.state=if ($connectorExit -eq 0) {'reported'} else {'failed'}
        } catch {
          $connectorProvisioning.state='failed'
          $connectorProvisioning.error='CONNECTOR_PROVISION_INVALID'
        }
      }
    }
  }
}

[ordered]@{
  schema='singularity-runtime-bootstrap/v1'
  mode=$(if ($Apply) {'apply'} else {'plan'})
  changed=($changes.Count -gt 0)
  changes=@($changes)
  resolved=[ordered]@{
    node=$node; ghostRunner=$codex; repoql=$repoql; repoqlPin=$repoqlPin; python312=$py312; python313=$py313
    bridgeExe=$BridgeExe; supervisorExe=$SupervisorExe; officeSource=$OfficeSource
    workspace=$Workspace; supervisorConfig=$SupervisorConfig; installRoot=$InstallRoot
  }
  problems=@($problems)
  installCommand=$installCommand
  installInvoked=[bool]($Apply -and $InstallProduct -and $problems.Count -eq 0)
  installResult=$installResult
  connectorProvisioning=$connectorProvisioning
  releaseReady=$false
} | ConvertTo-Json -Depth 8
