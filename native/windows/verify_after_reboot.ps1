#Requires -Version 5.1
<#
Read-only post-reboot acceptance for the default-root native Windows stack.

Checks the logon-triggered Rust supervisor, dashboard, Ghost scheduler and
Office service, the loopback health endpoints and task actions, RepoQL 1.7.18,
and the installed Claude Code settings (memory hooks + RepoQL plugin). Writes
one JSON receipt under <InstallRoot>\state\receipts and exits 1 when any
critical check fails.

This script never starts, stops or registers a service, never prints a secret,
and only reads the Office task and its health endpoint; it never writes Office
files or B7-owned sections.
#>
[CmdletBinding()]
param(
  [string]$InstallRoot = '',
  [string]$ClaudeHome = '',
  [string]$OutputPath = '',
  [switch]$Json
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'NATIVE_WINDOWS_REQUIRED' }
if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA_REQUIRED' }
if (-not $env:USERPROFILE) { throw 'USERPROFILE_REQUIRED' }

$checks = New-Object 'System.Collections.Generic.List[object]'
function Add-Check([string]$Name, [string]$Status, [string]$Detail, [string]$Evidence = '') {
  if ($Status -notin @('pass', 'fail', 'warn')) { throw 'CHECK_STATUS_INVALID' }
  $checks.Add([pscustomobject][ordered]@{ name = $Name; status = $Status; detail = $Detail; evidence = $Evidence })
}
function Get-Text([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  return (Get-Content -LiteralPath $Path -Raw -ErrorAction Stop)
}
function Get-Json([string]$Path) {
  $text = Get-Text $Path
  if ($null -eq $text) { return $null }
  return ($text | ConvertFrom-Json)
}
function Test-LoopbackPort([int]$Port) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $iar = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
    if (-not $iar.AsyncWaitHandle.WaitOne(2000)) { return $false }
    $client.EndConnect($iar)
    return $true
  } catch { return $false } finally { $client.Close() }
}
function Invoke-Health([string]$Uri, [hashtable]$Headers = @{}) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $Uri -Headers $Headers -TimeoutSec 8 -MaximumRedirection 0
    return [pscustomobject]@{ ok = $true; status = [int]$response.StatusCode; body = [string]$response.Content; error = '' }
  } catch {
    return [pscustomobject]@{ ok = $false; status = 0; body = ''; error = $_.Exception.Message }
  }
}
function Get-TaskSnapshot([string]$Name) {
  try {
    $task = Get-ScheduledTask -TaskName $Name -ErrorAction Stop
    $info = Get-ScheduledTaskInfo -TaskName $Name -ErrorAction Stop
    $actions = @($task.Actions | ForEach-Object { ("{0} {1}" -f $_.Execute, $_.Arguments).Trim() })
    $triggers = @($task.Triggers | ForEach-Object { $_.CimClass.CimClassName })
    return [pscustomobject]@{
      present = $true; state = [string]$task.State; actions = $actions; triggers = $triggers;
      lastRun = [string]$info.LastRunTime; lastResult = [int]$info.LastTaskResult;
      principal = [string]$task.Principal.UserId
    }
  } catch {
    return [pscustomobject]@{ present = $false; state = 'Missing'; actions = @(); triggers = @(); lastRun = ''; lastResult = -1; principal = '' }
  }
}
function Test-Task([string]$Name, [string[]]$ActionNeedles) {
  $snapshot = Get-TaskSnapshot $Name
  if (-not $snapshot.present) {
    Add-Check "task:$Name" 'fail' 'task is not registered'
    return $snapshot
  }
  $action = ($snapshot.actions -join ' ')
  $missing = @($ActionNeedles | Where-Object { $action -notlike "*$_*" })
  $logon = @($snapshot.triggers | Where-Object { $_ -eq 'MSFT_TaskLogonTrigger' }).Count -gt 0
  $running = $snapshot.state -eq 'Running'
  $ok = $running -and $logon -and $missing.Count -eq 0
  $detail = "state=$($snapshot.state); logonTrigger=$logon; missingAction=$($missing -join ',')"
  Add-Check "task:$Name" $(if ($ok) { 'pass' } else { 'fail' }) $detail "lastRun=$($snapshot.lastRun); lastResult=$($snapshot.lastResult)"
  return $snapshot
}

$defaultRoot = Join-Path $env:LOCALAPPDATA 'Singularity\WindowsNative'
if (-not $InstallRoot) {
  $candidateReceipt = Get-Json (Join-Path $defaultRoot 'INSTALLATION_RECEIPT.json')
  $InstallRoot = if ($candidateReceipt -and $candidateReceipt.installRoot) { [string]$candidateReceipt.installRoot } else { $defaultRoot }
}
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot)
if (-not $ClaudeHome) { $ClaudeHome = Join-Path $env:USERPROFILE '.claude' }
$ClaudeHome = [IO.Path]::GetFullPath($ClaudeHome)
$receiptPath = Join-Path $InstallRoot 'INSTALLATION_RECEIPT.json'
$supervisorPath = Join-Path $InstallRoot 'supervisor.json'
$memoryConfigPath = Join-Path $InstallRoot 'memory\stack.json'
$ghostRoot = Join-Path $env:LOCALAPPDATA 'Singularity\GhostScheduler'

$installReceipt = Get-Json $receiptPath
if ($null -eq $installReceipt) {
  Add-Check 'install:receipt' 'fail' "missing $receiptPath"
} else {
  Add-Check 'install:receipt' 'pass' "state=$($installReceipt.state); option=$($installReceipt.option); root=$($installReceipt.installRoot)" "sourceManifestSha256=$($installReceipt.sourceManifestSha256)"
  if ([string]$installReceipt.installRoot -ne $InstallRoot) {
    Add-Check 'install:root' 'fail' "receipt root does not match -InstallRoot"
  } else { Add-Check 'install:root' 'pass' 'receipt root matches' }
}

$supervisor = Test-Task 'Singularity-Rust-Native-Supervisor' @('singularity-windows-supervisor.exe', $supervisorPath)
$dashboard = Test-Task 'Singularity-ClaudeComplete-Dashboard' @('claude_complete_dashboard_host.py', '--port 18100', '--variant 2')
$office = Test-Task 'Singularity-ClaudeComplete-Office' @('run_office.py', '--config')
$ghost = Test-Task 'Singularity-Ghost-Scheduler' @('ghost_scheduler_host.py', '--config')

# The supervisor owns the memory stack; verify its generated config and the
# exact component health paths the supervisor was asked to manage.
$memoryConfig = Get-Json $memoryConfigPath
if ($null -eq $memoryConfig) {
  Add-Check 'memory:config' 'fail' "missing $memoryConfigPath"
} else {
  Add-Check 'memory:config' 'pass' "schema=$($memoryConfig.schema); components=$(@($memoryConfig.components.PSObject.Properties.Name) -join ',')"
}
$memoryPorts = @()
if ($memoryConfig -and $memoryConfig.components) {
  foreach ($name in @($memoryConfig.components.PSObject.Properties.Name)) {
    $component = $memoryConfig.components.$name
    if ($component.port) { $memoryPorts += [pscustomobject]@{ name = $name; port = [int]$component.port; health = [string]$component.healthPath } }
  }
}

# HTTP and TCP checks. The dashboard intentionally serves its SPA on /health;
# the marker is the reliable proof that the dashboard process answered.
$dashboardHealth = Invoke-Health 'http://127.0.0.1:18100/health'
$dashboardMarker = $dashboardHealth.ok -and $dashboardHealth.body -match '__SINGULARITY_VARIANT__'
Add-Check 'port:18100' $(if (Test-LoopbackPort 18100) { 'pass' } else { 'fail' }) 'dashboard loopback listener' "status=$($dashboardHealth.status)"
Add-Check 'http:18100' $(if ($dashboardMarker) { 'pass' } else { 'fail' }) "dashboard marker=$dashboardMarker" "status=$($dashboardHealth.status); error=$($dashboardHealth.error)"

# B7-owned Office service: observe only. It is a separate process from the
# Claude dashboard and exposes a minimal JSON health body on 18128.
$officeHealth = Invoke-Health 'http://127.0.0.1:18128/health'
$officeMarker = $officeHealth.ok -and $officeHealth.status -eq 200 -and $officeHealth.body -match '"status"\s*:\s*"ok"'
Add-Check 'port:18128' $(if (Test-LoopbackPort 18128) { 'pass' } else { 'fail' }) 'Office loopback listener' "status=$($officeHealth.status)"
Add-Check 'http:18128' $(if ($officeMarker) { 'pass' } else { 'fail' }) "Office health ok=$officeMarker" "status=$($officeHealth.status); error=$($officeHealth.error)"

$ghostConfig = Get-Json (Join-Path $ghostRoot 'config.json')
$ghostState = [pscustomobject]@{ ok = $false; state = 'unavailable'; schedules = 0; error = 'config missing' }
if ($ghostConfig -and $ghostConfig.controlKey) {
  $ghostHeaders = @{ 'X-Ghost-Control-Key' = [string]$ghostConfig.controlKey }
  $ghostResponse = Invoke-Health 'http://127.0.0.1:18473/state' $ghostHeaders
  if ($ghostResponse.ok) {
    try {
      $parsed = $ghostResponse.body | ConvertFrom-Json
      $ghostState = [pscustomobject]@{ ok = [bool]$parsed.ok; state = [string]$parsed.state; schedules = @($parsed.schedules).Count; error = '' }
    } catch { $ghostState = [pscustomobject]@{ ok = $false; state = 'invalid-json'; schedules = 0; error = $_.Exception.Message } }
  } else { $ghostState = [pscustomobject]@{ ok = $false; state = 'http-error'; schedules = 0; error = $ghostResponse.error } }
}
Add-Check 'port:18473' $(if (Test-LoopbackPort 18473) { 'pass' } else { 'fail' }) 'Ghost loopback listener'
Add-Check 'ghost:state' $(if ($ghostState.ok -and $ghostState.state -eq 'ready') { 'pass' } else { 'fail' }) "state=$($ghostState.state); schedules=$($ghostState.schedules)" "error=$($ghostState.error)"

foreach ($component in $memoryPorts) {
  $healthPath = if ($component.health) { $component.health } else { '/health' }
  $health = Invoke-Health ("http://127.0.0.1:{0}{1}" -f $component.port, $healthPath)
  $healthy = $health.ok -and ($health.status -ge 200 -and $health.status -lt 300)
  if ($component.name -eq 'core') {
    try { $healthy = $healthy -and (($health.body | ConvertFrom-Json).status -eq 'ok') } catch { $healthy = $false }
  }
  if ($component.name -eq 'gateway') {
    try { $healthy = $healthy -and (($health.body | ConvertFrom-Json).status -eq 'ok') } catch { $healthy = $false }
  }
  Add-Check "port:$($component.port)" $(if (Test-LoopbackPort $component.port) { 'pass' } else { 'fail' }) "$($component.name) loopback listener"
  Add-Check "http:$($component.name)" $(if ($healthy) { 'pass' } else { 'fail' }) "status=$($health.status); path=$healthPath" "error=$($health.error)"
}

# Memory L0 readback: a bounded search must return code 0. Zero items is a
# valid empty result; authentication or transport failure is not.
$coreBearer = Get-Text (Join-Path $InstallRoot 'memory\state\secrets\core-bearer')
if ($coreBearer) {
  try {
    $headers = @{ Authorization = "Bearer $($coreBearer.Trim())"; 'x-tdai-service-id' = 'default' }
    $body = @{ team_id = 'openchamber-agents'; user_id = 'pilot-operator'; agent_id = 'singularity-orchestrator'; query = 'windows native release'; limit = 1 } | ConvertTo-Json -Compress
    $readback = Invoke-RestMethod -Uri 'http://127.0.0.1:18421/v3/atomic/search' -Method Post -Headers $headers -ContentType 'application/json' -Body $body -TimeoutSec 20
    $ok = ([int]$readback.code -eq 0)
    Add-Check 'memory:l0-readback' $(if ($ok) { 'pass' } else { 'fail' }) "code=$($readback.code); items=$(@($readback.data.items).Count)" "requestId=$($readback.request_id)"
  } catch { Add-Check 'memory:l0-readback' 'fail' 'L0 search request failed' "error=$($_.Exception.Message)" }
} else { Add-Check 'memory:l0-readback' 'fail' 'core-bearer secret missing' }

$rql = Join-Path $env:LOCALAPPDATA 'rql\rql.exe'
if (Test-Path -LiteralPath $rql) {
  try {
    $rqlVersion = ((& $rql --version 2>&1) -join ' ').Trim()
    Add-Check 'repoql:version' $(if ($rqlVersion -match '1\.7\.18') { 'pass' } else { 'fail' }) "detected=$rqlVersion" "path=$rql"
  } catch { Add-Check 'repoql:version' 'fail' 'rql --version failed' "error=$($_.Exception.Message)" }
} else { Add-Check 'repoql:version' 'fail' "missing $rql" }

# Claude Code configuration: memory hooks, RepoQL plugin and agent assets.
$claudeSettingsPath = Join-Path $ClaudeHome 'settings.json'
$claudeSettings = Get-Json $claudeSettingsPath
if ($null -eq $claudeSettings) {
  Add-Check 'claude:settings' 'fail' "missing $claudeSettingsPath"
} else {
  $hookEvents = if ($claudeSettings.hooks) { @($claudeSettings.hooks.PSObject.Properties.Name) } else { @() }
  $requiredHooks = @('SubagentStart', 'SubagentStop', 'SessionStart', 'Stop')
  $missingHooks = @($requiredHooks | Where-Object { $hookEvents -notcontains $_ })
  $pluginEnabled = $claudeSettings.enabledPlugins -and ($claudeSettings.enabledPlugins.PSObject.Properties.Name -contains 'repoql@repoql-plugins')
  $memoryEnv = $claudeSettings.env -and $claudeSettings.env.SINGULARITY_MEMORY_CONFIG
  $ok = ($missingHooks.Count -eq 0) -and $pluginEnabled -and [bool]$memoryEnv
  Add-Check 'claude:settings' $(if ($ok) { 'pass' } else { 'fail' }) "hooks=$($hookEvents -join ','); repoqlPlugin=$pluginEnabled; memoryConfig=$([bool]$memoryEnv)" "path=$claudeSettingsPath"
  if ($memoryEnv -and -not (Test-Path -LiteralPath ([string]$claudeSettings.env.SINGULARITY_MEMORY_CONFIG))) {
    Add-Check 'claude:memory-config' 'fail' 'configured memory config path is missing'
  } else { Add-Check 'claude:memory-config' 'pass' 'configured memory config path exists' }
}
$agentsDir = Join-Path $ClaudeHome 'agents'
$agentCount = if (Test-Path -LiteralPath $agentsDir) { @(Get-ChildItem -LiteralPath $agentsDir -File -Filter 'singularity-*.md').Count } else { 0 }
Add-Check 'claude:agents' $(if ($agentCount -ge 17) { 'pass' } else { 'fail' }) "agents=$agentCount expected>=17"
$pluginRegistry = Join-Path $ClaudeHome 'plugins\installed_plugins.json'
if (Test-Path -LiteralPath $pluginRegistry) {
  $registryText = Get-Text $pluginRegistry
  Add-Check 'claude:repoql-plugin' $(if ($registryText -match 'repoql') { 'pass' } else { 'fail' }) 'installed plugin registry' "path=$pluginRegistry"
} else { Add-Check 'claude:repoql-plugin' 'warn' 'plugin registry missing; Claude Code may install on first launch' "path=$pluginRegistry" }

$claudeExe = Join-Path $env:USERPROFILE '.local\bin\claude.exe'
if (Test-Path -LiteralPath $claudeExe) {
  try { Add-Check 'claude:cli' 'pass' ((& $claudeExe --version 2>&1) -join ' ').Trim() "path=$claudeExe" }
  catch { Add-Check 'claude:cli' 'warn' 'claude --version failed' "error=$($_.Exception.Message)" }
} else { Add-Check 'claude:cli' 'warn' 'claude CLI not found (desktop-only install?)' }

$lastBoot = (Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue).LastBootUpTime
$uptime = if ($lastBoot) { [math]::Round(((Get-Date) - $lastBoot).TotalMinutes, 1) } else { $null }
$failed = @($checks | Where-Object { $_.status -eq 'fail' }).Count
$warned = @($checks | Where-Object { $_.status -eq 'warn' }).Count
$summary = [ordered]@{
  schema = 'singularity-native-windows-post-reboot/v1'
  generatedAtUtc = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  host = $env:COMPUTERNAME
  user = $env:USERNAME
  installRoot = $InstallRoot
  lastBootUtc = if ($lastBoot) { $lastBoot.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ') } else { $null }
  uptimeMinutes = $uptime
  ok = ($failed -eq 0)
  pass = @($checks | Where-Object { $_.status -eq 'pass' }).Count
  fail = $failed
  warn = $warned
  checks = $checks
}

if (-not $OutputPath) {
  $receiptDir = Join-Path $InstallRoot 'state\receipts'
  if (-not (Test-Path -LiteralPath $receiptDir)) { New-Item -ItemType Directory -Path $receiptDir -Force | Out-Null }
  $OutputPath = Join-Path $receiptDir ('post-reboot-' + (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ') + '.json')
}
$OutputPath = [IO.Path]::GetFullPath($OutputPath)
$parent = Split-Path -Parent $OutputPath
if ($parent -and -not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
[IO.File]::WriteAllText($OutputPath, (($summary | ConvertTo-Json -Depth 8) + "`n"), (New-Object Text.UTF8Encoding($false)))

if ($Json) { $summary | ConvertTo-Json -Depth 8 } else {
  "POST_REBOOT_VERIFY=$($summary.ok) PASS=$($summary.pass) FAIL=$($summary.fail) WARN=$($summary.warn)"
  $checks | ForEach-Object { "  [{0}] {1}: {2}" -f $_.status.ToUpperInvariant(), $_.name, $_.detail }
  "RECEIPT=$OutputPath"
}
if ($failed -gt 0) { exit 1 }
