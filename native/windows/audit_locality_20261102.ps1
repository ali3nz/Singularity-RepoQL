#Requires -Version 5.1
<#
Read-only Singularity RepoQL Windows locality inspection.
Does not stop services, alter firewall rules, read secret values, or modify files.
Run under the same Windows account as Singularity. Elevated privileges may be
needed to see executable paths and connections owned by other accounts.
#>
[CmdletBinding()]
param([string]$KnownRemoteHost = '')
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'WINDOWS_ONLY' }

$ports = @(18100,18101,18102,18126,18421,18431,18473,41005)
$taskPattern = 'Singularity|RepoQL|Tencent|MemoryCore|Ghost|Kanzo'
function Get-ProcessInfo([int]$PidValue) {
    try {
        $item = Get-CimInstance Win32_Process -Filter "ProcessId=$PidValue" -ErrorAction Stop
        if ($null -eq $item) { return @{ pid=$PidValue; name='NOT_FOUND'; executable='NOT_FOUND' } }
        return @{pid=$PidValue;name=[string]$item.Name;executable=[string]$item.ExecutablePath}
    } catch {
        return @{pid=$PidValue;name='UNAVAILABLE';executable='UNAVAILABLE'}
    }
}
function Get-PortEntries($items, $kind) {
    $out = @()
    foreach ($entry in @($items | Where-Object { $_.LocalPort -in $ports })) {
        $proc = Get-ProcessInfo ([int]$entry.OwningProcess)
        $out += [ordered]@{
            port = [int]$entry.LocalPort
            localAddress = [string]$entry.LocalAddress
            state = [string]$entry.State
            pid = $proc.pid
            processName = $proc.name
            executable = $proc.executable
        }
    }
    return $out
}

$networkError = ''
$connections = @()
try { $connections = @(Get-NetTCPConnection -ErrorAction Stop) }
catch { $networkError = 'Get-NetTCPConnection unavailable or access denied' }
$listeners = @(Get-PortEntries ($connections | Where-Object State -eq 'Listen') 'listener')
$ownerPids = @($listeners | ForEach-Object { [int]$_.pid } | Sort-Object -Unique)
$remoteSessions = @()
foreach ($entry in @($connections | Where-Object {
    $_.State -eq 'Established' -and $_.RemoteAddress -notin @('127.0.0.1','::1','0.0.0.0','::') -and
    (($_.OwningProcess -in $ownerPids) -or ($KnownRemoteHost -and $_.RemoteAddress -eq $KnownRemoteHost))
})) {
    $proc = Get-ProcessInfo ([int]$entry.OwningProcess)
    $remoteSessions += [ordered]@{
        remoteAddress = [string]$entry.RemoteAddress
        remotePort = [int]$entry.RemotePort
        localPort = [int]$entry.LocalPort
        pid = $proc.pid
        processName = $proc.name
        executable = $proc.executable
    }
}

$tasks = @()
try {
    foreach ($task in @(Get-ScheduledTask | Where-Object { $_.TaskName -match $taskPattern })) {
        $actions = @()
        foreach ($action in @($task.Actions)) {
            $arguments = [string]$action.Arguments
            $actions += [ordered]@{
                executableName = [IO.Path]::GetFileName([string]$action.Execute)
                hasSshPortForward = [bool]($arguments -match '(?i)(?:^|\s)-L\s|(?:^|\s)-R\s|(?:^|\s)-D\s')
                mentionsDockerhost = [bool](($arguments -match '(?i)dockerhost' -or ($KnownRemoteHost -and $arguments.Contains($KnownRemoteHost))))
                mentionsGraph18101 = [bool]($arguments -match '18101')
            }
        }
        $tasks += [ordered]@{ name = [string]$task.TaskName; state = [string]$task.State; actions = $actions }
    }
} catch { $tasks += @{status='SCHEDULED_TASK_QUERY_UNAVAILABLE'} }

$root = Join-Path $env:LOCALAPPDATA 'Singularity'
$dashboard = Join-Path $root 'Dashboard'
$gatewayConfig = Join-Path $dashboard 'windows-unified-gateway.json'
$gatewaySummary = [ordered]@{ configPresent=(Test-Path -LiteralPath $gatewayConfig -PathType Leaf) }
if ($gatewaySummary.configPresent) {
    try {
        $config = Get-Content -LiteralPath $gatewayConfig -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
        # Output only endpoint configuration and file presence, never credentials.
        $gatewaySummary.repoqlBase = [string]$config.repoqlBase
        $gatewaySummary.tencentBase = [string]$config.tencentBase
        $gatewaySummary.configuredPort = $config.port
        $gatewaySummary.binary = [string]$config.binary
        $gatewaySummary.repoqlTokenFilePresent = Test-Path -LiteralPath ([string]$config.repoqlTokenFile) -PathType Leaf
        $gatewaySummary.tencentKeyFilePresent = if ($config.tencentUserKeyFile) { Test-Path -LiteralPath ([string]$config.tencentUserKeyFile) -PathType Leaf } else { $false }
        $gatewaySummary.gatewayTokenFilePresent = Test-Path -LiteralPath ([string]$config.gatewayTokenFile) -PathType Leaf
    } catch { $gatewaySummary.configReadable = $false }
}
$files = [ordered]@{
    dashboardTokenPresent = Test-Path -LiteralPath (Join-Path $dashboard 'token') -PathType Leaf
    gatewayTokenPresent = Test-Path -LiteralPath (Join-Path $dashboard 'unified-gateway.token') -PathType Leaf
    memoryRootPresent = Test-Path -LiteralPath (Join-Path $root 'WindowsNative\memory') -PathType Container
    memoryCoreBearerPresent = Test-Path -LiteralPath (Join-Path $root 'WindowsNative\memory\state\secrets\core-bearer') -PathType Leaf
    memoryOwnerKeyPresent = Test-Path -LiteralPath (Join-Path $root 'WindowsNative\memory\state\secrets\admin-user-key') -PathType Leaf
}

$result = [ordered]@{
    report = 'Singularity Windows locality read-only inspection v1'
    generatedAtUtc = [DateTime]::UtcNow.ToString('o')
    computerName = $env:COMPUTERNAME
    networkQueryError = $networkError
    listeners = $listeners
    projectTasks = $tasks
    relevantEstablishedRemoteConnections = $remoteSessions
    privateFilePresenceOnly = $files
    gatewayConfigurationNoSecrets = $gatewaySummary
    interpretation = 'Discovery only. Loopback is not proof of data locality. Verify service owners, actual RepoQL index, Tencent metadata and unique Windows-only / Dockerhost-only marker readbacks independently.'
}
$result | ConvertTo-Json -Depth 8
