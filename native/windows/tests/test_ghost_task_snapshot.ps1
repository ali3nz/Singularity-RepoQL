# Extract only pure snapshot helpers. The adapter's main block is never run.
$ErrorActionPreference='Stop'
$scriptPath=Join-Path $PSScriptRoot '..\ghost_task_scheduler.ps1'
$tokens=$null
$parseErrors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile(
  $scriptPath,[ref]$tokens,[ref]$parseErrors
)
if ($parseErrors.Count -gt 0) { throw 'Adapter PowerShell parse failed.' }
foreach ($functionName in @('Convert-PrincipalSid','Convert-TaskSnapshot')) {
  $wantedName=$functionName
  $function=$ast.Find({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
      $node.Name -ceq $wantedName
  },$true)
  if ($null -eq $function) { throw 'Snapshot helper function not found.' }
  . ([scriptblock]::Create($function.Extent.Text))
}
$managerPath=Join-Path $PSScriptRoot '..\manage_ghost_scheduler.ps1'
$managerTokens=$null
$managerErrors=$null
$managerAst=[System.Management.Automation.Language.Parser]::ParseFile(
  $managerPath,[ref]$managerTokens,[ref]$managerErrors
)
if ($managerErrors.Count -gt 0) { throw 'Ghost manager PowerShell parse failed.' }
foreach ($functionName in @('Convert-PrincipalSid','Test-DashboardStatePath')) {
  $wantedName=$functionName
  $function=$managerAst.Find({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
      $node.Name -ceq $wantedName
  },$true)
  if ($null -eq $function) { throw 'Ghost manager helper function not found.' }
  . ([scriptblock]::Create($function.Extent.Text))
}
Set-StrictMode -Version Latest

$currentIdentity=[Security.Principal.WindowsIdentity]::GetCurrent()
$currentSid=$currentIdentity.User.Value
$accountName=([string]$currentIdentity.Name -split '\\')[-1]
if ((Convert-PrincipalSid $accountName) -cne $currentSid -or
    (Convert-PrincipalSid $currentSid) -cne $currentSid) {
  throw 'Principal SID canonicalization fixture failed.'
}
if ((Convert-PrincipalSid ([string]$currentIdentity.Name)) -cne $currentSid) {
  throw 'Ghost manager task principal account name was not normalized to its exact SID.'
}
$dashboardRoot=Join-Path $env:TEMP 'singularity-dashboard-scope-fixture\Dashboard'
if (-not (Test-DashboardStatePath $dashboardRoot $dashboardRoot) -or
    -not (Test-DashboardStatePath (Join-Path $dashboardRoot 'child') $dashboardRoot) -or
    (Test-DashboardStatePath ($dashboardRoot+'Extra') $dashboardRoot) -or
    (Test-DashboardStatePath (Join-Path $env:TEMP 'outside') $dashboardRoot)) {
  throw 'Dashboard root and bounded child path fixtures failed.'
}

function New-FixtureTask($Trigger) {
  [pscustomobject]@{
    Actions=@([pscustomobject]@{
      Execute='C:\fixture\python.exe'
      Arguments='fixture.py'
      WorkingDirectory='C:\fixture'
    })
    Triggers=@($Trigger)
    TaskName='fixture'
    TaskPath='\'
    State='Ready'
    Description='fixture only'
    Principal=[pscustomobject]@{
      UserId='S-1-5-21-100-200-300-1001'
      LogonType='InteractiveToken'
      RunLevel='LeastPrivilege'
    }
    Settings=[pscustomobject]@{
      Enabled=$false
      StartWhenAvailable=$false
      MultipleInstances='IgnoreNew'
      ExecutionTimeLimit='PT0S'
    }
  }
}

$principalFixture=New-FixtureTask ([pscustomobject]@{
  CimClass=[pscustomobject]@{CimClassName='MSFT_TaskTimeTrigger'}
  StartBoundary='2026-03-01T09:00:00'
  Enabled=$true
})
$principalFixture.Principal.UserId=$accountName
$principalSnapshot=Convert-TaskSnapshot $principalFixture
if ($principalSnapshot.principal.userId -cne $currentSid) {
  throw 'Task principal account name was not normalized to its exact SID.'
}

$time=Convert-TaskSnapshot (New-FixtureTask ([pscustomobject]@{
  CimClass=[pscustomobject]@{CimClassName='MSFT_TaskTimeTrigger'}
  StartBoundary='2026-03-01T09:00:00'
  Enabled=$true
}))
if ($time.triggers[0].kind -ne 'Time' -or $time.triggers[0].daysOfWeek.Count -ne 0) {
  throw 'Time trigger fixture failed.'
}

$daily=Convert-TaskSnapshot (New-FixtureTask ([pscustomobject]@{
  CimClass=[pscustomobject]@{CimClassName='MSFT_TaskDailyTrigger'}
  StartBoundary='2026-03-01T09:00:00'
  Enabled=$true
  DaysInterval=1
}))
if ($daily.triggers[0].kind -ne 'Daily' -or $daily.triggers[0].daysInterval -ne 1 -or
    $daily.triggers[0].daysOfWeek.Count -ne 0) {
  throw 'Daily trigger fixture failed.'
}

$weekly=Convert-TaskSnapshot (New-FixtureTask ([pscustomobject]@{
  CimClass=[pscustomobject]@{CimClassName='MSFT_TaskWeeklyTrigger'}
  StartBoundary='2026-03-01T09:00:00'
  Enabled=$true
  DaysOfWeek=[uint16]1
  WeeksInterval=1
}))
if ($weekly.triggers[0].kind -ne 'Weekly' -or
    $weekly.triggers[0].daysOfWeek.Count -ne 1 -or
    $weekly.triggers[0].daysOfWeek[0] -cne 'Sunday') {
  throw 'Weekly Sunday bitmask fixture failed.'
}

$multi=Convert-TaskSnapshot (New-FixtureTask ([pscustomobject]@{
  CimClass=[pscustomobject]@{CimClassName='MSFT_TaskWeeklyTrigger'}
  StartBoundary='2026-03-01T09:00:00'
  Enabled=$true
  DaysOfWeek=[uint16]65
  WeeksInterval=1
}))
if (($multi.triggers[0].daysOfWeek -join ',') -cne 'Sunday,Saturday') {
  throw 'Weekly multi-day bitmask fixture failed.'
}

'PASS: principal SID canonicalization, dashboard scope, and Time, Daily, Weekly UInt16 bitmask fixtures'
