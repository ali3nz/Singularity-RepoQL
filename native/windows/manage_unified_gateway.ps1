#Requires -Version 5.1
<#
Per-user, project-owned native Windows graph gateway lifecycle.
Plan/Verify do not modify the machine. Register/Start/Stop/Remove require
-Apply and never touch the old SSH tunnel without separate owner verification.
No password/token is supplied on the command line. Never delete user data.
#>
[CmdletBinding()]
param(
    [ValidateSet('Plan','Register','Start','Verify','Stop','Remove')][string]$Mode='Plan',
    [switch]$Apply,
    [string]$StagedSource='',
    [string]$StateDir='',
    [string]$RepoqlTokenFile='',
    [ValidateRange(1024,65535)][int]$DashboardPort=18100,
    [string]$TencentBase='',
    [string]$TencentServiceId='',
    [string]$TencentUserKeyFile='',
    [string]$HubDocUriPrefix='',
    [string[]]$WikiIds=@()
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'WINDOWS_ONLY' }
if (-not $StagedSource) { $StagedSource=(Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path }
# Option 2's dashboard host uses this exact private directory for its auth token.
# Deriving the paths prevents a second, unrelated token that would make
# the graph health endpoint green while every RepoQL graph read fails.
if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA_REQUIRED' }
$dashboardState=[IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Singularity\Dashboard'))
if (-not $StateDir) { $StateDir=$dashboardState }
$StagedSource=[IO.Path]::GetFullPath($StagedSource)
$StateDir=[IO.Path]::GetFullPath($StateDir)
if (-not $StateDir.Equals($dashboardState,[StringComparison]::OrdinalIgnoreCase)) { throw 'GATEWAY_STATE_MUST_MATCH_OPTION2_DASHBOARD' }
if (-not $RepoqlTokenFile) { $RepoqlTokenFile=Join-Path $StateDir 'token' }
if ($StagedSource.StartsWith('\\') -or $StateDir.StartsWith('\\')) { throw 'LOCAL_PATH_REQUIRED' }
$taskName='Singularity-Windows-Unified-Gateway'
$binary=Join-Path (Split-Path -Parent $StagedSource) 'bin\unified-repoql-control.exe'
$launcher=Join-Path $StagedSource 'native\windows\start_unified_gateway.ps1'
$config=Join-Path $StateDir 'windows-unified-gateway.json'
$keyFile=Join-Path $StateDir 'unified-gateway.token'
$repoqlBase='http://127.0.0.1:'+$DashboardPort
$existing=Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
function Assert-ProjectTask {
    if ($null -eq $existing) { throw 'GATEWAY_TASK_NOT_REGISTERED' }
    $actions=@($existing.Actions)
    if ($actions.Count -ne 1) { throw 'TASK_AMBIGUOUS' }
    $action=$actions[0]
    $native=([string]$action.Execute).Equals($binary,[StringComparison]::OrdinalIgnoreCase) -and
        [string]$action.Arguments -ceq ('--config "'+$config+'"')
    # Legacy tasks may only be stopped/removed after ownership verification.
    # They cannot be restarted: the legacy shell-based startup can flash.
    $legacy=([IO.Path]::GetFileName([string]$action.Execute) -in @('powershell.exe','pwsh.exe') -and
        [string]$action.Arguments -like ('*'+$launcher+'*') -and
        [string]$action.Arguments -like ('*'+$config+'*'))
    if (-not ($native -or $legacy)) { throw 'FOREIGN_TASK_REFUSED' }
    return $native
}
function Assert-PathOwner([string]$value,[string]$label) {
    if (-not [IO.Path]::IsPathRooted($value) -or $value.StartsWith('\\') -or
        $value.Contains('"') -or $value.Contains([char]13) -or $value.Contains([char]10)) { throw ($label+'_NOT_LOCAL_ABSOLUTE') }
    $cursor=[IO.Path]::GetFullPath($value)
    while ($true) {
        if (Test-Path -LiteralPath $cursor) {
            $item=Get-Item -LiteralPath $cursor -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw ($label+'_REPARSE_REFUSED') }
        }
        $parent=Split-Path -Parent $cursor
        if (-not $parent -or $parent -eq $cursor) { break }
        $cursor=$parent
    }
}
Assert-PathOwner $StagedSource 'SOURCE'
Assert-PathOwner $StateDir 'STATE'
Assert-PathOwner $binary 'BINARY'
Assert-PathOwner $launcher 'LAUNCHER'
if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) { throw 'LAUNCHER_MISSING' }
if ($Mode -eq 'Plan' -or $Mode -eq 'Register') {
    if (-not ([IO.Path]::GetFullPath($RepoqlTokenFile)).Equals([IO.Path]::GetFullPath((Join-Path $StateDir 'token')),[StringComparison]::OrdinalIgnoreCase)) { throw 'GATEWAY_REPOQL_TOKEN_MUST_MATCH_DASHBOARD' }
    Assert-PathOwner $RepoqlTokenFile 'REPOQL_TOKEN'
    if (-not (Test-Path -LiteralPath $RepoqlTokenFile -PathType Leaf)) { throw 'LOCAL_REPOQL_TOKEN_MISSING' }
    if (-not (Test-Path -LiteralPath $binary -PathType Leaf)) { throw 'COMPILED_WINDOWS_GATEWAY_MISSING' }
    if ($HubDocUriPrefix -and ($HubDocUriPrefix -cnotmatch '^github://[^\s?#]+/$' -or $HubDocUriPrefix.Length -gt 512)) { throw 'EXPLICIT_HUB_IMPORT_PREFIX_INVALID' }
    if ($TencentBase) {
        $parsed=[uri]$TencentBase
        if ($parsed.Scheme -ne 'http' -or $parsed.Host -ne '127.0.0.1' -or $parsed.Port -lt 1024 -or $parsed.AbsolutePath -ne '/' -or $parsed.Query -or $parsed.Fragment) { throw 'REMOTE_TENCENT_ENDPOINT_REFUSED' }
        if (-not $TencentServiceId -or -not $TencentUserKeyFile) { throw 'LOCAL_TENCENT_IDENTITY_REQUIRED' }
        Assert-PathOwner $TencentUserKeyFile 'TENCENT_KEY'
        if (-not (Test-Path -LiteralPath $TencentUserKeyFile -PathType Leaf)) { throw 'LOCAL_TENCENT_KEY_MISSING' }
    }
}
if ($Mode -eq 'Plan') {
    [ordered]@{mode='read-only';registered=($null -ne $existing);task=$taskName;binary=$binary;
        config=$config;gatewayTokenFile=$keyFile;repoqlBase=$repoqlBase;
        tencentBase=$TencentBase;hubDocUriPrefix=$HubDocUriPrefix;tunnelDisposition='not modified';graphLive='NOT_TESTED'} | ConvertTo-Json
    exit 0
}
if ($Mode -in @('Register','Start','Stop','Remove') -and -not $Apply) { throw 'APPLY_REQUIRED' }
if ($Mode -eq 'Register') {
    if ($null -ne $existing) { throw 'EXISTING_GATEWAY_TASK_REQUIRES_RECONCILIATION' }
    if (Test-Path -LiteralPath $config -PathType Leaf) { throw 'EXISTING_CONFIG_REQUIRES_RECONCILIATION' }
    $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
    if (-not (Test-Path -LiteralPath $StateDir)) { New-Item -ItemType Directory -Path $StateDir -Force | Out-Null }
    $acl=New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true,$false)
    $flags=[Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    foreach ($sid in @($identity.User,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
        $rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::FullControl,$flags,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $StateDir -AclObject $acl
    if (-not (Test-Path -LiteralPath $keyFile -PathType Leaf)) {
        $bytes=New-Object byte[] 48
        $rng=[Security.Cryptography.RandomNumberGenerator]::Create()
        try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
        [IO.File]::WriteAllText($keyFile,[Convert]::ToBase64String($bytes),[Text.Encoding]::ASCII)
    }
    $data=[ordered]@{
        binary=$binary; repoqlBase=$repoqlBase; repoqlTokenFile=$RepoqlTokenFile;
        tencentBase=$TencentBase; tencentServiceId=$TencentServiceId;
        tencentUserKeyFile=$TencentUserKeyFile; wikiIds=@($WikiIds);hubDocUriPrefix=$HubDocUriPrefix;
        gatewayTokenFile=$keyFile; usageDir=''; port=18101
    }
    $temporary=Join-Path $StateDir ('windows-unified-gateway.'+[guid]::NewGuid().ToString('N')+'.tmp')
    try {
        [IO.File]::WriteAllText($temporary,($data | ConvertTo-Json -Depth 3),[Text.Encoding]::UTF8)
        Move-Item -LiteralPath $temporary -Destination $config -ErrorAction Stop
        # The Rust gateway reads the existing protected JSON itself.
        # No PowerShell/cmd parent is required at logon or recovery.
        $args='--config "'+$config+'"'
        $action=New-ScheduledTaskAction -Execute $binary -Argument $args -WorkingDirectory $StateDir
        $trigger=New-ScheduledTaskTrigger -AtLogOn -User $identity.Name
        $principal=New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive -RunLevel Limited
        $settings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
        Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -ErrorAction Stop | Out-Null
        $existing=Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
        Assert-ProjectTask
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
    }
    Write-Host 'Project-owned Windows unified gateway task registered, not started. Run -Mode Start -Apply after disabling the verified SSH tunnel.'
    exit 0
}
Assert-ProjectTask
if ($Mode -eq 'Start') {
    $listener=@(Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 18101 -State Listen -ErrorAction SilentlyContinue)
    if ($listener.Count -gt 0) { throw 'GATEWAY_PORT_BUSY_VERIFY_OWNER_NO_AUTOMATIC_KILL' }
    if (-not (Assert-ProjectTask)) { throw 'LEGACY_GATEWAY_TASK_REQUIRES_SCOPED_REPLACEMENT' }
    Start-ScheduledTask -TaskName $taskName
    Write-Host 'Start requested. Run -Mode Verify to establish independent listener identity.'
    exit 0
}
if ($Mode -eq 'Verify') {
    if (-not (Assert-ProjectTask)) { throw 'LEGACY_GATEWAY_TASK_REQUIRES_SCOPED_REPLACEMENT' }
    $listener=@(Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 18101 -State Listen -ErrorAction SilentlyContinue)
    if ($listener.Count -ne 1) { throw 'EXPECTED_ONE_WINDOWS_GATEWAY_LISTENER' }
    $process=Get-CimInstance Win32_Process -Filter ('ProcessId='+$listener[0].OwningProcess)
    if ($null -eq $process -or [IO.Path]::GetFullPath([string]$process.ExecutablePath) -ine [IO.Path]::GetFullPath($binary)) { throw 'GATEWAY_LISTENER_NOT_OWNED_BY_WINDOWS_BINARY' }
    $key=(Get-Content -LiteralPath $keyFile -Raw).Trim()
    $health=Invoke-RestMethod -Uri 'http://127.0.0.1:18101/v1/health' -Method Get -Headers @{Authorization=('Bearer '+$key)} -TimeoutSec 15
    if ($health.service -ne 'unified-repoql-control' -or $health.rust -ne $true) { throw 'GATEWAY_HEALTH_CONTRACT_FAILED' }
    # A healthy process alone is not a working memory graph. Independently
    # exercise its RepoQL adapter against the same Windows dashboard port.
    $graph=Invoke-RestMethod -Uri 'http://127.0.0.1:18101/v1/graph?repoql=true&tencent=false&limit=10' -Method Get -Headers @{Authorization=('Bearer '+$key)} -TimeoutSec 30
    $localRepoql=@($graph.sources | Where-Object { $_.name -eq 'repoql' })
    if ($localRepoql.Count -ne 1 -or $localRepoql[0].available -ne $true) { throw 'GATEWAY_WINDOWS_REPOQL_READ_UNAVAILABLE' }
    [ordered]@{gatewayOwner='verified_win32_process_path';port=18101;service=$health.service;repoqlGraphApi='verified_available';sourceLocality='REQUIRES_UNIQUE_FIXTURE';tencentSource='NOT_TESTED';graphEndToEnd='NOT_TESTED'} | ConvertTo-Json
    exit 0
}
if ($Mode -eq 'Stop') { Stop-ScheduledTask -TaskName $taskName -ErrorAction Stop; exit 0 }
if ($Mode -eq 'Remove') {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host 'Owned gateway task removed; private configuration and tokens preserved.'
}
