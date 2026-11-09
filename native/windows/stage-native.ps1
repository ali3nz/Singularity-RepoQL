#Requires -Version 5.1
<#
.SYNOPSIS
Fail-closed, per-user, reversible native Windows *staging* of a prebuilt bridge
and a verified Singularity option source archive. NOT a service/GUI installer.
.DESCRIPTION
Preview is the default. -Apply stages an already compiled, explicitly supplied
Rust bridge and source profile under LocalAppData. RepoQL 1.7.18 must already
exist. A GUI executable may be supplied for a later optional integration, but
is not required and staging never configures it. Does not alter Claude/OpenChamber
settings, install services, read secrets, or start any service. -Rollback
restores a single previous snapshot without touching external service data.
-PrepareSource validates and stages only a manifest-owned source candidate for
a manager-owned source refresh transaction. It does not change binaries.
Neither operation implies any of the four profiles passed GUI acceptance.
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
  [ValidateRange(0,4)][int]$Option = 0,
  [string]$SourceRoot = '',
  [string]$BridgeExe = '',
  [string]$SupervisorExe = '',
  [string]$RepoqlExe = '',
  [string]$GuiExe = '',
  [string]$InstallRoot = '',
  [switch]$Apply,
  [switch]$Rollback,
  [switch]$PrepareSource
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'NATIVE_WINDOWS_REQUIRED: WSL or POSIX not supported' }
if (($Apply -and $Rollback) -or ($Rollback -and $PrepareSource)) { throw 'Choose one staging operation' }
if (-not $Rollback -and $Option -notin @(1,2,3,4)) { throw 'OPTION_1_THROUGH_4_REQUIRED' }
if ($PrepareSource -and ($BridgeExe -or $SupervisorExe -or $RepoqlExe -or $GuiExe)) { throw 'SOURCE_PREPARATION_BINARY_INPUTS_REFUSED' }
if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) { throw 'LOCALAPPDATA_REQUIRED' }
$localRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Singularity'))
if (-not $InstallRoot) { $InstallRoot = Join-Path $localRoot 'WindowsNative' }
$targetRoot = [IO.Path]::GetFullPath($InstallRoot)
if (-not $targetRoot.StartsWith($localRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'INSTALL_ROOT_MUST_BE_INSIDE_CURRENT_USERS_LOCALAPPDATA_SINGULARITY'
}
# Never follow symlinks/reparse points anywhere along the installation chain.
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
function Assert-NoReparse([string]$PathValue) {
  $cursor = [IO.Path]::GetFullPath($PathValue)
  while ($cursor) {
    if (Test-Path -LiteralPath $cursor) {
      $item = Get-Item -LiteralPath $cursor -Force
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'REPARSE_PATH_REFUSED' }
    }
    $parent = [IO.Path]::GetDirectoryName($cursor)
    if ([string]::IsNullOrEmpty($parent) -or $cursor -eq $parent) { break }
    $cursor = $parent
  }
}
function Assert-LocalExistingFile([string]$PathValue, [string]$Kind) {
  if (-not [IO.Path]::IsPathRooted($PathValue) -or $PathValue.StartsWith('\\')) { throw "$Kind must be an absolute local file" }
  Assert-NoReparse $PathValue
  if (-not [IO.File]::Exists($PathValue)) { throw "$Kind not found" }
}
function Assert-PortableExecutable([string]$PathValue) {
  $file = [IO.File]::OpenRead($PathValue)
  try {
    if ($file.Length -lt 128) { throw 'INVALID_WINDOWS_EXE' }
    $reader = [IO.BinaryReader]::new($file)
    if ($reader.ReadUInt16() -ne 0x5A4D) { throw 'INVALID_WINDOWS_EXE' }
    $file.Position = 0x3C
    $offset = $reader.ReadInt32()
    if ($offset -lt 64 -or $offset -gt $file.Length - 24) { throw 'INVALID_WINDOWS_EXE' }
    $file.Position = $offset
    if ($reader.ReadUInt32() -ne 0x00004550) { throw 'INVALID_WINDOWS_EXE' }
    # Validate the COFF machine and optional-header format, not merely MZ/PE.
    # This Windows candidate is explicitly built for AMD64 (PE32+).
    if ($reader.ReadUInt16() -ne 0x8664) { throw 'WINDOWS_AMD64_EXE_REQUIRED' }
    $file.Position = $offset + 24
    if ($file.Length -lt $file.Position + 2 -or $reader.ReadUInt16() -ne 0x020B) {
      throw 'WINDOWS_PE32_PLUS_REQUIRED'
    }
  } finally { $file.Dispose() }
}
function Test-BridgeBuildInfo([string]$PathValue,[bool]$Complete) {
  $start=[Diagnostics.ProcessStartInfo]::new()
  $start.FileName=$PathValue; $start.Arguments='build-info'; $start.UseShellExecute=$false; $start.CreateNoWindow=$true
  $start.RedirectStandardOutput=$true; $start.RedirectStandardError=$true; $start.StandardOutputEncoding=[Text.UTF8Encoding]::new($false)
  $process=[Diagnostics.Process]::new(); $process.StartInfo=$start
  $output=[Text.StringBuilder]::new(); $outputLimit=4096; $outputOverflow=$false; $stderrCount=0
  $stdoutBuffer=New-Object 'char[]' 1024; $stderrBuffer=New-Object 'char[]' 1024
  $started=$false
  try {
    if (-not $process.Start()) { throw 'BRIDGE_BUILD_INFO_START_FAILED' }
    $started=$true
    $stdoutRead=$process.StandardOutput.ReadAsync($stdoutBuffer,0,$stdoutBuffer.Length)
    $stderrRead=$process.StandardError.ReadAsync($stderrBuffer,0,$stderrBuffer.Length)
    $stdoutDone=$false; $stderrDone=$false; $watch=[Diagnostics.Stopwatch]::StartNew()
    while (-not ($process.HasExited -and $stdoutDone -and $stderrDone)) {
      if ($watch.Elapsed.TotalSeconds -gt 10) { throw 'BRIDGE_BUILD_INFO_TIMEOUT' }
      if (-not $stdoutDone -and $stdoutRead.IsCompleted) {
        $count=$stdoutRead.GetAwaiter().GetResult()
        if ($count -eq 0) { $stdoutDone=$true }
        else {
          if ($output.Length + $count -gt $outputLimit) { $outputOverflow=$true }
          elseif (-not $outputOverflow) { [void]$output.Append($stdoutBuffer,0,$count) }
          $stdoutRead=$process.StandardOutput.ReadAsync($stdoutBuffer,0,$stdoutBuffer.Length)
        }
      }
      if (-not $stderrDone -and $stderrRead.IsCompleted) {
        $count=$stderrRead.GetAwaiter().GetResult()
        if ($count -eq 0) { $stderrDone=$true }
        else { $stderrCount += $count; $stderrRead=$process.StandardError.ReadAsync($stderrBuffer,0,$stderrBuffer.Length) }
      }
      if (-not ($process.HasExited -and $stdoutDone -and $stderrDone)) { Start-Sleep -Milliseconds 10 }
    }
    $process.WaitForExit()
    if ($process.ExitCode -ne 0 -or $outputOverflow -or $stderrCount -ne 0 -or $output.Length -eq 0) { throw 'BRIDGE_BUILD_INFO_REFUSED' }
    $jsonText=$output.ToString().Trim()
    if (-not $jsonText.StartsWith('{') -or -not $jsonText.EndsWith('}')) { throw 'BRIDGE_BUILD_INFO_INVALID' }
    try { $info=$jsonText | ConvertFrom-Json -ErrorAction Stop } catch { throw 'BRIDGE_BUILD_INFO_INVALID' }
    $names=@($info.PSObject.Properties.Name)
    if ($info -isnot [pscustomobject] -or $names.Count -ne 4 -or
        @($names | Where-Object { $_ -notin @('schema','packageVersion','featureOffice','featureGhost') }).Count -gt 0 -or
        $info.schema -cne 'singularity-native-build-info/v1' -or $info.packageVersion -notmatch '^\d+\.\d+\.\d+$' -or
        $info.featureOffice -isnot [bool] -or $info.featureGhost -isnot [bool]) { throw 'BRIDGE_BUILD_INFO_INVALID' }
    if ([bool]$info.featureOffice -ne $Complete -or [bool]$info.featureGhost) { throw 'BRIDGE_BUILD_FEATURE_MISMATCH' }
    return [pscustomobject]@{packageVersion=[string]$info.packageVersion;featureOffice=[bool]$info.featureOffice;featureGhost=[bool]$info.featureGhost}
  } catch {
    if ($started -and -not $process.HasExited) { try { $process.Kill(); $process.WaitForExit() } catch { } }
    $failure=[string]$_.Exception.Message
    if ($failure -in @('BRIDGE_BUILD_INFO_START_FAILED','BRIDGE_BUILD_INFO_TIMEOUT','BRIDGE_BUILD_INFO_REFUSED',
        'BRIDGE_BUILD_INFO_INVALID','BRIDGE_BUILD_FEATURE_MISMATCH')) { throw $failure }
    throw 'BRIDGE_BUILD_INFO_REFUSED'
  } finally { $process.Dispose() }
}
function Assert-Manifest([string]$Root, [int]$Selected) {
  if (-not [IO.Path]::IsPathRooted($Root) -or $Root.StartsWith('\\')) { throw 'SourceRoot must be a local absolute path' }
  Assert-NoReparse $Root
  $manifestPath = Join-Path $Root 'NATIVE_WINDOWS_SOURCE_MANIFEST.json'
  if (-not [IO.File]::Exists($manifestPath)) { throw 'SOURCE_MANIFEST_MISSING' }
  $m = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($m.schema -ne 1 -or $m.variant -ne $Selected -or $m.release_status -ne 'SOURCE_ONLY_UNCOMPILED_NOT_INSTALLER') { throw 'SOURCE_PROFILE_INVALID' }
  if ($m.repoql.requiredVersion -ne '1.7.18' -or $m.repoql.connectorContract -cne 'fetch-render') { throw 'REPOQL_VERSION_OR_CONTRACT_DRIFT' }
  $complete = $Selected -in @(2,4)
  if ($m.features.ghost -isnot [bool] -or [bool]$m.features.office -ne $complete -or [bool]$m.features.ghost) { throw 'SOURCE_FEATURE_MISMATCH' }
  if ($m.rustGhostFeature -isnot [bool] -or [bool]$m.rustOfficeFeature -ne $complete -or [bool]$m.rustGhostFeature) { throw 'SOURCE_RUST_FEATURE_MISMATCH' }
  if ($m.gui -ne $(if ($Selected -le 2) { 'claude-desktop-code' } else { 'openchamber-desktop' })) { throw 'GUI_VARIANT_MISMATCH' }
  $seen = @{}
  $seenWindows = @{}
  $reserved = '^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9]|LPT[1-9])($|\.)'
  foreach ($row in $m.files) {
    $name = [string]$row.path
    if ($name -match '^(ghost/|dashboard/static/ghost/|openchamber/plugins/product-ghost/|native/windows/(ghost_|manage_ghost_|test_ghost_))' -or
        $name -in @('native/desktop-bridge/src/ghost.rs','dashboard/native_ghost.py','native/windows/test_native_ghost_client_config.py')) {
      throw 'SOURCE_GHOST_COMPONENT_LEAK'
    }
    if (-not $name -or $name.Contains('\') -or $name.Contains(':') -or $name.StartsWith('/') -or $name.Split('/') -contains '..' -or $name.Split('/') -contains '.' -or $name.Split('/') -contains '' -or $seen.ContainsKey($name)) { throw 'SOURCE_PATH_INVALID' }
    if ($name.Length -gt 240 -or $seenWindows.ContainsKey($name.ToUpperInvariant())) { throw 'WINDOWS_SOURCE_NAME_COLLISION' }
    $seenWindows[$name.ToUpperInvariant()] = $true
    foreach ($segment in $name.Split('/')) {
      if ($segment.Length -gt 200 -or $segment -match '[<>:"|?*]' -or $segment -match '[\. ]$' -or $segment -match $reserved) {
        throw 'WINDOWS_SOURCE_NAME_INVALID'
      }
    }
    $seen[$name] = $true
    if ($name -match '(?i)(^|/)(node_modules|\.git|\.venv|secrets|runs|__pycache__)/') { throw 'PRIVATE_SOURCE_FILE_REFUSED' }
    if ($name -match '(?i)\.(db|sqlite|sqlite3|pem|key|pfx|p12|kdbx|log)$') { throw 'PRIVATE_SOURCE_FILE_REFUSED' }
    if (-not $complete -and ($name -match '^(ghost/|office/|dashboard/static/ghost/|openchamber/plugins/product-(office|ghost)/)' -or $name -in @(
      'native/desktop-bridge/src/office.rs', 'native/desktop-bridge/src/ghost.rs', 'dashboard/office_bridge.py', 'dashboard/native_ghost.py',
      'native/windows/ghost_scheduler_host.py', 'native/windows/ghost_task_scheduler.ps1',
      'native/windows/manage_ghost_scheduler.ps1', 'native/windows/test_ghost_scheduler_host.py'))) { throw 'OPTIONAL_COMPONENT_LEAK' }
    $path = Join-Path $Root ($name -replace '/', [IO.Path]::DirectorySeparatorChar)
    Assert-NoReparse $path
    if (-not [IO.File]::Exists($path)) { throw 'SOURCE_FILE_MISSING' }
    $info = Get-Item -LiteralPath $path
    if ($info.Length -ne [long]$row.bytes) { throw 'SOURCE_SIZE_MISMATCH' }
    if ((Get-FileSha256 $path) -ne [string]$row.sha256) { throw 'SOURCE_HASH_MISMATCH' }
  }
  if ($seen.Count -lt 200) { throw 'SOURCE_INVENTORY_TOO_SMALL' }
  return $m
}
function Assert-SourceInventory([string]$Root, $Manifest) {
  $Root=[IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar,[IO.Path]::AltDirectorySeparatorChar)
  $expected=@{}
  foreach ($row in @($Manifest.files)) { $expected[([string]$row.path).ToUpperInvariant()]=$true }
  $expected['NATIVE_WINDOWS_SOURCE_MANIFEST.JSON']=$true
  $actual=@(); $stack=New-Object 'System.Collections.Generic.Stack[string]'; $stack.Push($Root)
  while ($stack.Count -gt 0) {
    $directory=$stack.Pop()
    foreach ($item in @(Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop)) {
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'SOURCE_REPARSE_REFUSED' }
      if ($item.PSIsContainer) { $stack.Push($item.FullName) }
      else { $actual += $item.FullName.Substring($Root.Length+1).Replace('\','/').ToUpperInvariant() }
    }
    if ($actual.Count -gt 30000) { throw 'SOURCE_INVENTORY_LIMIT' }
  }
  $diff=Compare-Object -ReferenceObject @($expected.Keys | Sort-Object) -DifferenceObject @($actual | Sort-Object)
  if ($diff) { throw 'SOURCE_UNMANIFESTED_FILE_REFUSED' }
}
function Set-PrivateDirectoryAcl([string]$Dir) {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  if (-not $identity -or -not $identity.User) { throw 'WINDOWS_IDENTITY_UNAVAILABLE' }
  $acl = [System.Security.AccessControl.DirectorySecurity]::new()
  $acl.SetAccessRuleProtection($true, $false)
  $inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
  $propagate = [System.Security.AccessControl.PropagationFlags]::None
  foreach ($sid in @($identity.User, [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, [System.Security.AccessControl.FileSystemRights]::FullControl, $inherit, $propagate, [System.Security.AccessControl.AccessControlType]::Allow)
    $acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $Dir -AclObject $acl
  $check = Get-Acl -LiteralPath $Dir
  if (-not $check.AreAccessRulesProtected) { throw 'ACL_NOT_PROTECTED' }
}

Assert-NoReparse $targetRoot
$current = Join-Path $targetRoot 'current'
$previous = Join-Path $targetRoot 'previous'
$sourceCandidate = Join-Path $targetRoot '.source-refresh-candidate'
if ($Rollback) {
  $held = Join-Path $targetRoot 'held-current'
  Assert-NoReparse $previous
  Assert-NoReparse $current
  Assert-NoReparse $held
  if (-not (Test-Path -LiteralPath $previous -PathType Container)) { throw 'NO_ROLLBACK_SNAPSHOT' }
  # Never overwrite a previously preserved installation. An operator must
  # archive that snapshot independently before starting another rollback.
  if (Test-Path -LiteralPath $held) { throw 'ROLLBACK_HELD_SNAPSHOT_EXISTS' }
  $receiptPath = Join-Path $previous 'STAGING_RECEIPT.json'
  Assert-NoReparse $receiptPath
  if (-not (Test-Path -LiteralPath $receiptPath -PathType Leaf)) { throw 'ROLLBACK_RECEIPT_MISSING' }
  $receipt = Get-Content -LiteralPath $receiptPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($receipt.schema -ne 1 -or $receipt.state -ne 'STAGED_UNVERIFIED' -or $receipt.option -notin @(1,2,3,4)) { throw 'ROLLBACK_RECEIPT_INVALID' }
  if ($receipt.repoqlVersion -ne '1.7.18' -or
      -not ([string]$receipt.bridgeSha256 -match '^[0-9a-fA-F]{64}$')) { throw 'ROLLBACK_RECEIPT_PIN_OR_BINARY_HASH_INVALID' }
  # A receipt alone cannot authenticate a backup. Validate the complete
  # manifest inventory and both native binary hashes BEFORE moving anything.
  $previousSource = Join-Path $previous 'source'
  $previousManifest = Assert-Manifest $previousSource ([int]$receipt.option)
  $previousBridge = Join-Path $previous 'bin/singularity-desktop-bridge.exe'
  Assert-LocalExistingFile $previousBridge 'Previous Rust bridge'
  Assert-PortableExecutable $previousBridge
  if ((Get-FileSha256 $previousBridge) -ne [string]$receipt.bridgeSha256) {
    throw 'ROLLBACK_BRIDGE_HASH_MISMATCH'
  }
  $previousSupervisor = Join-Path $previous 'bin/singularity-windows-supervisor.exe'
  if ($receipt.supervisorSha256) {
    if (-not ([string]$receipt.supervisorSha256 -match '^[0-9a-fA-F]{64}$')) { throw 'ROLLBACK_SUPERVISOR_HASH_INVALID' }
    Assert-LocalExistingFile $previousSupervisor 'Previous Rust supervisor'
    Assert-PortableExecutable $previousSupervisor
    if ((Get-FileSha256 $previousSupervisor) -ne [string]$receipt.supervisorSha256) {
      throw 'ROLLBACK_SUPERVISOR_HASH_MISMATCH'
    }
  } elseif (Test-Path -LiteralPath $previousSupervisor) { throw 'ROLLBACK_UNRECORDED_SUPERVISOR_REFUSED' }
  if ($receipt.PSObject.Properties['additionalBinaries']) {
    $extraNames=@{}
    if (@($receipt.additionalBinaries).Count -gt 2) { throw 'ROLLBACK_ADDITIONAL_BINARY_INVALID' }
    foreach ($extra in @($receipt.additionalBinaries)) {
      $relative=[string]$extra.path
      if ($relative -cnotin @('bin/singularity-windows-supervisorw.exe','bin/unified-repoql-control.exe') -or
          [string]$extra.sha256 -cnotmatch '^[0-9a-f]{64}$' -or $extraNames.ContainsKey($relative)) { throw 'ROLLBACK_ADDITIONAL_BINARY_INVALID' }
      $extraNames[$relative]=$true
      $extraPath=Join-Path $previous $relative
      Assert-LocalExistingFile $extraPath 'Previous additional product binary'
      Assert-PortableExecutable $extraPath
      if ((Get-FileSha256 $extraPath) -cne [string]$extra.sha256) { throw 'ROLLBACK_ADDITIONAL_BINARY_HASH_MISMATCH' }
    }
  }

  if ($PSCmdlet.ShouldProcess($current, 'Preserve active staged files, then restore previous snapshot')) {
    $heldCurrent = $false
    try {
      if (Test-Path -LiteralPath $current) {
        Move-Item -LiteralPath $current -Destination $held
        $heldCurrent = $true
      }
      Move-Item -LiteralPath $previous -Destination $current
    } catch {
      # If restoration fails, undo only our own current->held move. No delete,
      # no symlink traversal, and no overwrite of an existing current.
      if ($heldCurrent -and -not (Test-Path -LiteralPath $current)) {
        try { Move-Item -LiteralPath $held -Destination $current -ErrorAction Stop }
        catch { throw 'ROLLBACK_RECOVERY_INCOMPLETE_REVIEW_HELD_CURRENT' }
      }
      throw
    }
  }
  return
}

if ($PrepareSource) {
  $manifest = Assert-Manifest $SourceRoot $Option
  Assert-NoReparse $sourceCandidate
  if (-not (Test-Path -LiteralPath $targetRoot -PathType Container)) { throw 'SOURCE_PREPARATION_INSTALL_ROOT_MISSING' }
  Assert-SourceInventory $SourceRoot $manifest
  if (Test-Path -LiteralPath $sourceCandidate) { throw 'SOURCE_PREPARATION_CANDIDATE_EXISTS' }
  $preview=[ordered]@{schema=1;state='SOURCE_REFRESH_CANDIDATE_PREVIEW';option=$Option;file_count=$manifest.files.Count;
    candidateRoot=$sourceCandidate;willModify=$Apply.IsPresent;releaseReady=$false}
  $preview | ConvertTo-Json -Compress
  if (-not $Apply) { return }
  if (-not $PSCmdlet.ShouldProcess($sourceCandidate,'Prepare manifest-owned source candidate only')) { return }
  New-Item -ItemType Directory -Path $sourceCandidate -ErrorAction Stop | Out-Null
  Set-PrivateDirectoryAcl $sourceCandidate
  foreach ($row in $manifest.files) {
    $relative=([string]$row.path) -replace '/', [IO.Path]::DirectorySeparatorChar
    $destination=Join-Path $sourceCandidate $relative
    $parent=Split-Path -Parent $destination
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) { New-Item -ItemType Directory -Path $parent -Force -ErrorAction Stop | Out-Null }
    Copy-Item -LiteralPath (Join-Path $SourceRoot $relative) -Destination $destination -ErrorAction Stop
    if ((Get-FileSha256 $destination) -ine [string]$row.sha256) { throw 'SOURCE_CANDIDATE_COPY_HASH_MISMATCH' }
  }
  Copy-Item -LiteralPath (Join-Path $SourceRoot 'NATIVE_WINDOWS_SOURCE_MANIFEST.json') -Destination $sourceCandidate -ErrorAction Stop
  $candidateManifest=Assert-Manifest $sourceCandidate $Option
  Assert-SourceInventory $sourceCandidate $candidateManifest
  [ordered]@{schema=1;state='SOURCE_REFRESH_CANDIDATE_PREPARED';option=$Option;file_count=$manifest.files.Count;
    candidateRoot=$sourceCandidate;manifestSha256=(Get-FileSha256 (Join-Path $sourceCandidate 'NATIVE_WINDOWS_SOURCE_MANIFEST.json'));
    binariesTouched=$false;releaseReady=$false} | ConvertTo-Json -Compress
  return
}

Assert-LocalExistingFile $BridgeExe 'Rust bridge'
if ($SupervisorExe) { Assert-LocalExistingFile $SupervisorExe 'Rust supervisor'; Assert-PortableExecutable $SupervisorExe }
$additionalInputs=@()
if ($SupervisorExe) {
  foreach ($name in @('singularity-windows-supervisorw.exe','unified-repoql-control.exe')) {
    $extraPath=Join-Path (Split-Path -Parent $SupervisorExe) $name
    if (Test-Path -LiteralPath $extraPath -PathType Leaf) {
      Assert-LocalExistingFile $extraPath 'Additional product binary'
      Assert-PortableExecutable $extraPath
      $additionalInputs += [pscustomobject]@{path=('bin/'+$name);source=$extraPath}
    }
  }
}
Assert-LocalExistingFile $RepoqlExe 'RepoQL'
if ($GuiExe) { Assert-LocalExistingFile $GuiExe 'GUI executable' }
Assert-PortableExecutable $BridgeExe
$complete = $Option -in @(2,4)
$bridgeInfo = Test-BridgeBuildInfo $BridgeExe $complete
Assert-PortableExecutable $RepoqlExe
if ($GuiExe) { Assert-PortableExecutable $GuiExe }
function Test-RepoqlVersion([string]$PathValue) {
  $start = [Diagnostics.ProcessStartInfo]::new()
  $start.FileName = $PathValue
  $start.Arguments = '--version'
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true
  $process = [Diagnostics.Process]::Start($start)
  if (-not $process) { throw 'REPOQL_PROBE_START_FAILED' }
  try {
    if (-not $process.WaitForExit(10000)) {
      $process.Kill()
      throw 'REPOQL_PROBE_TIMEOUT'
    }
    if ($process.ExitCode -ne 0) { throw 'REPOQL_VERSION_CHECK_FAILED' }
    $banner = $process.StandardOutput.ReadToEnd()
    if ($banner.Length -gt 4096) { throw 'REPOQL_VERSION_OUTPUT_TOO_LARGE' }
    $bare = [regex]::Match($banner.Trim(), '^(?i:v)?(\d+\.\d+\.\d+)$')
    if ($bare.Success) { $versions = @($bare.Groups[1].Value) }
    else {
      $bareLines = @($banner -split "`r?`n" | Where-Object { $_.Trim() -match '^(?i:v)?\d+\.\d+\.\d+$' })
      if ($bareLines.Count -gt 0) { throw 'REPOQL_VERSION_BANNER_AMBIGUOUS' }
      $found = [regex]::Matches($banner, '(?im)\b(?:repoql|rql)\b[^\r\n]{0,64}?\bv?(\d+\.\d+\.\d+)\b')
      $versions = @($found | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique)
    }
    if ($versions.Count -ne 1 -or $versions[0] -cne '1.7.18') { throw 'REPOQL_1_7_18_REQUIRED' }
  } finally { $process.Dispose() }
}
$manifest = Assert-Manifest $SourceRoot $Option
# Bounded exact version probe; refuse ambiguous mixed banners.
Test-RepoqlVersion $RepoqlExe
$preview = [ordered]@{ schema=1; state='SOURCE_STAGING_ONLY'; option=$Option; repoql='1.7.18'; file_count=$manifest.files.Count; bridgeBuildInfo=$bridgeInfo;
  installRoot=$targetRoot; willModify=$Apply.IsPresent; supervisorProvided=[bool]$SupervisorExe;
  guiOptional=$true; guiExecutableProvided=[bool]$GuiExe; guiIntegrationInstalled=$false;
  servicesInstalled=$false; releaseReady=$false }
$preview | ConvertTo-Json -Compress
if (-not $Apply) { return }
if (Test-Path -LiteralPath $previous) { throw 'PREVIOUS_ROLLBACK_SNAPSHOT_EXISTS: resolve before upgrading' }
# A prior interrupted stage can leave its private, receipt-less pending files.
# Never sweep those files implicitly or silently mix a new staging attempt with
# an unresolved transaction; the operator must first inspect and recover them.
if (Test-Path -LiteralPath $targetRoot -PathType Container) {
  $pendingStages = @(Get-ChildItem -LiteralPath $targetRoot -Directory -Force -ErrorAction Stop |
    Where-Object { $_.Name -match '^\.pending-[0-9a-fA-F]{32}$' })
  if ($pendingStages.Count -gt 0) { throw 'UNRESOLVED_PENDING_STAGE_REQUIRES_MANUAL_REVIEW' }
}
if (-not $PSCmdlet.ShouldProcess($targetRoot, 'Stage native bridge and verified source snapshot')) { return }
New-Item -ItemType Directory -Path $targetRoot -Force | Out-Null
Set-PrivateDirectoryAcl $targetRoot
$staging = Join-Path $targetRoot ('.pending-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $staging | Out-Null
$promoted = $false
$movedPrevious = $false
try {
  Set-PrivateDirectoryAcl $staging
  New-Item -ItemType Directory -Path (Join-Path $staging 'bin') | Out-Null
  Copy-Item -LiteralPath $BridgeExe -Destination (Join-Path $staging 'bin/singularity-desktop-bridge.exe')
  if ($SupervisorExe) { Copy-Item -LiteralPath $SupervisorExe -Destination (Join-Path $staging 'bin/singularity-windows-supervisor.exe') }
  $additionalBinaries=@()
  foreach ($extra in $additionalInputs) {
    $extraDestination=Join-Path $staging $extra.path
    Copy-Item -LiteralPath $extra.source -Destination $extraDestination
    if ((Get-FileSha256 $extraDestination) -cne (Get-FileSha256 $extra.source)) { throw 'STAGED_COPY_HASH_MISMATCH' }
    $additionalBinaries += [ordered]@{path=$extra.path;sha256=(Get-FileSha256 $extraDestination)}
  }
  $sourceDestination = Join-Path $staging 'source'
  New-Item -ItemType Directory -Path $sourceDestination | Out-Null
  foreach ($row in $manifest.files) {
    $relative = ([string]$row.path) -replace '/', [IO.Path]::DirectorySeparatorChar
    $destination = Join-Path $sourceDestination $relative
    $destParent = Split-Path -Parent $destination
    New-Item -ItemType Directory -Path $destParent -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $SourceRoot $relative) -Destination $destination
    if ((Get-FileSha256 $destination) -ne [string]$row.sha256) { throw 'STAGED_COPY_HASH_MISMATCH' }
  }
  Copy-Item -LiteralPath (Join-Path $SourceRoot 'NATIVE_WINDOWS_SOURCE_MANIFEST.json') -Destination $sourceDestination
  $receipt = @{ schema=1; state='STAGED_UNVERIFIED'; option=$Option; repoqlVersion='1.7.18';
    bridgePackageVersion=$bridgeInfo.packageVersion; bridgeFeatureOffice=$bridgeInfo.featureOffice; bridgeFeatureGhost=$bridgeInfo.featureGhost;
    sourceManifestSha256=(Get-FileSha256 (Join-Path $staging 'source/NATIVE_WINDOWS_SOURCE_MANIFEST.json'));
    bridgeSha256=(Get-FileSha256 (Join-Path $staging 'bin/singularity-desktop-bridge.exe'));
    supervisorSha256=$(if ($SupervisorExe) { (Get-FileSha256 (Join-Path $staging 'bin/singularity-windows-supervisor.exe')) } else { $null });
    additionalBinaries=$additionalBinaries;
    guiExecutableProvided=[bool]$GuiExe; guiConfigured=$false; servicesInstalled=$false; acceptedOnWindows=$false }
  $receipt | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $staging 'STAGING_RECEIPT.json') -Encoding UTF8
  if (Test-Path -LiteralPath $current) {
    Move-Item -LiteralPath $current -Destination $previous
    $movedPrevious = $true
  }
  Move-Item -LiteralPath $staging -Destination $current
  $promoted = $true
} catch {
  if (-not $promoted -and $movedPrevious -and -not (Test-Path -LiteralPath $current)) {
    # Explicitly report if the former current stage cannot be restored.
    # The pending directory is left intact for operator inspection either way.
    try { Move-Item -LiteralPath $previous -Destination $current -ErrorAction Stop }
    catch { throw 'STAGE_RECOVERY_INCOMPLETE_REVIEW_PREVIOUS_AND_PENDING' }
  }
  # Do not silently delete the pending snapshot. A subsequent staging attempt
  # refuses it until an operator inspects and reconciles the failed transaction.
  throw
}
Write-Output 'SOURCE_STAGED_ONLY: no service or GUI configuration was modified; run Windows acceptance before release.'
