# Scope: the verified project-owned Singularity unified SSH port forward only.
# Run without -Apply for read-only inspection. Does not install a Windows gateway.
param([switch]$Apply)
$ErrorActionPreference = 'Stop'
$task = Get-ScheduledTask -TaskName 'Singularity-Unified-Tunnel' -ErrorAction SilentlyContinue
if ($null -eq $task) {
    Write-Host 'No Singularity unified tunnel task was found.'
    exit 0
}
$actions = @($task.Actions)
if ($actions.Count -ne 1) { throw 'Ambiguous task actions. No change.' }
$action = $actions[0]
$exe = [System.IO.Path]::GetFileName([string]$action.Execute)
$arguments = [string]$action.Arguments
if ($exe -ine 'ssh.exe' -or $arguments -notmatch '(?i)(?:^|\s)-L\s+127\.0\.0\.1:18101:127\.0\.0\.1:18101(?:\s|$)') {
    throw 'Task ownership or forwarding contract not verified. No change.'
}
Write-Host 'Verified Singularity unified SSH tunnel task. It is not a local Windows memory gateway.'
if (-not $Apply) {
    Write-Host 'Read-only mode. Pass -Apply after verifying the scope to stop and disable this project-owned tunnel.'
    exit 0
}
Stop-ScheduledTask -TaskName 'Singularity-Unified-Tunnel' -ErrorAction SilentlyContinue
Disable-ScheduledTask -TaskName 'Singularity-Unified-Tunnel' | Out-Null
$check = Get-ScheduledTask -TaskName 'Singularity-Unified-Tunnel'
if ($check.State -ne 'Disabled') { throw 'Tunnel task was not disabled. Review task state.' }
$listener = @(Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 18101 -State Listen -ErrorAction SilentlyContinue)
if ($listener.Count -gt 0) {
    Write-Warning 'Port 18101 remains bound. Check the owning process before stopping anything else.'
} else {
    Write-Host 'Forward task disabled. Port 18101 is unbound pending an independently installed Windows-local gateway.'
}
