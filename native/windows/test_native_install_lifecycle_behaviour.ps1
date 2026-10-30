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
  [ValidateSet('SkipOfficeExistingOfficeTask','SkipOfficeAbsentOfficeTask','StaleReceiptTemp','OrphanOfficeStop')]
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
throw 'SCENARIO_MISSING'
