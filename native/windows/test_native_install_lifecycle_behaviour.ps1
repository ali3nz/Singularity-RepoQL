#Requires -Version 5.1
<#
Behavioural harness for the native Windows lifecycle manager.

It parses native/windows/manage_native_windows.ps1, executes the real function
bodies in this process, and replaces only external dependencies (scheduler
cmdlets and child managers) with in-memory stubs. It never registers, starts or
removes a scheduled task and never writes a live installation path.

Output: one compact JSON object on stdout.
#>
[CmdletBinding()]
param(
  [ValidateSet('SkipOfficeExistingOfficeTask','SkipOfficeAbsentOfficeTask','StaleReceiptTemp','OrphanOfficeStop',
    'SourceRefreshRoundTrip','SourceRefreshMoveFailure','SourceRefreshStageReceiptFailure','SourceRefreshReceiptFailure',
    'SourceRollbackMoveFailure','SourceRollbackStageReceiptFailure','SourceRollbackReceiptFailure',
    'SourceCandidateUnownedPycacheRefused','SourceCurrentUnownedPycacheRefused',
    'SourceCurrentBinaryMismatchRefused','SourceInstallReceiptOwnerMismatchRefused','SourceReceiptPinMismatchRefused',
    'SourceConsumerProcessRefused','SourceConsumerProcessStateUnknown')]
  [string]$Scenario='SkipOfficeExistingOfficeTask'
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$managerPath=Join-Path $PSScriptRoot 'manage_native_windows.ps1'
if (-not (Test-Path -LiteralPath $managerPath -PathType Leaf)) { throw 'MANAGER_MISSING' }
$tokens=$null
$parseErrors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile($managerPath,[ref]$tokens,[ref]$parseErrors)
if ($parseErrors.Count -ne 0) {
  throw ('MANAGER_PARSE_ERROR: ' + (($parseErrors | ForEach-Object { $_.Message }) -join '; '))
}
function Get-ProductionFunctionText([string]$Name) {
  $defs=@($ast.FindAll({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $Name
  },$true))
  if ($defs.Count -ne 1) { throw ('MANAGER_FUNCTION_NOT_UNIQUE: ' + $Name + ' count=' + $defs.Count) }
  return $defs[0].Extent.Text
}
$taskSupervisor='Singularity-Rust-Native-Supervisor'
$taskDashboard='Singularity-ClaudeComplete-Dashboard'
$taskGhost='Singularity-Ghost-Scheduler'
$taskOffice='Singularity-ClaudeComplete-Office'
$script:fakeTasks=@()
function Get-ScheduledTask { [CmdletBinding()] param() return @($script:fakeTasks) }

if ($Scenario -in @('SkipOfficeExistingOfficeTask','SkipOfficeAbsentOfficeTask')) {
  . ([scriptblock]::Create((Get-ProductionFunctionText 'Get-Task')))
  . ([scriptblock]::Create((Get-ProductionFunctionText 'Get-RegisteredTaskState')))
  . ([scriptblock]::Create((Get-ProductionFunctionText 'Register-Components')))

  $script:receiptCaptures=New-Object 'System.Collections.Generic.List[object]'
  function Write-InstallReceipt($Receipt) {
    $script:receiptCaptures.Add(($Receipt | ConvertTo-Json -Depth 6 -Compress | ConvertFrom-Json))
  }
  function Invoke-Ghost { param([string]$ChildMode,[bool]$Mutate) return [pscustomobject]@{taskRegistered=$true} }
  function Invoke-Dashboard { param([string]$ChildMode,[bool]$Mutate) return [pscustomobject]@{taskRegistered=$true} }
  function Initialize-MemorySecrets { return $false }
  function New-MemoryStackConfig { return $false }

  $hasGhost=$true
  $hasOffice=$false
  $Option=2
  $SupervisorConfig=Join-Path $env:TEMP 'd6-supervisor-stub.json'
  $current=Join-Path $env:TEMP 'd6-current-stub'
  $script:stubDir=Join-Path $env:TEMP ('d6-stub-'+[guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $script:stubDir -Force | Out-Null
  $supervisorRegistrar=Join-Path $script:stubDir 'register-supervisor-task.ps1'
  Set-Content -LiteralPath $supervisorRegistrar -Value 'exit 0' -Encoding ASCII

  if ($Scenario -eq 'SkipOfficeExistingOfficeTask') {
    $script:fakeTasks=@([pscustomobject]@{TaskName=$taskOffice;TaskPath='\';State='Ready'})
  } else {
    $script:fakeTasks=@()
  }
  $receipt=[ordered]@{schema='singularity-native-windows-installation/v1';state='installing';option=2;
    installRoot='C:\d6-stub';ownerSid='S-1-0-0';supervisorTaskRegistered=$false;dashboardTaskRegistered=$false;
    ghostTaskRegistered=$false;officeTaskRegistered=$false}
  Register-Components $receipt
  $state=Get-RegisteredTaskState

  [ordered]@{
    scenario=$Scenario
    receiptWrites=$script:receiptCaptures.Count
    receiptOfficeTaskRegistered=[bool]$receipt.officeTaskRegistered
    receiptSupervisorTaskRegistered=[bool]$receipt.supervisorTaskRegistered
    receiptDashboardTaskRegistered=[bool]$receipt.dashboardTaskRegistered
    receiptGhostTaskRegistered=[bool]$receipt.ghostTaskRegistered
    receiptState=[string]$receipt.state
    resultOfficeTaskRegistered=[bool]$state.officeTaskRegistered
    resultSupervisorTaskRegistered=[bool]$state.supervisorTaskRegistered
    resultDashboardTaskRegistered=[bool]$state.dashboardTaskRegistered
    resultGhostTaskRegistered=[bool]$state.ghostTaskRegistered
    officeIncluded=[bool]$hasOffice
  } | ConvertTo-Json -Compress
  return
}

if ($Scenario -eq 'StaleReceiptTemp') {
  . ([scriptblock]::Create((Get-ProductionFunctionText 'Remove-StaleReceiptTemps')))
  . ([scriptblock]::Create((Get-ProductionFunctionText 'Write-InstallReceipt')))
  . ([scriptblock]::Create((Get-ProductionFunctionText 'Set-PrivateFileAcl')))
  . ([scriptblock]::Create((Get-ProductionFunctionText 'Assert-PrivateAcl')))
  $script:ownerSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $script:systemSid='S-1-5-18'
  $script:allowedSids=@($script:ownerSid,$script:systemSid)
  $script:installRoot=Join-Path $env:TEMP ('d6-receipt-'+[guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $script:installRoot -Force | Out-Null
  $script:installReceiptPath=Join-Path $script:installRoot 'INSTALLATION_RECEIPT.json'
  $freshOther=Join-Path $script:installRoot ('INSTALLATION_RECEIPT.json.pending-999999-'+[guid]::NewGuid().ToString('N'))
  $oldOwn=Join-Path $script:installRoot ('INSTALLATION_RECEIPT.json.pending-'+$PID+'-old')
  $oldOther=Join-Path $script:installRoot 'INSTALLATION_RECEIPT.json.pending-999999-old'
  Set-Content -LiteralPath $freshOther -Value 'fresh' -Encoding ASCII
  Set-Content -LiteralPath $oldOwn -Value 'old-own' -Encoding ASCII
  Set-Content -LiteralPath $oldOther -Value 'old-other' -Encoding ASCII
  (Get-Item -LiteralPath $oldOwn).LastWriteTime=(Get-Date).AddMinutes(-30)
  (Get-Item -LiteralPath $oldOther).LastWriteTime=(Get-Date).AddMinutes(-30)
  Write-InstallReceipt ([ordered]@{schema='singularity-native-windows-installation/v1';state='installing';option=2;installRoot=$script:installRoot;ownerSid=$script:ownerSid})
  $pending=@(Get-ChildItem -LiteralPath $script:installRoot -Filter 'INSTALLATION_RECEIPT.json.pending-*' -File -Force | ForEach-Object { $_.Name })
  $final=Get-Content -LiteralPath $script:installReceiptPath -Raw | ConvertFrom-Json
  [ordered]@{
    scenario=$Scenario
    pending=@($pending)
    finalExists=(Test-Path -LiteralPath $script:installReceiptPath -PathType Leaf)
    finalState=[string]$final.state
    freshOtherSurvived=($pending -contains (Split-Path -Leaf $freshOther))
    oldOwnRemoved=(-not ($pending -contains (Split-Path -Leaf $oldOwn)))
    oldOtherRemoved=(-not ($pending -contains (Split-Path -Leaf $oldOther)))
  } | ConvertTo-Json -Compress
  return
}

if ($Scenario -eq 'OrphanOfficeStop') {
  . ([scriptblock]::Create((Get-ProductionFunctionText 'Get-Task')))
  . ([scriptblock]::Create((Get-ProductionFunctionText 'Stop-OrphanOfficeTask')))
  $script:stopCalls=New-Object 'System.Collections.Generic.List[object]'
  function Stop-ScheduledTask {
    [CmdletBinding()]
    param([string]$TaskName,[string]$TaskPath)
    $script:stopCalls.Add([pscustomobject]@{TaskName=$TaskName;TaskPath=$TaskPath})
    $script:fakeTasks=@($script:fakeTasks | ForEach-Object {
      if ($_.TaskName -ceq $TaskName) { [pscustomobject]@{TaskName=$_.TaskName;TaskPath=$_.TaskPath;State='Ready'} } else { $_ }
    })
  }
  function Start-Sleep { param($Milliseconds) }
  $script:fakeTasks=@(
    [pscustomobject]@{TaskName=$taskOffice;TaskPath='\';State='Running'},
    [pscustomobject]@{TaskName='Singularity-ClaudeComplete-Office-Decoy';TaskPath='\';State='Running'},
    [pscustomobject]@{TaskName='Unrelated-Task';TaskPath='\';State='Running'}
  )
  $task=Get-Task $taskOffice
  Stop-OrphanOfficeTask $task
  $officeAfter=Get-Task $taskOffice
  $decoyAfter=Get-Task 'Singularity-ClaudeComplete-Office-Decoy'
  $unrelatedAfter=Get-Task 'Unrelated-Task'
  $first=if ($script:stopCalls.Count -gt 0) { $script:stopCalls[0] } else { $null }
  [ordered]@{
    scenario=$Scenario
    stopCallCount=$script:stopCalls.Count
    stoppedTaskName=$(if ($first) { [string]$first.TaskName } else { '' })
    stoppedTaskPath=$(if ($first) { [string]$first.TaskPath } else { '' })
    officeState=$(if ($officeAfter) { [string]$officeAfter.State } else { 'Absent' })
    decoyState=$(if ($decoyAfter) { [string]$decoyAfter.State } else { 'Absent' })
    unrelatedState=$(if ($unrelatedAfter) { [string]$unrelatedAfter.State } else { 'Absent' })
  } | ConvertTo-Json -Compress
  return
}

if ($Scenario -in @('SourceRefreshRoundTrip','SourceRefreshMoveFailure','SourceRefreshStageReceiptFailure','SourceRefreshReceiptFailure',
    'SourceRollbackMoveFailure','SourceRollbackStageReceiptFailure','SourceRollbackReceiptFailure',
    'SourceCandidateUnownedPycacheRefused','SourceCurrentUnownedPycacheRefused',
    'SourceCurrentBinaryMismatchRefused','SourceInstallReceiptOwnerMismatchRefused','SourceReceiptPinMismatchRefused',
    'SourceConsumerProcessRefused','SourceConsumerProcessStateUnknown')) {
  # Execute the production source-tree and transaction functions against a
  # synthetic isolated install. Only ACL, task and process probes are stubbed.
  foreach ($name in @('Get-FileSha256','Get-BytesSha256','Get-JsonObjectFromBytes','Assert-ExactFileInventory','Get-SourceTree',
      'Get-ReceiptWithoutSourceHash','Assert-ReceiptNonSourceFieldsEqual','Assert-SourceStageCoherence',
      'Copy-PrivateBytes','Write-SourceSnapshotMetadata','Read-SourceRefreshSnapshot',
      'Invoke-SourceRefreshTransaction','Remove-VerifiedSourceTree','Remove-VerifiedSourceRefreshSnapshot',
      'Invoke-SourceRollbackTransaction','Read-Stage','Read-InstallReceipt')) {
    . ([scriptblock]::Create((Get-ProductionFunctionText $name)))
  }
  $realWrite=(Get-ProductionFunctionText 'Write-BytesAtomic') -replace '^function Write-BytesAtomic','function Invoke-RealWriteBytesAtomic'
  . ([scriptblock]::Create($realWrite))
  function Assert-LocalPath([string]$Value,[string]$Code,[bool]$MustExist=$true,[bool]$Directory=$false) {
    if (-not $Value) { throw $Code }
    $full=[IO.Path]::GetFullPath($Value)
    if ($MustExist -and $Directory -and -not [IO.Directory]::Exists($full)) { throw $Code }
    if ($MustExist -and -not $Directory -and -not [IO.File]::Exists($full)) { throw $Code }
    return $full
  }
  function Assert-PrivateAcl([string]$PathValue) { if (-not (Test-Path -LiteralPath $PathValue)) { throw 'TEST_ACL_PATH_MISSING' } }
  function Set-PrivateDirectoryAcl([string]$PathValue) { if (-not (Test-Path -LiteralPath $PathValue -PathType Container)) { throw 'TEST_ACL_DIRECTORY_MISSING' } }
  function Set-PrivateFileAcl([string]$PathValue) { if (-not (Test-Path -LiteralPath $PathValue -PathType Leaf)) { throw 'TEST_ACL_FILE_MISSING' } }
  function Assert-SourceConsumersStopped($InstallReceipt) { $script:consumerChecks++ }
  function Get-Task([string]$Name) { return $null }
  function Test-GhostOwnershipArtifacts { return $false }
  function Get-CimInstance {
    [CmdletBinding()]
    param([string]$ClassName)
    if ($script:processProbeFailure) { throw 'INJECTED_PROCESS_PROBE_FAILURE' }
    return @($script:processFixture)
  }
  $script:consumerChecks=0
  $script:writeFailurePath=''
  $script:writeFailureConsumed=$false
  function Write-BytesAtomic([string]$Path,[byte[]]$Bytes) {
    if (-not $script:writeFailureConsumed -and $script:writeFailurePath -and $Path -ceq $script:writeFailurePath) {
      $script:writeFailureConsumed=$true
      throw 'INJECTED_RECEIPT_WRITE_FAILURE'
    }
    Invoke-RealWriteBytesAtomic $Path $Bytes
  }
  $script:moveCount=0
  $script:failMoveAt=0
  $script:moveFailureConsumed=$false
  function Move-Item {
    [CmdletBinding()]
    param([string]$LiteralPath,[string]$Destination)
    $script:moveCount++
    if (-not $script:moveFailureConsumed -and $script:failMoveAt -gt 0 -and $script:moveCount -eq $script:failMoveAt) {
      $script:moveFailureConsumed=$true
      throw 'INJECTED_RENAME_FAILURE'
    }
    Microsoft.PowerShell.Management\Move-Item -LiteralPath $LiteralPath -Destination $Destination -ErrorAction Stop
  }
  function New-TestSourceTree([string]$Root,[string]$Flavor) {
    New-Item -ItemType Directory -Path (Join-Path $Root 'fixture') -Force | Out-Null
    $rows=New-Object 'System.Collections.Generic.List[object]'
    for ($i=0; $i -lt 200; $i++) {
      $relative=('fixture/file-{0:D3}.py' -f $i)
      $path=Join-Path $Root ($relative -replace '/', [IO.Path]::DirectorySeparatorChar)
      $content="source-refresh-fixture:$($Flavor):$i`n"
      [IO.File]::WriteAllText($path,$content,[Text.UTF8Encoding]::new($false))
      $rows.Add([pscustomobject]@{path=$relative;sha256=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant();bytes=(Get-Item -LiteralPath $path).Length})
    }
    $manifest=[ordered]@{schema=1;variant=2;release_status='SOURCE_ONLY_UNCOMPILED_NOT_INSTALLER';
      repoql=[ordered]@{requiredVersion='1.7.18';connectorContract='fetch-render'};gui='claude-desktop-code';
      features=[ordered]@{office=$true;ghost=$true};rustOfficeFeature=$true;rustGhostFeature=$true;files=@($rows.ToArray())}
    [IO.File]::WriteAllText((Join-Path $Root 'NATIVE_WINDOWS_SOURCE_MANIFEST.json'),($manifest | ConvertTo-Json -Depth 8 -Compress),[Text.UTF8Encoding]::new($false))
  }
  function Assert-Test([bool]$Condition,[string]$Code) { if (-not $Condition) { throw $Code } }
  $script:sourceFixtureRoot=Join-Path ([IO.Path]::GetTempPath()) ('native-source-refresh-'+[guid]::NewGuid().ToString('N'))
  $script:installRoot=Join-Path $script:sourceFixtureRoot 'WindowsNative'
  $script:current=Join-Path $script:installRoot 'current'
  $script:ownerSid='S-1-0-0'
  New-Item -ItemType Directory -Path (Join-Path $script:current 'source') -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $script:current 'bin') -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $script:installRoot '.source-refresh-candidate') -Force | Out-Null
  New-TestSourceTree (Join-Path $script:current 'source') 'old'
  New-TestSourceTree (Join-Path $script:installRoot '.source-refresh-candidate') 'new'
  $script:installReceiptPath=Join-Path $script:installRoot 'INSTALLATION_RECEIPT.json'
  $script:stageReceiptPath=Join-Path $script:current 'STAGING_RECEIPT.json'
  $script:stagePath=$script:current
  $script:Option=2
  $oldTree=Get-SourceTree (Join-Path $script:current 'source') 2
  $candidateTree=Get-SourceTree (Join-Path $script:installRoot '.source-refresh-candidate') 2
  $bridgePath=Join-Path $script:current 'bin/singularity-desktop-bridge.exe'
  $supervisorPath=Join-Path $script:current 'bin/singularity-windows-supervisor.exe'
  [IO.File]::WriteAllBytes($bridgePath,[byte[]](1,2,3,4,5,6,7,8))
  [IO.File]::WriteAllBytes($supervisorPath,[byte[]](8,7,6,5,4,3,2,1))
  $bridgeHash=(Get-FileHash -LiteralPath $bridgePath -Algorithm SHA256).Hash.ToLowerInvariant()
  $supervisorHash=(Get-FileHash -LiteralPath $supervisorPath -Algorithm SHA256).Hash.ToLowerInvariant()
  $bridgePreimage=[IO.File]::ReadAllBytes($bridgePath)
  $stageReceipt=[ordered]@{schema=1;state='STAGED_UNVERIFIED';option=2;repoqlVersion='1.7.18';sourceManifestSha256=$oldTree.manifestSha256;
    bridgeSha256=$bridgeHash;supervisorSha256=$supervisorHash;bridgePackageVersion='1.0.0';bridgeFeatureOffice=$true;bridgeFeatureGhost=$true;guiConfigured=$false}
  $installReceipt=[ordered]@{schema='singularity-native-windows-installation/v1';state='installed_not_started';option=2;installRoot=$script:installRoot;ownerSid=$script:ownerSid;
    sourceManifestSha256=$oldTree.manifestSha256;bridgeSha256=$bridgeHash;supervisorSha256=$supervisorHash;supervisorTaskRegistered=$true;
    dashboardTaskRegistered=$true;ghostTaskRegistered=$true;officeTaskRegistered=$true;supervisorConfig='C:\fixture\supervisor.json';dashboardPort=18100;guiIntegrationInstalled=$false}
  $stageReceipt | ConvertTo-Json -Depth 8 -Compress | Set-Content -LiteralPath $script:stageReceiptPath -Encoding UTF8
  $installReceipt | ConvertTo-Json -Depth 8 -Compress | Set-Content -LiteralPath $script:installReceiptPath -Encoding UTF8
  $stage=Read-Stage $script:current 2
  $receipt=Read-InstallReceipt $true
  $stagePreimage=[IO.File]::ReadAllBytes($script:stageReceiptPath)
  $installPreimage=[IO.File]::ReadAllBytes($script:installReceiptPath)
  $refreshError=''
  $rollbackError=''
  $refusalError=''
  $refreshed=$false
  try {
    switch ($Scenario) {
      'SourceRefreshMoveFailure' { $script:failMoveAt=3 }
      'SourceRefreshStageReceiptFailure' { $script:writeFailurePath=$script:stageReceiptPath }
      'SourceRefreshReceiptFailure' { $script:writeFailurePath=$script:installReceiptPath }
      'SourceRollbackMoveFailure' { }
      'SourceRollbackStageReceiptFailure' { }
      'SourceRollbackReceiptFailure' { }
      'SourceCandidateUnownedPycacheRefused' { }
      'SourceCurrentUnownedPycacheRefused' { }
      default { }
    }
    if ($Scenario -eq 'SourceCurrentBinaryMismatchRefused') {
      [IO.File]::WriteAllBytes($bridgePath,[byte[]](1,2,3,4,5,6,7,9))
      try { $null=Read-Stage $script:current 2 } catch { $refusalError=$_.Exception.Message }
      [IO.File]::WriteAllBytes($bridgePath,$bridgePreimage)
      Assert-Test ($refusalError -ceq 'NATIVE_STAGE_BINARY_HASH_MISMATCH') 'SOURCE_BINARY_MISMATCH_NOT_REFUSED'
      Assert-Test ((Get-FileHash -LiteralPath $bridgePath -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $bridgeHash) 'SOURCE_BINARY_FIXTURE_NOT_RESTORED'
      Assert-Test ([Convert]::ToBase64String([IO.File]::ReadAllBytes($script:stageReceiptPath)) -ceq [Convert]::ToBase64String($stagePreimage)) 'SOURCE_BINARY_REFUSAL_CHANGED_STAGE_RECEIPT'
      Assert-Test ([Convert]::ToBase64String([IO.File]::ReadAllBytes($script:installReceiptPath)) -ceq [Convert]::ToBase64String($installPreimage)) 'SOURCE_BINARY_REFUSAL_CHANGED_INSTALL_RECEIPT'
    } elseif ($Scenario -eq 'SourceInstallReceiptOwnerMismatchRefused') {
      $badReceipt=$receipt | ConvertTo-Json -Depth 8 -Compress | ConvertFrom-Json
      $badReceipt.ownerSid='S-1-0-1'
      [IO.File]::WriteAllText($script:installReceiptPath,($badReceipt | ConvertTo-Json -Depth 8 -Compress),[Text.UTF8Encoding]::new($false))
      try { $null=Read-InstallReceipt $true } catch { $refusalError=$_.Exception.Message }
      [IO.File]::WriteAllBytes($script:installReceiptPath,$installPreimage)
      Assert-Test ($refusalError -ceq 'NATIVE_INSTALLATION_RECEIPT_INVALID') 'SOURCE_RECEIPT_OWNER_MISMATCH_NOT_REFUSED'
      Assert-Test ([Convert]::ToBase64String([IO.File]::ReadAllBytes($script:installReceiptPath)) -ceq [Convert]::ToBase64String($installPreimage)) 'SOURCE_RECEIPT_OWNER_FIXTURE_NOT_RESTORED'
    } elseif ($Scenario -eq 'SourceReceiptPinMismatchRefused') {
      $badReceipt=$receipt | ConvertTo-Json -Depth 8 -Compress | ConvertFrom-Json
      $badReceipt.sourceManifestSha256=('0' * 64)
      try { Assert-SourceStageCoherence $stage $badReceipt $oldTree } catch { $refusalError=$_.Exception.Message }
      Assert-Test ($refusalError -ceq 'NATIVE_SOURCE_RECEIPT_MISMATCH') 'SOURCE_RECEIPT_PIN_MISMATCH_NOT_REFUSED'
      Assert-Test ([Convert]::ToBase64String([IO.File]::ReadAllBytes($script:stageReceiptPath)) -ceq [Convert]::ToBase64String($stagePreimage)) 'SOURCE_RECEIPT_PIN_REFUSAL_CHANGED_STAGE_RECEIPT'
      Assert-Test ([Convert]::ToBase64String([IO.File]::ReadAllBytes($script:installReceiptPath)) -ceq [Convert]::ToBase64String($installPreimage)) 'SOURCE_RECEIPT_PIN_REFUSAL_CHANGED_INSTALL_RECEIPT'
    } elseif ($Scenario -in @('SourceConsumerProcessRefused','SourceConsumerProcessStateUnknown')) {
      . ([scriptblock]::Create((Get-ProductionFunctionText 'Assert-SourceConsumersStopped')))
      $script:dashboardReceipt=Join-Path $script:sourceFixtureRoot 'dashboard/task-ownership.json'
      $script:processProbeFailure=$false
      if ($Scenario -eq 'SourceConsumerProcessRefused') {
        $script:processFixture=@([pscustomobject]@{Name='unrelated.exe';CommandLine=('worker --source "'+(Join-Path $script:current 'source')+'"');ExecutablePath='C:\fixture\worker.exe'})
        $expectedConsumerError='NATIVE_SOURCE_CONSUMER_RUNNING'
      } else {
        $script:processFixture=@([pscustomobject]@{Name='python.exe';CommandLine=$null;ExecutablePath='C:\Python\python.exe'})
        $expectedConsumerError='NATIVE_SOURCE_CONSUMER_STATE_UNKNOWN'
      }
      $consumerReceipt=[pscustomobject]@{option=2;supervisorTaskRegistered=$false;dashboardTaskRegistered=$false;ghostTaskRegistered=$false;supervisorConfig=''}
      try { Assert-SourceConsumersStopped $consumerReceipt } catch { $refusalError=$_.Exception.Message }
      Assert-Test ($refusalError -ceq $expectedConsumerError) 'SOURCE_CONSUMER_STATE_NOT_REFUSED'
      Assert-Test ([Convert]::ToBase64String([IO.File]::ReadAllBytes($script:stageReceiptPath)) -ceq [Convert]::ToBase64String($stagePreimage)) 'SOURCE_CONSUMER_REFUSAL_CHANGED_STAGE_RECEIPT'
      Assert-Test ([Convert]::ToBase64String([IO.File]::ReadAllBytes($script:installReceiptPath)) -ceq [Convert]::ToBase64String($installPreimage)) 'SOURCE_CONSUMER_REFUSAL_CHANGED_INSTALL_RECEIPT'
    } elseif ($Scenario -in @('SourceCandidateUnownedPycacheRefused','SourceCurrentUnownedPycacheRefused')) {
      $unownedRoot=if ($Scenario -eq 'SourceCandidateUnownedPycacheRefused') { Join-Path $script:installRoot '.source-refresh-candidate' } else { Join-Path $script:current 'source' }
      $unowned=Join-Path $unownedRoot 'fixture/__pycache__/unmanifested.pyc'
      New-Item -ItemType Directory -Path (Split-Path -Parent $unowned) -Force | Out-Null
      [IO.File]::WriteAllBytes($unowned,[byte[]](1,2,3,4))
      try {
        if ($Scenario -eq 'SourceCandidateUnownedPycacheRefused') { $null=Get-SourceTree $unownedRoot 2 }
        else { $null=Read-Stage $script:current 2 }
      }
      catch { $refusalError=$_.Exception.Message }
      $expectedRefusal=if ($Scenario -eq 'SourceCandidateUnownedPycacheRefused') { 'NATIVE_SOURCE_UNOWNED_FILE_REFUSED' } else { 'NATIVE_STAGE_UNOWNED_FILE_REFUSED' }
      Assert-Test ($refusalError -ceq $expectedRefusal) 'SOURCE_UNOWNED_FILE_NOT_REFUSED'
      Assert-Test (Test-Path -LiteralPath $unowned -PathType Leaf) 'SOURCE_UNOWNED_PYCACHE_WAS_DELETED'
      $currentManifestPath=Join-Path $script:current 'source/NATIVE_WINDOWS_SOURCE_MANIFEST.json'
      Assert-Test ((Get-FileHash -LiteralPath $currentManifestPath -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $oldTree.manifestSha256) 'SOURCE_UNOWNED_REFUSAL_CHANGED_CURRENT'
      Assert-Test ([Convert]::ToBase64String([IO.File]::ReadAllBytes($script:stageReceiptPath)) -ceq [Convert]::ToBase64String($stagePreimage)) 'SOURCE_UNOWNED_REFUSAL_CHANGED_STAGE_RECEIPT'
      Assert-Test ([Convert]::ToBase64String([IO.File]::ReadAllBytes($script:installReceiptPath)) -ceq [Convert]::ToBase64String($installPreimage)) 'SOURCE_UNOWNED_REFUSAL_CHANGED_INSTALL_RECEIPT'
    } elseif ($Scenario -in @('SourceRefreshMoveFailure','SourceRefreshStageReceiptFailure','SourceRefreshReceiptFailure')) {
      try { $null=Invoke-SourceRefreshTransaction $stage $receipt $oldTree $candidateTree }
      catch { $refreshError=$_.Exception.Message }
      $restoredTree=Get-SourceTree (Join-Path $script:current 'source') 2
      $restoredStage=[IO.File]::ReadAllBytes($script:stageReceiptPath)
      $restoredInstall=[IO.File]::ReadAllBytes($script:installReceiptPath)
      Assert-Test ($refreshError -like 'NATIVE_SOURCE_REFRESH_FAILED_RECOVERED:*') 'SOURCE_REFRESH_FAILURE_NOT_RECOVERED'
      Assert-Test ($restoredTree.manifestSha256 -ceq $oldTree.manifestSha256) 'SOURCE_REFRESH_OLD_TREE_NOT_RESTORED'
      Assert-Test ([Convert]::ToBase64String($restoredStage) -ceq [Convert]::ToBase64String($stagePreimage)) 'SOURCE_REFRESH_STAGE_RECEIPT_NOT_EXACT'
      Assert-Test ([Convert]::ToBase64String($restoredInstall) -ceq [Convert]::ToBase64String($installPreimage)) 'SOURCE_REFRESH_INSTALL_RECEIPT_NOT_EXACT'
      $state=(Get-Content -LiteralPath (Join-Path $script:installRoot 'source-refresh-snapshot/snapshot.json') -Raw | ConvertFrom-Json).state
      Assert-Test ($state -ceq 'REFRESH_FAILED_RECOVERED') 'SOURCE_REFRESH_FAILURE_SNAPSHOT_STATE_INVALID'
    } else {
      $script:failMoveAt=0
      $script:writeFailurePath=''
      $result=Invoke-SourceRefreshTransaction $stage $receipt $oldTree $candidateTree
      $refreshed=$true
      $newTree=Get-SourceTree (Join-Path $script:current 'source') 2
      Assert-Test ($newTree.manifestSha256 -ceq $candidateTree.manifestSha256) 'SOURCE_REFRESH_NEW_TREE_MISSING'
      $newStageBytes=[IO.File]::ReadAllBytes($script:stageReceiptPath)
      $newInstallBytes=[IO.File]::ReadAllBytes($script:installReceiptPath)
      $snapshot=Read-SourceRefreshSnapshot 2
      if ($Scenario -in @('SourceRollbackMoveFailure','SourceRollbackStageReceiptFailure','SourceRollbackReceiptFailure')) {
        $script:moveCount=0; $script:failMoveAt=if ($Scenario -eq 'SourceRollbackMoveFailure') {2} else {0}; $script:moveFailureConsumed=$false
        if ($Scenario -eq 'SourceRollbackStageReceiptFailure') { $script:writeFailurePath=$script:stageReceiptPath; $script:writeFailureConsumed=$false }
        if ($Scenario -eq 'SourceRollbackReceiptFailure') { $script:writeFailurePath=$script:installReceiptPath; $script:writeFailureConsumed=$false }
        try { $null=Invoke-SourceRollbackTransaction $snapshot $receipt }
        catch { $rollbackError=$_.Exception.Message }
        $recoveredTree=Get-SourceTree (Join-Path $script:current 'source') 2
        Assert-Test ($rollbackError -like 'NATIVE_SOURCE_ROLLBACK_FAILED_RECOVERED:*') 'SOURCE_ROLLBACK_FAILURE_NOT_RECOVERED'
        Assert-Test ($recoveredTree.manifestSha256 -ceq $candidateTree.manifestSha256) 'SOURCE_ROLLBACK_NEW_TREE_NOT_RESTORED'
        Assert-Test ([Convert]::ToBase64String([IO.File]::ReadAllBytes($script:stageReceiptPath)) -ceq [Convert]::ToBase64String($newStageBytes)) 'SOURCE_ROLLBACK_STAGE_RECEIPT_NOT_EXACT'
        Assert-Test ([Convert]::ToBase64String([IO.File]::ReadAllBytes($script:installReceiptPath)) -ceq [Convert]::ToBase64String($newInstallBytes)) 'SOURCE_ROLLBACK_INSTALL_RECEIPT_NOT_EXACT'
        $script:moveCount=0; $script:failMoveAt=0; $script:moveFailureConsumed=$false; $script:writeFailurePath=''; $script:writeFailureConsumed=$false
        $snapshot=Read-SourceRefreshSnapshot 2
      }
      $rollback=Invoke-SourceRollbackTransaction $snapshot (Read-InstallReceipt $true)
      $finalTree=Get-SourceTree (Join-Path $script:current 'source') 2
      Assert-Test ($finalTree.manifestSha256 -ceq $oldTree.manifestSha256) 'SOURCE_ROLLBACK_OLD_TREE_NOT_RESTORED'
      Assert-Test ([Convert]::ToBase64String([IO.File]::ReadAllBytes($script:stageReceiptPath)) -ceq [Convert]::ToBase64String($stagePreimage)) 'SOURCE_ROLLBACK_STAGE_RECEIPT_NOT_EXACT'
      Assert-Test ([Convert]::ToBase64String([IO.File]::ReadAllBytes($script:installReceiptPath)) -ceq [Convert]::ToBase64String($installPreimage)) 'SOURCE_ROLLBACK_INSTALL_RECEIPT_NOT_EXACT'
      Assert-Test (-not (Test-Path -LiteralPath (Join-Path $script:installRoot 'source-refresh-snapshot'))) 'SOURCE_ROLLBACK_SNAPSHOT_NOT_REMOVED'
    }
  } finally {
    if (Test-Path -LiteralPath $script:sourceFixtureRoot) {
      Remove-Item -LiteralPath $script:sourceFixtureRoot -Recurse -Force -ErrorAction Stop
    }
  }
  [ordered]@{scenario=$Scenario;refreshRecovered=($Scenario -in @('SourceRefreshMoveFailure','SourceRefreshStageReceiptFailure','SourceRefreshReceiptFailure'));
    rollbackRecovered=($Scenario -in @('SourceRollbackMoveFailure','SourceRollbackStageReceiptFailure','SourceRollbackReceiptFailure'));
    roundTrip=($Scenario -eq 'SourceRefreshRoundTrip');sourceRefreshSucceeded=$refreshed;consumerChecks=$script:consumerChecks;
    unownedRefused=($Scenario -in @('SourceCandidateUnownedPycacheRefused','SourceCurrentUnownedPycacheRefused'));
    unownedFilePreserved=($Scenario -in @('SourceCandidateUnownedPycacheRefused','SourceCurrentUnownedPycacheRefused'));
    binaryMismatchRefused=($Scenario -eq 'SourceCurrentBinaryMismatchRefused');
    ownerMismatchRefused=($Scenario -eq 'SourceInstallReceiptOwnerMismatchRefused');
    receiptPinMismatchRefused=($Scenario -eq 'SourceReceiptPinMismatchRefused');
    consumerProcessRefused=($Scenario -eq 'SourceConsumerProcessRefused');
    consumerProcessStateUnknown=($Scenario -eq 'SourceConsumerProcessStateUnknown');
    refreshError=$refreshError;rollbackError=$rollbackError;refusalError=$refusalError;releaseReady=$false} | ConvertTo-Json -Compress
  return
}
throw 'SCENARIO_MISSING'
