#Requires -Version 5.1
<#
Isolated behaviour fixtures for the Office Restage mode.

It extracts the real manager functions, replaces only the Task Scheduler,
process discovery and the copy/promotion seams with in-memory or fixture
implementations, and works entirely under a private temp root. It never
registers, starts, stops or removes a real scheduled task and never touches the
live Office install.

Output: one compact JSON object on stdout.
#>
[CmdletBinding()]
param(
  [ValidateSet('RestageSuccessStaleManifest','TaskRunningRefused','TaskQueuedRefused','ProcessRunningRefused','PortBusyRefused','TaskOwnershipRefused','ReparseRefused','NestedPathRefused','DevicePathRefused','SourceCopyFailure','ReceiptPromotionFailureRollback')]
  [string]$Scenario='RestageSuccessStaleManifest'
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$managerPath=Join-Path $PSScriptRoot 'manage_claude_office.ps1'
if (-not (Test-Path -LiteralPath $managerPath -PathType Leaf)) { throw 'MANAGER_MISSING' }
$tokens=$null
$parseErrors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile($managerPath,[ref]$tokens,[ref]$parseErrors)
if ($parseErrors.Count -ne 0) { throw ('MANAGER_PARSE_ERROR: ' + (($parseErrors | ForEach-Object { $_.Message }) -join '; ')) }
function Get-ProductionFunctionText([string]$Name) {
  $defs=@($ast.FindAll({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $Name
  },$true))
  if ($defs.Count -ne 1) { throw ('MANAGER_FUNCTION_NOT_UNIQUE: ' + $Name + ' count=' + $defs.Count) }
  return $defs[0].Extent.Text
}
$productionFunctions=@(
  'Assert-LocalPath','Assert-NoReparseUnder','Assert-NoReparseChain','Assert-DisjointPaths',
  'Get-SelectedFileInventory','Assert-InventoryMatches','Get-Sha256','Set-PrivateDir','Set-PrivateFile',
  'Get-Task','Assert-ReceiptShape','Get-Receipt','Get-OfficeTask','Assert-TaskOwned','Test-Port',
  'Assert-PortClosed','Get-OfficeProcesses','Assert-OfficeStopped','Assert-SourcePin','Assert-SourceTree',
  'Assert-FrontendNextBuild','Assert-PatchedSource','Write-StageManifest','Assert-StageManifestDocument',
  'Assert-StageManifest','Write-OfficeReceipt','Copy-OfficeLayout','Invoke-StageCopy','Move-OwnedFile',
  'Write-RestageJournal','Assert-ReceiptIntegrity','New-RestageReceipt','Restore-RestageFile',
  'Invoke-RestageRollback','Invoke-OfficeRestage'
)
foreach ($name in $productionFunctions) { . ([scriptblock]::Create((Get-ProductionFunctionText $name))) }

# --- isolated fixture plumbing -------------------------------------------------
$script:TaskName='Singularity-ClaudeComplete-Office-Fixture'
$script:receiptSchema='singularity-windows-office/v1'
$script:fakeTasks=@()
$script:fakeProcesses=@()
$script:taskStarted=$false
$script:lastError=''
function Start-ScheduledTask { $script:taskStarted=$true }
function Get-ScheduledTask {
  [CmdletBinding()]
  param([string]$TaskName)
  return @($script:fakeTasks | Where-Object { $_.TaskName -eq $TaskName })
}
function Get-OfficeProcesses { return @($script:fakeProcesses) }
function New-FixtureText([string]$Path,[string]$Text) {
  $parent=Split-Path -Parent $Path
  if (-not (Test-Path -LiteralPath $parent -PathType Container)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
  [IO.File]::WriteAllText($Path,$Text,(New-Object Text.UTF8Encoding($false)))
}
function New-FixtureSource([string]$SourceRoot,[string]$BuildId,[string]$IndexText,[string]$OfficeGameText) {
  New-Item -ItemType Directory -Path $SourceRoot -Force | Out-Null
  New-FixtureText (Join-Path $SourceRoot 'LICENSE') 'fixture license'
  New-FixtureText (Join-Path $SourceRoot 'pyproject.toml') "[project]`nname = 'fixture-office'`n"
  New-FixtureText (Join-Path $SourceRoot 'backend/app/main.py') "from app.api.routes.layout import seed_default_layouts`n`nasync def app() -> None:`n    return None`n"
  New-FixtureText (Join-Path $SourceRoot 'backend/app/api/routes/layout.py') "async def seed_default_layouts():`n    return None`n"
  New-FixtureText (Join-Path $SourceRoot 'backend/app/api/websocket.py') "if host in _LOCALHOST_HOSTS:`n    pass`n"
  New-FixtureText (Join-Path $SourceRoot 'frontend/src/components/game/OfficeDesks.tsx') "export const desks = seats.map((seat, i) => seat);`n"
  New-FixtureText (Join-Path $SourceRoot 'frontend/src/systems/persistentIdentities.ts') "export const label = 'Ghost Protocol';`n"
  New-FixtureText (Join-Path $SourceRoot 'frontend/src/components/game/OfficeGame.tsx') $OfficeGameText
  New-FixtureText (Join-Path $SourceRoot 'backend/static/index.html') $IndexText
  New-FixtureText (Join-Path $SourceRoot 'frontend/out/index.html') $IndexText
  New-FixtureText (Join-Path $SourceRoot 'backend/static/404.html') ($IndexText + "`n404")
  New-FixtureText (Join-Path $SourceRoot 'frontend/out/404.html') ($IndexText + "`n404")
  New-FixtureText (Join-Path $SourceRoot ('backend/static/_next/' + $BuildId + '/_buildManifest.js')) 'self.__BUILD_MANIFEST={};'
  New-FixtureText (Join-Path $SourceRoot ('frontend/out/_next/' + $BuildId + '/_buildManifest.js')) 'self.__BUILD_MANIFEST={};'
  New-FixtureText (Join-Path $SourceRoot 'frontend/.next/BUILD_ID') $BuildId
  New-FixtureText (Join-Path $SourceRoot 'frontend/.next/server/app.js') 'fixture server build'
  New-FixtureText (Join-Path $SourceRoot 'backend/app/assets/default_layout.json') '{"layout":"old"}'
  New-FixtureText (Join-Path $SourceRoot 'node_modules/ignored.txt') 'excluded node_modules'
  New-FixtureText (Join-Path $SourceRoot 'data/ignored.db') 'excluded data'
}
function New-FixtureLayout([string]$Path,[string]$Value) {
  New-FixtureText $Path ('{"layout":"' + $Value + '","overrides":43}')
}
function New-FakeTask($Receipt) {
  $user=[Security.Principal.WindowsIdentity]::GetCurrent().Name
  return [pscustomobject]@{
    TaskName=$script:TaskName
    TaskPath='\'
    State='Ready'
    Actions=@([pscustomobject]@{Execute=[string]$Receipt.pythonExe;Arguments=[string]$Receipt.arguments;WorkingDirectory=[string]$script:root})
    Principal=[pscustomobject]@{UserId=$user;RunLevel='Limited'}
    Triggers=@([pscustomobject]@{CimClass=[pscustomobject]@{CimClassName='MSFT_TaskLogonTrigger'}})
  }
}
function Get-ClosedPort {
  $listener=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0)
  $listener.Start()
  $port=([Net.IPEndPoint]$listener.LocalEndpoint).Port
  $listener.Stop()
  return $port
}
function Get-FixtureRowsFingerprint($Rows) {
  $text=(@($Rows) | Sort-Object -Property path | ForEach-Object { [string]$_.path + ':' + [string]$_.sha256 }) -join "`n"
  $sha=[Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($text)))).Replace('-','').ToLowerInvariant() }
  finally { $sha.Dispose() }
}
function Get-FixtureFingerprint([string]$Path) {
  return Get-FixtureRowsFingerprint @(Get-SelectedFileInventory $Path @())
}
function Get-FixtureFileSha([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return '' }
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}
function New-FixtureInstall([string]$Root,[string]$OldBuildId) {
  $script:root=$Root
  $script:sourceDir=Join-Path $Root 'source'
  $script:stateDir=Join-Path $Root 'state'
  $script:logDir=Join-Path $Root 'logs'
  $script:venvDir=Join-Path $Root 'venv'
  $script:serviceDir=Join-Path $Root 'service'
  $script:receiptPath=Join-Path $Root 'office-install.json'
  $script:layoutAsset=Join-Path $Root 'approved-layout.json'
  $script:installExclusions=@('.git','node_modules','.venv','__pycache__','data','.claude','.codex','screenshots','feeds-test')
  foreach ($dir in @($Root,$script:sourceDir,$script:stateDir,$script:logDir,$script:venvDir,$script:serviceDir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
  }
  New-FixtureSource $script:sourceDir $OldBuildId '<html>old build</html>' 'old office game'
  $manifestPath=Join-Path $Root 'STAGE-MANIFEST.json'
  $null=Write-StageManifest -StageRoot $Root -SourceRoot $script:sourceDir -ManifestPath $manifestPath
  New-FixtureText (Join-Path $Root 'requirements-lock.txt') 'fixture-lock-v1'
  New-FixtureLayout (Join-Path $Root 'old-layout.json') 'old'
  New-FixtureLayout $script:layoutAsset 'approved'
  New-FixtureText (Join-Path $script:venvDir 'Scripts/python.exe') 'fixture-python'
  New-FixtureText (Join-Path $script:serviceDir 'run_office.py') 'fixture runner'
  New-FixtureText (Join-Path $script:serviceDir 'service.json') '{"port":18128}'
  New-FixtureText (Join-Path $script:stateDir 'office.db') 'fixture-office-db'
  New-FixtureText (Join-Path $script:stateDir 'keys.json') '{"apiKey":"fixture"}'
  New-FixtureText (Join-Path $script:logDir 'backend.log') 'fixture log'
  $receipt=[ordered]@{
    schema=$script:receiptSchema
    taskName=$script:TaskName
    installRoot=$Root
    pythonExe=(Join-Path $script:venvDir 'Scripts/python.exe')
    arguments='-B "fixture-runner" --config "fixture-service"'
    userId=[Security.Principal.WindowsIdentity]::GetCurrent().Name
    sourceCommit='unpinned'
    sourceDirty=$false
    sourceGitPresent=$false
    staticBuildId=$OldBuildId
    requirementsLockSha256=(Get-Sha256 (Join-Path $Root 'requirements-lock.txt'))
    layoutAssetSha256=(Get-Sha256 (Join-Path $Root 'old-layout.json'))
    stageManifestSha256=(Get-Sha256 $manifestPath)
    port=$script:Port
    installedAtUtc='20261030T034025Z'
  }
  Write-OfficeReceipt $receipt $script:receiptPath
  $script:fakeTasks=@(New-FakeTask $receipt)
  # Deliberate stale-manifest state: the served files are newer than the manifest.
  New-FixtureText (Join-Path $script:sourceDir 'backend/static/index.html') '<html>hybrid served</html>'
  New-FixtureText (Join-Path $script:sourceDir 'frontend/out/index.html') '<html>hybrid served</html>'
  New-FixtureText (Join-Path $script:sourceDir 'backend/static/404.html') '<html>hybrid served</html>'
  return (Get-Receipt)
}
function New-FixtureApprovedSource([string]$Root,[string]$BuildId) {
  $source=Join-Path $Root 'approved-source'
  New-FixtureSource $source $BuildId '<html>approved build</html>' 'approved office game'
  return $source
}
function Invoke-ExpectedFailure([string]$Expected,[string]$Code) {
  $script:lastError=''
  try {
    $null=Invoke-OfficeRestage $script:receipt
    throw 'EXPECTED_REFUSAL_MISSING'
  } catch {
    $script:lastError=$_.Exception.Message
  }
  if (-not $script:lastError.Contains($Expected)) { throw (\"WRONG_REFUSAL: \" + $script:lastError) }
  return $script:lastError
}

$script:newBuildId='tnlvkQbMxQGcWEiOKRlMg'
$script:oldBuildId='W2tMCPwkk18JRaB85Wp1m'
$script:Port=Get-ClosedPort
$portListener=$null
if ($Scenario -eq 'PortBusyRefused') {
  $portListener=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0)
  $portListener.Start()
  $script:Port=([Net.IPEndPoint]$portListener.LocalEndpoint).Port
}
$script:root=Join-Path $env:TEMP ('d11-office-restage-' + [guid]::NewGuid().ToString('N'))
$receipt=New-FixtureInstall $script:root $script:oldBuildId
$script:approvedRoot=Join-Path $env:TEMP ('d11-office-approved-' + [guid]::NewGuid().ToString('N'))
$script:OfficeSource=New-FixtureApprovedSource $script:approvedRoot $script:newBuildId
$script:AllowUnpinnedSource=$true
$out=[ordered]@{scenario=$Scenario;ok=$true;newBuildId=$script:newBuildId;oldBuildId=$script:oldBuildId}
try {
  $protectedBefore=(Get-FixtureFingerprint $script:stateDir) + '|' + (Get-FixtureFingerprint $script:venvDir) + '|' + (Get-FixtureFingerprint $script:serviceDir) + '|' + (Get-FixtureFingerprint $script:logDir)
  $sourceBefore=Get-FixtureFingerprint $script:sourceDir
  $manifestBefore=Get-FixtureFileSha (Join-Path $script:root 'STAGE-MANIFEST.json')
  $receiptBefore=Get-FixtureFileSha $script:receiptPath

  switch ($Scenario) {
    'RestageSuccessStaleManifest' {
      $result=Invoke-OfficeRestage $receipt
      $out.result=$result
      $out.state=[string]$result.state
      $out.staticBuildId=[string]$result.staticBuildId
      $out.stageFileCount=[int]$result.stageFileCount
      $out.previousSourceRetained=[bool]$result.previousSourceRetained
      $out.rollbackPath=[string]$result.rollbackPath
      $live=Get-Receipt
      $out.installedAtBefore='20261030T034025Z'
      $out.installedAtAfter=[string]$live.installedAtUtc
      $out.restagedAt=[string]$live.restagedAtUtc
      $out.pythonExePreserved=([string]$live.pythonExe -eq [string]$receipt.pythonExe)
      $out.argumentsPreserved=([string]$live.arguments -eq [string]$receipt.arguments)
      $expectedRows=@(Get-SelectedFileInventory $script:OfficeSource $script:installExclusions | Where-Object { $_.path -ne 'backend/app/assets/default_layout.json' })
      $layoutItem=Get-Item -LiteralPath $script:layoutAsset
      $expectedRows += [pscustomobject]@{path='backend/app/assets/default_layout.json';bytes=$layoutItem.Length;sha256=(Get-Sha256 $script:layoutAsset)}
      $out.expectedStaged=Get-FixtureRowsFingerprint $expectedRows
      $out.sourceBuildId=Assert-SourceTree $script:OfficeSource
      $out.stagedBuildId=Assert-SourceTree $script:sourceDir
      $out.sourceAfter=Get-FixtureFingerprint $script:sourceDir
      $out.approvedSource=Get-FixtureFingerprint $script:OfficeSource
      $out.manifestAfter=Get-FixtureFileSha (Join-Path $script:root 'STAGE-MANIFEST.json')
      $out.receiptAfter=Get-FixtureFileSha $script:receiptPath
      $out.protectedAfter=(Get-FixtureFingerprint $script:stateDir) + '|' + (Get-FixtureFingerprint $script:venvDir) + '|' + (Get-FixtureFingerprint $script:serviceDir) + '|' + (Get-FixtureFingerprint $script:logDir)
      $out.protectedPreserved=($out.protectedAfter -eq $protectedBefore)
      $out.manifestConsistent=$true
      try { Assert-StageManifest; Assert-ReceiptIntegrity $live } catch { $out.manifestConsistent=$false; throw }
    }
    'TaskRunningRefused' {
      $script:fakeTasks[0].State='Running'
      $out.error=Invoke-ExpectedFailure 'OFFICE_RESTAGE_TASK_RUNNING_STOP_FIRST' 'TASK_RUNNING'
    }
    'TaskQueuedRefused' {
      $script:fakeTasks[0].State='Queued'
      $out.error=Invoke-ExpectedFailure 'OFFICE_RESTAGE_TASK_RUNNING_STOP_FIRST' 'TASK_QUEUED'
    }
    'ProcessRunningRefused' {
      $script:fakeProcesses=@([pscustomobject]@{ProcessId=4242;CommandLine='fixture office process'})
      $out.error=Invoke-ExpectedFailure 'OFFICE_RESTAGE_PROCESSES_RUNNING_STOP_FIRST' 'PROCESS_RUNNING'
    }
    'PortBusyRefused' {
      $out.error=Invoke-ExpectedFailure 'OFFICE_PORT_IN_USE_REFUSED' 'PORT_BUSY'
    }
    'TaskOwnershipRefused' {
      $script:fakeTasks[0].Actions[0].Execute='C:\wrong\python.exe'
      $out.error=Invoke-ExpectedFailure 'OFFICE_TASK_OWNERSHIP_DRIFT' 'TASK_OWNERSHIP'
    }
    'ReparseRefused' {
      $link=Join-Path $script:OfficeSource 'extra-link'
      New-Item -ItemType Junction -Path $link -Target (Join-Path $script:OfficeSource 'backend') | Out-Null
      $out.error=Invoke-ExpectedFailure 'OFFICE_SOURCE_REPARSE_REFUSED' 'REPARSE'
    }
    'NestedPathRefused' {
      $nested=Join-Path $script:root 'nested-source'
      New-FixtureSource $nested $script:newBuildId '<html>nested build</html>' 'nested office game'
      $script:OfficeSource=$nested
      $out.error=Invoke-ExpectedFailure 'OFFICE_RESTAGE_PATH_NESTED_REFUSED' 'NESTED_PATH'
    }
    'DevicePathRefused' {
      $out.canonicalSource=Assert-LocalPath $script:OfficeSource 'OFFICE_SOURCE_REQUIRED' $true $true
      $script:OfficeSource='//?/' + ($script:OfficeSource -replace '\\','/')
      $out.deviceSource=$script:OfficeSource
      $out.error=Invoke-ExpectedFailure 'OFFICE_SOURCE_REQUIRED' 'DEVICE_PATH'
    }
    'SourceCopyFailure' {
      function Invoke-StageCopy([string]$SourcePath,[string]$DestinationPath) { throw 'OFFICE_STAGE_COPY_FAILED: 8' }
      $out.error=Invoke-ExpectedFailure 'OFFICE_STAGE_COPY_FAILED' 'COPY_FAILURE'
    }
    'ReceiptPromotionFailureRollback' {
      $script:failReceiptAt=$script:receiptPath
      function Move-OwnedFile([string]$From,[string]$To) {
        if ($To -ceq $script:failReceiptAt) { throw 'TEST_RECEIPT_PROMOTION_FAILURE' }
        if (Test-Path -LiteralPath $To -PathType Leaf) { [IO.File]::Replace($From,$To,[NullString]::Value) }
        else { Move-Item -LiteralPath $From -Destination $To -ErrorAction Stop }
      }
      $out.error=Invoke-ExpectedFailure 'OFFICE_RESTAGE_FAILED_ROLLED_BACK' 'RECEIPT_ROLLBACK'
      $txDirs=@(Get-ChildItem -LiteralPath (Join-Path $script:root '.restage') -Directory -ErrorAction Stop | Sort-Object Name)
      $out.failedSourceRetained=(Test-Path -LiteralPath (Join-Path $txDirs[-1].FullName 'failed-source') -PathType Container)
    }
    default { throw 'SCENARIO_MISSING' }
  }

  $out.sourceBefore=$sourceBefore
  $out.sourceAfter=Get-FixtureFingerprint $script:sourceDir
  $out.manifestBefore=$manifestBefore
  $out.manifestAfter=Get-FixtureFileSha (Join-Path $script:root 'STAGE-MANIFEST.json')
  $out.receiptBefore=$receiptBefore
  $out.receiptAfter=Get-FixtureFileSha $script:receiptPath
  $out.protectedBefore=$protectedBefore
  $out.protectedAfter=(Get-FixtureFingerprint $script:stateDir) + '|' + (Get-FixtureFingerprint $script:venvDir) + '|' + (Get-FixtureFingerprint $script:serviceDir) + '|' + (Get-FixtureFingerprint $script:logDir)
  $out.sourceUnchanged=($out.sourceBefore -eq $out.sourceAfter)
  $out.manifestUnchanged=($out.manifestBefore -eq $out.manifestAfter)
  $out.receiptUnchanged=($out.receiptBefore -eq $out.receiptAfter)
  $out.protectedUnchanged=($out.protectedBefore -eq $out.protectedAfter)
  $out.officeRoot=$script:root
  $out.taskStarted=[bool]$script:taskStarted
} catch {
  $out.ok=$false
  $out.error=$_.Exception.Message
  $out.stack=$_.ScriptStackTrace
  $out.officeRoot=$script:root
  $out.taskStarted=[bool]$script:taskStarted
} finally {
  if ($portListener) { $portListener.Stop() }
}
$out | ConvertTo-Json -Depth 8 -Compress
