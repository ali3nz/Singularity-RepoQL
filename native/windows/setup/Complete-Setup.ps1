<#
.SYNOPSIS
  Configuration engine used by Singularity-RepoQL-Setup.exe.
.DESCRIPTION
  Installs or repairs the per-user native product, starts the owned tasks,
  provisions the local MemoryCore owner identity, configures Claude Code, and
  verifies the dashboard plus the automatic Tencent MemoryPanel handshake.
  Provider ingestion keys are deliberately not required: the extraction
  gateway starts in degraded mode until the owner adds them.
#>
[CmdletBinding()]
param(
  [ValidateSet('Install','Repair','Uninstall','Verify')][string]$Mode='Install',
  [string]$PayloadRoot=''
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'WINDOWS_ONLY' }
if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA_REQUIRED' }
if (-not $PayloadRoot) { $PayloadRoot=$PSScriptRoot }
$PayloadRoot=[IO.Path]::GetFullPath($PayloadRoot)
$base=Join-Path $env:LOCALAPPDATA 'Singularity'
$installRoot=Join-Path $base 'WindowsNative'
$runtimeRoot=Join-Path $base 'Runtime'
$workspace=Join-Path $base 'Workspace'
$setupState=Join-Path $base 'Setup'
$setupReceipt=Join-Path $setupState 'receipt.json'
$dashboardState=Join-Path $base 'Dashboard'
$dashboardToken=Join-Path $dashboardState 'token'
$installReceipt=Join-Path $installRoot 'INSTALLATION_RECEIPT.json'
$current=Join-Path $installRoot 'current'
$previous=Join-Path $installRoot 'previous'
$memoryRoot=Join-Path $installRoot 'memory'
$memoryConfig=Join-Path $memoryRoot 'stack.json'
$nodeExe=Join-Path $runtimeRoot 'node\node.exe'
$pythonExe=Join-Path $runtimeRoot 'python\python.exe'
$repoqlExe=Join-Path $runtimeRoot 'repoql\rql.exe'
$codexExe=Join-Path $runtimeRoot 'codex\codex.exe'
$sourceRoot=Join-Path $PayloadRoot 'source'
$binRoot=Join-Path $PayloadRoot 'bin'
$setupLog=Join-Path $setupState ('setup-'+[DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')+'.log')
$steps=New-Object System.Collections.ArrayList
$setupVersion='1.0.0'
function Write-Step([string]$Name,[string]$Detail='') {
  $line=if($Detail){"STEP=$Name DETAIL=$Detail"}else{"STEP=$Name"}
  Write-Host $line
  try { Add-Content -LiteralPath $setupLog -Value ("["+[DateTime]::UtcNow.ToString('o')+"] "+$line) -Encoding UTF8 } catch {}
}
function Add-Result([string]$Name,[string]$State,[string]$Detail='') {
  [void]$steps.Add([ordered]@{name=$Name;state=$State;detail=$Detail;at=[DateTime]::UtcNow.ToString('o')})
}
function Write-SetupReceipt([string]$State,[string]$ErrorText='') {
  if (-not (Test-Path -LiteralPath $setupState -PathType Container)) { New-Item -ItemType Directory -Force -Path $setupState | Out-Null }
  $data=[ordered]@{schema='singularity-setup/v1';version=$setupVersion;mode=$Mode;state=$State;error=$ErrorText;
    installRoot=$installRoot;runtimeRoot=$runtimeRoot;memoryRoot=$memoryRoot;dashboardPort=18100;
    steps=@($steps);log=$setupLog;at=[DateTime]::UtcNow.ToString('o')}
  $data | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $setupReceipt -Encoding UTF8
}
function Convert-ArgumentsToHashtable([string[]]$Arguments) {
  $table=@{}
  for ($i=0; $i -lt $Arguments.Count; $i++) {
    $token=[string]$Arguments[$i]
    if (-not $token.StartsWith('-')) { throw ('INVALID_ARGUMENT '+$token) }
    $name=$token.Substring(1)
    if (($i+1) -lt $Arguments.Count -and -not ([string]$Arguments[$i+1]).StartsWith('-')) {
      $table[$name]=[string]$Arguments[$i+1]
      $i++
    } else {
      $table[$name]=$true
    }
  }
  return $table
}
function Invoke-Manage([string[]]$Arguments,[string]$Name) {
  # Use the payload manager so a fresh install and a reinstall both run the
  # same lifecycle code, including fresh router-key generation.
  $manager=Join-Path $sourceRoot 'native\windows\manage_native_windows.ps1'
  if (-not (Test-Path -LiteralPath $manager -PathType Leaf)) { throw ($Name+'_MANAGER_MISSING') }
  Write-Step $Name
  $table=Convert-ArgumentsToHashtable $Arguments
  $table['Confirm']=$false
  $raw=$null
  try { $raw=& $manager @table 2>&1 } catch { throw ($Name+'_FAILED '+[string]$_.Exception.Message) }
  foreach ($line in @($raw)) { if ($line) { Write-Host ("  "+[string]$line) } }
  Add-Result $Name 'ok'
}
function Remove-RemoteTunnels {
  # This product is Windows-local. Legacy setup invented SSH forwards that
  # pointed the dashboard's Kanzo and memory graph at Dockerhost. Remove only
  # those exact project-owned tasks and their exact ssh.exe command lines.
  Write-Step 'remove_remote_tunnels'
  foreach ($taskName in @('Singularity-Kanzo-Tunnel','Singularity-Unified-Tunnel')) {
    $task=Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if (-not $task) { continue }
    if ([string]$task.TaskPath -ne '\') { throw ('REMOTE_TUNNEL_TASK_PATH_MISMATCH '+$taskName) }
    try { Stop-ScheduledTask -TaskName $taskName -ErrorAction Stop } catch {}
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction Stop
  }
  Start-Sleep -Seconds 1
  $patterns=@('-L 127.0.0.1:4242:127.0.0.1:4242','-L 127.0.0.1:18101:127.0.0.1:18101')
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $name=[string]$_.Name; $cmd=[string]$_.CommandLine; $include=$false
    if ($name -ieq 'ssh.exe' -and $cmd -like '*root@192.168.1.240*') {
      foreach ($pattern in $patterns) { if ($cmd.Contains($pattern)) { $include=$true } }
    }
    $include
  } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }
  Add-Result 'remote_tunnels' 'removed' 'dockerhost kanzo and unified-graph forwards'
}
function Ensure-Kanzo {
  # Ship the reviewed Kanzo 0.1.3 binary and keep its board on this Windows
  # account. The dashboard's fixed loopback upstream is 127.0.0.1:4242.
  Write-Step 'configure_kanzo'
  $sourceKanzo=Join-Path $binRoot 'kanzo.exe'
  if (-not (Test-Path -LiteralPath $sourceKanzo -PathType Leaf)) { throw 'KANZO_BINARY_MISSING' }
  $kanzoRuntime=Join-Path $runtimeRoot 'kanzo'
  if (-not (Test-Path -LiteralPath $kanzoRuntime -PathType Container)) { New-Item -ItemType Directory -Force -Path $kanzoRuntime | Out-Null }
  $kanzoExe=Join-Path $kanzoRuntime 'kanzo.exe'
  if (-not (Test-Path -LiteralPath $kanzoExe -PathType Leaf) -or (Get-FileHash $kanzoExe -Algorithm SHA256).Hash -ne (Get-FileHash $sourceKanzo -Algorithm SHA256).Hash) {
    Copy-Item -LiteralPath $sourceKanzo -Destination $kanzoExe -Force
  }
  $kanzoHome=Join-Path $env:USERPROFILE 'kanzo'
  if (-not (Test-Path -LiteralPath $kanzoHome -PathType Container)) { New-Item -ItemType Directory -Force -Path $kanzoHome | Out-Null }
  $kanzoConfig=Join-Path $kanzoHome 'config.toml'
  if (-not (Test-Path -LiteralPath $kanzoConfig -PathType Leaf)) {
    $kanzoConfigText="port = 4242`nlisten = `"127.0.0.1`"`nstatuses = [`"todo`", `"doing`", `"review`", `"done`"]`nmcp_http = true`n"
    [IO.File]::WriteAllText($kanzoConfig,$kanzoConfigText,[Text.UTF8Encoding]::new($false))
  }
  $taskName='Singularity-Kanzo'
  $existing=Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($existing) {
    if ([string]$existing.TaskPath -ne '\') { throw 'KANZO_TASK_PATH_MISMATCH' }
    $action=@($existing.Actions)[0]
    if (([IO.Path]::GetFullPath([string]$action.Execute)) -ine ([IO.Path]::GetFullPath($kanzoExe))) { throw 'KANZO_TASK_FOREIGN_EXECUTABLE_REFUSED' }
    try { Stop-ScheduledTask -TaskName $taskName -ErrorAction Stop } catch {}
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction Stop
  }
  # Stopping a task does not guarantee its child exited; an old Kanzo holding
  # 4242 would make the new instance exit while the old process still answers.
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath -and ([IO.Path]::GetFullPath([string]$_.ExecutablePath)) -ieq ([IO.Path]::GetFullPath($kanzoExe)) } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }
  Start-Sleep -Seconds 2
  $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
  $action=New-ScheduledTaskAction -Execute $kanzoExe -Argument ('--home "'+$kanzoHome+'" --port 4242 --no-open') -WorkingDirectory $kanzoHome
  $trigger=New-ScheduledTaskTrigger -AtStartup
  $principal=New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType S4U -RunLevel Limited
  $settings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Seconds 0)
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -ErrorAction Stop | Out-Null
  Start-ScheduledTask -TaskName $taskName -ErrorAction Stop
  $deadline=(Get-Date).AddSeconds(45)
  $ready=$false
  do {
    try {
      $ping=Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:4242/api/ping' -TimeoutSec 4
      if ($ping.StatusCode -eq 200 -and $ping.Content.Trim() -eq 'kanzo') { $ready=$true; break }
    } catch {}
    Start-Sleep -Seconds 2
  } while ((Get-Date) -lt $deadline)
  if (-not $ready) { throw 'KANZO_LOCAL_SERVICE_NOT_READY' }
  $kanzoProcesses=@(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath -and ([IO.Path]::GetFullPath([string]$_.ExecutablePath)) -ieq ([IO.Path]::GetFullPath($kanzoExe)) })
  if ($kanzoProcesses.Count -ne 1) { throw ('KANZO_LOCAL_PROCESS_COUNT_'+$kanzoProcesses.Count) }
  $remoteKanzo=@(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -ieq 'ssh.exe' -and ([string]$_.CommandLine).Contains('4242:127.0.0.1:4242') })
  if ($remoteKanzo.Count -gt 0) { throw 'KANZO_REMOTE_TUNNEL_PRESENT' }
  # Get-NetTCPConnection and netstat have both been unreliable on this host;
  # when a listener row is available, pin it to the exact process we started.
  $listenerLines=@(& (Join-Path $env:SystemRoot 'System32\netstat.exe') -ano | Select-String 'LISTENING' | Select-String '127.0.0.1:4242')
  if ($listenerLines.Count -gt 0) {
    $listenerPid=[int](($listenerLines[0].Line -split '\s+')[-1])
    if ($listenerPid -ne [int]$kanzoProcesses[0].ProcessId) { throw 'KANZO_LISTENER_NOT_LOCAL_BINARY' }
  } else {
    Write-Host '  kanzo listener table unavailable; verified by owned process and loopback ping'
  }
  Write-Host ('  kanzo=127.0.0.1:4242 home='+$kanzoHome)
  Add-Result 'kanzo' 'ok' $kanzoHome
}
function Remove-KanzoTask {
  $task=Get-ScheduledTask -TaskName 'Singularity-Kanzo' -ErrorAction SilentlyContinue
  if ($task) {
    if ([string]$task.TaskPath -ne '\') { throw 'KANZO_TASK_PATH_MISMATCH' }
    try { Stop-ScheduledTask -TaskName 'Singularity-Kanzo' -ErrorAction Stop } catch {}
    Unregister-ScheduledTask -TaskName 'Singularity-Kanzo' -Confirm:$false -ErrorAction Stop
  }
  $kanzoExe=Join-Path $runtimeRoot 'kanzo\kanzo.exe'
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath -and ([IO.Path]::GetFullPath([string]$_.ExecutablePath)) -ieq ([IO.Path]::GetFullPath($kanzoExe)) } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }
}
function Stop-OwnedRuntimeConsumers {
  # Runtime files are replaced in place. Stop only this product's exact tasks
  # and processes first so a repair over a running installation cannot fail
  # with a sharing violation; Start restores them later in the same run.
  Write-Step 'stop_runtime_consumers'
  $watchdog=Get-ScheduledTask -TaskName 'Singularity-Dashboard-Watchdog' -ErrorAction SilentlyContinue
  if ($watchdog) { try { Stop-ScheduledTask -TaskName 'Singularity-Dashboard-Watchdog' -ErrorAction Stop } catch {}; try { Disable-ScheduledTask -TaskName 'Singularity-Dashboard-Watchdog' -ErrorAction Stop | Out-Null } catch {} }
  foreach ($task in @('Singularity-ClaudeComplete-Dashboard','Singularity-Ghost-Scheduler','Singularity-Rust-Native-Supervisor','Singularity-Windows-Unified-Gateway')) {
    $existing=Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
    if ($existing) { try { Stop-ScheduledTask -TaskName $task -ErrorAction Stop } catch {} }
  }
  Start-Sleep -Seconds 2
  $roots=@($runtimeRoot,$current,(Join-Path $base 'GhostScheduler'))
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $path=[string]$_.ExecutablePath; $include=$false
    if ($path) {
      foreach ($root in $roots) { if ($path.StartsWith($root,[StringComparison]::OrdinalIgnoreCase)) { $include=$true } }
    }
    $include
  } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }
  Start-Sleep -Seconds 2
}
function Copy-RuntimeFromPayload {
  Stop-OwnedRuntimeConsumers
  Write-Step 'installing_runtime'
  $sourceRuntime=Join-Path $PayloadRoot 'runtime'
  if (-not (Test-Path -LiteralPath $sourceRuntime -PathType Container)) { throw 'PAYLOAD_RUNTIME_MISSING' }
  if (-not (Test-Path -LiteralPath $runtimeRoot -PathType Container)) { New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null }
  $rc=robocopy $sourceRuntime $runtimeRoot /E /NFL /NDL /NJH /NJS /NP /R:1 /W:1
  if ($LASTEXITCODE -ge 8) { throw ('RUNTIME_COPY_FAILED exit='+$LASTEXITCODE) }
  foreach ($p in @($nodeExe,$pythonExe,$repoqlExe,$codexExe)) {
    if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { throw ('RUNTIME_FILE_MISSING '+$p) }
  }
  Add-Result 'runtime' 'ok'
}
function Get-ClaudeOfficeConfig {
  # The Claude Office hooks need the service endpoint and a non-empty ingest
  # key, not merely an Office install receipt. If that product configuration
  # is absent, configure the core Claude integration without Office rather
  # than failing the whole install on an invalid file.
  $candidate=Join-Path $installRoot 'office\office-install.json'
  if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { return '' }
  try {
    $office=Get-Content -LiteralPath $candidate -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([string]$office.endpoint -and [string]$office.ingestKey) { return $candidate }
  } catch {}
  return ''
}
function Invoke-ClaudeConfiguration {
  $node=Join-Path $current 'source\native\windows\configure_claude_code_windows.mjs'
  if (-not (Test-Path -LiteralPath $node -PathType Leaf)) { throw 'CLAUDE_CONFIGURATOR_MISSING' }
  Write-Step 'verify_claude'
  $raw=& $nodeExe $node --mode verify --home $env:USERPROFILE 2>&1
  $code=$LASTEXITCODE
  $text=(@($raw) -join "`n").Trim()
  $verified=$false
  try { $verified=([bool](($text | ConvertFrom-Json -ErrorAction Stop).configured)) } catch {}
  if ($code -eq 0 -and $verified) {
    Write-Host '  Claude configuration already verified'
    Add-Result 'claude' 'ok'
    return
  }
  $variant=1
  $officeConfig=Get-ClaudeOfficeConfig
  if ($officeConfig) { $variant=2 }
  $args=@('--mode','apply','--variant',[string]$variant,'--source',(Join-Path $current 'source'),'--home',$env:USERPROFILE,'--node-exe',$nodeExe,'--memory-config',$memoryConfig)
  if ($variant -eq 2) { $args += @('--office-config',$officeConfig) }
  $args += '--apply'
  Write-Step 'configure_claude'
  $raw=& $nodeExe $node @args 2>&1
  $code=$LASTEXITCODE
  foreach ($line in @($raw)) { if ($line) { Write-Host ("  "+[string]$line) } }
  if ($code -ne 0) { throw ('CLAUDE_CONFIGURATION_FAILED exit='+$code) }
  Add-Result 'claude' 'ok'
}
function Wait-Http([string]$Uri,[hashtable]$Headers,[int]$Seconds=180) {
  $deadline=(Get-Date).AddSeconds($Seconds)
  do {
    try { return Invoke-WebRequest -UseBasicParsing -Uri $Uri -Headers $Headers -TimeoutSec 15 } catch { Start-Sleep -Seconds 3 }
  } while ((Get-Date) -lt $deadline)
  throw ('HTTP_NOT_READY '+$Uri)
}
function Invoke-DashboardVerification {
  if (-not (Test-Path -LiteralPath $dashboardToken -PathType Leaf)) { throw 'DASHBOARD_TOKEN_MISSING' }
  $token=(Get-Content -LiteralPath $dashboardToken -Raw).Trim()
  if (-not $token) { throw 'DASHBOARD_TOKEN_EMPTY' }
  $headers=@{ Authorization='Bearer '+$token }
  $baseUri='http://127.0.0.1:18100'
  Write-Step 'verify_dashboard'
  $root=Wait-Http ($baseUri+'/') $headers 180
  if ($root.StatusCode -ne 200) { throw ('DASHBOARD_HTTP_'+$root.StatusCode) }
  $panels=Invoke-RestMethod -Uri ($baseUri+'/api/embed/panels') -Headers $headers -TimeoutSec 30
  if (-not $panels.tencent -or -not $panels.tencent.configured) { throw 'TENCENT_PANEL_NOT_CONFIGURED' }
  Write-Host ('  tencent_url='+[string]$panels.tencent.url+' configured='+[string]$panels.tencent.configured)
  # Prove the short-lived same-origin browser session works without a password.
  $session=New-Object Microsoft.PowerShell.Commands.WebRequestSession
  $handshake=Invoke-WebRequest -UseBasicParsing -Uri ($baseUri+'/api/embed/tencent/handshake') -Headers $headers -WebSession $session -TimeoutSec 30
  if ($handshake.StatusCode -ne 200) { throw ('TENCENT_HANDSHAKE_HTTP_'+$handshake.StatusCode) }
  $panel=Invoke-WebRequest -UseBasicParsing -Uri ($baseUri+'/embed/tencent/') -WebSession $session -TimeoutSec 30
  if ($panel.StatusCode -ne 200) { throw ('TENCENT_PANEL_HTTP_'+$panel.StatusCode) }
  Write-Host ('  handshake=200 panel=200 bytes='+$panel.Content.Length)
  # Kanzo is a separate Windows-local board. The handshake itself proves the
  # fixed upstream answers as the native Kanzo contract, not Dockerhost.
  $kanzoSession=New-Object Microsoft.PowerShell.Commands.WebRequestSession
  $kanzoHandshake=Invoke-WebRequest -UseBasicParsing -Uri ($baseUri+'/api/embed/kanzo/handshake') -Headers $headers -WebSession $kanzoSession -TimeoutSec 30
  if ($kanzoHandshake.StatusCode -ne 200) { throw ('KANZO_HANDSHAKE_HTTP_'+$kanzoHandshake.StatusCode) }
  $kanzoPanel=Invoke-WebRequest -UseBasicParsing -Uri ($baseUri+'/embed/kanzo/') -WebSession $kanzoSession -TimeoutSec 30
  if ($kanzoPanel.StatusCode -ne 200) { throw ('KANZO_PANEL_HTTP_'+$kanzoPanel.StatusCode) }
  Write-Host ('  kanzo_handshake=200 panel=200 bytes='+$kanzoPanel.Content.Length)
  Write-Step 'verify_memory_graph'
  $graph=Invoke-RestMethod -Uri ($baseUri+'/api/unified/graph?repoql=true&tencent=true&memories=true&limit=120') -Headers $headers -TimeoutSec 90
  $keys=@($graph.PSObject.Properties.Name)
  if ($keys -contains 'available' -and $graph.available -ne $true) {
    $reason=if ($keys -contains 'error') { [string]$graph.error } else { 'unavailable' }
    throw ('UNIFIED_GRAPH_UNAVAILABLE '+$reason)
  }
  if ($keys -notcontains 'nodes') { throw 'UNIFIED_GRAPH_INVALID_RESPONSE' }
  $nodeCount=@($graph.nodes).Count
  if ($nodeCount -lt 1) { throw 'UNIFIED_GRAPH_EMPTY' }
  $sourceCount=if ($keys -contains 'sources') { @($graph.sources).Count } else { 0 }
  Write-Host ('  graph_nodes='+$nodeCount+' sources='+$sourceCount)
  Add-Result 'dashboard' 'ok'
  Add-Result 'kanzo_panel' 'ok'
  Add-Result 'tencent_auth' 'ok'
  Add-Result 'memory_graph' 'ok'
}
function Ensure-UnifiedBinary {
  $dest=Join-Path $current 'bin\unified-repoql-control.exe'
  $src=Join-Path $binRoot 'unified-repoql-control.exe'
  if (-not (Test-Path -LiteralPath $src -PathType Leaf)) { Add-Result 'unified_binary' 'warning' 'payload_missing'; return $false }
  if (-not (Test-Path -LiteralPath (Split-Path -Parent $dest) -PathType Container)) { return $false }
  if (-not (Test-Path -LiteralPath $dest -PathType Leaf) -or (Get-FileHash $dest -Algorithm SHA256).Hash -ne (Get-FileHash $src -Algorithm SHA256).Hash) {
    Copy-Item -LiteralPath $src -Destination $dest -Force
  }
  Add-Result 'unified_binary' 'ok'
  return $true
}
function Invoke-GatewayRegistration {
  $gatewayManager=Join-Path $current 'source\native\windows\manage_unified_gateway.ps1'
  $gatewayBinary=Join-Path $current 'bin\unified-repoql-control.exe'
  if (-not (Test-Path -LiteralPath $gatewayManager -PathType Leaf) -or -not (Test-Path -LiteralPath $gatewayBinary -PathType Leaf)) {
    Add-Result 'unified_gateway' 'skipped' 'binary_or_manager_missing'
    return
  }
  $tencentKey=Join-Path $memoryRoot 'state\secrets\admin-user-key'
  $gatewayTencent=@()
  if (Test-Path -LiteralPath $tencentKey -PathType Leaf) {
    $gatewayTencent=@('-TencentBase','http://127.0.0.1:18126','-TencentServiceId','default','-TencentUserKeyFile',$tencentKey)
  }
  $existing=Get-ScheduledTask -TaskName 'Singularity-Windows-Unified-Gateway' -ErrorAction SilentlyContinue
  if ($existing -and $gatewayTencent.Count -gt 0) {
    $gatewayConfig=Join-Path $dashboardState 'windows-unified-gateway.json'
    $needsReconcile=$true
    if (Test-Path -LiteralPath $gatewayConfig -PathType Leaf) {
      try { $currentGateway=Get-Content -LiteralPath $gatewayConfig -Raw -Encoding UTF8 | ConvertFrom-Json; $needsReconcile=([string]$currentGateway.tencentBase -ne 'http://127.0.0.1:18126' -or [string]$currentGateway.tencentServiceId -ne 'default') } catch {}
    }
    if ($needsReconcile) {
      try { Stop-ScheduledTask -TaskName 'Singularity-Windows-Unified-Gateway' -ErrorAction Stop } catch {}
      Unregister-ScheduledTask -TaskName 'Singularity-Windows-Unified-Gateway' -Confirm:$false -ErrorAction Stop
      if (Test-Path -LiteralPath $gatewayConfig) { Remove-Item -LiteralPath $gatewayConfig -Force }
      $existing=$null
    }
  }
  if (-not $existing) {
    # A config without its owned task is a stale pre-repair artifact. Move it
    # aside so Register can create a consistent task/config pair.
    foreach ($stale in @('windows-unified-gateway.json','unified-gateway.token')) {
      $p=Join-Path $dashboardState $stale
      if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Force }
    }
    Write-Step 'register_unified_gateway'
    $argv=@('-NoProfile','-ExecutionPolicy','Bypass','-File',$gatewayManager,'-Mode','Register','-Apply','-StagedSource',(Join-Path $current 'source'),'-StateDir',$dashboardState,'-RepoqlTokenFile',$dashboardToken) + $gatewayTencent
    $raw=& powershell @argv 2>&1
    if ($LASTEXITCODE -ne 0) { Add-Result 'unified_gateway' 'warning' 'registration_failed'; Write-Host '  gateway registration skipped'; return }
  }
  $running=Get-ScheduledTask -TaskName 'Singularity-Windows-Unified-Gateway' -ErrorAction SilentlyContinue
  if ($running -and [string]$running.State -eq 'Running') { Add-Result 'unified_gateway' 'ok'; return }
  Write-Step 'start_unified_gateway'
  $argv=@('-NoProfile','-ExecutionPolicy','Bypass','-File',$gatewayManager,'-Mode','Start','-Apply','-StagedSource',(Join-Path $current 'source'),'-StateDir',$dashboardState,'-RepoqlTokenFile',$dashboardToken) + $gatewayTencent
  $raw=& powershell @argv 2>&1
  if ($LASTEXITCODE -ne 0) { Add-Result 'unified_gateway' 'warning' 'start_failed'; return }
  Add-Result 'unified_gateway' 'ok'
}
function Invoke-ProjectMcp {
  # Claude Code's project MCP config must point at the installed Windows Kanzo,
  # not a build folder or a Dockerhost endpoint. The existing helper owns a
  # reversible .mcp.json registration and refuses foreign entries.
  Write-Step 'configure_project_mcp'
  $helper=Join-Path $current 'source\native\windows\configure_project_mcp.mjs'
  $kanzoExe=Join-Path $runtimeRoot 'kanzo\kanzo.exe'
  if (-not (Test-Path -LiteralPath $helper -PathType Leaf)) { throw 'PROJECT_MCP_HELPER_MISSING' }
  if (-not (Test-Path -LiteralPath $kanzoExe -PathType Leaf)) { throw 'PROJECT_MCP_KANZO_MISSING' }
  $receipt=Join-Path $workspace '.singularity-native-mcp-receipt.json'
  if (Test-Path -LiteralPath $receipt -PathType Leaf) {
    $verify=@(& $nodeExe $helper --verify --variant 2 --workspace $workspace 2>&1)
    foreach ($line in $verify) { if ($line) { Write-Host ('  '+[string]$line) } }
    if ($LASTEXITCODE -ne 0) { throw 'PROJECT_MCP_EXISTING_CONFIG_NOT_OWNED' }
    $rollback=@(& $nodeExe $helper --rollback --variant 2 --workspace $workspace 2>&1)
    foreach ($line in $rollback) { if ($line) { Write-Host ('  '+[string]$line) } }
    if ($LASTEXITCODE -ne 0) { throw 'PROJECT_MCP_ROLLBACK_FAILED' }
  }
  $ombCli=Join-Path $runtimeRoot 'openmausbot\cli.js'
  $apply=@(& $nodeExe $helper --apply --variant 2 --workspace $workspace --rql-exe $repoqlExe --kanzo-exe $kanzoExe --omb-cli $ombCli --omb-port 18211 --node-exe $nodeExe 2>&1)
  foreach ($line in $apply) { if ($line) { Write-Host ('  '+[string]$line) } }
  if ($LASTEXITCODE -ne 0) { throw 'PROJECT_MCP_CONFIGURATION_FAILED' }
  Add-Result 'project_mcp' 'ok' 'kanzo.exe mcp at installed runtime path'
}
function Invoke-OpenMausBot([string]$Action) {
  $manager=Join-Path $current 'source\native\windows\manage_openmausbot.ps1'
  if (-not (Test-Path -LiteralPath $manager -PathType Leaf)) { throw 'OPENMAUSBOT_MANAGER_MISSING' }
  $argv=@('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$manager,'-Mode',$Action)
  if ($Action -in @('Install','Start','Stop','Unregister')) { $argv += '-Apply' }
  & powershell @argv
  if ($LASTEXITCODE -ne 0) { throw ('OPENMAUSBOT_'+$Action.ToUpperInvariant()+'_FAILED') }
  Add-Result 'openmausbot' 'ok' $Action
}
function Invoke-Shortcut {
  $shortcut=Join-Path $current 'source\native\windows\manage_dashboard_shortcut.ps1'
  if (-not (Test-Path -LiteralPath $shortcut -PathType Leaf)) { Add-Result 'shortcut' 'skipped' 'script_missing'; return }
  $argv=@('-NoProfile','-ExecutionPolicy','Bypass','-File',$shortcut,'-Mode','Create')
  $raw=& powershell @argv 2>&1
  if ($LASTEXITCODE -eq 0) { Add-Result 'shortcut' 'ok' } else { Add-Result 'shortcut' 'warning' 'create_failed' }
}
function Backup-UserState {
  $stamp=[DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')
  $backup=Join-Path $setupState ('backup-'+$stamp)
  New-Item -ItemType Directory -Force -Path $backup | Out-Null
  foreach ($pair in @(@((Join-Path $memoryRoot 'state'),(Join-Path $backup 'memory-state')),@($dashboardState,(Join-Path $backup 'Dashboard')),@($workspace,(Join-Path $backup 'Workspace')))) {
    if (Test-Path -LiteralPath $pair[0] -PathType Container) {
      $rc=robocopy $pair[0] $pair[1] /E /NFL /NDL /NJH /NJS /NP /R:1 /W:1
      if ($LASTEXITCODE -ge 8) { Add-Result 'backup' 'warning' ('partial '+$pair[0]) }
    }
  }
  Add-Result 'backup' 'ok' $backup
}
function Invoke-Install {
  if (-not (Test-Path -LiteralPath $sourceRoot -PathType Container)) { throw 'PAYLOAD_SOURCE_MISSING' }
  if (-not (Test-Path -LiteralPath $workspace -PathType Container)) { New-Item -ItemType Directory -Force -Path $workspace | Out-Null }
  Remove-RemoteTunnels
  Copy-RuntimeFromPayload
  $hasReceipt=Test-Path -LiteralPath $installReceipt -PathType Leaf
  if ($hasReceipt) { Backup-UserState }
  $action=if ($hasReceipt) {'Reinstall'} else {'Install'}
  if (-not $hasReceipt) {
    if ((Test-Path -LiteralPath $current) -or (Test-Path -LiteralPath $previous)) { throw 'EXISTING_STAGE_REQUIRES_VERIFIED_OWNERSHIP' }
  }
  $args=@('-Mode',$action,'-SourceRoot',$sourceRoot,
    '-BridgeExe',(Join-Path $binRoot 'singularity-desktop-bridge.exe'),
    '-SupervisorExe',(Join-Path $binRoot 'singularity-windows-supervisor.exe'),
    '-InstallRoot',$installRoot,'-RepoqlExe',$repoqlExe,'-PythonExe',$pythonExe,
    '-RunnerExe',$codexExe,'-Workspace',$workspace,'-NodeExe',$nodeExe,
    '-MemoryRoot',$memoryRoot,'-MemorySourceRoot',(Join-Path $runtimeRoot 'memory-source'),
    '-MemoryBuildRoot',(Join-Path $runtimeRoot 'build'),'-SkipOffice','-Apply')
  Invoke-Manage $args 'install_product'
  Invoke-Manage @('-Mode','Start','-Apply','-SourceRoot',$sourceRoot,'-BridgeExe',(Join-Path $binRoot 'singularity-desktop-bridge.exe'),'-SupervisorExe',(Join-Path $binRoot 'singularity-windows-supervisor.exe'),'-InstallRoot',$installRoot,'-RepoqlExe',$repoqlExe,'-PythonExe',$pythonExe,'-RunnerExe',$codexExe,'-Workspace',$workspace,'-NodeExe',$nodeExe,'-MemoryRoot',$memoryRoot,'-MemorySourceRoot',(Join-Path $runtimeRoot 'memory-source'),'-MemoryBuildRoot',(Join-Path $runtimeRoot 'build'),'-SkipOffice') 'start_product'
  $null=Ensure-UnifiedBinary
  Ensure-Kanzo
  Invoke-GatewayRegistration
  Invoke-OpenMausBot 'Install'
  Invoke-OpenMausBot 'Start'
  Invoke-ProjectMcp
  Invoke-ClaudeConfiguration
  Invoke-Shortcut
  Invoke-DashboardVerification
  Invoke-Hardening
}
function Invoke-Hardening([switch]$Remove) {
  # Reliability layer: password-free SYSTEM watchdog service, S4U boot tasks, hidden (no console) launches.
  # Never fatal: the product already works without it, so a failure here is reported, not thrown.
  $nativeDir=Join-Path $current 'source\native\windows'
  if (-not (Test-Path -LiteralPath $nativeDir -PathType Container)) { $nativeDir=$PSScriptRoot | Split-Path }
  $steps=@(
    @{n='supervisor_service';f='register-supervisor-service.ps1';a=@('-Root',$installRoot)},
    @{n='boot_tasks';f='register-boot-tasks.ps1';a=@()},
    @{n='hidden_launch';f='hide-console-tasks.ps1';a=@()})
  if ($Remove) { $steps=@($steps[0]); $steps[0].a=@('-Root',$installRoot,'-Uninstall') }
  foreach ($step in $steps) {
    $script=Join-Path $nativeDir $step.f
    if (-not (Test-Path -LiteralPath $script -PathType Leaf)) { Add-Result $step.n 'skipped' 'script_missing'; continue }
    if ($step.n -eq 'supervisor_service' -and -not $Remove) {
      $svcExe=Join-Path $installRoot 'current\bin\singularity_windows_supervisor_service.exe'
      if (-not (Test-Path -LiteralPath $svcExe -PathType Leaf)) { Add-Result $step.n 'skipped' 'service_binary_not_staged'; continue }
    }
    try {
      $argv=@('-NoProfile','-ExecutionPolicy','Bypass','-File',$script)+$step.a
      & powershell @argv 2>&1 | Out-Null
      if ($LASTEXITCODE -ne 0) { Add-Result $step.n 'warning' ('exit_'+$LASTEXITCODE) } else { Add-Result $step.n 'ok' 'applied' }
    } catch { Add-Result $step.n 'warning' $_.Exception.Message }
  }
}
function Invoke-Uninstall {
  Invoke-Hardening -Remove
  Invoke-OpenMausBot 'Unregister'
  Remove-RemoteTunnels
  Remove-KanzoTask
  if (Test-Path -LiteralPath $installReceipt -PathType Leaf) {
    $args=@('-Mode','Stop','-Apply','-InstallRoot',$installRoot,'-RepoqlExe',$repoqlExe,'-PythonExe',$pythonExe,'-RunnerExe',$codexExe,'-Workspace',$workspace,'-NodeExe',$nodeExe,'-SkipOffice')
    try { Invoke-Manage $args 'stop_product' } catch { Add-Result 'stop_product' 'warning' $_.Exception.Message }
    $args=@('-Mode','Uninstall','-Apply','-InstallRoot',$installRoot,'-RepoqlExe',$repoqlExe,'-PythonExe',$pythonExe,'-RunnerExe',$codexExe,'-Workspace',$workspace,'-NodeExe',$nodeExe,'-SkipOffice')
    Invoke-Manage $args 'uninstall_product'
  } else {
    Add-Result 'uninstall_product' 'skipped' 'not_installed'
  }
  $shortcut=Join-Path $current 'source\native\windows\manage_dashboard_shortcut.ps1'
  if (Test-Path -LiteralPath $shortcut -PathType Leaf) {
    $argv=@('-NoProfile','-ExecutionPolicy','Bypass','-File',$shortcut,'-Mode','Remove')
    & powershell @argv 2>&1 | Out-Null
  }
  Add-Result 'preserve_user_state' 'ok' 'memory,dashboard,workspace,claude,runtime_retained'
}
function Invoke-Verify {
  Remove-RemoteTunnels
  $null=Ensure-UnifiedBinary
  Ensure-Kanzo
  Invoke-GatewayRegistration
  Invoke-OpenMausBot 'Verify'
  Invoke-ProjectMcp
  Invoke-DashboardVerification
  Invoke-ClaudeConfiguration
}
try {
  if (-not (Test-Path -LiteralPath $setupState -PathType Container)) { New-Item -ItemType Directory -Force -Path $setupState | Out-Null }
  Write-Step 'begin' ('mode='+$Mode)
  switch ($Mode) {
    'Install' { Invoke-Install; Write-SetupReceipt 'installed' }
    'Repair' { Invoke-Install; Write-SetupReceipt 'repaired' }
    'Uninstall' { Invoke-Uninstall; Write-SetupReceipt 'uninstalled' }
    'Verify' { Invoke-Verify; Write-SetupReceipt 'verified' }
  }
  Write-Step 'complete'
  exit 0
} catch {
  $message=[string]$_.Exception.Message
  if (-not $message) { $message='UNKNOWN_SETUP_FAILURE' }
  Add-Result 'failure' 'error' $message
  Write-Step 'failed' $message
  try { Write-SetupReceipt 'failed' $message } catch {}
  exit 1
}
