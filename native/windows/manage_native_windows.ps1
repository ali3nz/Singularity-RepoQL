#Requires -Version 5.1
<#
Codex-operated, per-user lifecycle entrypoint for the four native Windows
variants. Install registers but never starts tasks; GUI integration is optional.
Every mutation requires -Apply and exact task/receipt readback. User state and
external GUI settings are retained by uninstall and reinstall.
#>
[CmdletBinding(SupportsShouldProcess=$true, ConfirmImpact='High')]
param(
[ValidateSet('Plan','Install','Start','Stop','Status','Uninstall','Reinstall','RefreshSource','RollbackSource')][string]$Mode='Plan',
  [string]$SourceRoot='', [string]$BridgeExe='', [string]$SupervisorExe='', [string]$InstallRoot='',
  [string]$RepoqlExe='', [string]$GuiExe='', [string]$PythonExe='',
  [string]$RunnerExe='', [string]$Workspace='', [string]$SupervisorConfig='',
  [string]$OfficeSource='', [string]$OfficePythonExe='', [string]$OfficeWheelhouse='',
  [string]$NodeExe='', [string]$MemoryRoot='', [string]$MemorySourceRoot='', [string]$MemoryBuildRoot='', [string]$MemorySecretsSource='',
  [ValidateSet('','prepare','start','status','stop','verify','provision')][string]$MemoryAction='',
  [ValidateSet('','status','build','install')][string]$ConnectorAction='',
  [string]$ConnectorBuildRoot='',
  [ValidateRange(1024,65535)][int]$DashboardPort=18100,
  [ValidateRange(1024,65535)][int]$GhostPort=18473,
  [ValidateRange(1024,65535)][int]$OfficePort=18128,
  [switch]$OfficeAllowNetwork,
  [switch]$SkipOffice,
  [ValidateSet('read-only','workspace-write')][string]$Sandbox='read-only',
  [ValidateRange(1,86400)][int]$RunTimeoutSeconds=3600,
  [switch]$Apply
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'NATIVE_WINDOWS_REQUIRED' }
$Option=2 # The Codex-operated product entrypoint ships complete Claude Code variant 2 only.
$hasOffice=-not $SkipOffice
$mutating=$Mode -in @('Install','Start','Stop','Uninstall','Reinstall','RefreshSource','RollbackSource')
$sourceRefreshMode=$Mode -in @('RefreshSource','RollbackSource')
$memoryReadOnly=$MemoryAction -in @('status','verify')
$connectorMutating=$ConnectorAction -in @('build','install')
if (($mutating -or ($MemoryAction -and -not $memoryReadOnly) -or $connectorMutating) -and -not $Apply -and -not $sourceRefreshMode) { throw 'NATIVE_LIFECYCLE_EXPLICIT_APPLY_REQUIRED' }
if (-not $mutating -and -not $MemoryAction -and -not $ConnectorAction -and $Apply) { throw 'NATIVE_LIFECYCLE_READ_ONLY_REFUSES_APPLY' }
if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA_REQUIRED' }

$base=[IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Singularity'))
$installRoot=if ($InstallRoot) { [IO.Path]::GetFullPath($InstallRoot) } else { Join-Path $base 'WindowsNative' }
$current=Join-Path $installRoot 'current'
$previous=Join-Path $installRoot 'previous'
$installReceiptPath=Join-Path $installRoot 'INSTALLATION_RECEIPT.json'
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $identity -or -not $identity.User) { throw 'WINDOWS_USER_IDENTITY_UNAVAILABLE' }
$ownerSid=$identity.User.Value
$systemSid='S-1-5-18'
$allowedSids=@($ownerSid,$systemSid)
$stageScript=Join-Path $PSScriptRoot 'stage-native.ps1'
$dashboardManager=Join-Path $PSScriptRoot 'manage_claude_complete_dashboard.ps1'
$ghostManager=Join-Path $PSScriptRoot 'manage_ghost_scheduler.ps1'
$officeManager=Join-Path $PSScriptRoot 'manage_claude_office.ps1'
$supervisorRegistrar=Join-Path $PSScriptRoot 'register-supervisor-task.ps1'
$supervisorVerifier=Join-Path $PSScriptRoot 'verify_supervisor_task.ps1'
$taskSupervisor='Singularity-Rust-Native-Supervisor'
$taskDashboard='Singularity-ClaudeComplete-Dashboard'
$taskGhost='Singularity-Ghost-Scheduler'
$taskOffice='Singularity-ClaudeComplete-Office'
$officeRoot=Join-Path $base 'Office'
$officeReceipt=Join-Path $officeRoot 'office-install.json'
# --- A3 memory + generated supervisor config (kept as one block for merge safety) ---
$memoryRoot=if ($MemoryRoot) { [IO.Path]::GetFullPath($MemoryRoot) } else { Join-Path $installRoot 'memory' }
$memoryRuntimeCandidate=if ($env:SINGULARITY_NATIVE_RUNTIME) { [IO.Path]::GetFullPath($env:SINGULARITY_NATIVE_RUNTIME) } else { Join-Path $env:USERPROFILE 'tools\singularity-native-runtime' }
$memorySourceRoot=if ($MemorySourceRoot) { [IO.Path]::GetFullPath($MemorySourceRoot) } elseif (Test-Path -LiteralPath (Join-Path $memoryRoot 'source\MemoryCore') -PathType Container) { Join-Path $memoryRoot 'source' } elseif (Test-Path -LiteralPath (Join-Path $memoryRuntimeCandidate 'source\MemoryCore') -PathType Container) { Join-Path $memoryRuntimeCandidate 'source' } else { Join-Path $memoryRoot 'source' }
$memoryBuildRoot=if ($MemoryBuildRoot) { [IO.Path]::GetFullPath($MemoryBuildRoot) } elseif (Test-Path -LiteralPath (Join-Path $memoryRoot 'build\MemoryCore') -PathType Container) { Join-Path $memoryRoot 'build' } elseif (Test-Path -LiteralPath (Join-Path $memoryRuntimeCandidate 'build\MemoryCore') -PathType Container) { Join-Path $memoryRuntimeCandidate 'build' } else { Join-Path $memoryRoot 'build' }
$memoryConfig=Join-Path $memoryRoot 'stack.json'
$memoryBuilder=Join-Path $PSScriptRoot 'build_memory_stack_config.py'
$supervisorBuilder=Join-Path $PSScriptRoot 'build_supervisor_config.py'
# --- end A3 paths ---
$hasGhost=$false
if (-not $RepoqlExe) {
  $repoqlCandidate=Join-Path $env:LOCALAPPDATA 'rql\rql.exe'
  if (Test-Path -LiteralPath $repoqlCandidate -PathType Leaf) { $RepoqlExe=$repoqlCandidate }
}
if (-not $RunnerExe -and $hasGhost) {
  $codexRoot=Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
  if (Test-Path -LiteralPath $codexRoot -PathType Container) {
    $codexCandidate=@(Get-ChildItem -LiteralPath $codexRoot -Directory | Sort-Object LastWriteTime -Descending | ForEach-Object { Join-Path $_.FullName 'codex.exe' } | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1)
    if ($codexCandidate.Count -gt 0) { $RunnerExe=$codexCandidate[0] }
  }
}
if (-not $NodeExe) {
  $nodeCommand=Get-Command node -ErrorAction SilentlyContinue
  if ($nodeCommand) { $NodeExe=$nodeCommand.Source }
}
$dashboardState=Join-Path $base 'Dashboard'
$dashboardReceipt=if ($dashboardState) { Join-Path $dashboardState 'task-ownership.json' } else { '' }
$ghostRoot=Join-Path $base 'GhostScheduler'
$ghostReceipt=Join-Path $ghostRoot 'task-ownership.json'
$ghostConfig=Join-Path $ghostRoot 'config.json'
$ghostClientConfig=Join-Path $ghostRoot 'native-bridge-client.json'
function Test-GhostOwnershipArtifacts {
  foreach ($path in @(
      $ghostReceipt,$ghostConfig,$ghostClientConfig,
      (Join-Path $ghostRoot 'task-ownership.pending.json'),
      (Join-Path $ghostRoot 'config.pending.json'),
      (Join-Path $ghostRoot 'native-bridge-client.pending.json'))) {
    if (Test-Path -LiteralPath $path) { return $true }
  }
  return $false
}

function Assert-LocalPath([string]$Value,[string]$Code,[bool]$MustExist=$true,[bool]$Directory=$false) {
  if (-not $Value -or -not [IO.Path]::IsPathRooted($Value) -or $Value.StartsWith('\\')) { throw $Code }
  $full=[IO.Path]::GetFullPath($Value)
  if ($full.Contains('"') -or $full.Contains([char]10) -or $full.Contains([char]13)) { throw $Code }
  for ($cursor=$full;$cursor;$cursor=[IO.Path]::GetDirectoryName($cursor)) {
    if (Test-Path -LiteralPath $cursor) {
      if (((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'NATIVE_REPARSE_PATH_REFUSED' }
    }
    if ([IO.Path]::GetDirectoryName($cursor) -eq $cursor) { break }
  }
  if ($MustExist) {
    if ($Directory -and -not [IO.Directory]::Exists($full)) { throw $Code }
    if (-not $Directory -and -not [IO.File]::Exists($full)) { throw $Code }
  }
  return $full
}
function Assert-PrivateAcl([string]$PathValue) {
  $acl=Get-Acl -LiteralPath $PathValue -ErrorAction Stop
  if (-not $acl.AreAccessRulesProtected) { throw 'NATIVE_PRIVATE_ACL_NOT_PROTECTED' }
  $rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
  $seen=@{}
  foreach ($rule in $rules) {
    $sid=[string]$rule.IdentityReference.Value
    if ($rule.IsInherited -or $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or $sid -notin $allowedSids -or
        (($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne [Security.AccessControl.FileSystemRights]::FullControl)) { throw 'NATIVE_PRIVATE_ACL_PRINCIPAL_UNEXPECTED' }
    $seen[$sid]=$true
  }
  foreach ($sid in $allowedSids) { if (-not $seen.ContainsKey($sid)) { throw 'NATIVE_PRIVATE_ACL_PRINCIPAL_MISSING' } }
}
function Set-PrivateDirectoryAcl([string]$PathValue) {
  if (-not (Test-Path -LiteralPath $PathValue -PathType Container)) { New-Item -ItemType Directory -Path $PathValue -Force | Out-Null }
  $acl=[System.Security.AccessControl.DirectorySecurity]::new(); $acl.SetAccessRuleProtection($true,$false)
  $inherit=[Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
  foreach ($sidText in $allowedSids) {
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sidText),[Security.AccessControl.FileSystemRights]::FullControl,$inherit,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow))
  }
  Set-Acl -LiteralPath $PathValue -AclObject $acl
  Assert-PrivateAcl $PathValue
}
function Set-PrivateFileAcl([string]$PathValue) {
  $acl=[System.Security.AccessControl.FileSecurity]::new(); $acl.SetAccessRuleProtection($true,$false)
  foreach ($sidText in $allowedSids) {
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sidText),[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.AccessControlType]::Allow))
  }
  Set-Acl -LiteralPath $PathValue -AclObject $acl
  Assert-PrivateAcl $PathValue
}
function Remove-StaleReceiptTemps {
  # Receipt writers are per-process; a fresh temp from another process must
  # survive. Only this process's own leftovers and files older than the grace
  # period are stale.
  $ownPrefix='INSTALLATION_RECEIPT.json.pending-'+$PID+'-'
  $staleBefore=(Get-Date).AddMinutes(-10)
  Get-ChildItem -LiteralPath $installRoot -Filter 'INSTALLATION_RECEIPT.json.pending-*' -File -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.Name.StartsWith($ownPrefix,[StringComparison]::Ordinal) -or $_.LastWriteTime -lt $staleBefore } |
    Remove-Item -Force -ErrorAction SilentlyContinue
}
function Write-InstallReceipt($Receipt) {
  $json=$Receipt | ConvertTo-Json -Depth 6 -Compress
  Remove-StaleReceiptTemps
  $temp=$installReceiptPath+'.pending-'+$PID+'-'+[guid]::NewGuid().ToString('N')
  [IO.File]::WriteAllText($temp,$json,[Text.UTF8Encoding]::new($false)); Set-PrivateFileAcl $temp
  if (Test-Path -LiteralPath $installReceiptPath -PathType Leaf) {
    $backup=$installReceiptPath+'.bak'
    Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue
    [IO.File]::Replace($temp,$installReceiptPath,$backup)
    Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue
  }
  else { Move-Item -LiteralPath $temp -Destination $installReceiptPath -ErrorAction Stop }
  Assert-PrivateAcl $installReceiptPath
}
function Read-InstallReceipt([bool]$Required=$true) {
  if (-not (Test-Path -LiteralPath $installReceiptPath -PathType Leaf)) {
    if ($Required) { throw 'NATIVE_INSTALLATION_RECEIPT_MISSING' }
    return $null
  }
  Assert-PrivateAcl $installReceiptPath
  try { $receipt=Get-Content -LiteralPath $installReceiptPath -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop }
  catch { throw 'NATIVE_INSTALLATION_RECEIPT_INVALID' }
  if ($receipt.schema -ne 'singularity-native-windows-installation/v1' -or $receipt.installRoot -cne $installRoot -or $receipt.ownerSid -cne $ownerSid -or [int]$receipt.option -ne 2 -or
      $receipt.state -notin @('installing','installed_not_started','reinstalling','partial')) { throw 'NATIVE_INSTALLATION_RECEIPT_INVALID' }
  if ($Option -ne 0 -and [int]$receipt.option -ne $Option) { throw 'NATIVE_OPTION_RECEIPT_MISMATCH' }
  return $receipt
}
function Get-FileSha256([string]$PathValue) {
  # Hash validation is read-only even under powershell.exe -File -WhatIf.
  # Windows PowerShell Get-FileHash can suppress output via ForEach-Object.
  $sha=[Security.Cryptography.SHA256]::Create()
  try {
    $stream=[IO.File]::OpenRead($PathValue)
    try { return [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-','').ToLowerInvariant() }
    finally { $stream.Dispose() }
  } finally { $sha.Dispose() }
}
function Read-Stage([string]$StagePath,[int]$ExpectedOption,[switch]$AllowLegacyGhost) {
  if (-not (Test-Path -LiteralPath $StagePath -PathType Container)) { return $null }
  $null=Assert-LocalPath $StagePath 'NATIVE_STAGE_PATH_INVALID' $true $true
  $receiptPath=Join-Path $StagePath 'STAGING_RECEIPT.json'
  $manifestPath=Join-Path $StagePath 'source/NATIVE_WINDOWS_SOURCE_MANIFEST.json'
  if (-not (Test-Path -LiteralPath $receiptPath -PathType Leaf) -or -not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'NATIVE_STAGE_RECEIPT_OR_MANIFEST_MISSING' }
  try { $stageReceipt=Get-Content -LiteralPath $receiptPath -Raw -Encoding UTF8 | ConvertFrom-Json; $manifest=Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json }
  catch { throw 'NATIVE_STAGE_RECEIPT_OR_MANIFEST_INVALID' }
  $legacyGhost=$AllowLegacyGhost -and $ExpectedOption -in @(2,4) -and
    $manifest.features.ghost -eq $true -and $manifest.rustGhostFeature -eq $true -and $stageReceipt.bridgeFeatureGhost -eq $true
  if ($manifest.features.ghost -isnot [bool] -or $manifest.rustGhostFeature -isnot [bool] -or $stageReceipt.bridgeFeatureGhost -isnot [bool] -or
      $stageReceipt.schema -ne 1 -or $stageReceipt.state -ne 'STAGED_UNVERIFIED' -or [int]$stageReceipt.option -ne $ExpectedOption -or $stageReceipt.repoqlVersion -ne '1.7.18' -or
      $stageReceipt.sourceManifestSha256 -notmatch '^[0-9a-f]{64}$' -or $manifest.schema -ne 1 -or [int]$manifest.variant -ne $ExpectedOption -or
      $manifest.release_status -ne 'SOURCE_ONLY_UNCOMPILED_NOT_INSTALLER' -or $manifest.repoql.requiredVersion -ne '1.7.18' -or $manifest.repoql.connectorContract -cne 'fetch-render' -or
      [bool]$manifest.features.ghost -ne $legacyGhost -or [bool]$manifest.features.office -ne ($ExpectedOption -in @(2,4)) -or
      [bool]$manifest.rustGhostFeature -ne $legacyGhost -or [bool]$manifest.rustOfficeFeature -ne ($ExpectedOption -in @(2,4)) -or
      $stageReceipt.bridgePackageVersion -notmatch '^\d+\.\d+\.\d+$' -or
      [bool]$stageReceipt.bridgeFeatureGhost -ne $legacyGhost -or [bool]$stageReceipt.bridgeFeatureOffice -ne ($ExpectedOption -in @(2,4))) {
    throw 'NATIVE_STAGE_IDENTITY_OR_PIN_INVALID'
  }
  if ((Get-FileSha256 $manifestPath) -cne [string]$stageReceipt.sourceManifestSha256) { throw 'NATIVE_STAGE_MANIFEST_HASH_MISMATCH' }
  $expected=@{}
  foreach ($row in @($manifest.files)) {
    $relative=[string]$row.path
    if (-not $legacyGhost -and ($relative -match '^(ghost/|dashboard/static/ghost/|openchamber/plugins/product-ghost/|native/windows/(ghost_|manage_ghost_|test_ghost_))' -or
        $relative -in @('native/desktop-bridge/src/ghost.rs','dashboard/native_ghost.py','native/windows/test_native_ghost_client_config.py'))) {
      throw 'NATIVE_STAGE_GHOST_COMPONENT_LEAK'
    }
    if (-not $relative -or $relative.Contains('\\') -or $relative.Contains(':') -or $relative.StartsWith('/') -or $relative.Split('/') -contains '..' -or $relative.Split('/') -contains '') { throw 'NATIVE_STAGE_MANIFEST_PATH_INVALID' }
    if ($row.sha256 -notmatch '^[0-9a-f]{64}$' -or [long]$row.bytes -lt 0) { throw 'NATIVE_STAGE_MANIFEST_ENTRY_INVALID' }
    $path=Join-Path (Join-Path $StagePath 'source') ($relative -replace '/', [IO.Path]::DirectorySeparatorChar)
    $null=Assert-LocalPath $path 'NATIVE_STAGE_SOURCE_FILE_MISSING' $true $false
    $info=Get-Item -LiteralPath $path
    if ($info.Length -ne [long]$row.bytes -or (Get-FileSha256 $path) -cne [string]$row.sha256) { throw 'NATIVE_STAGE_SOURCE_HASH_MISMATCH' }
    $expected[('source/'+$relative).ToUpperInvariant()]=$path
  }
  if ($ExpectedOption -in @(1,3) -and @($manifest.files | Where-Object {
      [string]$_.path -in @('native/windows/ghost_scheduler_host.py','native/windows/ghost_task_scheduler.ps1',
        'native/windows/manage_ghost_scheduler.ps1','native/windows/test_ghost_scheduler_host.py',
        'native/desktop-bridge/src/ghost.rs','native/desktop-bridge/src/office.rs',
        'dashboard/native_ghost.py','dashboard/office_bridge.py') -or
      [string]$_.path -match '^(ghost/|office/|dashboard/static/ghost/|openchamber/plugins/product-(office|ghost)/)'
    }).Count -gt 0) { throw 'NATIVE_STAGE_OPTIONAL_COMPONENT_LEAK' }
  if ($expected.Count -lt 200) { throw 'NATIVE_STAGE_SOURCE_INVENTORY_TOO_SMALL' }
  $expected['source/NATIVE_WINDOWS_SOURCE_MANIFEST.JSON']=(Join-Path $StagePath 'source/NATIVE_WINDOWS_SOURCE_MANIFEST.json')
  $bridge=Join-Path $StagePath 'bin/singularity-desktop-bridge.exe'
  $supervisor=Join-Path $StagePath 'bin/singularity-windows-supervisor.exe'
  foreach ($pair in @(@($bridge,$stageReceipt.bridgeSha256),@($supervisor,$stageReceipt.supervisorSha256))) {
    if ($pair[1] -notmatch '^[0-9a-f]{64}$') { throw 'NATIVE_STAGE_BINARY_RECEIPT_INVALID' }
    $null=Assert-LocalPath $pair[0] 'NATIVE_STAGE_BINARY_MISSING' $true $false
    if ((Get-FileSha256 $pair[0]) -cne [string]$pair[1]) { throw 'NATIVE_STAGE_BINARY_HASH_MISMATCH' }
    $expected[('bin/'+(Split-Path -Leaf $pair[0])).ToUpperInvariant()]=$pair[0]
  }
  $expected['STAGING_RECEIPT.JSON']=$receiptPath
  if ($stageReceipt.PSObject.Properties['additionalBinaries']) {
    $extras=@($stageReceipt.additionalBinaries)
    if ($extras.Count -gt 2) { throw 'NATIVE_STAGE_ADDITIONAL_BINARY_INVALID' }
    foreach ($extra in $extras) {
      $relative=[string]$extra.path
      if ($relative -cnotin @('bin/singularity-windows-supervisorw.exe','bin/unified-repoql-control.exe') -or
          [string]$extra.sha256 -cnotmatch '^[0-9a-f]{64}$' -or $expected.ContainsKey($relative.ToUpperInvariant())) {
        throw 'NATIVE_STAGE_ADDITIONAL_BINARY_INVALID'
      }
      $extraPath=Join-Path $StagePath ($relative -replace '/', [IO.Path]::DirectorySeparatorChar)
      $null=Assert-LocalPath $extraPath 'NATIVE_STAGE_ADDITIONAL_BINARY_INVALID' $true $false
      if ((Get-FileSha256 $extraPath) -cne [string]$extra.sha256) { throw 'NATIVE_STAGE_ADDITIONAL_BINARY_HASH_MISMATCH' }
      $expected[$relative.ToUpperInvariant()]=$extraPath
    }
  }
  $actual=@(); $stack=New-Object 'System.Collections.Generic.Stack[string]'; $stack.Push($StagePath)
  while ($stack.Count -gt 0) {
    $directory=$stack.Pop()
    foreach ($item in @(Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop)) {
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'NATIVE_STAGE_REPARSE_REFUSED' }
      if ($item.PSIsContainer) { $stack.Push($item.FullName) }
      else { $actual += $item.FullName.Substring($StagePath.Length+1).Replace('\','/').ToUpperInvariant() }
    }
    if ($actual.Count -gt 30000) { throw 'NATIVE_STAGE_INVENTORY_LIMIT' }
  }
  $diff=Compare-Object -ReferenceObject @($expected.Keys | Sort-Object) -DifferenceObject @($actual | Sort-Object)
  if ($diff) { throw 'NATIVE_STAGE_UNOWNED_FILE_REFUSED' }
  return [pscustomobject]@{path=$StagePath;receipt=$stageReceipt;manifest=$manifest;files=@($expected.Values);option=$ExpectedOption}
}
function Get-BytesSha256([byte[]]$Bytes) {
  $sha=[Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($sha.ComputeHash($Bytes)).Replace('-','').ToLowerInvariant() }
  finally { $sha.Dispose() }
}
function Get-JsonObjectFromBytes([byte[]]$Bytes,[string]$FailureCode) {
  try { return ([Text.Encoding]::UTF8.GetString($Bytes).TrimStart([char]0xFEFF) | ConvertFrom-Json -ErrorAction Stop) }
  catch { throw $FailureCode }
}
function Assert-ExactFileInventory([string]$Root,[string[]]$Expected,[string]$FailureCode) {
  $full=[IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar,[IO.Path]::AltDirectorySeparatorChar)
  if (-not (Test-Path -LiteralPath $full -PathType Container)) { throw $FailureCode }
  $actual=@(); $stack=New-Object 'System.Collections.Generic.Stack[string]'; $stack.Push($full)
  while ($stack.Count -gt 0) {
    $directory=$stack.Pop()
    foreach ($item in @(Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop)) {
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw $FailureCode }
      if ($item.PSIsContainer) { $stack.Push($item.FullName) }
      else { $actual += $item.FullName.Substring($full.Length+1).Replace('\','/').ToUpperInvariant() }
    }
    if ($actual.Count -gt 30000) { throw 'NATIVE_SOURCE_INVENTORY_LIMIT' }
  }
  $diff=Compare-Object -ReferenceObject @($Expected | ForEach-Object { ([string]$_).Replace('\','/').ToUpperInvariant() } | Sort-Object) -DifferenceObject @($actual | Sort-Object)
  if ($diff) { throw $FailureCode }
}
function Get-SourceTree([string]$Root,[int]$ExpectedOption,[switch]$AllowLegacyGhost) {
  $full=Assert-LocalPath $Root 'NATIVE_SOURCE_ROOT_INVALID' $true $true
  $full=[IO.Path]::GetFullPath($full).TrimEnd([IO.Path]::DirectorySeparatorChar,[IO.Path]::AltDirectorySeparatorChar)
  $manifestPath=Join-Path $full 'NATIVE_WINDOWS_SOURCE_MANIFEST.json'
  $null=Assert-LocalPath $manifestPath 'NATIVE_SOURCE_MANIFEST_INVALID' $true $false
  try { $manifest=Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop }
  catch { throw 'NATIVE_SOURCE_MANIFEST_INVALID' }
  $complete=$ExpectedOption -in @(2,4)
  $legacyGhost=$AllowLegacyGhost -and $complete -and $manifest.features.ghost -eq $true -and $manifest.rustGhostFeature -eq $true
  $expectedGui=if ($ExpectedOption -le 2) {'claude-desktop-code'} else {'openchamber-desktop'}
  if ($manifest.features.ghost -isnot [bool] -or $manifest.rustGhostFeature -isnot [bool] -or
      $manifest.schema -ne 1 -or [int]$manifest.variant -ne $ExpectedOption -or $manifest.release_status -cne 'SOURCE_ONLY_UNCOMPILED_NOT_INSTALLER' -or
      $manifest.repoql.requiredVersion -cne '1.7.18' -or $manifest.repoql.connectorContract -cne 'fetch-render' -or $manifest.gui -cne $expectedGui -or
      [bool]$manifest.features.office -ne $complete -or [bool]$manifest.features.ghost -ne $legacyGhost -or
      [bool]$manifest.rustOfficeFeature -ne $complete -or [bool]$manifest.rustGhostFeature -ne $legacyGhost) { throw 'NATIVE_SOURCE_PIN_OR_PROFILE_INVALID' }
  $seen=@{}; $seenWindows=@{}; $expectedFiles=@('NATIVE_WINDOWS_SOURCE_MANIFEST.json')
  $reserved='^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9]|LPT[1-9])($|\.)'
  foreach ($row in @($manifest.files)) {
    $relative=[string]$row.path
    if (-not $legacyGhost -and ($relative -match '^(ghost/|dashboard/static/ghost/|openchamber/plugins/product-ghost/|native/windows/(ghost_|manage_ghost_|test_ghost_))' -or
        $relative -in @('native/desktop-bridge/src/ghost.rs','dashboard/native_ghost.py','native/windows/test_native_ghost_client_config.py'))) {
      throw 'NATIVE_SOURCE_GHOST_COMPONENT_LEAK'
    }
    if (-not $relative -or $relative.Contains('\') -or $relative.Contains(':') -or $relative.StartsWith('/') -or
        $relative.Split('/') -contains '..' -or $relative.Split('/') -contains '.' -or $relative.Split('/') -contains '' -or
        $seen.ContainsKey($relative.ToUpperInvariant())) { throw 'NATIVE_SOURCE_MANIFEST_PATH_INVALID' }
    if ($relative.Length -gt 240 -or $seenWindows.ContainsKey($relative.ToUpperInvariant())) { throw 'NATIVE_SOURCE_WINDOWS_NAME_COLLISION' }
    $seenWindows[$relative.ToUpperInvariant()]=$true
    foreach ($segment in $relative.Split('/')) {
      if ($segment.Length -gt 200 -or $segment -match '[<>:"|?*]' -or $segment -match '[\. ]$' -or $segment -match $reserved) { throw 'NATIVE_SOURCE_WINDOWS_NAME_INVALID' }
    }
    if ($relative -match '(?i)(^|/)(node_modules|\.git|\.venv|secrets|runs|__pycache__)/' -or
        $relative -match '(?i)\.(db|sqlite|sqlite3|pem|key|pfx|p12|kdbx|log)$') { throw 'NATIVE_SOURCE_PRIVATE_FILE_REFUSED' }
    if (-not $complete -and ($relative -match '^(ghost/|office/|dashboard/static/ghost/|openchamber/plugins/product-(office|ghost)/)' -or $relative -in @(
        'native/desktop-bridge/src/office.rs','native/desktop-bridge/src/ghost.rs','dashboard/office_bridge.py','dashboard/native_ghost.py',
        'native/windows/ghost_scheduler_host.py','native/windows/ghost_task_scheduler.ps1','native/windows/manage_ghost_scheduler.ps1','native/windows/test_ghost_scheduler_host.py'))) {
      throw 'NATIVE_SOURCE_OPTIONAL_COMPONENT_LEAK'
    }
    if ([string]$row.sha256 -notmatch '^[0-9a-f]{64}$' -or [long]$row.bytes -lt 0) { throw 'NATIVE_SOURCE_MANIFEST_ENTRY_INVALID' }
    $path=Join-Path $full ($relative -replace '/',[IO.Path]::DirectorySeparatorChar)
    $null=Assert-LocalPath $path 'NATIVE_SOURCE_FILE_MISSING' $true $false
    $info=Get-Item -LiteralPath $path
    if ($info.Length -ne [long]$row.bytes -or (Get-FileSha256 $path) -cne [string]$row.sha256) { throw 'NATIVE_SOURCE_FILE_HASH_MISMATCH' }
    $seen[$relative.ToUpperInvariant()]=$true
    $expectedFiles += $relative
  }
  if ($seen.Count -lt 200) { throw 'NATIVE_SOURCE_INVENTORY_TOO_SMALL' }
  Assert-ExactFileInventory $full $expectedFiles 'NATIVE_SOURCE_UNOWNED_FILE_REFUSED'
  return [pscustomobject]@{path=$full;manifest=$manifest;manifestSha256=(Get-FileSha256 $manifestPath);fileCount=$seen.Count;files=@($expectedFiles)}
}
function Get-ReceiptWithoutSourceHash($Receipt) {
  $copy=[ordered]@{}
  foreach ($property in $Receipt.PSObject.Properties) {
    if ($property.Name -cne 'sourceManifestSha256') { $copy[$property.Name]=$property.Value }
  }
  return ($copy | ConvertTo-Json -Depth 20 -Compress)
}
function Assert-ReceiptNonSourceFieldsEqual($Before,$After,[string]$FailureCode) {
  if ((Get-ReceiptWithoutSourceHash $Before) -cne (Get-ReceiptWithoutSourceHash $After)) { throw $FailureCode }
}
function Assert-SourceStageCoherence($Stage,$InstallReceipt,$Tree) {
  $stageReceipt=$Stage.receipt
  if ($stageReceipt.schema -ne 1 -or $stageReceipt.state -cne 'STAGED_UNVERIFIED' -or [int]$stageReceipt.option -ne [int]$InstallReceipt.option -or
      $stageReceipt.repoqlVersion -cne '1.7.18' -or [string]$stageReceipt.sourceManifestSha256 -notmatch '^[0-9a-f]{64}$' -or
      [string]$stageReceipt.sourceManifestSha256 -cne [string]$Tree.manifestSha256 -or
      -not $InstallReceipt.PSObject.Properties['sourceManifestSha256'] -or [string]$InstallReceipt.sourceManifestSha256 -cne [string]$Tree.manifestSha256 -or
      [string]$InstallReceipt.bridgeSha256 -cne [string]$stageReceipt.bridgeSha256 -or
      [string]$InstallReceipt.supervisorSha256 -cne [string]$stageReceipt.supervisorSha256) { throw 'NATIVE_SOURCE_RECEIPT_MISMATCH' }
}
function Write-BytesAtomic([string]$Path,[byte[]]$Bytes) {
  $temp=$Path+'.source-refresh-pending-'+$PID+'-'+[guid]::NewGuid().ToString('N')
  $backup=$Path+'.source-refresh-backup-'+$PID+'-'+[guid]::NewGuid().ToString('N')
  $beforeHash=''
  try {
    if (Test-Path -LiteralPath $Path -PathType Leaf) { $beforeHash=(Get-FileSha256 $Path) }
    [IO.File]::WriteAllBytes($temp,$Bytes)
    Set-PrivateFileAcl $temp
    if ($beforeHash) {
      if (Test-Path -LiteralPath $backup) { throw 'NATIVE_SOURCE_RECEIPT_BACKUP_PATH_OCCUPIED' }
      [IO.File]::Replace($temp,$Path,$backup)
      if (-not (Test-Path -LiteralPath $backup -PathType Leaf) -or (Get-FileSha256 $backup) -cne $beforeHash) {
        throw 'NATIVE_SOURCE_RECEIPT_BACKUP_PREIMAGE_MISMATCH'
      }
      Remove-Item -LiteralPath $backup -Force -ErrorAction Stop
      if (Test-Path -LiteralPath $backup) { throw 'NATIVE_SOURCE_RECEIPT_BACKUP_REMAINS' }
    }
    elseif (Test-Path -LiteralPath $Path) { throw 'NATIVE_SOURCE_RECEIPT_DESTINATION_UNEXPECTED' }
    else { Move-Item -LiteralPath $temp -Destination $Path -ErrorAction Stop }
    if (Test-Path -LiteralPath $temp) { throw 'NATIVE_SOURCE_TEMP_REMAINS' }
  } finally {
    if (Test-Path -LiteralPath $temp -PathType Leaf) { Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue }
  }
}
function Copy-PrivateBytes([string]$Path,[byte[]]$Bytes) {
  [IO.File]::WriteAllBytes($Path,$Bytes)
  Set-PrivateFileAcl $Path
}
function Write-SourceSnapshotMetadata([string]$SnapshotPath,$Metadata) {
  $path=Join-Path $SnapshotPath 'snapshot.json'
  $bytes=[Text.Encoding]::UTF8.GetBytes(($Metadata | ConvertTo-Json -Depth 8 -Compress))
  Write-BytesAtomic $path $bytes
}
function Assert-SourceConsumersStopped($InstallReceipt) {
  $consumers=@(
    [pscustomobject]@{name=$taskSupervisor;registered=[bool]$InstallReceipt.supervisorTaskRegistered;kind='supervisor'},
    [pscustomobject]@{name=$taskDashboard;registered=[bool]$InstallReceipt.dashboardTaskRegistered;kind='dashboard'}
  )
  if ([int]$InstallReceipt.option -in @(2,4)) { $consumers += [pscustomobject]@{name=$taskGhost;registered=[bool]$InstallReceipt.ghostTaskRegistered;kind='ghost'} }
  foreach ($consumer in $consumers) {
    $task=Get-Task $consumer.name
    if ([bool]$task -ne [bool]$consumer.registered) { throw 'NATIVE_SOURCE_CONSUMER_OWNERSHIP_UNKNOWN' }
    if (-not $task) {
      if (($consumer.kind -eq 'dashboard' -and (Test-Path -LiteralPath $dashboardReceipt)) -or
          ($consumer.kind -eq 'ghost' -and (Test-GhostOwnershipArtifacts)) -or
          ($consumer.kind -eq 'supervisor' -and [string]$InstallReceipt.supervisorConfig)) { throw 'NATIVE_SOURCE_CONSUMER_OWNERSHIP_UNKNOWN' }
      continue
    }
    if ([string]$task.TaskPath -cne '\') { throw 'NATIVE_SOURCE_CONSUMER_OWNERSHIP_UNKNOWN' }
    if ([string]$task.State -notin @('Ready','Disabled')) { throw 'NATIVE_SOURCE_CONSUMER_NOT_STOPPED' }
    if ($consumer.kind -eq 'supervisor') {
      $status=Get-SupervisorStatus (Join-Path $current 'bin/singularity-windows-supervisor.exe') ([string]$InstallReceipt.supervisorConfig)
      if ($status.registeredOwnedAndConfigured -ne $true) { throw 'NATIVE_SOURCE_CONSUMER_OWNERSHIP_UNKNOWN' }
    } elseif ($consumer.kind -eq 'dashboard') {
      $status=Invoke-Dashboard 'Verify' $false
      if ($status.taskRegistered -ne $true) { throw 'NATIVE_SOURCE_CONSUMER_OWNERSHIP_UNKNOWN' }
    } else {
      $status=Invoke-JsonScript $ghostManager @{Mode='Verify'} 'NATIVE_SOURCE_CONSUMER_VERIFY_FAILED'
      if ($status.taskRegistered -ne $true) { throw 'NATIVE_SOURCE_CONSUMER_OWNERSHIP_UNKNOWN' }
    }
  }
  try { $processes=@(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop) }
  catch { throw 'NATIVE_SOURCE_CONSUMER_STATE_UNKNOWN' }
  $sourceNeedle=(Join-Path $current 'source').TrimEnd('\')
  foreach ($process in $processes) {
    $name=[string]$process.Name
    $command=[string]$process.CommandLine
    # Refuse any process whose command line explicitly names the live source
    # tree, regardless of its image name; known runtimes with unreadable
    # metadata remain an unknown-consumer condition below.
    $pathHit=($command -and $command.IndexOf($sourceNeedle,[StringComparison]::OrdinalIgnoreCase) -ge 0)
    if ($pathHit) { throw 'NATIVE_SOURCE_CONSUMER_RUNNING' }
    if ($name -ieq 'singularity-windows-supervisor.exe') { throw 'NATIVE_SOURCE_CONSUMER_RUNNING' }
    if ($name -notmatch '^(?i:python|python3|node|codex|pwsh|powershell)\.exe$') { continue }
    if (-not $command) { throw 'NATIVE_SOURCE_CONSUMER_STATE_UNKNOWN' }
  }
}
function Read-SourceRefreshSnapshot([int]$ExpectedOption) {
  $snapshotPath=Join-Path $installRoot 'source-refresh-snapshot'
  $null=Assert-LocalPath $snapshotPath 'NATIVE_SOURCE_SNAPSHOT_INVALID' $true $true
  Assert-PrivateAcl $snapshotPath
  $metadataPath=Join-Path $snapshotPath 'snapshot.json'
  $null=Assert-LocalPath $metadataPath 'NATIVE_SOURCE_SNAPSHOT_INVALID' $true $false
  try { $metadata=Get-Content -LiteralPath $metadataPath -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop }
  catch { throw 'NATIVE_SOURCE_SNAPSHOT_INVALID' }
  if ($metadata.schema -cne 'singularity-native-source-refresh/v1' -or $metadata.state -cne 'REFRESHED' -or
      [int]$metadata.option -ne $ExpectedOption -or [string]$metadata.installRoot -cne $installRoot -or [string]$metadata.ownerSid -cne $ownerSid -or
      [string]$metadata.oldSourceManifestSha256 -notmatch '^[0-9a-f]{64}$' -or [string]$metadata.newSourceManifestSha256 -notmatch '^[0-9a-f]{64}$' -or
      [string]$metadata.bridgeSha256 -notmatch '^[0-9a-f]{64}$' -or [string]$metadata.supervisorSha256 -notmatch '^[0-9a-f]{64}$') { throw 'NATIVE_SOURCE_SNAPSHOT_INVALID' }
  $oldSource=Get-SourceTree (Join-Path $snapshotPath 'source') $ExpectedOption
  if ([string]$oldSource.manifestSha256 -cne [string]$metadata.oldSourceManifestSha256) { throw 'NATIVE_SOURCE_SNAPSHOT_SOURCE_MISMATCH' }
  $names=@('STAGING_RECEIPT.preimage.json','INSTALLATION_RECEIPT.preimage.json','STAGING_RECEIPT.refreshed.json','INSTALLATION_RECEIPT.refreshed.json')
  $expected=@($oldSource.files | ForEach-Object { 'source/'+[string]$_ }) + $names + @('snapshot.json')
  Assert-ExactFileInventory $snapshotPath $expected 'NATIVE_SOURCE_SNAPSHOT_UNOWNED_FILE_REFUSED'
  $oldStageBytes=[IO.File]::ReadAllBytes((Join-Path $snapshotPath $names[0]))
  $oldInstallBytes=[IO.File]::ReadAllBytes((Join-Path $snapshotPath $names[1]))
  $newStageBytes=[IO.File]::ReadAllBytes((Join-Path $snapshotPath $names[2]))
  $newInstallBytes=[IO.File]::ReadAllBytes((Join-Path $snapshotPath $names[3]))
  if ((Get-BytesSha256 $oldStageBytes) -cne [string]$metadata.stageReceiptPreimageSha256 -or
      (Get-BytesSha256 $oldInstallBytes) -cne [string]$metadata.installReceiptPreimageSha256 -or
      (Get-BytesSha256 $newStageBytes) -cne [string]$metadata.stageReceiptRefreshedSha256 -or
      (Get-BytesSha256 $newInstallBytes) -cne [string]$metadata.installReceiptRefreshedSha256) { throw 'NATIVE_SOURCE_SNAPSHOT_RECEIPT_HASH_MISMATCH' }
  $oldStage=Get-JsonObjectFromBytes $oldStageBytes 'NATIVE_SOURCE_SNAPSHOT_RECEIPT_INVALID'
  $oldInstall=Get-JsonObjectFromBytes $oldInstallBytes 'NATIVE_SOURCE_SNAPSHOT_RECEIPT_INVALID'
  $newStage=Get-JsonObjectFromBytes $newStageBytes 'NATIVE_SOURCE_SNAPSHOT_RECEIPT_INVALID'
  $newInstall=Get-JsonObjectFromBytes $newInstallBytes 'NATIVE_SOURCE_SNAPSHOT_RECEIPT_INVALID'
  if ([string]$oldStage.sourceManifestSha256 -cne [string]$metadata.oldSourceManifestSha256 -or
      [string]$oldInstall.sourceManifestSha256 -cne [string]$metadata.oldSourceManifestSha256 -or
      [string]$newStage.sourceManifestSha256 -cne [string]$metadata.newSourceManifestSha256 -or
      [string]$newInstall.sourceManifestSha256 -cne [string]$metadata.newSourceManifestSha256 -or
      [string]$oldStage.bridgeSha256 -cne [string]$metadata.bridgeSha256 -or [string]$newStage.bridgeSha256 -cne [string]$metadata.bridgeSha256 -or
      [string]$oldStage.supervisorSha256 -cne [string]$metadata.supervisorSha256 -or [string]$newStage.supervisorSha256 -cne [string]$metadata.supervisorSha256) {
    throw 'NATIVE_SOURCE_SNAPSHOT_RECEIPT_MISMATCH'
  }
  Assert-ReceiptNonSourceFieldsEqual $oldStage $newStage 'NATIVE_SOURCE_SNAPSHOT_STAGE_RECEIPT_DRIFT'
  Assert-ReceiptNonSourceFieldsEqual $oldInstall $newInstall 'NATIVE_SOURCE_SNAPSHOT_INSTALL_RECEIPT_DRIFT'
  return [pscustomobject]@{path=$snapshotPath;metadata=$metadata;oldSource=$oldSource;oldStageBytes=$oldStageBytes;oldInstallBytes=$oldInstallBytes;
    newStageBytes=$newStageBytes;newInstallBytes=$newInstallBytes;oldStage=$oldStage;oldInstall=$oldInstall;newStage=$newStage;newInstall=$newInstall}
}
function Invoke-SourceRefreshTransaction($Stage,$InstallReceipt,$OldTree,$CandidateTree) {
  $snapshotPath=Join-Path $installRoot 'source-refresh-snapshot'
  $candidatePath=Join-Path $installRoot '.source-refresh-candidate'
  $currentSource=Join-Path $current 'source'
  $stageReceiptPath=Join-Path $current 'STAGING_RECEIPT.json'
  if (Test-Path -LiteralPath $snapshotPath) { throw 'NATIVE_SOURCE_SNAPSHOT_EXISTS' }
  if (-not (Test-Path -LiteralPath $candidatePath -PathType Container)) { throw 'NATIVE_SOURCE_CANDIDATE_MISSING' }
  $oldStageBytes=[IO.File]::ReadAllBytes($stageReceiptPath)
  $oldInstallBytes=[IO.File]::ReadAllBytes($installReceiptPath)
  $oldStageObject=Get-JsonObjectFromBytes $oldStageBytes 'NATIVE_SOURCE_RECEIPT_INVALID'
  $oldInstallObject=Get-JsonObjectFromBytes $oldInstallBytes 'NATIVE_SOURCE_RECEIPT_INVALID'
  $newStageObject=Get-JsonObjectFromBytes $oldStageBytes 'NATIVE_SOURCE_RECEIPT_INVALID'
  $newInstallObject=Get-JsonObjectFromBytes $oldInstallBytes 'NATIVE_SOURCE_RECEIPT_INVALID'
  $newStageObject.sourceManifestSha256=[string]$CandidateTree.manifestSha256
  $newInstallObject.sourceManifestSha256=[string]$CandidateTree.manifestSha256
  Assert-ReceiptNonSourceFieldsEqual $oldStageObject $newStageObject 'NATIVE_SOURCE_STAGE_RECEIPT_FIELD_DRIFT'
  Assert-ReceiptNonSourceFieldsEqual $oldInstallObject $newInstallObject 'NATIVE_SOURCE_INSTALL_RECEIPT_FIELD_DRIFT'
  $newStageBytes=[Text.Encoding]::UTF8.GetBytes(($newStageObject | ConvertTo-Json -Depth 20 -Compress))
  $newInstallBytes=[Text.Encoding]::UTF8.GetBytes(($newInstallObject | ConvertTo-Json -Depth 20 -Compress))
  $metadata=[ordered]@{schema='singularity-native-source-refresh/v1';state='PREPARED';option=[int]$InstallReceipt.option;installRoot=$installRoot;ownerSid=$ownerSid;
    oldSourceManifestSha256=[string]$OldTree.manifestSha256;newSourceManifestSha256=[string]$CandidateTree.manifestSha256;
    bridgeSha256=([string]$Stage.receipt.bridgeSha256).ToLowerInvariant();supervisorSha256=([string]$Stage.receipt.supervisorSha256).ToLowerInvariant();
    stageReceiptPreimageSha256=(Get-BytesSha256 $oldStageBytes);installReceiptPreimageSha256=(Get-BytesSha256 $oldInstallBytes);
    stageReceiptRefreshedSha256=(Get-BytesSha256 $newStageBytes);installReceiptRefreshedSha256=(Get-BytesSha256 $newInstallBytes);
    oldSourceFileCount=[int]$OldTree.fileCount;newSourceFileCount=[int]$CandidateTree.fileCount}
  $created=$false
  try {
    New-Item -ItemType Directory -Path $snapshotPath -ErrorAction Stop | Out-Null
    $created=$true
    Set-PrivateDirectoryAcl $snapshotPath
    Copy-PrivateBytes (Join-Path $snapshotPath 'STAGING_RECEIPT.preimage.json') $oldStageBytes
    Copy-PrivateBytes (Join-Path $snapshotPath 'INSTALLATION_RECEIPT.preimage.json') $oldInstallBytes
    Copy-PrivateBytes (Join-Path $snapshotPath 'STAGING_RECEIPT.refreshed.json') $newStageBytes
    Copy-PrivateBytes (Join-Path $snapshotPath 'INSTALLATION_RECEIPT.refreshed.json') $newInstallBytes
    Write-SourceSnapshotMetadata $snapshotPath $metadata
    # Revalidate all three inputs and consumers at the final boundary. No task,
    # service, process, binary or external-state action is part of this mode.
    $oldNow=Get-SourceTree $currentSource ([int]$InstallReceipt.option)
    $candidateNow=Get-SourceTree $candidatePath ([int]$InstallReceipt.option)
    if ($oldNow.manifestSha256 -cne $OldTree.manifestSha256 -or $candidateNow.manifestSha256 -cne $CandidateTree.manifestSha256) { throw 'NATIVE_SOURCE_CANDIDATE_DRIFT_REFUSED' }
    $stageNow=Read-Stage $current ([int]$InstallReceipt.option)
    $installNow=Read-InstallReceipt $true
    Assert-SourceStageCoherence $stageNow $installNow $oldNow
    Assert-ReceiptNonSourceFieldsEqual $Stage.receipt $stageNow.receipt 'NATIVE_SOURCE_STAGE_RECEIPT_DRIFT_REFUSED'
    Assert-ReceiptNonSourceFieldsEqual $InstallReceipt $installNow 'NATIVE_SOURCE_INSTALL_RECEIPT_DRIFT_REFUSED'
    if ([string]$stageNow.receipt.bridgeSha256 -cne [string]$metadata.bridgeSha256 -or
        [string]$stageNow.receipt.supervisorSha256 -cne [string]$metadata.supervisorSha256) { throw 'NATIVE_SOURCE_BINARY_DRIFT_REFUSED' }
    Assert-SourceConsumersStopped $installNow
    if ((Get-BytesSha256 ([IO.File]::ReadAllBytes($stageReceiptPath))) -cne [string]$metadata.stageReceiptPreimageSha256 -or
        (Get-BytesSha256 ([IO.File]::ReadAllBytes($installReceiptPath))) -cne [string]$metadata.installReceiptPreimageSha256) { throw 'NATIVE_SOURCE_RECEIPT_DRIFT_REFUSED' }
    Move-Item -LiteralPath $currentSource -Destination (Join-Path $snapshotPath 'source') -ErrorAction Stop
    Move-Item -LiteralPath $candidatePath -Destination $currentSource -ErrorAction Stop
    Write-BytesAtomic $stageReceiptPath $newStageBytes
    Write-BytesAtomic $installReceiptPath $newInstallBytes
    $newTree=Get-SourceTree $currentSource ([int]$InstallReceipt.option)
    $newStage=Read-Stage $current ([int]$InstallReceipt.option)
    $newInstall=Read-InstallReceipt $true
    Assert-SourceStageCoherence $newStage $newInstall $newTree
    if ((Get-BytesSha256 ([IO.File]::ReadAllBytes($stageReceiptPath))) -cne [string]$metadata.stageReceiptRefreshedSha256 -or
        (Get-BytesSha256 ([IO.File]::ReadAllBytes($installReceiptPath))) -cne [string]$metadata.installReceiptRefreshedSha256) { throw 'NATIVE_SOURCE_RECEIPT_PROMOTION_MISMATCH' }
    $metadata.state='REFRESHED'
    Write-SourceSnapshotMetadata $snapshotPath $metadata
    return [pscustomobject]@{state='source_refreshed';sourceFileCount=$newTree.fileCount;sourceManifestSha256=$newTree.manifestSha256;
      binariesPreserved=$true;taskConfigurationPreserved=$true;rollbackAvailable=$true;releaseReady=$false}
  } catch {
    $failure=[string]$_.Exception.Message
    try {
      if (Test-Path -LiteralPath $currentSource -PathType Container) {
        $activeTree=Get-SourceTree $currentSource ([int]$InstallReceipt.option)
        if ($activeTree.manifestSha256 -ceq [string]$CandidateTree.manifestSha256) {
          $heldNew=Join-Path $snapshotPath 'refresh-source'
          if (Test-Path -LiteralPath $heldNew) { throw 'NATIVE_SOURCE_REFRESH_RECOVERY_SLOT_OCCUPIED' }
          Move-Item -LiteralPath $currentSource -Destination $heldNew -ErrorAction Stop
        } elseif ($activeTree.manifestSha256 -cne [string]$OldTree.manifestSha256) { throw 'NATIVE_SOURCE_REFRESH_RECOVERY_SOURCE_UNKNOWN' }
      }
      if (-not (Test-Path -LiteralPath $currentSource) -and (Test-Path -LiteralPath (Join-Path $snapshotPath 'source') -PathType Container)) {
        Move-Item -LiteralPath (Join-Path $snapshotPath 'source') -Destination $currentSource -ErrorAction Stop
      }
      Write-BytesAtomic $stageReceiptPath $oldStageBytes
      Write-BytesAtomic $installReceiptPath $oldInstallBytes
      $restoredTree=Get-SourceTree $currentSource ([int]$InstallReceipt.option)
      $restoredStage=Read-Stage $current ([int]$InstallReceipt.option)
      $restoredInstall=Read-InstallReceipt $true
      Assert-SourceStageCoherence $restoredStage $restoredInstall $restoredTree
      if ($restoredTree.manifestSha256 -cne [string]$OldTree.manifestSha256 -or
          (Get-BytesSha256 ([IO.File]::ReadAllBytes($stageReceiptPath))) -cne [string]$metadata.stageReceiptPreimageSha256 -or
          (Get-BytesSha256 ([IO.File]::ReadAllBytes($installReceiptPath))) -cne [string]$metadata.installReceiptPreimageSha256) { throw 'NATIVE_SOURCE_REFRESH_RECOVERY_READBACK_MISMATCH' }
      $metadata.state='REFRESH_FAILED_RECOVERED'
      Write-SourceSnapshotMetadata $snapshotPath $metadata
      throw 'RECOVERED'
    } catch {
      if ($_.Exception.Message -eq 'RECOVERED') { throw "NATIVE_SOURCE_REFRESH_FAILED_RECOVERED: $failure" }
      throw "NATIVE_SOURCE_REFRESH_RECOVERY_INCOMPLETE: $failure"
    }
  }
}
function Remove-VerifiedSourceTree([string]$Root,[int]$ExpectedOption,[string]$ExpectedManifestSha256) {
  $tree=Get-SourceTree $Root $ExpectedOption
  if ($tree.manifestSha256 -cne $ExpectedManifestSha256) { throw 'NATIVE_SOURCE_CLEANUP_MANIFEST_MISMATCH' }
  foreach ($relative in $tree.files) {
    $path=Join-Path $Root (([string]$relative) -replace '/',[IO.Path]::DirectorySeparatorChar)
    Remove-Item -LiteralPath $path -Force -ErrorAction Stop
  }
  $directories=@(Get-ChildItem -LiteralPath $Root -Directory -Recurse -Force -ErrorAction Stop | Sort-Object { $_.FullName.Length } -Descending)
  foreach ($directory in $directories) {
    if (@(Get-ChildItem -LiteralPath $directory.FullName -Force -ErrorAction Stop).Count -ne 0) { throw 'NATIVE_SOURCE_CLEANUP_DIRECTORY_NOT_EMPTY' }
    Remove-Item -LiteralPath $directory.FullName -Force -ErrorAction Stop
  }
  if (@(Get-ChildItem -LiteralPath $Root -Force -ErrorAction Stop).Count -ne 0) { throw 'NATIVE_SOURCE_CLEANUP_DIRECTORY_NOT_EMPTY' }
  Remove-Item -LiteralPath $Root -Force -ErrorAction Stop
}
function Remove-VerifiedSourceRefreshSnapshot($Snapshot) {
  $snapshotPath=[string]$Snapshot.path
  $metadata=$Snapshot.metadata
  if ($metadata.state -cne 'ROLLED_BACK') { throw 'NATIVE_SOURCE_SNAPSHOT_STATE_INVALID' }
  $newSource=Get-SourceTree (Join-Path $snapshotPath 'refresh-source') ([int]$metadata.option)
  if ($newSource.manifestSha256 -cne [string]$metadata.newSourceManifestSha256) { throw 'NATIVE_SOURCE_SNAPSHOT_REFRESH_SOURCE_MISMATCH' }
  $receiptNames=@('STAGING_RECEIPT.preimage.json','INSTALLATION_RECEIPT.preimage.json','STAGING_RECEIPT.refreshed.json','INSTALLATION_RECEIPT.refreshed.json')
  $expected=@($newSource.files | ForEach-Object { 'refresh-source/'+[string]$_ }) + $receiptNames + @('snapshot.json')
  Assert-ExactFileInventory $snapshotPath $expected 'NATIVE_SOURCE_SNAPSHOT_UNOWNED_FILE_REFUSED'
  foreach ($pair in @(
      @($receiptNames[0],[string]$metadata.stageReceiptPreimageSha256),
      @($receiptNames[1],[string]$metadata.installReceiptPreimageSha256),
      @($receiptNames[2],[string]$metadata.stageReceiptRefreshedSha256),
      @($receiptNames[3],[string]$metadata.installReceiptRefreshedSha256))) {
    if ((Get-BytesSha256 ([IO.File]::ReadAllBytes((Join-Path $snapshotPath $pair[0])))) -cne [string]$pair[1]) { throw 'NATIVE_SOURCE_SNAPSHOT_RECEIPT_HASH_MISMATCH' }
  }
  Remove-VerifiedSourceTree (Join-Path $snapshotPath 'refresh-source') ([int]$metadata.option) ([string]$metadata.newSourceManifestSha256)
  foreach ($name in $receiptNames + @('snapshot.json')) { Remove-Item -LiteralPath (Join-Path $snapshotPath $name) -Force -ErrorAction Stop }
  if (@(Get-ChildItem -LiteralPath $snapshotPath -Force -ErrorAction Stop).Count -ne 0) { throw 'NATIVE_SOURCE_SNAPSHOT_NOT_EMPTY' }
  Remove-Item -LiteralPath $snapshotPath -Force -ErrorAction Stop
}
function Invoke-SourceRollbackTransaction($Snapshot,$InstallReceipt) {
  $snapshotPath=[string]$Snapshot.path
  $currentSource=Join-Path $current 'source'
  $stageReceiptPath=Join-Path $current 'STAGING_RECEIPT.json'
  $metadata=$Snapshot.metadata
  if (Test-Path -LiteralPath (Join-Path $snapshotPath 'refresh-source')) { throw 'NATIVE_SOURCE_SNAPSHOT_TRANSACTION_UNRESOLVED' }
  try {
    $metadata.state='ROLLBACK_PREPARED'
    Write-SourceSnapshotMetadata $snapshotPath $metadata
    $stageNow=Read-Stage $current ([int]$InstallReceipt.option)
    $installNow=Read-InstallReceipt $true
    $currentTree=Get-SourceTree $currentSource ([int]$InstallReceipt.option)
    Assert-SourceStageCoherence $stageNow $installNow $currentTree
    if ($currentTree.manifestSha256 -cne [string]$metadata.newSourceManifestSha256 -or
        (Get-BytesSha256 ([IO.File]::ReadAllBytes($stageReceiptPath))) -cne [string]$metadata.stageReceiptRefreshedSha256 -or
        (Get-BytesSha256 ([IO.File]::ReadAllBytes($installReceiptPath))) -cne [string]$metadata.installReceiptRefreshedSha256) { throw 'NATIVE_SOURCE_ROLLBACK_CURRENT_DRIFT' }
    Assert-SourceConsumersStopped $installNow
    Move-Item -LiteralPath $currentSource -Destination (Join-Path $snapshotPath 'refresh-source') -ErrorAction Stop
    Move-Item -LiteralPath (Join-Path $snapshotPath 'source') -Destination $currentSource -ErrorAction Stop
    Write-BytesAtomic $stageReceiptPath $Snapshot.oldStageBytes
    Write-BytesAtomic $installReceiptPath $Snapshot.oldInstallBytes
    $restoredTree=Get-SourceTree $currentSource ([int]$InstallReceipt.option)
    $restoredStage=Read-Stage $current ([int]$InstallReceipt.option)
    $restoredInstall=Read-InstallReceipt $true
    Assert-SourceStageCoherence $restoredStage $restoredInstall $restoredTree
    if ($restoredTree.manifestSha256 -cne [string]$metadata.oldSourceManifestSha256 -or
        (Get-BytesSha256 ([IO.File]::ReadAllBytes($stageReceiptPath))) -cne [string]$metadata.stageReceiptPreimageSha256 -or
        (Get-BytesSha256 ([IO.File]::ReadAllBytes($installReceiptPath))) -cne [string]$metadata.installReceiptPreimageSha256) { throw 'NATIVE_SOURCE_ROLLBACK_READBACK_MISMATCH' }
    $metadata.state='ROLLED_BACK'
    Write-SourceSnapshotMetadata $snapshotPath $metadata
  } catch {
    $failure=[string]$_.Exception.Message
    try {
      $heldNew=Join-Path $snapshotPath 'refresh-source'
      if (Test-Path -LiteralPath $currentSource -PathType Container) {
        $activeTree=Get-SourceTree $currentSource ([int]$InstallReceipt.option)
        if ($activeTree.manifestSha256 -ceq [string]$metadata.oldSourceManifestSha256) {
          if (Test-Path -LiteralPath (Join-Path $snapshotPath 'source')) { throw 'NATIVE_SOURCE_ROLLBACK_RECOVERY_SLOT_OCCUPIED' }
          Move-Item -LiteralPath $currentSource -Destination (Join-Path $snapshotPath 'source') -ErrorAction Stop
        } elseif ($activeTree.manifestSha256 -cne [string]$metadata.newSourceManifestSha256) { throw 'NATIVE_SOURCE_ROLLBACK_RECOVERY_SOURCE_UNKNOWN' }
      }
      if (-not (Test-Path -LiteralPath $currentSource) -and (Test-Path -LiteralPath $heldNew -PathType Container)) {
        Move-Item -LiteralPath $heldNew -Destination $currentSource -ErrorAction Stop
      }
      if (-not (Test-Path -LiteralPath $currentSource -PathType Container)) { throw 'NATIVE_SOURCE_ROLLBACK_RECOVERY_SOURCE_MISSING' }
      Write-BytesAtomic $stageReceiptPath $Snapshot.newStageBytes
      Write-BytesAtomic $installReceiptPath $Snapshot.newInstallBytes
      $recoveredTree=Get-SourceTree $currentSource ([int]$InstallReceipt.option)
      $recoveredStage=Read-Stage $current ([int]$InstallReceipt.option)
      $recoveredInstall=Read-InstallReceipt $true
      Assert-SourceStageCoherence $recoveredStage $recoveredInstall $recoveredTree
      if ($recoveredTree.manifestSha256 -cne [string]$metadata.newSourceManifestSha256 -or
          (Get-BytesSha256 ([IO.File]::ReadAllBytes($stageReceiptPath))) -cne [string]$metadata.stageReceiptRefreshedSha256 -or
          (Get-BytesSha256 ([IO.File]::ReadAllBytes($installReceiptPath))) -cne [string]$metadata.installReceiptRefreshedSha256) { throw 'NATIVE_SOURCE_ROLLBACK_RECOVERY_READBACK_MISMATCH' }
      $metadata.state='REFRESHED'
      Write-SourceSnapshotMetadata $snapshotPath $metadata
      throw 'RECOVERED'
    } catch {
      if ($_.Exception.Message -eq 'RECOVERED') { throw "NATIVE_SOURCE_ROLLBACK_FAILED_RECOVERED: $failure" }
      throw "NATIVE_SOURCE_ROLLBACK_RECOVERY_INCOMPLETE: $failure"
    }
  }
  # Cleanup is a separate, manifest-verified phase. If it is interrupted, the
  # old source and exact receipts are already active; the remaining snapshot
  # blocks another refresh until an operator reviews it.
  Remove-VerifiedSourceRefreshSnapshot $Snapshot
  return [pscustomobject]@{state='source_rolled_back';sourceManifestSha256=[string]$metadata.oldSourceManifestSha256;
    binariesPreserved=$true;taskConfigurationPreserved=$true;userStatePreserved=$true;rollbackAvailable=$false;releaseReady=$false}
}
function Remove-VerifiedStage([string]$StagePath,[int]$ExpectedOption) {
  $stage=Read-Stage $StagePath $ExpectedOption -AllowLegacyGhost
  if (-not $stage) { return }
  foreach ($file in $stage.files) { Remove-Item -LiteralPath $file -Force -ErrorAction Stop }
  $directories=@(Get-ChildItem -LiteralPath $StagePath -Directory -Recurse -Force | Sort-Object { $_.FullName.Length } -Descending)
  foreach ($directory in $directories) {
    if (@(Get-ChildItem -LiteralPath $directory.FullName -Force).Count -ne 0) { throw 'NATIVE_STAGE_DIRECTORY_NOT_EMPTY' }
    Remove-Item -LiteralPath $directory.FullName -Force -ErrorAction Stop
  }
  if (@(Get-ChildItem -LiteralPath $StagePath -Force).Count -ne 0) { throw 'NATIVE_STAGE_DIRECTORY_NOT_EMPTY' }
  Remove-Item -LiteralPath $StagePath -Force -ErrorAction Stop
}
function Get-Task([string]$Name) {
  try { $all=@(Get-ScheduledTask -ErrorAction Stop) } catch { throw 'NATIVE_SCHEDULER_UNAVAILABLE' }
  $matches=@($all | Where-Object { $_.TaskName -ceq $Name })
  if ($matches.Count -gt 1) { throw 'NATIVE_TASK_AMBIGUOUS' }
  if ($matches.Count -eq 0) { return $null }
  return $matches[0]
}
# One source of truth for the task-registration booleans in the receipt and in
# every Emit-Result payload: the real scheduler state, never an install option.
function Get-RegisteredTaskState {
  return [ordered]@{
    supervisorTaskRegistered=[bool](Get-Task $taskSupervisor)
    dashboardTaskRegistered=[bool](Get-Task $taskDashboard)
    ghostTaskRegistered=[bool](Get-Task $taskGhost)
    officeTaskRegistered=[bool](Get-Task $taskOffice)
  }
}
function Stop-OrphanOfficeTask($Task) {
  # Stop only the exact product-owned task. A missing office-install.json means
  # there is no child manager to verify ownership, so this path refuses a
  # non-root task path and proves the task left Running.
  if ([string]$Task.TaskPath -cne '\') { throw 'NATIVE_OFFICE_TASK_PATH_MISMATCH' }
  if ([string]$Task.State -ne 'Running') { return }
  Stop-ScheduledTask -TaskName $taskOffice -TaskPath ([string]$Task.TaskPath) -ErrorAction Stop
  $deadline=[DateTime]::UtcNow.AddSeconds(10)
  do {
    Start-Sleep -Milliseconds 250
    $after=Get-Task $taskOffice
    if (-not $after) { break }
    if ([string]$after.TaskPath -cne '\') { throw 'NATIVE_OFFICE_TASK_PATH_MISMATCH' }
    if ([string]$after.State -ne 'Running') { break }
  } while ([DateTime]::UtcNow -lt $deadline)
  if ($after -and [string]$after.State -eq 'Running') { throw 'NATIVE_OFFICE_TASK_STOP_READBACK_FAILED' }
}
function Invoke-JsonScript([string]$Path,[hashtable]$Arguments,[string]$FailureCode) {
  try { $childOutput=@(& $Path @Arguments 2>$null) }
  catch { throw $FailureCode }
  if ($childOutput.Count -eq 0) { throw $FailureCode }
  try { return ($childOutput[-1] | ConvertFrom-Json -ErrorAction Stop) }
  catch { throw $FailureCode }
}
function Get-SupervisorStatus([string]$SupervisorPath,[string]$ConfigPath) {
  if (-not (Test-Path -LiteralPath $supervisorVerifier -PathType Leaf)) { throw 'NATIVE_SUPERVISOR_VERIFIER_MISSING' }
  try { $childOutput=@(& $supervisorVerifier -SupervisorExe $SupervisorPath -ConfigPath $ConfigPath 2>$null) }
  catch { throw 'NATIVE_SUPERVISOR_READBACK_FAILED' }
  if ($childOutput.Count -eq 0) { throw 'NATIVE_SUPERVISOR_READBACK_FAILED' }
  try { return ($childOutput[-1] | ConvertFrom-Json -ErrorAction Stop) }
  catch { throw 'NATIVE_SUPERVISOR_READBACK_FAILED' }
}
function Invoke-Dashboard([string]$ChildMode,[bool]$Mutate,[bool]$DryRun=$false) {
  $childArgs=@{Mode=$ChildMode;Variant=$Option;Port=$DashboardPort}
  if ($Mutate) { $childArgs.Apply=$true; $childArgs.Confirm=$false }
  if ($DryRun) { $childArgs.WhatIf=$true }
  if ($ChildMode -eq 'Register') {
    $childArgs.StagedSource=(Join-Path $current 'source');$childArgs.PythonExe=$PythonExe;$childArgs.RepoqlExe=$RepoqlExe;$childArgs.Workspace=$Workspace
  }
  return Invoke-JsonScript $dashboardManager $childArgs 'NATIVE_DASHBOARD_MANAGER_FAILED'
}
function Invoke-Ghost([string]$ChildMode,[bool]$Mutate,[bool]$DryRun=$false) {
  $childArgs=@{Mode=$ChildMode;InstallRoot=$installRoot}
  if ($Mutate) { $childArgs.Apply=$true; $childArgs.Confirm=$false }
  if ($DryRun) { $childArgs.WhatIf=$true }
  if ($ChildMode -in @('Plan','Register')) {
    $hostBase=if ($ChildMode -eq 'Plan') { $SourceRoot } else { Join-Path $current 'source' }
    $childArgs.HostScript=Join-Path $hostBase 'native/windows/ghost_scheduler_host.py'
    $childArgs.PythonExe=$PythonExe;$childArgs.RunnerExe=$RunnerExe;$childArgs.Workspace=$Workspace
    $childArgs.DraftStateDirectory=$dashboardState;$childArgs.Port=$GhostPort;$childArgs.Sandbox=$Sandbox;$childArgs.RunTimeoutSeconds=$RunTimeoutSeconds
  }
  return Invoke-JsonScript $ghostManager $childArgs 'NATIVE_GHOST_MANAGER_FAILED'
}
function Invoke-Office([string]$ChildMode,[bool]$Mutate,[bool]$DryRun=$false) {
  $childArgs=@{Mode=$ChildMode;InstallRoot=$officeRoot;Port=$OfficePort;TaskName=$taskOffice}
  if ($Mutate) { $childArgs.Apply=$true; $childArgs.Confirm=$false }
  if ($DryRun) { $childArgs.WhatIf=$true }
  if ($ChildMode -eq 'Install') {
    $childArgs.OfficeSource=$OfficeSource;$childArgs.PythonExe=$OfficePythonExe
    if ($OfficeWheelhouse) { $childArgs.Wheelhouse=$OfficeWheelhouse }
    if ($OfficeAllowNetwork) { $childArgs.AllowNetwork=$true }
    if (-not (Test-Path -LiteralPath (Join-Path $OfficeSource '.git'))) { $childArgs.AllowUnpinnedSource=$true }
  }
  return Invoke-JsonScript $officeManager $childArgs 'NATIVE_OFFICE_MANAGER_FAILED'
}
# --- A3 memory lifecycle + generated supervisor config ---
function Get-MemoryNode {
  if ($NodeExe) { return (Assert-LocalPath $NodeExe 'NATIVE_MEMORY_NODE_INVALID' $true $false) }
  $runtime=Join-Path $base 'runtime'
  if (Test-Path -LiteralPath $runtime -PathType Container) {
    $candidates=@(Get-ChildItem -LiteralPath $runtime -Directory -Filter 'node-*' | Sort-Object Name -Descending | ForEach-Object { Join-Path $_.FullName 'node.exe' } | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf })
    if ($candidates.Count -gt 0) { return $candidates[0] }
  }
  $command=Get-Command 'node.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($command -and $command.Source -and (Test-Path -LiteralPath $command.Source -PathType Leaf)) { return $command.Source }
  throw 'NATIVE_MEMORY_NODE_REQUIRED'
}
function Stop-MemoryStackIfPresent {
  if (-not (Test-Path -LiteralPath $memoryConfig -PathType Leaf)) { return }
  $manifest=Join-Path $memoryRoot 'state\supervisor.json'
  try { $null=Invoke-MemoryStack 'stop' }
  catch {
    # A stale config can fail validation before the manifest is read. With no
    # manifest there are no ownership records, so there is nothing to stop.
    if (Test-Path -LiteralPath $manifest) { throw ("NATIVE_MEMORY_STOP_FAILED: " + $_.Exception.Message) }
  }
}
function Initialize-MemorySecrets {
  if (-not $MemorySecretsSource) { return $false }
  $source=Assert-LocalPath $MemorySecretsSource 'NATIVE_MEMORY_SECRETS_SOURCE_INVALID' $true $true
  $destination=Join-Path $memoryRoot 'state\secrets'
  if (-not (Test-Path -LiteralPath $destination -PathType Container)) { Set-PrivateDirectoryAcl $destination }
  $names=@('router-access-key','groq-api-key','cohere-api-key')
  $names += @(Get-ChildItem -LiteralPath $source -File -Force -ErrorAction Stop | Where-Object { $_.Name -match '^[A-Za-z0-9][A-Za-z0-9._-]*-api-(key|provider\.json)$' } | ForEach-Object { $_.Name })
  foreach ($name in @($names | Sort-Object -Unique)) {
    $from=Join-Path $source $name
    if (-not (Test-Path -LiteralPath $from -PathType Leaf)) { continue }
    $to=Join-Path $destination $name
    Copy-Item -LiteralPath $from -Destination $to -Force -ErrorAction Stop
    Set-PrivateFileAcl $to
  }
  if (Test-Path -LiteralPath (Join-Path $destination 'router-access-key') -PathType Leaf) { return $true }
  throw 'NATIVE_MEMORY_ROUTER_KEY_REQUIRED'
}
function New-MemoryStackConfig {
  if (-not (Test-Path -LiteralPath $memoryBuilder -PathType Leaf)) { return $false }
  if (-not (Test-Path -LiteralPath (Join-Path $memoryBuildRoot 'MemoryCore') -PathType Container) -or
      -not (Test-Path -LiteralPath (Join-Path $memoryBuildRoot 'MemoryPanel') -PathType Container)) { return $false }
  if (-not (Test-Path -LiteralPath (Join-Path $memoryRoot 'state\secrets\router-access-key') -PathType Leaf)) { return $false }
  $node=Get-MemoryNode
  $builderArgs=@('--root',$memoryRoot,'--output',$memoryConfig,'--node',$node,'--source-root',$memorySourceRoot,'--build-root',$memoryBuildRoot,'--gateway-script',(Join-Path $current 'source/scripts/extraction-failover.mjs'))
  & $PythonExe $memoryBuilder @builderArgs | Out-Null
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $memoryConfig -PathType Leaf)) { throw 'NATIVE_MEMORY_CONFIG_GENERATION_FAILED' }
  return $true
}
function Invoke-MemoryStack([string]$Verb) {
  if (-not (Test-Path -LiteralPath $memoryBuilder -PathType Leaf)) { throw 'NATIVE_MEMORY_CONFIG_BUILDER_MISSING' }
  $node=Get-MemoryNode
  if ($Verb -eq 'prepare') {
    $builderArgs=@('--root',$memoryRoot,'--output',$memoryConfig,'--node',$node,'--source-root',$memorySourceRoot,'--build-root',$memoryBuildRoot,'--gateway-script',(Join-Path $current 'source/scripts/extraction-failover.mjs'))
    & $PythonExe $memoryBuilder @builderArgs | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'NATIVE_MEMORY_CONFIG_GENERATION_FAILED' }
  }
  if (-not (Test-Path -LiteralPath $memoryConfig -PathType Leaf)) { throw 'NATIVE_MEMORY_CONFIG_MISSING' }
  $supervisor=Join-Path $current 'source/scripts/native-memory-supervisor.mjs'
  if (-not (Test-Path -LiteralPath $supervisor -PathType Leaf)) { throw 'NATIVE_MEMORY_SUPERVISOR_MISSING' }
  try { $lines=@(& $node $supervisor $Verb --config $memoryConfig --json 2>$null) } catch { throw 'NATIVE_MEMORY_SUPERVISOR_FAILED' }
  if ($lines.Count -eq 0) { throw 'NATIVE_MEMORY_SUPERVISOR_FAILED' }
  $text=($lines | ForEach-Object { [string]$_ }) -join "`n"
  try { $result=$text.Trim() | ConvertFrom-Json -ErrorAction Stop } catch { throw 'NATIVE_MEMORY_SUPERVISOR_INVALID' }
  if ($Verb -eq 'verify' -and $result.ok -ne $true) { throw 'NATIVE_MEMORY_VERIFY_FAILED' }
  return $result
}
# First-start identity provisioning. The reference stack performs the equivalent in
# memory/upstream/start-memory-core.sh (init-admin -> admin user + default team),
# but the native lifecycle only generated stack.json, so a fresh install shipped
# a MemoryCore with 0 users / 0 teams / 0 agents. Every consumer then wrote under
# fleet identity names (team openchamber-agents, agent claude-code-main) that had
# never been registered, and MetadataService.ensureChatMemoryAsset() threw
# agent_not_found on each /v3/conversation/add. provision_memory_identity.mjs
# closes that gap: init-admin with a persisted key, the product team + literal
# agent ids, and state/identity-map.json for the delegated roles.
function Wait-MemoryHealthy([int]$TimeoutSeconds=120) {
  $deadline=(Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    try { $status=Invoke-MemoryStack 'status' } catch { $status=$null }
    if ($status -and $status.ok -eq $true) { return $true }
    Start-Sleep -Seconds 3
  }
  return $false
}
function Invoke-MemoryIdentityProvision {
  $provisioner=Join-Path $PSScriptRoot 'provision_memory_identity.mjs'
  if (-not (Test-Path -LiteralPath $provisioner -PathType Leaf)) { throw 'NATIVE_MEMORY_IDENTITY_PROVISIONER_MISSING' }
  if (-not (Test-Path -LiteralPath $memoryConfig -PathType Leaf)) { throw 'NATIVE_MEMORY_CONFIG_MISSING' }
  if (-not (Wait-MemoryHealthy 120)) { throw 'NATIVE_MEMORY_IDENTITY_PROVISION_CORE_UNHEALTHY' }
  $node=Get-MemoryNode
  # Conflict policy: the provisioner exits nonzero when a requested agent id
  # already belongs to another team. It never steals the row, writes the map
  # without that id, and fails Start rather than report
  # memoryIdentityProvisioned for conflicted ids.
  # stdout is the JSON receipt only; the SQLite experimental warning and the
  # progress log go to stderr and are dropped here so the receipt stays parseable.
  $lines=@(& $node $provisioner --memory-root $memoryRoot --json 2>$null)
  $code=$LASTEXITCODE
  if ($code -ne 0) { throw 'NATIVE_MEMORY_IDENTITY_PROVISION_FAILED' }
  if ($lines.Count -eq 0) { throw 'NATIVE_MEMORY_IDENTITY_PROVISION_FAILED' }
  $text=($lines | ForEach-Object { [string]$_ }) -join "`n"
  try { return ($text.Trim() | ConvertFrom-Json -ErrorAction Stop) } catch { throw 'NATIVE_MEMORY_IDENTITY_PROVISION_INVALID' }
}
function New-GeneratedSupervisorConfig {
  if (-not (Test-Path -LiteralPath $supervisorBuilder -PathType Leaf)) { throw 'NATIVE_SUPERVISOR_CONFIG_BUILDER_MISSING' }
  if (-not (Test-Path -LiteralPath $dashboardState -PathType Container)) { Set-PrivateDirectoryAcl $dashboardState }
  $script:SupervisorConfig=Join-Path $installRoot 'supervisor.json'
  $builderArgs=@(
    '--install-root',$installRoot,'--source-root',(Join-Path $current 'source'),'--bin-dir',(Join-Path $current 'bin'),
    '--python',$PythonExe,'--repoql',$RepoqlExe,'--workspace',$Workspace,
    '--ghost-config',$ghostConfig,'--ghost-client-config',$ghostClientConfig,
    '--dashboard-state',$dashboardState,'--memory-root',$memoryRoot,
    '--memory-build-root',$memoryBuildRoot,'--memory-stack-config',$memoryConfig,
    '--memory-supervisor',(Join-Path $current 'source/scripts/native-memory-supervisor.mjs'),
    '--output',$SupervisorConfig)
  # Dashboard, Ghost and Office each own a dedicated scheduled task. The Rust
  # supervisor owns only the memory stack, so Start never binds the same port twice.
  $builderArgs += @('--skip-office','--skip-dashboard','--skip-ghost')
  if ($NodeExe) { $builderArgs += @('--node',$NodeExe) }
  elseif (Test-Path -LiteralPath (Join-Path $memoryBuildRoot 'MemoryCore') -PathType Container) { $builderArgs += @('--node',(Get-MemoryNode)) }
  & $PythonExe $supervisorBuilder @builderArgs | Out-Null
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $SupervisorConfig -PathType Leaf)) { throw 'NATIVE_SUPERVISOR_CONFIG_GENERATION_FAILED' }
  $script:SupervisorConfig=Test-SupervisorConfig $SupervisorConfig
}
# --- end A3 memory lifecycle ---
function Test-SupervisorConfig([string]$PathValue) {
  $full=Assert-LocalPath $PathValue 'SUPERVISOR_CONFIG_REQUIRED' $true $false
  if (-not $full.StartsWith($base+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'SUPERVISOR_CONFIG_OUTSIDE_PRIVATE_ROOT' }
  Assert-PrivateAcl (Split-Path -Parent $full)
  return $full
}
function Assert-CleanInstallScope([bool]$AllowRootReceipt) {
  if ((Test-Path -LiteralPath $current) -or (Test-Path -LiteralPath $previous)) { throw 'NATIVE_UNOWNED_OR_EXISTING_STAGE_REFUSED' }
  $dashboardTaskNow=Get-Task $taskDashboard
  $supervisorTaskNow=Get-Task $taskSupervisor
  if ($dashboardTaskNow -or $supervisorTaskNow) { throw 'NATIVE_EXISTING_TASK_REQUIRES_OWNERSHIP_REVIEW' }
  if ((Get-Task $taskGhost)) { throw 'NATIVE_EXISTING_TASK_REQUIRES_OWNERSHIP_REVIEW' }
  if ($dashboardReceipt -and (Test-Path -LiteralPath $dashboardReceipt)) { throw 'NATIVE_EXISTING_RECEIPT_REQUIRES_OWNERSHIP_REVIEW' }
  if ($hasOffice -and ((Test-Path -LiteralPath $officeRoot) -or (Test-Path -LiteralPath $officeReceipt) -or (Get-Task $taskOffice))) { throw 'NATIVE_EXISTING_RECEIPT_REQUIRES_OWNERSHIP_REVIEW' }
  if ((Test-GhostOwnershipArtifacts)) { throw 'NATIVE_EXISTING_RECEIPT_REQUIRES_OWNERSHIP_REVIEW' }
  if ((Test-Path -LiteralPath $installReceiptPath) -and -not $AllowRootReceipt) { throw 'NATIVE_ALREADY_INSTALLED_USE_REINSTALL' }
}
function Assert-InstallInputs {
  $script:SourceRoot=Assert-LocalPath $SourceRoot 'SOURCE_ROOT_REQUIRED' $true $true
  $script:BridgeExe=Assert-LocalPath $BridgeExe 'BRIDGE_EXE_REQUIRED' $true $false
  $script:SupervisorExe=Assert-LocalPath $SupervisorExe 'SUPERVISOR_EXE_REQUIRED' $true $false
  $script:RepoqlExe=Assert-LocalPath $RepoqlExe 'REPOQL_EXE_REQUIRED' $true $false
  $script:PythonExe=Assert-LocalPath $PythonExe 'PYTHON_EXE_REQUIRED' $true $false
  $script:Workspace=Assert-LocalPath $Workspace 'WORKSPACE_REQUIRED' $true $true
  if ($SupervisorConfig) { $script:SupervisorConfig=Test-SupervisorConfig $SupervisorConfig } else { $script:SupervisorConfig='' }
  if ([IO.Path]::GetFileName($PythonExe) -notin @('python.exe','python3.exe')) { throw 'PYTHON_EXE_INVALID' }
  if ($hasOffice) {
    $script:OfficeSource=Assert-LocalPath $OfficeSource 'OFFICE_SOURCE_REQUIRED_FOR_OPTION_2' $true $true
    $script:OfficePythonExe=Assert-LocalPath $OfficePythonExe 'OFFICE_PYTHON_313_REQUIRED_FOR_OPTION_2' $true $false
    if ([IO.Path]::GetFileName($OfficePythonExe) -notin @('python.exe','python3.exe')) { throw 'OFFICE_PYTHON_EXE_INVALID' }
    if (-not $OfficeAllowNetwork -and -not $OfficeWheelhouse) { throw 'OFFICE_DEPENDENCY_SOURCE_REQUIRED' }
    if ($OfficeWheelhouse) { $script:OfficeWheelhouse=Assert-LocalPath $OfficeWheelhouse 'OFFICE_WHEELHOUSE_INVALID' $true $true }
  } else {
    $script:OfficeSource='';$script:OfficePythonExe='';$script:OfficeWheelhouse=''
  }
  if ($GuiExe) { $script:GuiExe=Assert-LocalPath $GuiExe 'OPTIONAL_GUI_EXE_INVALID' $true $false }
  if ($hasGhost) {
    $script:RunnerExe=Assert-LocalPath $RunnerExe 'CODEX_RUNNER_REQUIRED_FOR_GHOST' $true $false
    if ([IO.Path]::GetFileName($RunnerExe) -ine 'codex.exe') { throw 'CODEX_RUNNER_REQUIRED_FOR_GHOST' }
  }
}
function Invoke-Stage([bool]$ApplyStage) {
  $args=@{Option=$Option;SourceRoot=$SourceRoot;BridgeExe=$BridgeExe;SupervisorExe=$SupervisorExe;RepoqlExe=$RepoqlExe;InstallRoot=$installRoot}
  if ($GuiExe) { $args.GuiExe=$GuiExe }
  if ($ApplyStage) { $args.Apply=$true;$args.Confirm=$false }
  try { & $stageScript @args | Out-Null }
  catch { throw 'NATIVE_STAGE_OPERATION_FAILED' }
}
function Register-Components($Receipt) {
  if ($hasGhost) {
    $ghost=Invoke-Ghost 'Register' $true
    if (-not $ghost.taskRegistered) { throw 'NATIVE_GHOST_REGISTRATION_UNVERIFIED' }
    $Receipt.ghostTaskRegistered=$true; Write-InstallReceipt $Receipt
  }
  $null=Initialize-MemorySecrets
  $null=New-MemoryStackConfig
  if (-not $SupervisorConfig) { New-GeneratedSupervisorConfig }
  $Receipt.supervisorConfig=$SupervisorConfig
  $stagedSupervisor=Join-Path $current 'bin/singularity-windows-supervisor.exe'
  $supervisorArgs=@{SupervisorExe=$stagedSupervisor;ConfigPath=[string]$Receipt.supervisorConfig;Apply=$true;Confirm=$false}
  try { & $supervisorRegistrar @supervisorArgs | Out-Null }
  catch { throw ("NATIVE_SUPERVISOR_REGISTRATION_FAILED: " + $_.Exception.Message) }
  $Receipt.supervisorTaskRegistered=$true; $Receipt.state='partial'; Write-InstallReceipt $Receipt
  $dash=Invoke-Dashboard 'Register' $true
  if (-not $dash.taskRegistered) { throw 'NATIVE_DASHBOARD_REGISTRATION_UNVERIFIED' }
  $Receipt.dashboardTaskRegistered=$true; Write-InstallReceipt $Receipt
  if ($hasOffice) {
    $office=Invoke-Office 'Install' $true
    if (-not $office.taskRegistered) { throw 'NATIVE_OFFICE_REGISTRATION_UNVERIFIED' }
    $Receipt.officeTaskRegistered=$true; Write-InstallReceipt $Receipt
  } else {
    # Office is not part of THIS install (-SkipOffice), but the product-owned
    # task may already be registered by an Office-only install. Record the real
    # registration state instead of mirroring the install option.
    $Receipt.officeTaskRegistered=(Get-RegisteredTaskState).officeTaskRegistered
  }
  $Receipt.state='installed_not_started';$Receipt.guiIntegrationInstalled=$false;$Receipt.releaseReady=$false;Write-InstallReceipt $Receipt
}
function Get-SupervisorTask([string]$SupervisorPath,[string]$ConfigPath) {
  $status=Get-SupervisorStatus $SupervisorPath $ConfigPath
  if ($status.registeredOwnedAndConfigured -ne $true) { throw 'NATIVE_SUPERVISOR_TASK_NOT_OWNED' }
  return (Get-Task $taskSupervisor)
}
function Stop-Components($Receipt) {
  $supervisorPath=Join-Path $current 'bin/singularity-windows-supervisor.exe'
  $supervisorTaskNow=Get-Task $taskSupervisor
  if ($supervisorTaskNow -and [string]$supervisorTaskNow.TaskPath -cne '\') { throw 'NATIVE_SUPERVISOR_TASK_PATH_MISMATCH' }
  $s=$null
  if ($supervisorTaskNow) { $s=Get-SupervisorStatus $supervisorPath ([string]$Receipt.supervisorConfig) }
  $ghostReadback=$null
  $ghostTaskNow=$null
  if ($hasGhost) {
    try { $allTasks=@(Get-ScheduledTask -ErrorAction Stop) } catch { throw 'NATIVE_SCHEDULER_UNAVAILABLE' }
    if (@($allTasks | Where-Object { $_.TaskName -like 'Singularity-Ghost-Schedule-*' }).Count -gt 0) { throw 'NATIVE_GHOST_SCHEDULES_REMAIN_REFUSE_STOP' }
    $ghostTaskNow=Get-Task $taskGhost
    if ($ghostTaskNow) {
      $ghostReadback=Invoke-Ghost 'Verify' $false
      if (-not $ghostReadback.taskRegistered) { throw 'NATIVE_GHOST_TASK_NOT_OWNED' }
    } elseif (Test-GhostOwnershipArtifacts) {
      $null=Invoke-Ghost 'Remove' $true $true
    }
  }
  $dashboardTaskNow=Get-Task $taskDashboard
  if (Test-Path -LiteralPath $dashboardReceipt) {
    if ($dashboardTaskNow) { $null=Invoke-Dashboard 'Verify' $false }
    else { $null=Invoke-Dashboard 'Remove' $true $true }
  }
  if ($supervisorTaskNow) {
    if ($s.registeredOwnedAndConfigured -ne $true) { throw 'NATIVE_SUPERVISOR_TASK_NOT_OWNED' }
  }
  # Office is product-owned even when THIS install skipped it: stop the exact
  # task whether or not office-install.json survived.
  $officeTaskNow=Get-Task $taskOffice
  if ($officeTaskNow) {
    if (Test-Path -LiteralPath $officeReceipt) { $null=Invoke-Office 'Stop' $true }
    else { Stop-OrphanOfficeTask $officeTaskNow }
  }
  if ($hasGhost -and $ghostReadback -and $ghostReadback.taskRunning) { $null=Invoke-Ghost 'Stop' $true }
  if ($dashboardTaskNow) { $null=Invoke-Dashboard 'Stop' $true }
  if ($supervisorTaskNow -and [string]$supervisorTaskNow.State -eq 'Running') {
    Stop-ScheduledTask -TaskName $taskSupervisor -TaskPath ([string]$supervisorTaskNow.TaskPath) -ErrorAction Stop
    $deadline=[DateTime]::UtcNow.AddSeconds(10)
    do {
      Start-Sleep -Milliseconds 250
      $after=Get-Task $taskSupervisor
      if (-not $after) { break }
      if ([string]$after.TaskPath -cne '\') { throw 'NATIVE_SUPERVISOR_TASK_PATH_MISMATCH' }
      if ([string]$after.State -ne 'Running') { break }
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($after -and [string]$after.State -eq 'Running') { throw 'NATIVE_SUPERVISOR_TASK_STOP_READBACK_FAILED' }
  }
  Stop-MemoryStackIfPresent
}
function Remove-Components($Receipt) {
  Stop-MemoryStackIfPresent
  if ($hasOffice) {
    if (Test-Path -LiteralPath $officeReceipt) { $null=Invoke-Office 'Uninstall' $true }
    if (Get-Task $taskOffice) { throw 'NATIVE_OFFICE_REMOVAL_UNVERIFIED' }
  }
  if (Test-Path -LiteralPath $dashboardReceipt) { $null=Invoke-Dashboard 'Remove' $true }
  if ($hasGhost -and (Test-GhostOwnershipArtifacts)) { $null=Invoke-Ghost 'Remove' $true }
  $supervisorTaskNow=Get-Task $taskSupervisor
  if ($supervisorTaskNow) {
    if ([string]$supervisorTaskNow.TaskPath -cne '\') { throw 'NATIVE_SUPERVISOR_TASK_PATH_MISMATCH' }
    $supervisorPath=Join-Path $current 'bin/singularity-windows-supervisor.exe'
    $childArgs=@{SupervisorExe=$supervisorPath;ConfigPath=[string]$Receipt.supervisorConfig;Remove=$true;Apply=$true;Confirm=$false}
    try { & $supervisorRegistrar @childArgs | Out-Null } catch { throw 'NATIVE_SUPERVISOR_REMOVAL_FAILED' }
  }
  if (Get-Task $taskSupervisor) { throw 'NATIVE_SUPERVISOR_REMOVAL_UNVERIFIED' }
  $generatedConfig=[string]$Receipt.supervisorConfig
  if ($generatedConfig -and (Test-Path -LiteralPath $generatedConfig -PathType Leaf) -and $generatedConfig.StartsWith($installRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) {
    Remove-Item -LiteralPath $generatedConfig -Force -ErrorAction Stop
    if (Test-Path -LiteralPath $generatedConfig) { throw 'NATIVE_SUPERVISOR_CONFIG_REMOVAL_UNVERIFIED' }
  }
  if (Get-Task $taskDashboard) { throw 'NATIVE_DASHBOARD_REMOVAL_UNVERIFIED' }
  if ($hasGhost -and (Get-Task $taskGhost)) { throw 'NATIVE_GHOST_REMOVAL_UNVERIFIED' }
}
function Emit-Result($Data) { $Data | ConvertTo-Json -Depth 12 -Compress }

if (-not (Test-Path -LiteralPath $stageScript -PathType Leaf) -or -not (Test-Path -LiteralPath $dashboardManager -PathType Leaf) -or
    -not (Test-Path -LiteralPath $supervisorRegistrar -PathType Leaf) -or ($hasGhost -and -not (Test-Path -LiteralPath $ghostManager -PathType Leaf)) -or
    ($hasOffice -and -not (Test-Path -LiteralPath $officeManager -PathType Leaf))) { throw 'NATIVE_LIFECYCLE_COMPONENT_MISSING' }
if (-not $installRoot.StartsWith($base+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'INSTALL_ROOT_OUTSIDE_LOCALAPPDATA_SINGULARITY' }

if ($MemoryAction) {
  if ($Option -ne 2) { throw 'NATIVE_MEMORY_REQUIRES_COMPLETE_OPTION_2' }
  if (-not (Test-Path -LiteralPath $memoryRoot -PathType Container)) { New-Item -ItemType Directory -Path $memoryRoot -Force | Out-Null }
  $null=Assert-LocalPath $memoryRoot 'NATIVE_MEMORY_ROOT_INVALID' $true $true
  if ($MemoryAction -eq 'prepare' -and -not $PythonExe) { throw 'NATIVE_MEMORY_PYTHON_REQUIRED' }
  if ($MemoryAction -eq 'provision') { $memory=Invoke-MemoryIdentityProvision } else { $memory=Invoke-MemoryStack $MemoryAction }
  Emit-Result ([ordered]@{schema='singularity-native-memory-lifecycle/v1';action=$MemoryAction;root=$memoryRoot;changed=($MemoryAction -in @('prepare','start','stop','provision'));result=$memory})
  return
}
if ($ConnectorAction) {
  if (-not $RepoqlExe) { throw 'NATIVE_CONNECTOR_REPOQL_REQUIRED' }
  if (-not $PythonExe) { throw 'NATIVE_CONNECTOR_PYTHON_REQUIRED' }
  $repoqlPath=Assert-LocalPath $RepoqlExe 'NATIVE_CONNECTOR_REPOQL_INVALID' $true $false
  $pythonPath=Assert-LocalPath $PythonExe 'NATIVE_CONNECTOR_PYTHON_INVALID' $true $false
  $helper=Join-Path $PSScriptRoot 'provision_connectors.py'
  if (-not (Test-Path -LiteralPath $helper -PathType Leaf)) { throw 'NATIVE_CONNECTOR_HELPER_MISSING' }
  $connectorBuildRoot=if ($ConnectorBuildRoot) { $ConnectorBuildRoot } else { Join-Path $env:LOCALAPPDATA 'Singularity\connectors' }
  $connectorBuildRoot=Assert-LocalPath $connectorBuildRoot 'NATIVE_CONNECTOR_BUILD_ROOT_INVALID' $false $true
  if (-not $connectorBuildRoot.StartsWith($base+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'NATIVE_CONNECTOR_BUILD_ROOT_OUTSIDE_LOCALAPPDATA_SINGULARITY' }
  $argv=@($helper,'--action',$ConnectorAction,'--rql-exe',$repoqlPath,'--build-root',$connectorBuildRoot)
  if ($ConnectorAction -eq 'install') { $argv += @('--install-timeout','660','--auto-approve','--memory-data-root',(Join-Path $installRoot 'memory\state\data\core')) }
  $raw=& $pythonPath @argv 2>&1
  $text=($raw -join "`n").Trim()
  $exitCode=$LASTEXITCODE
  try { $result=$text | ConvertFrom-Json -ErrorAction Stop } catch { throw 'NATIVE_CONNECTOR_PROVISION_INVALID' }
  Emit-Result ([ordered]@{schema='singularity-native-connectors/v1';action=$ConnectorAction;buildRoot=$connectorBuildRoot;exitCode=$exitCode;result=$result;releaseReady=$false})
  if ($exitCode -ne 0) { exit $exitCode }
  return
}

if ($Mode -eq 'Plan') {
  Assert-InstallInputs
  Assert-CleanInstallScope $false
  Invoke-Stage $false
  $null=Invoke-Dashboard 'Plan' $false
  if ($hasGhost) {
    $null=Invoke-Ghost 'Plan' $false
  }
  if ($hasOffice) { $null=Invoke-Office 'Plan' $false }
  Emit-Result ([ordered]@{schema='singularity-native-windows-plan/v1';option=$Option;state='plan_validated';willModify=$false;
    guiOptional=$true;guiExecutableProvided=[bool]$GuiExe;guiIntegrationInstalled=$false;claudeRequired=$false;
    dashboardWillRegister=$true;ghostWillRegister=$hasGhost;officeWillRegister=$hasOffice;supervisorWillRegister=$true;supervisorConfigWillGenerate=(-not [bool]$SupervisorConfig);releaseReady=$false})
  return
}

if ($Mode -in @('Install','Reinstall')) {
  Assert-InstallInputs
  $receipt=Read-InstallReceipt ($Mode -eq 'Reinstall')
  if ($Mode -eq 'Install') { Assert-CleanInstallScope $false }
  else {
    if ([int]$receipt.option -ne $Option -or $receipt.state -notin @('installed_not_started','partial','reinstalling')) { throw 'NATIVE_REINSTALL_OWNERSHIP_OR_STATE_INVALID' }
    if (Test-Path -LiteralPath (Join-Path $installRoot 'source-refresh-snapshot')) { throw 'NATIVE_REINSTALL_SOURCE_SNAPSHOT_EXISTS' }
    $oldStage=Read-Stage $current $Option -AllowLegacyGhost
    if (-not $oldStage -and $receipt.state -notin @('partial','reinstalling')) { throw 'NATIVE_REINSTALL_STAGE_MISSING' }
    if ($oldStage) {
      $oldTree=Get-SourceTree (Join-Path $current 'source') $Option -AllowLegacyGhost
      Assert-SourceStageCoherence $oldStage $receipt $oldTree
    }
    if (Test-Path -LiteralPath $previous) { throw 'NATIVE_REINSTALL_PREVIOUS_SNAPSHOT_EXISTS' }
  }
  if (-not $PSCmdlet.ShouldProcess($installRoot,"$Mode native Windows option $Option (tasks registered, services not started)")) {
    Emit-Result ([ordered]@{schema='singularity-native-windows-lifecycle/v1';option=$Option;state='operation_planned';changed=$false;releaseReady=$false}); return
  }
  if ($Mode -eq 'Reinstall') {
    $script:hasGhost=[bool]($oldStage -and $oldStage.manifest.features.ghost)
    if ($hasGhost) { $script:ghostManager=Assert-LocalPath (Join-Path $current 'source/native/windows/manage_ghost_scheduler.ps1') 'NATIVE_LEGACY_GHOST_MANAGER_MISSING' $true $false }
    if (-not $hasGhost -and ((Get-Task $taskGhost) -or (Test-GhostOwnershipArtifacts))) { throw 'NATIVE_LEGACY_GHOST_REMOVAL_UNVERIFIED' }
    Stop-Components $receipt
    Remove-Components $receipt
    if ((Get-Task $taskGhost) -or (Test-GhostOwnershipArtifacts)) { throw 'NATIVE_LEGACY_GHOST_REMOVAL_UNVERIFIED' }
    Remove-VerifiedStage $current $Option
    $script:hasGhost=$false
    $script:ghostManager=Join-Path $PSScriptRoot 'manage_ghost_scheduler.ps1'
    $receipt.state='reinstalling';$receipt.supervisorTaskRegistered=$false;$receipt.dashboardTaskRegistered=$false;$receipt.ghostTaskRegistered=$false;$receipt.officeTaskRegistered=$false
    $receipt.sourceRoot=$SourceRoot;$receipt.bridgeInput=$BridgeExe;$receipt.supervisorInput=$SupervisorExe;$receipt.repoqlExe=$RepoqlExe
    $receipt.pythonExe=$PythonExe;$receipt.runnerExe=$(if ($hasGhost) {$RunnerExe} else {''});$receipt.workspace=$Workspace
    $receipt.supervisorConfig=$SupervisorConfig;$receipt.dashboardPort=$DashboardPort;$receipt.ghostPort=$(if ($hasGhost) {$GhostPort} else {$null})
    $receipt.officeSource=$OfficeSource;$receipt.officePythonExe=$OfficePythonExe;$receipt.officePort=$OfficePort;$receipt.officeWheelhouse=$OfficeWheelhouse;$receipt.officeAllowNetwork=[bool]$OfficeAllowNetwork
    $receipt.sandbox=$Sandbox;$receipt.runTimeoutSeconds=$RunTimeoutSeconds;$receipt.guiExecutableProvided=[bool]$GuiExe
    Write-InstallReceipt $receipt
  } else {
    if (Test-Path -LiteralPath $installRoot) {
      Remove-StaleReceiptTemps
      Remove-Item -LiteralPath ($installReceiptPath+'.bak') -Force -ErrorAction SilentlyContinue
      $ownedRootNames=@('memory')
      if (-not $hasOffice) { $ownedRootNames += 'office' }
      $unowned=@(Get-ChildItem -LiteralPath $installRoot -Force | Where-Object { $_.Name -notin $ownedRootNames -and $_.Name -notlike 'INSTALLATION_RECEIPT.json.pending-*' })
      if ($unowned.Count -gt 0) { throw 'NATIVE_INSTALL_ROOT_CONTAINS_UNOWNED_CONTENT' }
      Set-PrivateDirectoryAcl $installRoot
    } else { Set-PrivateDirectoryAcl $installRoot }
    $receipt=[ordered]@{schema='singularity-native-windows-installation/v1';state='installing';ownerSid=$ownerSid;option=$Option;installRoot=$installRoot;
      sourceRoot=$SourceRoot;bridgeInput=$BridgeExe;supervisorInput=$SupervisorExe;repoqlExe=$RepoqlExe;pythonExe=$PythonExe;runnerExe=$(if ($hasGhost) {$RunnerExe} else {''});
      workspace=$Workspace;supervisorConfig=$SupervisorConfig;dashboardPort=$DashboardPort;ghostPort=$(if ($hasGhost) {$GhostPort} else {$null});
      officeSource=$OfficeSource;officePythonExe=$OfficePythonExe;officePort=$OfficePort;officeWheelhouse=$OfficeWheelhouse;officeAllowNetwork=[bool]$OfficeAllowNetwork;
      sandbox=$Sandbox;runTimeoutSeconds=$RunTimeoutSeconds;guiExecutableProvided=[bool]$GuiExe;guiIntegrationInstalled=$false;
      sourceManifestSha256='';bridgeSha256='';supervisorSha256='';supervisorTaskRegistered=$false;dashboardTaskRegistered=$false;ghostTaskRegistered=$false;officeTaskRegistered=$false;releaseReady=$false}
    Write-InstallReceipt $receipt
  }
  try {
    Invoke-Stage $true
    $stageInfo=Read-Stage $current $Option
    $receipt.sourceManifestSha256=$stageInfo.receipt.sourceManifestSha256
    $receipt.bridgeSha256=$stageInfo.receipt.bridgeSha256
    $receipt.supervisorSha256=$stageInfo.receipt.supervisorSha256
    $receipt.state='partial';Write-InstallReceipt $receipt
    Register-Components $receipt
  } catch {
    $detail=$_.Exception.Message
    $receipt.state='partial';Write-InstallReceipt $receipt
    throw "NATIVE_INSTALL_PARTIAL: $detail; run -Mode Status, then -Mode Uninstall -Apply after reviewing ownership readback"
  }
  $taskState=Get-RegisteredTaskState
  Emit-Result ([ordered]@{schema='singularity-native-windows-lifecycle/v1';option=$Option;state='installed_not_started';
    supervisorTaskRegistered=$taskState.supervisorTaskRegistered;dashboardTaskRegistered=$taskState.dashboardTaskRegistered;ghostTaskRegistered=$taskState.ghostTaskRegistered;officeTaskRegistered=$taskState.officeTaskRegistered;officeIncluded=$hasOffice;guiOptional=$true;guiIntegrationInstalled=$false;servicesStarted=$false;releaseReady=$false})
  return
}

if ($Mode -eq 'Status') {
  $receipt=Read-InstallReceipt $false
  if (-not $receipt) {
    $knownDashboard=$false
    foreach ($candidateName in @('Singularity-ClaudeComplete-Dashboard','Singularity-WindowsNative-Option1-Dashboard','Singularity-WindowsNative-Option3-Dashboard','Singularity-WindowsNative-Option4-Dashboard')) {
      if (Get-Task $candidateName) { $knownDashboard=$true }
    }
    if ((Test-Path -LiteralPath $current) -or (Test-Path -LiteralPath $previous) -or (Get-Task $taskSupervisor) -or $knownDashboard -or (Get-Task $taskGhost) -or ($hasOffice -and ((Get-Task $taskOffice) -or (Test-Path -LiteralPath $officeReceipt)))) { throw 'NATIVE_PARTIAL_OR_UNOWNED_INSTALL_REFUSED' }
    Emit-Result ([ordered]@{schema='singularity-native-windows-status/v1';state='not_installed';option=$Option;stageVerified=$false;
      supervisorTaskVerified=$false;dashboardTaskVerified=$false;ghostTaskVerified=$false;officeTaskVerified=$false;guiIntegrationInstalled=$false;processHealthVerified=$false;releaseReady=$false}); return
  }
  $selected=[int]$receipt.option
  if ($Option -eq 0) { $script:Option=$selected;$script:hasGhost=($selected -in @(2,4));$script:taskDashboard=if ($selected -eq 2) {'Singularity-ClaudeComplete-Dashboard'} else {"Singularity-WindowsNative-Option$selected-Dashboard"};$script:dashboardState=if($selected -eq 2){Join-Path $base 'Dashboard'}else{Join-Path $base "Dashboard\Option$selected"};$script:dashboardReceipt=Join-Path $dashboardState 'task-ownership.json' }
  $stageInfo=Read-Stage $current $selected -AllowLegacyGhost
  $script:hasGhost=[bool]($stageInfo -and $stageInfo.manifest.features.ghost)
  if ($hasGhost) { $script:ghostManager=Assert-LocalPath (Join-Path $current 'source/native/windows/manage_ghost_scheduler.ps1') 'NATIVE_LEGACY_GHOST_MANAGER_MISSING' $true $false }
  $s=Get-SupervisorStatus (Join-Path $current 'bin/singularity-windows-supervisor.exe') ([string]$receipt.supervisorConfig)
  $supTask=Get-Task $taskSupervisor
  if ($supTask -and [string]$supTask.TaskPath -cne '\') { throw 'NATIVE_SUPERVISOR_TASK_PATH_MISMATCH' }
  $d=$null; if (Test-Path -LiteralPath $dashboardReceipt) { $d=Invoke-Dashboard 'Verify' $false }
  $g=if ($hasGhost) { Invoke-JsonScript $ghostManager @{Mode='Verify'} 'NATIVE_GHOST_MANAGER_FAILED' } else { [pscustomobject]@{taskRegistered=$false;hostReady=$false} }
  $o=if ($hasOffice -and (Test-Path -LiteralPath $officeReceipt)) { Invoke-Office 'Status' $false } else { $null }
  $mem=$null
  if ((Test-Path -LiteralPath $memoryConfig -PathType Leaf) -and (Test-Path -LiteralPath (Join-Path $current 'source/scripts/native-memory-supervisor.mjs') -PathType Leaf)) {
    try { $mem=Invoke-MemoryStack 'status' } catch { $mem=[pscustomobject]@{ok=$false;code='STATUS_FAILED';processes=@()} }
  }
  Emit-Result ([ordered]@{schema='singularity-native-windows-status/v1';state=[string]$receipt.state;option=$selected;
    stageVerified=[bool]$stageInfo;supervisorTaskVerified=($s.registeredOwnedAndConfigured -eq $true);
    dashboardTaskVerified=([bool]($d -and $d.taskRegistered));ghostTaskVerified=[bool]($g.taskRegistered);
    officeTaskVerified=[bool]($o -and $o.taskRegistered);officeHealthOk=[bool]($o -and $o.healthOk);
    ghostHostReady=[bool]$g.hostReady;memoryStatus=[string]$(if($mem){$mem.code}else{'NOT_CONFIGURED'});
    memoryOk=[bool]($mem -and $mem.ok);memoryProcesses=@($(if($mem){$mem.processes}else{@()}));
    guiExecutableProvided=[bool]$receipt.guiExecutableProvided;guiIntegrationInstalled=$false;
     processHealthVerified=$false;releaseReady=$false}); return
}

if ($Mode -eq 'RefreshSource') {
  if ([string]::IsNullOrWhiteSpace($SourceRoot)) { throw 'NATIVE_SOURCE_REFRESH_SOURCE_ROOT_REQUIRED' }
  Assert-PrivateAcl $installRoot
  Assert-PrivateAcl $current
  if (Test-Path -LiteralPath (Join-Path $installRoot 'source-refresh-snapshot')) { throw 'NATIVE_SOURCE_SNAPSHOT_EXISTS' }
  $receipt=Read-InstallReceipt $true
  if ([string]$receipt.state -cne 'installed_not_started') { throw 'NATIVE_SOURCE_REFRESH_INSTALL_STATE_INVALID' }
  $selected=[int]$receipt.option
  $stageInfo=Read-Stage $current $selected
  $oldTree=Get-SourceTree (Join-Path $current 'source') $selected
  Assert-SourceStageCoherence $stageInfo $receipt $oldTree
  $inputTree=Get-SourceTree $SourceRoot $selected
  if ($oldTree.manifestSha256 -ceq $inputTree.manifestSha256) { throw 'NATIVE_SOURCE_REFRESH_NO_CHANGE' }
  Assert-SourceConsumersStopped $receipt
  $candidatePath=Join-Path $installRoot '.source-refresh-candidate'
  $candidateTree=$null
  if (Test-Path -LiteralPath $candidatePath) {
    $null=Assert-LocalPath $candidatePath 'NATIVE_SOURCE_CANDIDATE_INVALID' $true $true
    Assert-PrivateAcl $candidatePath
    $candidateTree=Get-SourceTree $candidatePath $selected
    if ($candidateTree.manifestSha256 -cne $inputTree.manifestSha256) { throw 'NATIVE_SOURCE_CANDIDATE_DRIFT_REFUSED' }
  }
  $plan=[ordered]@{schema='singularity-native-source-refresh/v1';state='source_refresh_planned';option=$selected;willModify=[bool]$Apply;
    candidatePrepared=[bool]$candidateTree;candidateRoot=$candidatePath;sourceFileCount=$inputTree.fileCount;binariesTouched=$false;
    tasksOrServicesChanged=$false;externalStateChanged=$false;releaseReady=$false}
  if (-not $Apply) { Emit-Result $plan; return }
  if (-not $PSCmdlet.ShouldProcess($current,'Refresh only manifest-owned current/source and source-manifest receipt pins')) {
    $plan.willModify=$false;Emit-Result $plan;return
  }
  if (-not $candidateTree) {
    $stagerArgs=@{Option=$selected;SourceRoot=$SourceRoot;InstallRoot=$installRoot;PrepareSource=$true;Apply=$true;Confirm=$false}
    try {
      $stagerOutput=@(& $stageScript @stagerArgs 2>$null)
      if ($stagerOutput.Count -eq 0 -or [string]($stagerOutput[-1] | ConvertFrom-Json -ErrorAction Stop).state -cne 'SOURCE_REFRESH_CANDIDATE_PREPARED') { throw 'PREPARE_STATE_INVALID' }
    } catch { throw 'NATIVE_SOURCE_CANDIDATE_PREPARATION_FAILED' }
    $null=Assert-LocalPath $candidatePath 'NATIVE_SOURCE_CANDIDATE_INVALID' $true $true
    Assert-PrivateAcl $candidatePath
    $candidateTree=Get-SourceTree $candidatePath $selected
    if ($candidateTree.manifestSha256 -cne $inputTree.manifestSha256) { throw 'NATIVE_SOURCE_CANDIDATE_DRIFT_REFUSED' }
  }
  if ($candidateTree.manifestSha256 -ceq $oldTree.manifestSha256) { throw 'NATIVE_SOURCE_REFRESH_NO_CHANGE' }
  $stageNow=Read-Stage $current $selected
  $receiptNow=Read-InstallReceipt $true
  $oldNow=Get-SourceTree (Join-Path $current 'source') $selected
  Assert-SourceStageCoherence $stageNow $receiptNow $oldNow
  if ($oldNow.manifestSha256 -cne $oldTree.manifestSha256) { throw 'NATIVE_SOURCE_OLD_STAGE_DRIFT_REFUSED' }
  Assert-SourceConsumersStopped $receiptNow
  $result=Invoke-SourceRefreshTransaction $stageNow $receiptNow $oldNow $candidateTree
  Emit-Result ([ordered]@{schema='singularity-native-source-refresh/v1';option=$selected;state=$result.state;sourceFileCount=$result.sourceFileCount;
    sourceManifestSha256=$result.sourceManifestSha256;binariesPreserved=$result.binariesPreserved;taskConfigurationPreserved=$result.taskConfigurationPreserved;
    rollbackAvailable=$result.rollbackAvailable;releaseReady=$false}); return
}

if ($Mode -eq 'RollbackSource') {
  Assert-PrivateAcl $installRoot
  Assert-PrivateAcl $current
  if (Test-Path -LiteralPath (Join-Path $installRoot '.source-refresh-candidate')) { throw 'NATIVE_SOURCE_CANDIDATE_EXISTS' }
  $receipt=Read-InstallReceipt $true
  if ([string]$receipt.state -cne 'installed_not_started') { throw 'NATIVE_SOURCE_ROLLBACK_INSTALL_STATE_INVALID' }
  $selected=[int]$receipt.option
  $stageInfo=Read-Stage $current $selected
  $currentTree=Get-SourceTree (Join-Path $current 'source') $selected
  Assert-SourceStageCoherence $stageInfo $receipt $currentTree
  $snapshot=Read-SourceRefreshSnapshot $selected
  if ($currentTree.manifestSha256 -cne [string]$snapshot.metadata.newSourceManifestSha256 -or
      (Get-BytesSha256 ([IO.File]::ReadAllBytes((Join-Path $current 'STAGING_RECEIPT.json')))) -cne [string]$snapshot.metadata.stageReceiptRefreshedSha256 -or
      (Get-BytesSha256 ([IO.File]::ReadAllBytes($installReceiptPath))) -cne [string]$snapshot.metadata.installReceiptRefreshedSha256) { throw 'NATIVE_SOURCE_ROLLBACK_CURRENT_DRIFT' }
  if ([string]$stageInfo.receipt.bridgeSha256 -cne [string]$snapshot.metadata.bridgeSha256 -or
      [string]$stageInfo.receipt.supervisorSha256 -cne [string]$snapshot.metadata.supervisorSha256) { throw 'NATIVE_SOURCE_ROLLBACK_BINARY_DRIFT' }
  Assert-SourceConsumersStopped $receipt
  $plan=[ordered]@{schema='singularity-native-source-refresh/v1';state='source_rollback_planned';option=$selected;willModify=[bool]$Apply;
    sourceFileCount=$snapshot.oldSource.fileCount;binariesTouched=$false;tasksOrServicesChanged=$false;externalStateChanged=$false;releaseReady=$false}
  if (-not $Apply) { Emit-Result $plan; return }
  if (-not $PSCmdlet.ShouldProcess($current,'Restore exact source and receipt preimages from the verified refresh snapshot')) {
    $plan.willModify=$false;Emit-Result $plan;return
  }
  $stageNow=Read-Stage $current $selected
  $receiptNow=Read-InstallReceipt $true
  $currentNow=Get-SourceTree (Join-Path $current 'source') $selected
  $snapshot=Read-SourceRefreshSnapshot $selected
  Assert-SourceStageCoherence $stageNow $receiptNow $currentNow
  if ($currentNow.manifestSha256 -cne [string]$snapshot.metadata.newSourceManifestSha256 -or
      (Get-BytesSha256 ([IO.File]::ReadAllBytes((Join-Path $current 'STAGING_RECEIPT.json')))) -cne [string]$snapshot.metadata.stageReceiptRefreshedSha256 -or
      (Get-BytesSha256 ([IO.File]::ReadAllBytes($installReceiptPath))) -cne [string]$snapshot.metadata.installReceiptRefreshedSha256) { throw 'NATIVE_SOURCE_ROLLBACK_CURRENT_DRIFT' }
  Assert-SourceConsumersStopped $receiptNow
  $result=Invoke-SourceRollbackTransaction $snapshot $receiptNow
  Emit-Result ([ordered]@{schema='singularity-native-source-refresh/v1';option=$selected;state=$result.state;sourceManifestSha256=$result.sourceManifestSha256;
    binariesPreserved=$result.binariesPreserved;taskConfigurationPreserved=$result.taskConfigurationPreserved;userStatePreserved=$result.userStatePreserved;
    rollbackAvailable=$result.rollbackAvailable;releaseReady=$false}); return
}

$receipt=Read-InstallReceipt $true
$selected=[int]$receipt.option
if ($Option -eq 0) { $script:Option=$selected;$script:hasGhost=($selected -in @(2,4));$script:taskDashboard=if ($selected -eq 2) {'Singularity-ClaudeComplete-Dashboard'} else {"Singularity-WindowsNative-Option$selected-Dashboard"};$script:dashboardState=if($selected -eq 2){Join-Path $base 'Dashboard'}else{Join-Path $base "Dashboard\Option$selected"};$script:dashboardReceipt=Join-Path $dashboardState 'task-ownership.json' }
if ([int]$receipt.option -ne $selected) { throw 'NATIVE_OPTION_RECEIPT_MISMATCH' }
$stageInfo=Read-Stage $current $selected -AllowLegacyGhost
$script:hasGhost=[bool]($stageInfo -and $stageInfo.manifest.features.ghost)
if ($Mode -eq 'Start' -and ($hasGhost -or (Get-Task $taskGhost) -or (Test-GhostOwnershipArtifacts))) { throw 'NATIVE_LEGACY_GHOST_STAGE_REQUIRES_REINSTALL' }
if ($hasGhost) { $script:ghostManager=Assert-LocalPath (Join-Path $current 'source/native/windows/manage_ghost_scheduler.ps1') 'NATIVE_LEGACY_GHOST_MANAGER_MISSING' $true $false }
$receiptBridge=if ($receipt.PSObject.Properties['bridgeSha256']) { [string]$receipt.bridgeSha256 } else { '' }
$receiptSupervisor=if ($receipt.PSObject.Properties['supervisorSha256']) { [string]$receipt.supervisorSha256 } else { '' }
$noStageCleanup=$Mode -in @('Stop','Uninstall','Reinstall') -and $receipt.state -in @('installing','partial','reinstalling')
if (-not $stageInfo) {
  if (-not $noStageCleanup) { throw 'NATIVE_STAGE_DOES_NOT_MATCH_INSTALL_RECEIPT' }
} elseif (($receiptBridge -and [string]$stageInfo.receipt.bridgeSha256 -cne $receiptBridge) -or
    ($receiptSupervisor -and [string]$stageInfo.receipt.supervisorSha256 -cne $receiptSupervisor)) { throw 'NATIVE_STAGE_DOES_NOT_MATCH_INSTALL_RECEIPT' }
$supervisorExe=Join-Path $current 'bin/singularity-windows-supervisor.exe'
$supervisorTaskNow=Get-Task $taskSupervisor
$supervisorStatus=$null
if ($supervisorTaskNow -or [string]$receipt.supervisorConfig) {
  $supervisorStatus=Get-SupervisorStatus $supervisorExe ([string]$receipt.supervisorConfig)
}
if ($supervisorTaskNow -and [string]$supervisorTaskNow.TaskPath -cne '\') { throw 'NATIVE_SUPERVISOR_TASK_PATH_MISMATCH' }
if ($supervisorStatus -and $supervisorStatus.registeredOwnedAndConfigured -ne $true) {
  if (-not ($Mode -in @('Stop','Uninstall') -and $receipt.state -in @('installing','partial','reinstalling') -and -not $supervisorTaskNow)) {
    throw 'NATIVE_SUPERVISOR_TASK_NOT_OWNED'
  }
}
$partialCleanupAllowed=$Mode -in @('Stop','Uninstall') -and $receipt.state -in @('installing','partial','reinstalling')
$dashboardStatus=$null
$dashboardTaskNow=Get-Task $taskDashboard
if ($dashboardTaskNow) {
  if (-not (Test-Path -LiteralPath $dashboardReceipt)) { throw 'NATIVE_DASHBOARD_TASK_UNOWNED' }
  $dashboardStatus=Invoke-Dashboard 'Verify' $false
} elseif (Test-Path -LiteralPath $dashboardReceipt) {
  if ($partialCleanupAllowed) { $null=Invoke-Dashboard 'Remove' $true $true }
  else { $dashboardStatus=Invoke-Dashboard 'Verify' $false }
}
$ghostStatus=[pscustomobject]@{taskRegistered=$false;hostReady=$false}
if ($hasGhost) {
  $ghostTaskNow=Get-Task $taskGhost
  if ($ghostTaskNow) {
    $ghostStatus=Invoke-JsonScript $ghostManager @{Mode='Verify'} 'NATIVE_GHOST_MANAGER_FAILED'
    if (-not $ghostStatus.taskRegistered) { throw 'NATIVE_GHOST_TASK_NOT_OWNED' }
  } elseif ($partialCleanupAllowed) {
    if (Test-GhostOwnershipArtifacts) { $null=Invoke-Ghost 'Remove' $true $true }
  } else {
    $ghostStatus=Invoke-JsonScript $ghostManager @{Mode='Verify'} 'NATIVE_GHOST_MANAGER_FAILED'
    if (-not $ghostStatus.taskRegistered) { throw 'NATIVE_GHOST_TASK_NOT_OWNED' }
  }
}

if ($Mode -eq 'Start') {
  if (-not $PSCmdlet.ShouldProcess($installRoot,'Start only independently verified native product tasks')) {
    Emit-Result ([ordered]@{schema='singularity-native-windows-lifecycle/v1';option=$selected;state='start_planned';changed=$false;releaseReady=$false}); return
  }
  if ([string]$supervisorTaskNow.State -ne 'Running') { Start-ScheduledTask -TaskName $taskSupervisor -ErrorAction Stop }
  # The Rust supervisor owns the memory children, so the core is only reachable
  # after the task starts. Provision the product identity before the remaining
  # components come up; a memory stack without its team/agent rows logs
  # agent_not_found on every conversation write.
  $memoryIdentity=$null
  if (Test-Path -LiteralPath $memoryConfig -PathType Leaf) { $memoryIdentity=Invoke-MemoryIdentityProvision }
  if ($dashboardStatus) { $null=Invoke-Dashboard 'Start' $true }
  $officeStarted=$null
  if ($hasOffice -and (Test-Path -LiteralPath $officeReceipt)) { $officeStarted=Invoke-Office 'Start' $true }
  if ($hasGhost) { $ghostStatus=Invoke-Ghost 'Start' $true }
  Emit-Result ([ordered]@{schema='singularity-native-windows-lifecycle/v1';option=$selected;state='started';
    supervisorTaskStarted=$true;dashboardTaskStarted=[bool]$dashboardStatus;officeHealthOk=([bool]($officeStarted -and $officeStarted.healthOk));ghostHostReady=[bool]($hasGhost -and $ghostStatus.hostReady);
    memoryIdentityProvisioned=[bool]$memoryIdentity;memoryIdentityTeam=$(if($memoryIdentity){[string]$memoryIdentity.team_id}else{''});
    guiIntegrationInstalled=$false;releaseReady=$false}); return
}
if ($Mode -eq 'Stop') {
  if (-not $PSCmdlet.ShouldProcess($installRoot,'Stop only independently verified native product tasks')) {
    Emit-Result ([ordered]@{schema='singularity-native-windows-lifecycle/v1';option=$selected;state='stop_planned';changed=$false;releaseReady=$false}); return
  }
  Stop-Components $receipt
  $taskState=Get-RegisteredTaskState
  Emit-Result ([ordered]@{schema='singularity-native-windows-lifecycle/v1';option=$selected;state='stopped';legacyGhostResidue=[bool]((Get-Task $taskGhost) -or (Test-GhostOwnershipArtifacts));
    supervisorTaskRegistered=$taskState.supervisorTaskRegistered;dashboardTaskRegistered=$taskState.dashboardTaskRegistered;ghostTaskRegistered=$taskState.ghostTaskRegistered;officeTaskRegistered=$taskState.officeTaskRegistered;releaseReady=$false}); return
}
if ($Mode -eq 'Uninstall') {
  if (-not $PSCmdlet.ShouldProcess($installRoot,'Remove exact owned tasks and source-manifest-owned files; preserve user state')) {
    Emit-Result ([ordered]@{schema='singularity-native-windows-lifecycle/v1';option=$selected;state='uninstall_planned';changed=$false;releaseReady=$false}); return
  }
  # Legacy Ghost residue must never be orphaned by deleting the receipt that tracks it.
  if (-not $hasGhost -and ((Get-Task $taskGhost) -or (Test-GhostOwnershipArtifacts))) { throw 'NATIVE_LEGACY_GHOST_REMOVAL_UNVERIFIED' }
  Stop-Components $receipt
  Remove-Components $receipt
  if ((Get-Task $taskGhost) -or (Test-GhostOwnershipArtifacts)) { throw 'NATIVE_LEGACY_GHOST_REMOVAL_UNVERIFIED' }
  Remove-VerifiedStage $current $selected
  if (Test-Path -LiteralPath $previous) { Remove-VerifiedStage $previous $selected }
  Remove-Item -LiteralPath $installReceiptPath -Force -ErrorAction Stop
  Emit-Result ([ordered]@{schema='singularity-native-windows-lifecycle/v1';option=$selected;state='uninstalled_state_preserved';
    userDataPreserved=$true;externalGuiSettingsModified=$false;releaseReady=$false}); return
}
throw 'NATIVE_LIFECYCLE_MODE_INVALID'
