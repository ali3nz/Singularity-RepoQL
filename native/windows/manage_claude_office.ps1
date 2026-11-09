#Requires -Version 5.1
<#
Per-user lifecycle for the bundled Claude Office visualizer on Windows.

Plan/Status are read-only. Install/Restage/Start/Stop/Uninstall require -Apply
and an exact ownership receipt. Install stages a pinned Office source tree plus
the already-built frontend, creates a private venv, writes the dependency lock
input, registers the per-user task and never starts it. Restage replaces only
the staged source, manifest and receipt after the owned task is stopped; venv,
state, service, logs and the task registration are preserved. Start performs
the health check; Stop also reaps the venv redirector child. No elevation, no
secrets in Task Scheduler, no remote downloads beyond pip and the supplied
source tree.

Known environment facts (2026-10-30): the uv-created acceptance venv failed to
spawn its interpreter after its junction broke, so this manager always creates
its own venv with `python -m venv` from an explicit >=3.13 interpreter and never
depends on a uv-managed junction.
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
  [ValidateSet('Plan','Install','Restage','Start','Stop','Status','Uninstall')][string]$Mode = 'Plan',
  [string]$OfficeSource = '',
  [string]$PythonExe = '',
  [string]$InstallRoot = '',
  [int]$Port = 18128,
  [string]$TaskName = 'Singularity-ClaudeComplete-Office',
  [string]$RequirementsLock = '',
  [string]$LayoutAsset = '',
  [string]$Wheelhouse = '',
  [switch]$AllowUnpinnedSource,
  [switch]$AllowNetwork,
  [switch]$Apply
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'NATIVE_WINDOWS_REQUIRED' }
if ($Port -lt 1024 -or $Port -gt 65535) { throw 'OFFICE_PORT_INVALID' }
$mutating = $Mode -in @('Install','Restage','Start','Stop','Uninstall')
if ($mutating -and -not $Apply) { throw 'OFFICE_EXPLICIT_APPLY_REQUIRED' }
if (-not $mutating -and $Apply) { throw 'OFFICE_READ_ONLY_REFUSES_APPLY' }
if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA_REQUIRED' }
$pin = '95d8bdc5728b23bcf0fee4c371b35e071c44f642'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
if (-not $InstallRoot) { $InstallRoot = Join-Path $env:LOCALAPPDATA 'Singularity\WindowsNative\office' }
$root = [IO.Path]::GetFullPath($InstallRoot)
$receiptPath = Join-Path $root 'office-install.json'
$receiptSchema = 'singularity-windows-office/v1'
$stateDir = Join-Path $root 'state'
$logDir = Join-Path $root 'logs'
$venvDir = Join-Path $root 'venv'
$sourceDir = Join-Path $root 'source'
$serviceDir = Join-Path $root 'service'
$layoutAsset = if ($LayoutAsset) { $LayoutAsset } else { Join-Path $repoRoot 'office\assets\ben-layout.json' }
$installExclusions = @('.git', 'node_modules', '.venv', '__pycache__', 'data', '.claude', '.codex', 'screenshots', 'feeds-test')

function Assert-LocalPath([string]$Value, [string]$Code, [bool]$MustExist = $true, [bool]$Directory = $false) {
  if (-not $Value -or -not [IO.Path]::IsPathRooted($Value) -or $Value.StartsWith('\\\\')) { throw $Code }
  $full = [IO.Path]::GetFullPath($Value)
  if ($full -notmatch '^[A-Za-z]:\\') { throw $Code }
  if ($full.Contains('"') -or $full.Contains([char]10) -or $full.Contains([char]13)) { throw $Code }
  if ($MustExist) {
    if ($Directory -and -not [IO.Directory]::Exists($full)) { throw $Code }
    if (-not $Directory -and -not [IO.File]::Exists($full)) { throw $Code }
  }
  return $full
}
function Assert-NoReparseUnder([string]$PathValue) {
  if (-not (Test-Path -LiteralPath $PathValue)) { return }
  $stack = New-Object 'System.Collections.Generic.Stack[string]'
  $stack.Push($PathValue)
  while ($stack.Count -gt 0) {
    $dir = $stack.Pop()
    foreach ($item in @(Get-ChildItem -LiteralPath $dir -Force -ErrorAction Stop)) {
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "OFFICE_REPARSE_PATH_REFUSED: $($item.FullName)" }
      if ($item.PSIsContainer) { $stack.Push($item.FullName) }
    }
  }
}
function Assert-NoReparseChain([string]$PathValue) {
  $full = [IO.Path]::GetFullPath($PathValue)
  $cursor = $full
  while ($cursor) {
    if (Test-Path -LiteralPath $cursor) {
      $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "OFFICE_REPARSE_PATH_REFUSED: $cursor" }
    }
    $parent = [IO.Path]::GetDirectoryName($cursor)
    if (-not $parent -or $parent -eq $cursor) { break }
    $cursor = $parent
  }
  return $full
}
function Assert-DisjointPaths([string]$SourcePath, [string]$DestinationPath) {
  $trimChars = [char[]]@([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  $sourceFull = [IO.Path]::GetFullPath($SourcePath).TrimEnd($trimChars)
  $destinationFull = [IO.Path]::GetFullPath($DestinationPath).TrimEnd($trimChars)
  $comparison = [StringComparison]::OrdinalIgnoreCase
  if ($sourceFull.Equals($destinationFull, $comparison)) { throw 'OFFICE_RESTAGE_PATH_EQUALS_REFUSED' }
  $separator = [IO.Path]::DirectorySeparatorChar
  if ($sourceFull.StartsWith($destinationFull + $separator, $comparison) -or $destinationFull.StartsWith($sourceFull + $separator, $comparison)) { throw 'OFFICE_RESTAGE_PATH_NESTED_REFUSED' }
}
function Get-SelectedFileInventory([string]$SourceRoot, [string[]]$ExcludeNames) {
  if (-not $ExcludeNames) { $ExcludeNames = @() }
  $trimChars = [char[]]@([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  $rootFull = [IO.Path]::GetFullPath($SourceRoot).TrimEnd($trimChars)
  $rows = New-Object 'System.Collections.Generic.List[object]'
  $stack = New-Object 'System.Collections.Generic.Stack[string]'
  $stack.Push($rootFull)
  while ($stack.Count -gt 0) {
    $dir = $stack.Pop()
    foreach ($item in @(Get-ChildItem -LiteralPath $dir -Force -ErrorAction Stop)) {
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "OFFICE_SOURCE_REPARSE_REFUSED: $($item.FullName)" }
      if ($item.PSIsContainer) {
        if ($ExcludeNames -contains $item.Name) { continue }
        $stack.Push($item.FullName)
      } else {
        $rows.Add([pscustomobject]@{path=$item.FullName.Substring($rootFull.Length + 1).Replace('\','/');bytes=$item.Length;sha256=(Get-Sha256 $item.FullName)})
      }
    }
  }
  return @($rows | Sort-Object -Property path)
}
function Assert-InventoryMatches($Expected, $Actual, [string]$Code) {
  $expectedMap = @{}
  foreach ($row in @($Expected)) { $expectedMap[[string]$row.path] = $row }
  $actualMap = @{}
  foreach ($row in @($Actual)) { $actualMap[[string]$row.path] = $row }
  if ($expectedMap.Count -ne $actualMap.Count) { throw ("{0}: count {1} != {2}" -f $Code, $expectedMap.Count, $actualMap.Count) }
  foreach ($key in @($expectedMap.Keys)) {
    if (-not $actualMap.ContainsKey($key)) { throw ("{0}: missing {1}" -f $Code, $key) }
    if ([long]$expectedMap[$key].bytes -ne [long]$actualMap[$key].bytes -or [string]$expectedMap[$key].sha256 -ne [string]$actualMap[$key].sha256) { throw ("{0}: {1}" -f $Code, $key) }
  }
}
function Get-Sha256([string]$PathValue) { return (Get-FileHash -LiteralPath $PathValue -Algorithm SHA256).Hash.ToLowerInvariant() }
function Set-PrivateDir([string]$PathValue) {
  if (-not (Test-Path -LiteralPath $PathValue)) { New-Item -ItemType Directory -Path $PathValue -Force | Out-Null }
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $acl = [System.Security.AccessControl.DirectorySecurity]::new()
  $acl.SetAccessRuleProtection($true, $false)
  $inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
  foreach ($sid in @($identity.User, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
    $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::FullControl, $inherit, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow))
  }
  Set-Acl -LiteralPath $PathValue -AclObject $acl
}
function Set-PrivateFile([string]$PathValue) {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $acl = [System.Security.AccessControl.FileSecurity]::new()
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($sid in @($identity.User, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
    $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.AccessControlType]::Allow))
  }
  Set-Acl -LiteralPath $PathValue -AclObject $acl
}
function Get-Task { param([string]$Name) return @(Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue) }
function Assert-ReceiptShape($Receipt, [string]$Code) {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  if ($Receipt.schema -ne $receiptSchema -or [string]$Receipt.taskName -ne $TaskName -or [string]$Receipt.installRoot -ne $root) { throw $Code }
  if ([string]$Receipt.userId -notin @($identity.Name, $identity.User.Value)) { throw "${Code}_OWNER_MISMATCH" }
}
function Get-Receipt {
  if (-not (Test-Path -LiteralPath $receiptPath -PathType Leaf)) { throw 'OFFICE_NOT_INSTALLED' }
  $receipt = Get-Content -LiteralPath $receiptPath -Raw -Encoding UTF8 | ConvertFrom-Json
  Assert-ReceiptShape $receipt 'OFFICE_RECEIPT_INVALID'
  return $receipt
}
function Get-OfficeTask([bool]$Required = $true) {
  $tasks = @(Get-Task $TaskName)
  if ($tasks.Count -gt 1) { throw 'OFFICE_TASK_AMBIGUOUS' }
  if ($tasks.Count -eq 0) { if ($Required) { throw 'OFFICE_TASK_MISSING' }; return $null }
  return $tasks[0]
}
function Assert-TaskOwned($task, $receipt) {
  $actions = @($task.Actions)
  if ($actions.Count -ne 1 -or [string]$task.TaskPath -cne '\' -or
      [string]$actions[0].Execute -ne [string]$receipt.pythonExe -or
      [string]$actions[0].Arguments -ne [string]$receipt.arguments -or
      [string]$actions[0].WorkingDirectory -ne [string]$root -or
      ([string]$task.Principal.UserId -notin @([string]$receipt.userId, ([string]$receipt.userId).Split('\\')[-1])) -or
      [string]$task.Principal.RunLevel -notin @('Limited','LeastPrivilege') -or
      @($task.Triggers | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger' }).Count -ne 1) {
    throw 'OFFICE_TASK_OWNERSHIP_DRIFT'
  }
}
function Test-Port([int]$PortValue) {
  $client = New-Object Net.Sockets.TcpClient
  try { $task = $client.ConnectAsync('127.0.0.1', $PortValue); $done = $task.Wait(1000); $open = ($done -and $client.Connected) }
  catch { $open = $false }
  finally { $client.Close() }
  return $open
}
function Assert-PortClosed([int]$PortValue) {
  $client = New-Object Net.Sockets.TcpClient
  try {
    $task = $client.ConnectAsync('127.0.0.1', $PortValue)
    $deadline = [DateTime]::UtcNow.AddSeconds(5)
    while (-not $task.IsCompleted -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 50 }
    if (-not $task.IsCompleted) { throw 'OFFICE_PORT_STATE_UNKNOWN_REFUSE: probe timed out' }
    if ($task.IsFaulted -and $task.Exception) {
      $inner = $task.Exception.GetBaseException()
      if ($inner -is [Net.Sockets.SocketException] -and $inner.SocketErrorCode -eq [Net.Sockets.SocketError]::ConnectionRefused) { return }
      throw ("OFFICE_PORT_STATE_UNKNOWN_REFUSE: {0}" -f $inner.Message)
    }
    if ($client.Connected) { throw 'OFFICE_PORT_IN_USE_REFUSED' }
    throw 'OFFICE_PORT_STATE_UNKNOWN_REFUSE'
  }
  finally { $client.Close() }
}
function Wait-PortFree([int]$PortValue, [int]$Seconds = 15) {
  $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    if (-not (Test-Port $PortValue)) { return $true }
    Start-Sleep -Milliseconds 300
  }
  return (-not (Test-Port $PortValue))
}
function Get-OfficeProcesses {
  $marker = Join-Path $serviceDir 'run_office.py'
  return @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($marker) })
}
function Assert-OfficeStopped($Task) {
  if ($Task -and [string]$Task.State -notin @('Ready','Disabled')) { throw 'OFFICE_RESTAGE_TASK_RUNNING_STOP_FIRST' }
  if (@(Get-OfficeProcesses).Count -ne 0) { throw 'OFFICE_RESTAGE_PROCESSES_RUNNING_STOP_FIRST' }
  Assert-PortClosed $Port
}
function Stop-OfficeProcesses {
  $procs = @(Get-OfficeProcesses)
  if ($procs.Count -eq 0) { return }
  $ids = @($procs | ForEach-Object { $_.ProcessId })
  foreach ($p in @($procs | Where-Object { $ids -contains $_.ParentProcessId })) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  foreach ($p in @($procs | Where-Object { $ids -notcontains $_.ParentProcessId })) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  while (@(Get-OfficeProcesses).Count -gt 0 -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 250 }
  if (@(Get-OfficeProcesses).Count -gt 0) { throw 'OFFICE_PROCESS_STOP_UNVERIFIED' }
}
function Get-Health {
  try { $r = Invoke-WebRequest -UseBasicParsing -Uri ("http://127.0.0.1:{0}/health" -f $Port) -TimeoutSec 3; if ($r.StatusCode -eq 200) { return [pscustomobject]@{ok=$true;body=[string]$r.Content} } }
  catch { }
  return [pscustomobject]@{ok=$false;body=''}
}
function Wait-Health([int]$Seconds = 90) {
  $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    $h = Get-Health
    if ($h.ok) { return $h }
    Start-Sleep -Milliseconds 750
  }
  return (Get-Health)
}
function Get-PythonVersion([string]$Exe) {
  $out = & $Exe -c "import sys;print('%d.%d.%d' % sys.version_info[:3])" 2>&1
  if ($LASTEXITCODE -ne 0) { throw 'OFFICE_PYTHON_EXE_UNUSABLE' }
  return ([string]($out | Select-Object -First 1)).Trim()
}
function Assert-Python313([string]$Exe) {
  $null = Assert-LocalPath $Exe 'OFFICE_PYTHON_EXE_REQUIRED'
  if ([IO.Path]::GetFileName($Exe) -notin @('python.exe','python3.exe')) { throw 'OFFICE_PYTHON_EXE_INVALID' }
  $version = Get-PythonVersion $Exe
  $parts = $version.Split('.')
  if ([int]$parts[0] -lt 3 -or ([int]$parts[0] -eq 3 -and [int]$parts[1] -lt 13)) { throw "OFFICE_PYTHON_313_REQUIRED: $version" }
  return $version
}
function Assert-CleanScope {
  if (Test-Path -LiteralPath $root) { throw 'OFFICE_INSTALL_ROOT_EXISTS_USE_REINSTALL_OR_UNINSTALL' }
  if (@(Get-Task $TaskName).Count -ne 0) { throw 'OFFICE_TASK_ALREADY_EXISTS' }
}
function Assert-SourcePin([string]$Source) {
  if (-not (Test-Path -LiteralPath (Join-Path $Source '.git'))) {
    # The recovered acceptance tree carries no .git, so the pin cannot be proven
    # from the tree itself; the operator asserts it and the receipt says so.
    if (-not $AllowUnpinnedSource) { throw 'OFFICE_SOURCE_NO_GIT_PIN_UNVERIFIED' }
    return [pscustomobject]@{commit='unpinned';dirty=$false;gitPresent=$false}
  }
  $commit = (& git -C $Source rev-parse HEAD 2>&1 | Select-Object -First 1)
  if ($LASTEXITCODE -ne 0) { throw 'OFFICE_SOURCE_NOT_A_GIT_CHECKOUT' }
  $commit = ([string]$commit).Trim().ToLowerInvariant()
  if ($commit -ne $pin -and -not $AllowUnpinnedSource) { throw "OFFICE_SOURCE_PIN_MISMATCH: $commit != $pin" }
  $dirty = ((@(& git -C $Source status --porcelain 2>&1) | Measure-Object).Count -gt 0)
  return [pscustomobject]@{commit=$commit;dirty=$dirty;gitPresent=$true}
}
function Assert-SourceTree([string]$Source) {
  foreach ($relative in @('backend/app/main.py','backend/static/index.html','LICENSE','pyproject.toml')) {
    $null = Assert-LocalPath (Join-Path $Source $relative) "OFFICE_SOURCE_INCOMPLETE: $relative"
  }
  $next = Join-Path $Source 'backend/static/_next'
  $buildDirs = @(Get-ChildItem -LiteralPath $next -Directory | Where-Object { $_.Name -ne 'static' })
  if ($buildDirs.Count -ne 1) { throw 'OFFICE_SOURCE_STATIC_BUILD_AMBIGUOUS' }
  $outIndex = Join-Path $Source 'frontend/out/index.html'
  if (Test-Path -LiteralPath $outIndex) {
    if ((Get-Sha256 $outIndex) -ne (Get-Sha256 (Join-Path $Source 'backend/static/index.html'))) {
      throw 'OFFICE_SOURCE_STATIC_IS_STALE: frontend/out and backend/static differ, run apply_office_static.ps1 first'
    }
  }
  return $buildDirs[0].Name
}
function Assert-FrontendNextBuild([string]$Source) {
  $nextDir = Join-Path $Source 'frontend\.next'
  $buildIdPath = Join-Path $nextDir 'BUILD_ID'
  if (-not (Test-Path -LiteralPath $buildIdPath -PathType Leaf)) { throw 'OFFICE_SOURCE_NEXT_BUILD_ID_MISSING' }
  $buildId = ([string](Get-Content -LiteralPath $buildIdPath -Raw -Encoding UTF8)).Trim()
  if (-not $buildId -or $buildId -notmatch '^[A-Za-z0-9._-]+$') { throw 'OFFICE_SOURCE_NEXT_BUILD_ID_INVALID' }
  $staticNext = Join-Path $Source 'backend\static\_next'
  $staticDirs = @(Get-ChildItem -LiteralPath $staticNext -Directory | Where-Object { $_.Name -ne 'static' })
  if ($staticDirs.Count -ne 1) { throw 'OFFICE_SOURCE_STATIC_BUILD_AMBIGUOUS' }
  if ($staticDirs[0].Name -cne $buildId) { throw "OFFICE_SOURCE_BUILD_ID_INCOHERENT: frontend/.next=$buildId backend/static=$($staticDirs[0].Name)" }
  $outNext = Join-Path $Source 'frontend\out\_next'
  if (Test-Path -LiteralPath $outNext -PathType Container) {
    $outDirs = @(Get-ChildItem -LiteralPath $outNext -Directory | Where-Object { $_.Name -ne 'static' })
    if ($outDirs.Count -ne 1 -or $outDirs[0].Name -cne $buildId) { throw 'OFFICE_SOURCE_BUILD_ID_INCOHERENT: frontend/out' }
  }
  return $buildId
}
function Assert-PatchedSource([string]$Source) {
  # The staged tree must already carry the release patch set (office\patches):
  # Ghost-free identities, the seeded Ben default layout, the unconditional desk
  # set and the loopback WebSocket origin. Detect by markers rather than by
  # applying patches, so an already-patched tree is never double-patched.
  $checks = @(
    @{path='backend/app/api/routes/layout.py';marker='async def seed_default_layouts'},
    @{path='backend/app/main.py';marker='from app.api.routes.layout import seed_default_layouts'},
    @{path='backend/app/api/websocket.py';marker='if host in _LOCALHOST_HOSTS:'},
    @{path='frontend/src/components/game/OfficeDesks.tsx';marker='seats.map((seat, i)'},
    @{path='frontend/src/systems/persistentIdentities.ts';marker='agent.id !== "ai-companion"'},
    @{path='frontend/src/systems/idleSweep.ts';marker='agent.id === "ai-companion"'}
  )
  foreach ($check in $checks) {
    $full = Join-Path $Source $check.path
    if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { throw "OFFICE_SOURCE_NOT_PATCHED: $($check.path) missing" }
    if (-not ((Get-Content -LiteralPath $full -Raw) -match [regex]::Escape($check.marker))) { throw "OFFICE_SOURCE_NOT_PATCHED: $($check.path) lacks $($check.marker)" }
  }
  $ghostSeed = '\{\s*name:\s*"Ghost Protocol",\s*id:\s*"ai-companion"\s*\}'
  foreach ($relative in @('frontend/src/systems/persistentIdentities.ts','frontend/src/components/game/OfficeGame.tsx')) {
    $body = Get-Content -LiteralPath (Join-Path $Source $relative) -Raw
    if ($body -match $ghostSeed) { throw 'OFFICE_GHOST_SEED_PRESENT' }
  }
  $desks = Get-Content -LiteralPath (Join-Path $Source 'frontend/src/components/game/OfficeDesks.tsx') -Raw
  if ($desks -match [regex]::Escape('if (!occupied.has(i + 1))')) { throw 'OFFICE_SOURCE_NOT_PATCHED: occupancy draw gate still present' }
  return $true
}
function Write-StageManifest([string]$StageRoot = $root, [string]$SourceRoot = $sourceDir, [string]$ManifestPath = '') {
  # Only the staged Office tree is described. The venv, service wrapper, state,
  # logs, receipt and lock live beside it and are covered by the receipt instead.
  if (-not $ManifestPath) { $ManifestPath = Join-Path $StageRoot 'STAGE-MANIFEST.json' }
  $files = @(Get-ChildItem -LiteralPath $SourceRoot -Recurse -File -Force)
  $rows = foreach ($file in $files) {
    [ordered]@{path=$file.FullName.Substring($SourceRoot.Length + 1).Replace('\','/');bytes=$file.Length;sha256=(Get-Sha256 $file.FullName)}
  }
  $manifest = [ordered]@{schema='singularity-windows-office-stage/v1';stagedAtUtc=(Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ');source='source';fileCount=@($rows).Count;files=@($rows)}
  $manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $ManifestPath -Encoding UTF8
  return $manifest
}
function Assert-StageManifestDocument([string]$ManifestPath = '') {
  if (-not $ManifestPath) { $ManifestPath = Join-Path $root 'STAGE-MANIFEST.json' }
  if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) { throw 'OFFICE_STAGE_MANIFEST_MISSING' }
  $manifest = Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($manifest.schema -ne 'singularity-windows-office-stage/v1' -or $null -eq $manifest.fileCount) { throw 'OFFICE_STAGE_MANIFEST_INVALID' }
  $files = @($manifest.files)
  if ([int]$manifest.fileCount -ne $files.Count) { throw 'OFFICE_STAGE_MANIFEST_INVALID' }
  $seen = @{}
  foreach ($row in $files) {
    $rel = [string]$row.path
    if (-not $rel -or $rel.Contains('..') -or $rel.Contains(':') -or [IO.Path]::IsPathRooted($rel)) { throw 'OFFICE_STAGE_MANIFEST_PATH_INVALID' }
    if ($seen.ContainsKey($rel)) { throw 'OFFICE_STAGE_MANIFEST_PATH_INVALID' }
    $seen[$rel] = $true
  }
  return $manifest
}
function Assert-StageManifest([string]$StageRoot = $root, [string]$SourceRoot = $sourceDir, [string]$ManifestPath = '') {
  if (-not $ManifestPath) { $ManifestPath = Join-Path $StageRoot 'STAGE-MANIFEST.json' }
  $manifest = Assert-StageManifestDocument $ManifestPath
  $expected = @{}
  foreach ($row in @($manifest.files)) {
    $rel = [string]$row.path
    $full = Join-Path $SourceRoot ($rel -replace '/', [IO.Path]::DirectorySeparatorChar)
    if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { throw "OFFICE_STAGE_FILE_MISSING: $rel" }
    if ((Get-Item -LiteralPath $full).Length -ne [long]$row.bytes -or (Get-Sha256 $full) -ne [string]$row.sha256) { throw "OFFICE_STAGE_HASH_MISMATCH: $rel" }
    $expected[$rel] = $true
  }
  $actual = @(Get-ChildItem -LiteralPath $SourceRoot -Recurse -File -Force | ForEach-Object { $_.FullName.Substring($SourceRoot.Length + 1).Replace('\','/') })
  $diff = Compare-Object -ReferenceObject @($expected.Keys | Sort-Object) -DifferenceObject @($actual | Sort-Object)
  if ($diff) { throw 'OFFICE_STAGE_UNOWNED_FILE_REFUSED' }
}
function Write-OfficeReceipt($Receipt, [string]$Path = $receiptPath) {
  [IO.File]::WriteAllText($Path, ($Receipt | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))
  Set-PrivateFile $Path
}
function Copy-OfficeLayout([string]$LayoutPath, [string]$SourceRoot) {
  $destination = Join-Path $SourceRoot 'backend\app\assets\default_layout.json'
  $parent = Split-Path -Parent $destination
  if (-not (Test-Path -LiteralPath $parent -PathType Container)) { throw 'OFFICE_SOURCE_LAYOUT_DIR_MISSING' }
  Copy-Item -LiteralPath $LayoutPath -Destination $destination -Force -ErrorAction Stop
  if ((Get-Sha256 $destination) -ne (Get-Sha256 $LayoutPath)) { throw 'OFFICE_LAYOUT_SEED_MISMATCH' }
}
function Invoke-StageCopy([string]$SourcePath, [string]$DestinationPath) {
  $robocopy = @($SourcePath, $DestinationPath, '/E', '/R:2', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/XD') + $installExclusions
  & robocopy.exe @robocopy | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "OFFICE_STAGE_COPY_FAILED: $LASTEXITCODE" }
}
function Move-OwnedFile([string]$From, [string]$To) {
  if (-not (Test-Path -LiteralPath $From -PathType Leaf)) { throw "OFFICE_RESTAGE_MOVE_SOURCE_MISSING: $From" }
  if (Test-Path -LiteralPath $To -PathType Leaf) { [IO.File]::Replace($From, $To, [NullString]::Value) }
  else { Move-Item -LiteralPath $From -Destination $To -ErrorAction Stop }
}
function Write-RestageJournal([string]$Path, [string]$Phase, [string]$Transaction, [string]$SourcePath, [string]$StagedSource, [string]$PreviousSource, [string]$Detail = '') {
  $journal = [ordered]@{schema='singularity-windows-office-restage/v1';phase=$Phase;atUtc=(Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ');transaction=$Transaction;source=$SourcePath;stagedSource=$StagedSource;previousSource=$PreviousSource;detail=$Detail}
  [IO.File]::WriteAllText($Path, ($journal | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))
  Set-PrivateFile $Path
}
function Assert-ReceiptIntegrity($Receipt) {
  if ([int]$Receipt.port -ne $Port) { throw 'OFFICE_RECEIPT_PORT_MISMATCH' }
  foreach ($name in @('pythonExe','arguments','requirementsLockSha256','stageManifestSha256')) {
    if (-not [string]$Receipt.$name) { throw "OFFICE_RECEIPT_FIELD_MISSING: $name" }
  }
  $lockPath = Join-Path $root 'requirements-lock.txt'
  if (-not (Test-Path -LiteralPath $lockPath -PathType Leaf)) { throw 'OFFICE_LOCK_MISSING' }
  if ((Get-Sha256 $lockPath) -ne [string]$Receipt.requirementsLockSha256) { throw 'OFFICE_LOCK_TAMPERED' }
  $manifestPath = Join-Path $root 'STAGE-MANIFEST.json'
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'OFFICE_STAGE_MANIFEST_MISSING' }
  $null = Assert-StageManifestDocument $manifestPath
  if ((Get-Sha256 $manifestPath) -ne [string]$Receipt.stageManifestSha256) { throw 'OFFICE_STAGE_MANIFEST_TAMPERED' }
  if (-not (Test-Path -LiteralPath ([string]$Receipt.pythonExe) -PathType Leaf)) { throw 'OFFICE_RECEIPT_PYTHON_MISSING' }
  foreach ($relative in @('service\run_office.py', 'service\service.json', 'state\office.db', 'state\keys.json')) {
    if (-not (Test-Path -LiteralPath (Join-Path $root $relative) -PathType Leaf)) { throw "OFFICE_RECEIPT_STATE_MISSING: $relative" }
  }
  if (-not (Test-Path -LiteralPath $logDir -PathType Container)) { throw 'OFFICE_RECEIPT_LOGS_MISSING' }
}
function New-RestageReceipt($Existing, [string]$ManifestPath, [string]$BuildId, $PinInfo, [string]$LayoutSha, [string]$Stamp) {
  $next = $Existing | Select-Object -Property *
  $next.sourceCommit = [string]$PinInfo.commit
  $next.sourceDirty = [bool]$PinInfo.dirty
  $next.sourceGitPresent = [bool]$PinInfo.gitPresent
  $next.staticBuildId = $BuildId
  $next.layoutAssetSha256 = $LayoutSha
  $next.stageManifestSha256 = (Get-Sha256 $ManifestPath)
  $next | Add-Member -NotePropertyName restagedAtUtc -NotePropertyValue $Stamp -Force
  return $next
}
function Restore-RestageFile([string]$Backup, [string]$Target, [string]$ExpectedSha, [string]$Code) {
  if (-not (Test-Path -LiteralPath $Backup -PathType Leaf)) { throw "$Code`: backup missing" }
  Copy-Item -LiteralPath $Backup -Destination $Target -Force -ErrorAction Stop
  if ((Get-Sha256 $Target) -ne $ExpectedSha) { throw "$Code`: hash mismatch" }
}
function Invoke-RestageRollback([string]$SourceRoot, [string]$PreviousSource, [string]$FailedSource, [string]$PreviousManifest, [string]$PreviousReceipt, [string]$ManifestPath, [string]$ReceiptPath, $OriginalInventory, [string]$OriginalManifestSha, [string]$OriginalReceiptSha) {
  $errors = New-Object 'System.Collections.Generic.List[string]'
  try {
    if (Test-Path -LiteralPath $PreviousSource -PathType Container) {
      if (Test-Path -LiteralPath $SourceRoot) {
        if (Test-Path -LiteralPath $FailedSource) { throw 'failed holding path already exists' }
        Move-Item -LiteralPath $SourceRoot -Destination $FailedSource -ErrorAction Stop
      }
      Move-Item -LiteralPath $PreviousSource -Destination $SourceRoot -ErrorAction Stop
    } elseif (-not (Test-Path -LiteralPath $SourceRoot -PathType Container)) {
      throw 'source and previous source are both missing'
    }
    Restore-RestageFile $PreviousManifest $ManifestPath $OriginalManifestSha 'OFFICE_RESTAGE_ROLLBACK_MANIFEST'
    Restore-RestageFile $PreviousReceipt $ReceiptPath $OriginalReceiptSha 'OFFICE_RESTAGE_ROLLBACK_RECEIPT'
    $restored = @(Get-SelectedFileInventory $SourceRoot @())
    Assert-InventoryMatches $OriginalInventory $restored 'OFFICE_RESTAGE_ROLLBACK_SOURCE'
  } catch { $errors.Add($_.Exception.Message) }
  if ($errors.Count -ne 0) { throw ('OFFICE_RESTAGE_ROLLBACK_FAILED: ' + ($errors -join ' | ')) }
}
function Invoke-OfficeRestage($Receipt) {
  $stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
  $txRoot = Join-Path $root '.restage'
  $txDir = Join-Path $txRoot $stamp
  $stagedSource = Join-Path $txDir 'new-source'
  $previousSource = Join-Path $txDir 'previous-source'
  $failedSource = Join-Path $txDir 'failed-source'
  $previousManifest = Join-Path $txDir 'previous-STAGE-MANIFEST.json'
  $previousReceipt = Join-Path $txDir 'previous-office-install.json'
  $candidateManifest = Join-Path $txDir 'STAGE-MANIFEST.json'
  $candidateReceipt = Join-Path $txDir 'office-install.json'
  $layoutCopy = Join-Path $txDir 'ben-layout.json'
  $journalPath = Join-Path $txDir 'RESTAGE-JOURNAL.json'
  $manifestPath = Join-Path $root 'STAGE-MANIFEST.json'

  Assert-ReceiptIntegrity $Receipt
  $task = Get-OfficeTask
  Assert-TaskOwned $task $Receipt
  Assert-OfficeStopped $task

  $source = Assert-LocalPath $OfficeSource 'OFFICE_SOURCE_REQUIRED' $true $true
  $null = Assert-NoReparseChain $source
  $null = Assert-NoReparseChain $root
  $null = Assert-NoReparseChain $sourceDir
  $null = Assert-NoReparseChain $manifestPath
  $null = Assert-NoReparseChain $receiptPath
  $null = Assert-NoReparseChain $txRoot
  Assert-DisjointPaths $source $root
  Assert-DisjointPaths $source $sourceDir
  $layout = Assert-LocalPath $layoutAsset 'OFFICE_LAYOUT_ASSET_REQUIRED'
  $null = Assert-NoReparseChain $layout
  $pinInfo = Assert-SourcePin $source
  $sourceBuild = Assert-SourceTree $source
  $nextBuild = Assert-FrontendNextBuild $source
  if ($sourceBuild -ne $nextBuild) { throw 'OFFICE_SOURCE_BUILD_ID_INCOHERENT' }
  $null = Assert-PatchedSource $source
  $sourceInventory = @(Get-SelectedFileInventory $source $installExclusions)
  if ($sourceInventory.Count -eq 0) { throw 'OFFICE_SOURCE_EMPTY' }
  $null = Assert-NoReparseUnder $sourceDir
  $originalSourceInventory = @(Get-SelectedFileInventory $sourceDir @())

  if (-not (Test-Path -LiteralPath $txRoot -PathType Container)) {
    New-Item -ItemType Directory -Path $txRoot -Force | Out-Null
    Set-PrivateDir $txRoot
  }
  if (Test-Path -LiteralPath $txDir) { throw 'OFFICE_RESTAGE_TRANSACTION_EXISTS' }
  New-Item -ItemType Directory -Path $txDir -Force | Out-Null
  Set-PrivateDir $txDir
  Write-RestageJournal $journalPath 'prepared' $txDir $source $stagedSource $previousSource

  Copy-Item -LiteralPath $manifestPath -Destination $previousManifest -Force -ErrorAction Stop
  $originalManifestSha = Get-Sha256 $manifestPath
  if ((Get-Sha256 $previousManifest) -ne $originalManifestSha) { throw 'OFFICE_RESTAGE_BACKUP_MANIFEST_MISMATCH' }
  Copy-Item -LiteralPath $receiptPath -Destination $previousReceipt -Force -ErrorAction Stop
  $originalReceiptSha = Get-Sha256 $receiptPath
  if ((Get-Sha256 $previousReceipt) -ne $originalReceiptSha) { throw 'OFFICE_RESTAGE_BACKUP_RECEIPT_MISMATCH' }
  Copy-Item -LiteralPath $layout -Destination $layoutCopy -Force -ErrorAction Stop
  $layoutSha = Get-Sha256 $layout
  if ((Get-Sha256 $layoutCopy) -ne $layoutSha) { throw 'OFFICE_RESTAGE_BACKUP_LAYOUT_MISMATCH' }

  Invoke-StageCopy $source $stagedSource
  Set-PrivateDir $stagedSource
  $null = Assert-NoReparseUnder $stagedSource
  Copy-OfficeLayout $layoutCopy $stagedSource

  $sourceInventoryAfter = @(Get-SelectedFileInventory $source $installExclusions)
  Assert-InventoryMatches $sourceInventory $sourceInventoryAfter 'OFFICE_RESTAGE_SOURCE_CHANGED'
  $stagedInventory = @(Get-SelectedFileInventory $stagedSource @())
  $expectedInventory = @($sourceInventory | Where-Object { $_.path -ne 'backend/app/assets/default_layout.json' })
  $expectedInventory += [pscustomobject]@{path='backend/app/assets/default_layout.json';bytes=(Get-Item -LiteralPath $layoutCopy).Length;sha256=$layoutSha}
  Assert-InventoryMatches $expectedInventory $stagedInventory 'OFFICE_RESTAGE_STAGED_SOURCE_MISMATCH'
  $null = Assert-PatchedSource $stagedSource
  $stagedBuild = Assert-SourceTree $stagedSource
  $stagedNextBuild = Assert-FrontendNextBuild $stagedSource
  if ($stagedBuild -ne $sourceBuild -or $stagedNextBuild -ne $sourceBuild) { throw 'OFFICE_RESTAGE_BUILD_ID_CHANGED' }
  $null = Assert-NoReparseUnder $stagedSource
  $manifest = Write-StageManifest -StageRoot $txDir -SourceRoot $stagedSource -ManifestPath $candidateManifest
  Assert-StageManifest -StageRoot $txDir -SourceRoot $stagedSource -ManifestPath $candidateManifest
  $candidateManifestSha = Get-Sha256 $candidateManifest
  $candidateReceiptData = New-RestageReceipt $Receipt $candidateManifest $stagedBuild $pinInfo $layoutSha $stamp
  Write-OfficeReceipt $candidateReceiptData $candidateReceipt
  $candidateReceiptSha = Get-Sha256 $candidateReceipt
  $candidateReadback = Get-Content -LiteralPath $candidateReceipt -Raw -Encoding UTF8 | ConvertFrom-Json
  Assert-ReceiptShape $candidateReadback 'OFFICE_RESTAGE_RECEIPT_INVALID'
  foreach ($name in @('pythonExe','arguments','userId','taskName','installRoot','port','requirementsLockSha256','installedAtUtc')) {
    if ([string]$candidateReadback.$name -ne [string]$Receipt.$name) { throw "OFFICE_RESTAGE_RECEIPT_FIELD_CHANGED: $name" }
  }
  if ([string]$candidateReadback.stageManifestSha256 -ne $candidateManifestSha) { throw 'OFFICE_RESTAGE_RECEIPT_MANIFEST_MISMATCH' }

  $null = Assert-SourcePin $source
  $recheckBuild = Assert-SourceTree $source
  $recheckNext = Assert-FrontendNextBuild $source
  if ($recheckBuild -ne $sourceBuild -or $recheckNext -ne $sourceBuild) { throw 'OFFICE_RESTAGE_SOURCE_BUILD_CHANGED' }
  $null = Assert-PatchedSource $source
  $recheckInventory = @(Get-SelectedFileInventory $source $installExclusions)
  Assert-InventoryMatches $sourceInventory $recheckInventory 'OFFICE_RESTAGE_SOURCE_CHANGED_BEFORE_PROMOTION'
  $taskNow = Get-OfficeTask
  Assert-TaskOwned $taskNow $Receipt
  Assert-OfficeStopped $taskNow
  Assert-ReceiptIntegrity $Receipt
  Write-RestageJournal $journalPath 'rechecked' $txDir $source $stagedSource $previousSource

  $promotionStarted = $false
  try {
    Write-RestageJournal $journalPath 'promoting' $txDir $source $stagedSource $previousSource
    $promotionStarted = $true
    Move-Item -LiteralPath $sourceDir -Destination $previousSource -ErrorAction Stop
    $previousInventory = @(Get-SelectedFileInventory $previousSource @())
    Assert-InventoryMatches $originalSourceInventory $previousInventory 'OFFICE_RESTAGE_PREVIOUS_SOURCE_MISMATCH'
    Write-RestageJournal $journalPath 'previous-source-held' $txDir $source $stagedSource $previousSource
    Move-Item -LiteralPath $stagedSource -Destination $sourceDir -ErrorAction Stop
    $promotedInventory = @(Get-SelectedFileInventory $sourceDir @())
    Assert-InventoryMatches $expectedInventory $promotedInventory 'OFFICE_RESTAGE_PROMOTED_SOURCE_MISMATCH'
    Move-OwnedFile $candidateManifest $manifestPath
    if ((Get-Sha256 $manifestPath) -ne $candidateManifestSha) { throw 'OFFICE_RESTAGE_MANIFEST_MISMATCH' }
    Move-OwnedFile $candidateReceipt $receiptPath
    if ((Get-Sha256 $receiptPath) -ne $candidateReceiptSha) { throw 'OFFICE_RESTAGE_RECEIPT_MISMATCH' }
    $liveReceipt = Get-Receipt
    Assert-ReceiptIntegrity $liveReceipt
    Assert-StageManifest
    $liveTask = Get-OfficeTask
    Assert-TaskOwned $liveTask $liveReceipt
    Assert-OfficeStopped $liveTask
    Write-RestageJournal $journalPath 'verified' $txDir $source $stagedSource $previousSource
  } catch {
    $failure = $_.Exception.Message
    if (-not $promotionStarted) {
      try { Write-RestageJournal $journalPath 'failed-before-promotion' $txDir $source $stagedSource $previousSource $failure } catch { }
      throw ("OFFICE_RESTAGE_FAILED_BEFORE_PROMOTION: " + $failure)
    }
    $rollbackOk = $true
    $rollbackError = ''
    try {
      Invoke-RestageRollback $sourceDir $previousSource $failedSource $previousManifest $previousReceipt $manifestPath $receiptPath $originalSourceInventory $originalManifestSha $originalReceiptSha
    } catch { $rollbackOk = $false; $rollbackError = $_.Exception.Message }
    if ($rollbackOk) {
      try { Write-RestageJournal $journalPath 'rolled-back' $txDir $source $stagedSource $previousSource $failure } catch { }
      throw ("OFFICE_RESTAGE_FAILED_ROLLED_BACK: " + $failure)
    }
    try { Write-RestageJournal $journalPath 'rollback-failed' $txDir $source $stagedSource $previousSource ($failure + ' | ' + $rollbackError) } catch { }
    throw ("OFFICE_RESTAGE_ROLLBACK_FAILED: " + $failure + ' | ' + $rollbackError)
  }

  $liveReceipt = Get-Receipt
  return [ordered]@{schema='singularity-windows-office-lifecycle/v1';mode='Restage';installRoot=$root;port=$Port;taskName=$TaskName;releaseReady=$false;
    state='restaged_not_started';taskRegistered=$true;taskRunning=$false;sourceCommit=[string]$liveReceipt.sourceCommit;sourceDirty=[bool]$liveReceipt.sourceDirty;
    sourceGitPresent=[bool]$liveReceipt.sourceGitPresent;staticBuildId=[string]$liveReceipt.staticBuildId;stageFileCount=[int]$manifest.fileCount;
    stageManifestSha256=$candidateManifestSha;layoutAssetSha256=$layoutSha;restagedAtUtc=$stamp;installedAtUtc=[string]$liveReceipt.installedAtUtc;
    rollbackPath=$txDir;previousSourceRetained=(Test-Path -LiteralPath $previousSource -PathType Container);sourceReplaced=$true}
}
function Invoke-Result($Data) { $Data | ConvertTo-Json -Compress }
$result = [ordered]@{schema='singularity-windows-office-lifecycle/v1';mode=$Mode;installRoot=$root;port=$Port;taskName=$TaskName;releaseReady=$false}
if ($Mode -eq 'Plan') {
  $source = Assert-LocalPath $OfficeSource 'OFFICE_SOURCE_REQUIRED' $true $true
  $version = Assert-Python313 $PythonExe
  $pinInfo = Assert-SourcePin $source
  $buildId = Assert-SourceTree $source
  $null = Assert-PatchedSource $source
  $layout = Assert-LocalPath $layoutAsset 'OFFICE_LAYOUT_ASSET_REQUIRED'
  $lock = $RequirementsLock; if (-not $lock) { $lock = Join-Path $repoRoot 'office\requirements-windows-py313.lock.txt' }
  $lock = Assert-LocalPath $lock 'OFFICE_REQUIREMENTS_LOCK_REQUIRED'
  if ($Wheelhouse) { $Wheelhouse = Assert-LocalPath $Wheelhouse 'OFFICE_WHEELHOUSE_REQUIRED' $true $true }
  if (-not $Wheelhouse -and -not $AllowNetwork) { throw 'OFFICE_NETWORK_INSTALL_NEEDS_ALLOW_NETWORK_OR_WHEELHOUSE' }
  $result.state = 'plan_validated'; $result.willModify = $false; $result.sourceCommit = $pinInfo.commit; $result.sourceDirty = $pinInfo.dirty; $result.sourceGitPresent = $pinInfo.gitPresent
  $result.staticBuildId = $buildId; $result.pythonVersion = $version; $result.requirementsLock = $lock; $result.wheelhouse = $Wheelhouse
  $result.sourcePatched = $true; $result.layoutAsset = $layout; $result.layoutAssetSha256 = (Get-Sha256 $layout)
  $result.taskExists = (@(Get-Task $TaskName).Count -gt 0); $result.installed = (Test-Path -LiteralPath $receiptPath); $result.portOpen = (Test-Port $Port)
  return (Invoke-Result $result)
}
if ($Mode -eq 'Install') {
  Assert-CleanScope
  if (-not $Wheelhouse -and -not $AllowNetwork) { throw 'OFFICE_NETWORK_INSTALL_NEEDS_ALLOW_NETWORK_OR_WHEELHOUSE' }
  $source = Assert-LocalPath $OfficeSource 'OFFICE_SOURCE_REQUIRED' $true $true
  $python = Assert-LocalPath $PythonExe 'OFFICE_PYTHON_EXE_REQUIRED'
  $version = Assert-Python313 $python
  $pinInfo = Assert-SourcePin $source
  $buildId = Assert-SourceTree $source
  $null = Assert-PatchedSource $source
  $layout = Assert-LocalPath $layoutAsset 'OFFICE_LAYOUT_ASSET_REQUIRED'
  $lock = $RequirementsLock; if (-not $lock) { $lock = Join-Path $repoRoot 'office\requirements-windows-py313.lock.txt' }
  $lock = Assert-LocalPath $lock 'OFFICE_REQUIREMENTS_LOCK_REQUIRED'
  if ($Wheelhouse) { $Wheelhouse = Assert-LocalPath $Wheelhouse 'OFFICE_WHEELHOUSE_REQUIRED' $true $true }
  if (-not $PSCmdlet.ShouldProcess($root, "Stage Office source and create venv on port $Port")) { throw 'OFFICE_INSTALL_NOT_CONFIRMED' }
  if (Test-Port $Port) { throw 'OFFICE_PORT_IN_USE_REFUSED' }
  New-Item -ItemType Directory -Path $root -Force | Out-Null
  Set-PrivateDir $root
  New-Item -ItemType Directory -Path $sourceDir -Force | Out-Null
  Set-PrivateDir $sourceDir
  Invoke-StageCopy $source $sourceDir
  Copy-Item -LiteralPath $lock -Destination (Join-Path $root 'requirements-lock.txt') -Force
  # Seed parity: the staged backend asset is the exact Ben layout bundled by the
  # release (office/assets/ben-layout.json), so first boot seeds the live floor.
  Copy-OfficeLayout $layout $sourceDir
  $null = Assert-PatchedSource $sourceDir
  Assert-NoReparseUnder $sourceDir
  $manifest = Write-StageManifest
  Assert-StageManifest
  $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  $venvBootstrap = @('-B', '-c', 'import sys; print(sys.version_info[:3])')
  & $python -m venv $venvDir | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'OFFICE_VENV_CREATE_FAILED' }
  $venvPython = Join-Path $venvDir 'Scripts\python.exe'
  if (-not (Test-Path -LiteralPath $venvPython)) { throw 'OFFICE_VENV_PYTHON_MISSING' }
  $null = Assert-Python313 $venvPython
  $venvPythonw = Join-Path $venvDir 'Scripts\pythonw.exe'
  if (-not (Test-Path -LiteralPath $venvPythonw -PathType Leaf)) { throw 'OFFICE_VENV_PYTHONW_MISSING' }
  & $venvPython -m ensurepip --upgrade 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'OFFICE_ENSUREPIP_FAILED' }
  $installArgs = @('-m','pip','install','--disable-pip-version-check','--no-input','--no-warn-script-location','-r',(Join-Path $root 'requirements-lock.txt'))
  if ($Wheelhouse) { $installArgs += @('--no-index','--find-links',$Wheelhouse) }
  & $venvPython @installArgs 2>&1 | Tee-Object -FilePath (Join-Path $root 'pip-install.log') -Append | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'OFFICE_DEPENDENCY_INSTALL_FAILED' }
  New-Item -ItemType Directory -Path $serviceDir -Force | Out-Null
  Set-PrivateDir $serviceDir
  New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
  Set-PrivateDir $stateDir
  New-Item -ItemType Directory -Path $logDir -Force | Out-Null
  Set-PrivateDir $logDir
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  $bytes = New-Object byte[] 32
  $rng.GetBytes($bytes); $apiKey = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+','-').Replace('/','_')
  $rng.GetBytes($bytes); $ingestKey = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+','-').Replace('/','_')
  $keysPath = Join-Path $stateDir 'keys.json'
  [IO.File]::WriteAllText($keysPath, ([ordered]@{apiKey=$apiKey;ingestKey=$ingestKey;createdAtUtc=(Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')} | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))
  Set-PrivateFile $keysPath
  $serviceJson = Join-Path $serviceDir 'service.json'
  [IO.File]::WriteAllText($serviceJson, ([ordered]@{port=$Port;backendDir=(Join-Path $sourceDir 'backend');stateDir=$stateDir;logDir=$logDir;serveStatic=$true} | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))
  $runnerPath = Join-Path $serviceDir 'run_office.py'
  $runner = @'
import json, os, sys, pathlib
logs = pathlib.Path(__file__).resolve().parent.parent / 'logs'
logs.mkdir(parents=True, exist_ok=True)
handle = open(logs / 'backend.log', 'a', encoding='utf-8', buffering=1)
sys.stdout = sys.stderr = handle
args = sys.argv[1:]
config = pathlib.Path(args[args.index('--config') + 1])
cfg = json.loads(config.read_text(encoding='utf-8-sig'))
state = pathlib.Path(cfg['stateDir'])
keys = json.loads((state / 'keys.json').read_text(encoding='utf-8-sig'))
os.environ.update(
    CLAUDE_OFFICE_API_KEY=keys['apiKey'],
    CLAUDE_OFFICE_INGEST_KEY=keys['ingestKey'],
    SUMMARY_ENABLED='false',
    SUMMARY_BACKEND='disabled',
    SERVE_STATIC='true',
    DATABASE_URL='sqlite+aiosqlite:///' + (state / 'office.db').as_posix(),
)
sys.path.insert(0, str(pathlib.Path(cfg['backendDir'])))
import uvicorn
uvicorn.run('app.main:app', host='127.0.0.1', port=int(cfg['port']), log_level='info')
'@
  [IO.File]::WriteAllText($runnerPath, $runner, (New-Object Text.UTF8Encoding($false)))
  $arguments = '-B "' + $runnerPath + '" --config "' + $serviceJson + '"'
  foreach ($value in @($runnerPath,$serviceJson)) { if ($value.Contains([char]10) -or $value.Contains([char]13)) { throw 'OFFICE_ARGUMENTS_INVALID' } }
  $receipt = [ordered]@{schema=$receiptSchema;taskName=$TaskName;installRoot=$root;pythonExe=$venvPythonw;arguments=$arguments;userId=$user;
    sourceCommit=$pinInfo.commit;sourceDirty=$pinInfo.dirty;sourceGitPresent=$pinInfo.gitPresent;staticBuildId=$buildId;requirementsLockSha256=(Get-Sha256 (Join-Path $root 'requirements-lock.txt'));layoutAssetSha256=(Get-Sha256 $layout);
    stageManifestSha256=(Get-Sha256 (Join-Path $root 'STAGE-MANIFEST.json'));port=$Port;installedAtUtc=(Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')}
  Write-OfficeReceipt $receipt $receiptPath
  $action = New-ScheduledTaskAction -Execute $venvPythonw -Argument $arguments -WorkingDirectory $root
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -ErrorAction Stop | Out-Null
  $registered = Get-OfficeTask
  Assert-TaskOwned $registered (Get-Receipt)
  Assert-StageManifest
  $result.state='installed_not_started';$result.taskRegistered=$true;$result.sourceCommit=$pinInfo.commit;$result.staticBuildId=$buildId
  $result.pythonVersion=$version;$result.portOpen=(Test-Port $Port);$result.stageFileCount=$manifest.fileCount;$result.layoutAssetSha256=(Get-Sha256 $layout);$result.sourcePatched=$true
  return (Invoke-Result $result)
}
$receipt = Get-Receipt
$task = Get-OfficeTask
if ($task) { Assert-TaskOwned $task $receipt }
if ($Mode -eq 'Restage') {
  if (-not $PSCmdlet.ShouldProcess($root, "Restage Office source from $OfficeSource")) { throw 'OFFICE_RESTAGE_NOT_CONFIRMED' }
  return (Invoke-Result (Invoke-OfficeRestage $receipt))
}
if ($Mode -eq 'Start') {
  if (-not $task) { throw 'OFFICE_TASK_MISSING' }
  if (Test-Port $Port) { throw 'OFFICE_PORT_IN_USE_REFUSED' }
  if ($PSCmdlet.ShouldProcess($TaskName, 'Start the owned Office task')) {
    Assert-StageManifest
    if ((Get-Sha256 (Join-Path $root 'requirements-lock.txt')) -ne [string]$receipt.requirementsLockSha256) { throw 'OFFICE_LOCK_TAMPERED' }
    Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  }
  $health = Wait-Health 120
  if (-not $health.ok) {
    $logTail = @()
    $logPath = Join-Path $logDir 'backend.log'
    if (Test-Path -LiteralPath $logPath) { $logTail = @(Get-Content -LiteralPath $logPath -Tail 15) }
    $result.state='start_failed';$result.healthOk=$false;$result.logTail=$logTail
    throw ('OFFICE_HEALTH_FAILED: ' + (($logTail | Select-Object -Last 6) -join ' | '))
  }
  $proc = @(Get-OfficeProcesses)
  $result.state='running';$result.healthOk=$true;$result.healthBody=$health.body;$result.processCount=$proc.Count
  $result.processIds=@($proc | ForEach-Object { $_.ProcessId })
  return (Invoke-Result $result)
}
if ($Mode -eq 'Stop') {
  if ($task -and [string]$task.State -eq 'Running' -and $PSCmdlet.ShouldProcess($TaskName, 'Stop the owned Office task')) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    $deadline=[DateTime]::UtcNow.AddSeconds(10)
    do { Start-Sleep -Milliseconds 250; $task=Get-OfficeTask } while ([string]$task.State -eq 'Running' -and [DateTime]::UtcNow -lt $deadline)
    if ([string]$task.State -eq 'Running') { throw 'OFFICE_TASK_STOP_READBACK_FAILED' }
  }
  if ($PSCmdlet.ShouldProcess($TaskName, 'Terminate the owned Office process tree')) { Stop-OfficeProcesses }
  if (-not (Wait-PortFree $Port)) { throw 'OFFICE_PORT_STILL_OPEN_AFTER_STOP' }
  $result.state='stopped';$result.taskRunning=$false;$result.portOpen=$false
  return (Invoke-Result $result)
}
if ($Mode -eq 'Status') {
  $health = Get-Health
  $result.state = if ($task) { [string]$task.State } else { 'not_installed' }
  $result.taskRegistered = [bool]$task
  $result.taskRunning = [bool]($task -and [string]$task.State -eq 'Running')
  $result.healthOk = [bool]$health.ok
  $result.portOpen = Test-Port $Port
  $result.processCount = @(Get-OfficeProcesses).Count
  $result.sourceCommit = $receipt.sourceCommit; $result.staticBuildId = $receipt.staticBuildId
  $result.stageManifestPresent = (Test-Path -LiteralPath (Join-Path $root 'STAGE-MANIFEST.json'))
  return (Invoke-Result $result)
}
if ($Mode -eq 'Uninstall') {
  if ($PSCmdlet.ShouldProcess($TaskName, 'Stop and remove the owned Office installation')) {
    if ($task -and [string]$task.State -eq 'Running') { Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop; Start-Sleep -Seconds 1 }
    Stop-OfficeProcesses
    if (-not (Wait-PortFree $Port)) { throw 'OFFICE_PORT_STILL_OPEN_AFTER_STOP' }
    if ($task) {
      Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop
      if (@(Get-Task $TaskName).Count -ne 0) { throw 'OFFICE_TASK_REMOVAL_UNVERIFIED' }
    }
    Assert-NoReparseUnder $root
    Remove-Item -LiteralPath $receiptPath -Force
    Remove-Item -LiteralPath $root -Recurse -Force
  }
  if (@(Get-Task $TaskName).Count -ne 0 -or (Test-Path -LiteralPath $root) -or (Test-Port $Port)) { throw 'OFFICE_UNINSTALL_UNVERIFIED' }
  $result.state='uninstalled';$result.taskRegistered=$false;$result.installRootPresent=$false;$result.portOpen=$false
  return (Invoke-Result $result)
}
throw 'OFFICE_MODE_UNHANDLED'
