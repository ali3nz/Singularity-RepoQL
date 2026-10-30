#Requires -Version 5.1
<#
.SYNOPSIS
Operator-gated native Claude Code Complete installation workflow (Option 2 only).
.DESCRIPTION
Connects the existing, separately audited verification, transactional staging,
Claude configuration, and Kanzo MCP configurators. Preview is read-only.
No implicit service registration, auto-start, plugin download, credential creation,
or release approval. Stage and Configure are deliberately separate commits.
The original bundle and trusted bootstrap must be reviewed independently.
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
  [ValidateSet('UpgradePlan','VerifyInstalled','Plan','Stage','Configure','Verify','SupervisorPlan','SupervisorVerify','RegisterSupervisor','RemoveSupervisor','RollbackConfig','RollbackStage','RetireStage','RestoreRetired','ParentPlan','ConfigureParent','VerifyParent','RollbackParent','DashboardPlan','DashboardRegister','DashboardVerify','DashboardStart','DashboardRemove')]
  [string]$Mode = 'Plan',
  [string]$Bundle = '',
  [string]$Prepared = '',
  [string]$Bootstrap = '',
  [string]$PythonExe = '',
  [string]$NodeExe = '',
  [string]$RepoqlExe = '',
  [string]$ClaudeExe = '',
  [string]$KanzoExe = '',
  [string]$MemoryConfig = '',
  [string]$OfficeConfig = '',
  [string]$ParentProxyConfig = '',
  [string]$ClaudeHome = '',
  [string]$Workspace = '',
  [string]$SupervisorConfig = '',
  [int]$DashboardPort = 18100,
  [string]$InstallRoot = '',
  [switch]$Apply
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'NATIVE_WINDOWS_REQUIRED' }
$mutates = $Mode -in @('Stage','Configure','RegisterSupervisor','RemoveSupervisor','RollbackConfig','RollbackStage','RetireStage','RestoreRetired','ConfigureParent','RollbackParent','DashboardRegister','DashboardStart','DashboardRemove')
if ($mutates -and -not $Apply) { throw 'EXPLICIT_APPLY_REQUIRED' }
if (-not $mutates -and $Apply) { throw 'READ_ONLY_MODE_REFUSES_APPLY' }
if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) { throw 'LOCALAPPDATA_REQUIRED' }
$localBase = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Singularity'))
if (-not $InstallRoot) { $InstallRoot = Join-Path $localBase 'WindowsNativePreview' }
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot)
if (-not $InstallRoot.StartsWith($localBase + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'INSTALL_ROOT_OUTSIDE_PRIVATE_LOCALAPPDATA'
}
function Assert-Local([string]$Value, [string]$Label, [bool]$IsFile = $true, [bool]$MayBeMissing = $false) {
  if (-not $Value -or -not [IO.Path]::IsPathRooted($Value) -or $Value.StartsWith('\\')) { throw "${Label}_ABSOLUTE_LOCAL_PATH_REQUIRED" }
  $full = [IO.Path]::GetFullPath($Value)
  $cursor = $full
  while ($cursor) {
    if (Test-Path -LiteralPath $cursor) {
      if (((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'REPARSE_PATH_REFUSED' }
    }
    $parent = [IO.Path]::GetDirectoryName($cursor)
    if (-not $parent -or $parent -eq $cursor) { break }
    $cursor = $parent
  }
  if (-not $MayBeMissing -and $IsFile -and -not [IO.File]::Exists($full)) { throw "${Label}_FILE_MISSING" }
  if (-not $MayBeMissing -and -not $IsFile -and -not [IO.Directory]::Exists($full)) { throw "${Label}_DIRECTORY_MISSING" }
  return $full
}
function Invoke-Checked([string]$Exe, [string[]]$Arguments) {
  # Native argument arrays only; no shell evaluation or logging of private paths.
  & $Exe @Arguments | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'CHILD_COMMAND_FAILED' }
}
if ($Mode -eq 'UpgradePlan') {
  # Read-only: enumerate scheduler visibility, then pass only an observed state.
  # Do NOT interpret an access error as proof of task absence.
  $script:PythonExe = Assert-Local $PythonExe 'PYTHON'
  $script:ClaudeHome = Assert-Local $ClaudeHome 'CLAUDE_HOME' $false
  $script:Workspace = Assert-Local $Workspace 'WORKSPACE' $false
  $planner = Assert-Local (Join-Path $PSScriptRoot 'plan_option2_upgrade.py') 'UPGRADE_PLANNER'
  $taskState = 'UNKNOWN'
  try {
    $allTasks = @(Get-ScheduledTask -ErrorAction Stop)
    $found = @($allTasks | Where-Object { $_.TaskName -eq 'Singularity-Rust-Native-Supervisor' })
    $taskState = if ($found.Count -gt 0) { 'REGISTERED' } else { 'ABSENT' }
  } catch { $taskState = 'UNKNOWN' }
  $dashboardTaskState='UNKNOWN'
  try {
    $allDashboardTasks=@(Get-ScheduledTask -ErrorAction Stop)
    $dashboardMatches=@($allDashboardTasks | Where-Object { $_.TaskName -eq 'Singularity-ClaudeComplete-Dashboard' })
    $dashboardTaskState=if ($dashboardMatches.Count -gt 0) {'REGISTERED'} else {'ABSENT'}
  } catch { $dashboardTaskState='UNKNOWN' }
  & $PythonExe $planner '--stage-root' $InstallRoot '--claude-home' $ClaudeHome '--workspace' $Workspace '--task-state' $taskState '--dashboard-task-state' $dashboardTaskState
  if ($LASTEXITCODE -ne 0) { throw 'UPGRADE_DEPENDENCY_PLAN_REFUSED' }
  return
}
function Assert-Prepared {
  $script:Bundle = Assert-Local $Bundle 'BUNDLE'
  $script:Prepared = Assert-Local $Prepared 'PREPARED' $false
  $script:Bootstrap = Assert-Local $Bootstrap 'BOOTSTRAP' $false
  $script:PythonExe = Assert-Local $PythonExe 'PYTHON'
  $verifier = Assert-Local (Join-Path $Bootstrap 'verify_prepared_option2_candidate.py') 'VERIFIER'
  # A bootstrap helper and its nested source counterpart must be byte-identical.
  # This does not authenticate the publisher or make the outer ZIP a trust root.
  foreach ($name in @('verify_prepared_option2_candidate.py','build_option2_acceptance_bundle.py','prepare_option2_candidate.py','scan_source_archive.py','windows_source_policy.py')) {
    $one = Assert-Local (Join-Path $Bootstrap $name) 'BOOTSTRAP_HELPER'
    $two = Assert-Local (Join-Path $Prepared ('source/native/windows/' + $name)) 'SOURCE_HELPER'
    if ((Get-FileHash -LiteralPath $one -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $two -Algorithm SHA256).Hash) { throw 'BOOTSTRAP_SOURCE_MISMATCH' }
  }
  Invoke-Checked $PythonExe @($verifier,'--bundle',$Bundle,'--prepared',$Prepared)
  $script:SourceRoot = Join-Path $Prepared 'source'
  $script:BridgeExe = Join-Path $Prepared 'bin/singularity-desktop-bridge.exe'
  $script:SupervisorExe = Join-Path $Prepared 'bin/singularity-windows-supervisor.exe'
  $script:StageScript = Assert-Local (Join-Path $SourceRoot 'native/windows/stage-native.ps1') 'STAGE_SCRIPT'
}
function Assert-StageMatchesPrepared {
  $current = Assert-Local (Join-Path $InstallRoot 'current') 'STAGED_CURRENT' $false
  $receiptPath = Assert-Local (Join-Path $current 'STAGING_RECEIPT.json') 'STAGING_RECEIPT'
  $receipt = Get-Content -LiteralPath $receiptPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($receipt.schema -ne 1 -or $receipt.state -ne 'STAGED_UNVERIFIED' -or $receipt.option -ne 2 -or $receipt.repoqlVersion -ne '1.7.18') { throw 'UNOWNED_STAGE_RECEIPT' }
  foreach ($pair in @(@('singularity-desktop-bridge.exe','bridgeSha256'),@('singularity-windows-supervisor.exe','supervisorSha256'))) {
    $file = Assert-Local (Join-Path $current ('bin/' + $pair[0])) 'STAGED_BINARY'
    $source = Assert-Local (Join-Path $Prepared ('bin/' + $pair[0])) 'PREPARED_BINARY'
    $hash = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash
    if ($hash -ne (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -or $hash -ne [string]$receipt.($pair[1])) { throw 'STAGED_BINARY_HASH_DRIFT' }
  }
  $m = Join-Path $SourceRoot 'NATIVE_WINDOWS_SOURCE_MANIFEST.json'
  $stagedManifest = Assert-Local (Join-Path $current 'source/NATIVE_WINDOWS_SOURCE_MANIFEST.json') 'STAGED_MANIFEST'
  if ((Get-FileHash -LiteralPath $m -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $stagedManifest -Algorithm SHA256).Hash) { throw 'STAGED_SOURCE_MANIFEST_DRIFT' }
  $manifest = Get-Content -LiteralPath $m -Raw -Encoding UTF8 | ConvertFrom-Json
  foreach ($row in $manifest.files) {
    $p = Assert-Local (Join-Path $current ('source/' + [string]$row.path)) 'STAGED_SOURCE'
    if ((Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash -ne [string]$row.sha256) { throw 'STAGED_SOURCE_HASH_DRIFT' }
  }
  return $current
}
function Assert-ConfigurationInputs {
  $script:NodeExe = Assert-Local $NodeExe 'NODE'
  $script:RepoqlExe = Assert-Local $RepoqlExe 'REPOQL'
  $script:ClaudeExe = Assert-Local $ClaudeExe 'CLAUDE_DESKTOP'
  $script:KanzoExe = Assert-Local $KanzoExe 'KANZO'
  $script:MemoryConfig = Assert-Local $MemoryConfig 'MEMORY_CONFIG'
  $script:OfficeConfig = Assert-Local $OfficeConfig 'OFFICE_CONFIG'
  $script:ClaudeHome = Assert-Local $ClaudeHome 'CLAUDE_HOME' $false
  $script:Workspace = Assert-Local $Workspace 'WORKSPACE' $false
  $script:ClaudeScript = Assert-Local (Join-Path $SourceRoot 'native/windows/configure_claude_code_windows.mjs') 'CLAUDE_CONFIGURATOR'
  $script:McpScript = Assert-Local (Join-Path $SourceRoot 'native/windows/configure_project_mcp.mjs') 'MCP_CONFIGURATOR'
}
function Invoke-Claude([string]$Action) {
  $args = @($ClaudeScript,'--mode',$Action,'--variant','2','--source',$SourceRoot,'--home',$ClaudeHome,'--node-exe',$NodeExe,'--memory-config',$MemoryConfig,'--office-config',$OfficeConfig)
  if ($Action -eq 'apply') { $args += '--apply' }
  Invoke-Checked $NodeExe $args
}
function Invoke-Mcp([string]$Action) {
  $args = @($McpScript,'--variant','2','--workspace',$Workspace,'--rql-exe',$RepoqlExe,'--kanzo-exe',$KanzoExe)
  if ($Action -eq 'apply') { $args += '--apply' }
  if ($Action -eq 'rollback') { $args += '--rollback' }
  if ($Action -eq 'verify') { $args += '--verify' }
  Invoke-Checked $NodeExe $args
}
function Assert-SupervisorTaskAbsent {
  # Scheduler errors are unknown state, NEVER evidence of task absence.
  # Enumerate visible tasks explicitly so a missing exact task does not
  # require suppressing ambiguous Get-ScheduledTask errors.
  try { $allTasks = @(Get-ScheduledTask -ErrorAction Stop) }
  catch { throw 'SUPERVISOR_SCHEDULER_UNAVAILABLE_REFUSE_MUTATION' }
  if (@($allTasks | Where-Object { $_.TaskName -eq 'Singularity-Rust-Native-Supervisor' }).Count -gt 0) {
    throw 'REMOVE_SUPERVISOR_TASK_BEFORE_MUTATION'
  }
}
function Assert-DashboardTaskAbsent {
  try { $allTasks = @(Get-ScheduledTask -ErrorAction Stop) }
  catch { throw 'DASHBOARD_SCHEDULER_UNAVAILABLE_REFUSE_MUTATION' }
  if (@($allTasks | Where-Object { $_.TaskName -eq 'Singularity-ClaudeComplete-Dashboard' }).Count -gt 0) {
    throw 'REMOVE_DASHBOARD_TASK_BEFORE_STAGE_MUTATION'
  }
  if (Test-Path -LiteralPath (Join-Path $env:LOCALAPPDATA 'Singularity/Dashboard/task-ownership.json')) {
    throw 'DASHBOARD_PARTIAL_REGISTRATION_REFUSE_MUTATION'
  }
}
function Assert-NoLiveInstallReferences {
  $script:ClaudeHome = Assert-Local $ClaudeHome 'CLAUDE_HOME' $false
  $script:Workspace = Assert-Local $Workspace 'WORKSPACE' $false
  if ((Test-Path -LiteralPath (Join-Path $ClaudeHome '.claude/.singularity-native-claude-journal.json')) -or
      (Test-Path -LiteralPath (Join-Path $Workspace '.singularity-native-mcp-receipt.json')) -or
      (Test-Path -LiteralPath (Join-Path $ClaudeHome '.claude/.singularity-parent-memory-proxy-receipt.json'))) {
    throw 'REMOVE_CONFIGURATION_BEFORE_STAGE_RETIRE_OR_RESTORE'
  }
  Assert-SupervisorTaskAbsent
  Assert-DashboardTaskAbsent
}
function Assert-OwnedStagingSnapshot([string]$Candidate) {
  $dir = Assert-Local $Candidate 'OWNED_STAGING' $false
  $receiptFile = Assert-Local (Join-Path $dir 'STAGING_RECEIPT.json') 'OWNED_STAGING_RECEIPT'
  $rcpt = Get-Content -LiteralPath $receiptFile -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($rcpt.schema -ne 1 -or $rcpt.state -ne 'STAGED_UNVERIFIED' -or $rcpt.option -ne 2 -or
      $rcpt.repoqlVersion -ne '1.7.18' -or
      -not ([string]$rcpt.bridgeSha256 -match '^[a-fA-F0-9]{64}$') -or
      -not ([string]$rcpt.supervisorSha256 -match '^[a-fA-F0-9]{64}$')) {
    throw 'UNRECOGNIZED_STAGE_RECEIPT'
  }
  $manifestFile = Assert-Local (Join-Path $dir 'source/NATIVE_WINDOWS_SOURCE_MANIFEST.json') 'OWNED_SOURCE_MANIFEST'
  $manifest = Get-Content -LiteralPath $manifestFile -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($manifest.schema -ne 1 -or $manifest.variant -ne 2 -or $manifest.repoql.requiredVersion -ne '1.7.18' -or
      $manifest.repoql.connectorContract -ne 'fetch-render' -or $manifest.files.Count -lt 200) { throw 'OWNED_STAGE_MANIFEST_DRIFT' }
  $expected = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($path in @('STAGING_RECEIPT.json','source/NATIVE_WINDOWS_SOURCE_MANIFEST.json',
                    'bin/singularity-desktop-bridge.exe','bin/singularity-windows-supervisor.exe')) {
    if (-not $expected.Add($path)) { throw 'DUPLICATE_STAGE_ENTRY' }
  }
  foreach ($pair in @(@('singularity-desktop-bridge.exe','bridgeSha256'),@('singularity-windows-supervisor.exe','supervisorSha256'))) {
    $file=Assert-Local (Join-Path $dir ('bin/' + $pair[0])) 'OWNED_BINARY'
    if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne [string]$rcpt.($pair[1])) { throw 'OWNED_BINARY_HASH_DRIFT' }
  }
  foreach ($row in $manifest.files) {
    $name=[string]$row.path
    if ($name -match '[\\:]' -or $name.StartsWith('/') -or $name.Split('/') -contains '..' -or
        -not $expected.Add('source/'+$name)) { throw 'OWNED_STAGE_PATH_UNSAFE_OR_DUPLICATE' }
    $file=Assert-Local (Join-Path $dir ('source/'+$name)) 'OWNED_SOURCE'
    if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne [string]$row.sha256) { throw 'OWNED_SOURCE_HASH_DRIFT' }
  }
  foreach ($entry in Get-ChildItem -LiteralPath $dir -Force -Recurse -ErrorAction Stop) {
    if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'OWNED_STAGE_REPARSE_REFUSED' }
    if (-not $entry.PSIsContainer) {
      $relative=$entry.FullName.Substring($dir.Length+1).Replace('\','/')
      if (-not $expected.Remove($relative)) { throw 'UNEXPECTED_STAGED_FILE_REFUSED' }
    }
  }
  if ($expected.Count -ne 0) { throw 'STAGED_FILE_INVENTORY_INCOMPLETE' }
}
if ($Mode -in @('RetireStage','RestoreRetired')) {
  # Recovery for FIRST staging only; no deletion, no silent system change.
  # Retired files remain under the protected per-user staging root.
  Assert-NoLiveInstallReferences
  $current=Join-Path $InstallRoot 'current'
  $retired=Join-Path $InstallRoot 'held-retired'
  if (Test-Path -LiteralPath (Join-Path $InstallRoot 'previous')) { throw 'USE_ROLLBACK_STAGE_FOR_UPGRADE_SNAPSHOT' }
  if ($Mode -eq 'RetireStage') {
    if (Test-Path -LiteralPath $retired) { throw 'RETIRED_SNAPSHOT_ALREADY_EXISTS' }
    Assert-OwnedStagingSnapshot $current
    if ($PSCmdlet.ShouldProcess($current,'Preserve first staged snapshot as held-retired')) {
      Move-Item -LiteralPath $current -Destination $retired
    }
  } else {
    if (Test-Path -LiteralPath $current) { throw 'ACTIVE_STAGE_EXISTS_REFUSE_RESTORE' }
    Assert-OwnedStagingSnapshot $retired
    if ($PSCmdlet.ShouldProcess($retired,'Restore unchanged retired snapshot as current staging')) {
      Move-Item -LiteralPath $retired -Destination $current
    }
  }
  [ordered]@{schema='singularity-option2-stage-recovery/v1';mode=$Mode;option=2;
    servicesInstalled=$false;runtimeAccepted=$false;releaseReady=$false} | ConvertTo-Json -Compress
  return
}
if ($Mode -in @('DashboardPlan','DashboardRegister','DashboardVerify','DashboardStart','DashboardRemove')) {
  # Native dashboard is an explicit install step, not simply an archived file.
  $manager=Assert-Local (Join-Path $PSScriptRoot 'manage_claude_complete_dashboard.ps1') 'DASHBOARD_MANAGER'
  $taskMode=switch ($Mode) { 'DashboardPlan' {'Plan'} 'DashboardRegister' {'Register'}
    'DashboardVerify' {'Verify'} 'DashboardStart' {'Start'} 'DashboardRemove' {'Remove'} }
  $args=@{Mode=$taskMode}
  if ($Mode -eq 'DashboardRegister') {
    $current=Assert-Local (Join-Path $InstallRoot 'current') 'STAGED_CURRENT' $false
    Assert-OwnedStagingSnapshot $current
    $args['StagedSource']=Assert-Local (Join-Path $current 'source') 'DASHBOARD_SOURCE' $false
    $args['PythonExe']=Assert-Local $PythonExe 'PYTHON'
    $args['RepoqlExe']=Assert-Local $RepoqlExe 'REPOQL'
    $args['Workspace']=Assert-Local $Workspace 'WORKSPACE' $false
    $args['Port']=$DashboardPort
  }
  if ($Mode -in @('DashboardRegister','DashboardStart','DashboardRemove')) {
    if ($PSCmdlet.ShouldProcess('Singularity-ClaudeComplete-Dashboard',"Dashboard $taskMode")) {
      & $manager @args -Apply -Confirm:$false
    }
  } else { & $manager @args }
  return
}
if ($Mode -eq 'VerifyInstalled') {
  # Read-only verification independent of the old downloaded acceptance bundle.
  # All checks operate on receipt-owned *staged* files; not a live GUI test.
  $script:NodeExe = Assert-Local $NodeExe 'NODE'
  $script:ClaudeHome = Assert-Local $ClaudeHome 'CLAUDE_HOME' $false
  $script:Workspace = Assert-Local $Workspace 'WORKSPACE' $false
  $current = Assert-Local (Join-Path $InstallRoot 'current') 'STAGED_CURRENT' $false
  Assert-OwnedStagingSnapshot $current
  $script:SourceRoot = Assert-Local (Join-Path $current 'source') 'STAGED_SOURCE' $false
  $claude = Assert-Local (Join-Path $SourceRoot 'native/windows/configure_claude_code_windows.mjs') 'CLAUDE_VERIFIER'
  $mcp = Assert-Local (Join-Path $SourceRoot 'native/windows/configure_project_mcp.mjs') 'MCP_VERIFIER'
  $parent = Assert-Local (Join-Path $SourceRoot 'native/windows/configure_parent_memory_proxy.mjs') 'PARENT_VERIFIER'
  $c = & $NodeExe $claude '--mode' 'verify' '--home' $ClaudeHome
  if ($LASTEXITCODE -ne 0) { throw 'OWNED_CLAUDE_CONFIG_VERIFY_FAILED' }
  $claudeState = $c | ConvertFrom-Json
  if (-not $claudeState.configured) { throw 'OWNED_CLAUDE_CONFIG_INCOMPLETE' }
  $m = & $NodeExe $mcp '--variant' '2' '--workspace' $Workspace '--verify'
  if ($LASTEXITCODE -ne 0) { throw 'OWNED_KANZO_VERIFY_FAILED' }
  $mcpState = $m | ConvertFrom-Json
  if (-not $mcpState.installedConfigVerified) { throw 'OWNED_KANZO_CONFIG_INCOMPLETE' }
  $parentPresent = Test-Path -LiteralPath (Join-Path $ClaudeHome '.claude/.singularity-parent-memory-proxy-receipt.json')
  if ($parentPresent) {
    $p = & $NodeExe $parent '--mode' 'verify' '--home' $ClaudeHome
    if ($LASTEXITCODE -ne 0) { throw 'PARENT_PROXY_VERIFY_FAILED' }
    $parentState = $p | ConvertFrom-Json
    if (-not $parentState.configured) { throw 'PARENT_PROXY_CONFIGURATION_DRIFT' }
  }
  [ordered]@{schema='singularity-option2-installed-static-readback/v1';option=2;
    stagedBytesVerified=$true;ownedClaudeConfigVerified=$true;ownedKanzoVerified=$true;
    parentProxyPresent=$parentPresent;parentProxyVerified=$parentPresent;
    nativeClaudeGuiVerified=$false;servicesRunningVerified=$false;
    repoqlPluginLoadedVerified=$false;releaseReady=$false} | ConvertTo-Json -Compress
  return
}
if ($Mode -eq 'SupervisorVerify') {
  # Read-only registration evidence; neither health nor reboot recovery.
  $script:SupervisorConfig=Assert-Local $SupervisorConfig 'SUPERVISOR_CONFIG'
  $current=Assert-Local (Join-Path $InstallRoot 'current') 'STAGED_CURRENT' $false
  Assert-OwnedStagingSnapshot $current
  $supervisor=Assert-Local (Join-Path $current 'bin/singularity-windows-supervisor.exe') 'SUPERVISOR_BINARY'
  $verifier=Assert-Local (Join-Path $PSScriptRoot 'verify_supervisor_task.ps1') 'TASK_VERIFIER'
  & $verifier -SupervisorExe $supervisor -ConfigPath $SupervisorConfig
  if ($LASTEXITCODE -ne 0) { throw 'SUPERVISOR_TASK_NOT_VERIFIED' }
  return
}
if ($Mode -in @('SupervisorPlan','RegisterSupervisor','RemoveSupervisor')) {
  # Registering a task is NOT starting, installing or accepting the services.
  # The external Rust supervisor must validate its independently supplied
  # private configuration. We do not create or read the contents of that file.
  $script:SupervisorConfig = Assert-Local $SupervisorConfig 'SUPERVISOR_CONFIG' $true ($Mode -eq 'RemoveSupervisor')
  $registration = Assert-Local (Join-Path $PSScriptRoot 'register-supervisor-task.ps1') 'TASK_REGISTRAR'
  $supervisor = Assert-Local (Join-Path $InstallRoot 'current/bin/singularity-windows-supervisor.exe') 'STAGED_SUPERVISOR' $true ($Mode -eq 'RemoveSupervisor')
  if ($Mode -ne 'RemoveSupervisor') {
    Assert-Prepared
    $null = Assert-StageMatchesPrepared
  }
  if ($Mode -eq 'SupervisorPlan') {
    & $registration -SupervisorExe $supervisor -ConfigPath $SupervisorConfig | Out-Null
  } elseif ($Mode -eq 'RegisterSupervisor') {
    if ($PSCmdlet.ShouldProcess('Singularity-Rust-Native-Supervisor','Register exact current-user logon task')) {
      & $registration -SupervisorExe $supervisor -ConfigPath $SupervisorConfig -Apply -Confirm:$false | Out-Null
    }
  } else {
    # Removal can work without the original acceptance ZIP, so a missing
    # download cannot trap the operator with an owned scheduled task.
    if ($PSCmdlet.ShouldProcess('Singularity-Rust-Native-Supervisor','Unregister exact owned current-user task')) {
      & $registration -SupervisorExe $supervisor -ConfigPath $SupervisorConfig -Remove -Apply -Confirm:$false | Out-Null
    }
  }
  [ordered]@{schema='singularity-option2-supervisor-task/v1';mode=$Mode;taskExecutionVerified=$false;
    taskRegisteredAndHealthy=$false;servicesInstalled=$false;releaseReady=$false} | ConvertTo-Json -Compress
  return
}
if ($Mode -eq 'RollbackStage') {
  $script:ClaudeHome = Assert-Local $ClaudeHome 'CLAUDE_HOME' $false
  $script:Workspace = Assert-Local $Workspace 'WORKSPACE' $false
  if ((Test-Path -LiteralPath (Join-Path $ClaudeHome '.claude/.singularity-native-claude-journal.json')) -or
      (Test-Path -LiteralPath (Join-Path $Workspace '.singularity-native-mcp-receipt.json')) -or
      (Test-Path -LiteralPath (Join-Path $ClaudeHome '.claude/.singularity-parent-memory-proxy-receipt.json'))) {
    throw 'ROLLBACK_CONFIGURATION_BEFORE_STAGE'
  }
  # Do not move binaries while a logon task may still point at them.
  Assert-SupervisorTaskAbsent # REMOVE_SUPERVISOR_TASK_BEFORE_STAGE_ROLLBACK
  Assert-DashboardTaskAbsent
  # Option 2 previous stage must be an unchanged, receipt-owned snapshot.
  # Never promote it using the generic stager's receipt-only header.
  Assert-OwnedStagingSnapshot (Join-Path $InstallRoot 'previous')
  $stager = Assert-Local (Join-Path $PSScriptRoot 'stage-native.ps1') 'STAGER'
  if ($PSCmdlet.ShouldProcess($InstallRoot,'Restore the owned previous staging snapshot; preserve held current')) {
    & $stager -InstallRoot $InstallRoot -Rollback -Confirm:$false
  }
  return
}
if ($Mode -in @('ParentPlan','ConfigureParent','VerifyParent','RollbackParent')) {
  # Separate opt-in: Stage and Configure never take over the user's model provider.
  $script:NodeExe = Assert-Local $NodeExe 'NODE'
  $script:ClaudeHome = Assert-Local $ClaudeHome 'CLAUDE_HOME' $false
  $script:SourceRoot = Assert-Local (Join-Path $InstallRoot 'current/source') 'INSTALLED_SOURCE' $false
  $parentTool = Assert-Local (Join-Path $SourceRoot 'native/windows/configure_parent_memory_proxy.mjs') 'PARENT_PROXY_CONFIGURATOR'
  if ($Mode -in @('ParentPlan','ConfigureParent')) {
    $script:ParentProxyConfig = Assert-Local $ParentProxyConfig 'PARENT_PROXY_CONFIG'
    if ($Mode -eq 'ConfigureParent' -and -not (Test-Path -LiteralPath (Join-Path $ClaudeHome '.claude/.singularity-native-claude-journal.json'))) {
      throw 'CONFIGURE_OWNED_CLAUDE_BEFORE_PARENT_PROXY'
    }
  }
  $submode = switch($Mode) { 'ParentPlan' {'plan'} 'ConfigureParent' {'apply'} 'VerifyParent' {'verify'} 'RollbackParent' {'rollback'} }
  $args=@($parentTool,'--mode',$submode,'--home',$ClaudeHome)
  if ($Mode -in @('ParentPlan','ConfigureParent')) { $args+=@('--config',$ParentProxyConfig) }
  if ($Mode -in @('ConfigureParent','RollbackParent')) {
    if ($PSCmdlet.ShouldProcess($ClaudeHome,'Change only the receipt-owned parent-session model proxy routing')) {
      $args+='--apply'; Invoke-Checked $NodeExe $args
    }
  } else { Invoke-Checked $NodeExe $args }
  [ordered]@{schema='singularity-option2-parent-proxy-install/v1';mode=$Mode;option=2;
    providerRuntimeVerified=$false;newSessionMemoryRecallVerified=$false;releaseReady=$false} | ConvertTo-Json -Compress
  return
}
if ($Mode -eq 'RollbackConfig') {
  Assert-SupervisorTaskAbsent
  Assert-DashboardTaskAbsent
  $script:NodeExe = Assert-Local $NodeExe 'NODE'
  $script:ClaudeHome = Assert-Local $ClaudeHome 'CLAUDE_HOME' $false
  if (Test-Path -LiteralPath (Join-Path $ClaudeHome '.claude/.singularity-parent-memory-proxy-receipt.json')) {
    throw 'ROLLBACK_PARENT_PROXY_BEFORE_CLAUDE_CONFIGURATION'
  }
  $script:Workspace = Assert-Local $Workspace 'WORKSPACE' $false
  $script:SourceRoot = Assert-Local (Join-Path $InstallRoot 'current/source') 'INSTALLED_SOURCE' $false
  $script:ClaudeScript = Assert-Local (Join-Path $SourceRoot 'native/windows/configure_claude_code_windows.mjs') 'CLAUDE_CONFIGURATOR'
  $script:McpScript = Assert-Local (Join-Path $SourceRoot 'native/windows/configure_project_mcp.mjs') 'MCP_CONFIGURATOR'
  $hasMcp = Test-Path -LiteralPath (Join-Path $Workspace '.singularity-native-mcp-receipt.json')
  $hasClaude = Test-Path -LiteralPath (Join-Path $ClaudeHome '.claude/.singularity-native-claude-journal.json')
  if (-not $hasMcp -and -not $hasClaude) { throw 'NO_OWNED_CONFIGURATION_RECEIPTS' }
  if ($PSCmdlet.ShouldProcess($Workspace,'Roll back only receipt-owned project MCP and Claude configuration')) {
    if ($hasMcp) { Invoke-Checked $NodeExe @($McpScript,'--variant','2','--workspace',$Workspace,'--rollback') }
    if ($hasClaude) { Invoke-Checked $NodeExe @($ClaudeScript,'--mode','rollback','--home',$ClaudeHome,'--apply') }
  }
  return
}
Assert-Prepared
if ($Mode -eq 'Stage' -or $Mode -eq 'Plan') {
  $script:RepoqlExe = Assert-Local $RepoqlExe 'REPOQL'
  $script:ClaudeExe = Assert-Local $ClaudeExe 'CLAUDE_DESKTOP'
  $args = @{Option=2;SourceRoot=$SourceRoot;BridgeExe=$BridgeExe;SupervisorExe=$SupervisorExe;RepoqlExe=$RepoqlExe;GuiExe=$ClaudeExe;InstallRoot=$InstallRoot}
  if ($Mode -eq 'Stage') {
    # Never promote a new source under an active Claude/Kanzo configuration or
    # registered supervisor. Replacing current would invalidate owned paths and
    # receipts while native Claude Desktop may still be using them. A FIRST
    # staging has no existing current and does not require home/workspace.
    if (Test-Path -LiteralPath (Join-Path $InstallRoot 'current')) {
      Assert-NoLiveInstallReferences
    } else {
      Assert-SupervisorTaskAbsent
    }
    if ($PSCmdlet.ShouldProcess($InstallRoot,'Stage verified native binaries and Option 2 source')) {
      & $StageScript @args -Apply -Confirm:$false | Out-Null
    }
  } else { & $StageScript @args | Out-Null }
  if ($Mode -eq 'Plan') {
    Assert-ConfigurationInputs
    Invoke-Claude 'plan'
    Invoke-Mcp 'plan'
  }
}
if ($Mode -eq 'Configure' -or $Mode -eq 'Verify') {
  $null = Assert-StageMatchesPrepared
  Assert-ConfigurationInputs
  if ($Mode -eq 'Configure') {
    # Keep these as separate, receipt-owned commits. A failure does not attempt
    # to delete a first-time stage or foreign settings; operator can explicitly
    # invoke RollbackConfig. Never claim transactional cross-system completion.
    Invoke-Claude 'plan'
    Invoke-Mcp 'plan'
    if ($PSCmdlet.ShouldProcess($ClaudeHome,'Configure Claude hooks/skills and Kanzo project MCP')) {
      Invoke-Claude 'apply'
      Invoke-Mcp 'apply'
    }
  } else {
    $claudeVerify = & $NodeExe $ClaudeScript '--mode' 'verify' '--home' $ClaudeHome
    if ($LASTEXITCODE -ne 0) { throw 'CLAUDE_CONFIGURATION_VERIFY_FAILED' }
    $status = $claudeVerify | ConvertFrom-Json
    if (-not $status.configured) { throw 'CLAUDE_CONFIGURATION_UNVERIFIED' }
    Invoke-Mcp 'verify' # verifies owned registration, not live MCP traffic
  }
}
[ordered]@{schema='singularity-option2-phased-install/v1';mode=$Mode;option=2;
  stageOrConfigRequested=$mutates;installedAndRuntimeVerified=$false;servicesRegistered=$false;
  officeRuntimeVerified=$false;ghostRuntimeVerified=$false;repoqlPluginSkillsVerified=$false;
  releaseReady=$false;next='Run independent Windows Code-tab, service, memory and MCP acceptance'} | ConvertTo-Json -Compress
