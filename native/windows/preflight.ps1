#Requires -Version 5.1
<#
.SYNOPSIS
Read-only native Windows installation preflight for one Singularity option.
.DESCRIPTION
Emits only statuses and sha256 of explicitly supplied executables; never
reads or prints credentials. Does not install, start or change any service.
Must run on actual Windows; this file is SOURCE-ONLY until that test occurs.
.EXAMPLE
powershell.exe -NoProfile -File .\native\windows\preflight.ps1 -Option 3 -RepoqlExe 'C:\Tools\RepoQL\rql.exe' -BridgeExe 'C:\Program Files\Singularity\singularity-desktop-bridge.exe' -OpenChamberGuiExe 'C:\Apps\OpenChamber\OpenChamber.exe'
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidateRange(1, 4)][int]$Option,
  [string]$RepoqlExe = '',
  [string]$BridgeExe = '',
  [string]$SupervisorExe = '',
  [string]$SupervisorConfig = '',
  [string]$ClaudeGuiExe = '',
  [string]$OpenChamberGuiExe = '',
  [switch]$SkipLocalPortChecks,
  [int]$RepoqlPort = 41005,
  [int]$TencentPort = 8125,
  [int]$KanzoPort = 4242,
  [int]$DashboardPort = 18100,
  [int]$GraphPort = 18101,
  [int]$OfficePort = 8001
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Test-ExplicitFile([string]$PathValue) {
  if ([string]::IsNullOrWhiteSpace($PathValue)) {
    return @{ state = 'unconfigured'; verified = $false }
  }
  if ($PathValue.StartsWith('\\')) {
    return @{ state = 'remote_executable_refused'; verified = $false }
  }
  if (-not [System.IO.Path]::IsPathRooted($PathValue)) {
    return @{ state = 'invalid_path'; verified = $false }
  }
  if (-not [System.IO.File]::Exists($PathValue)) {
    return @{ state = 'missing'; verified = $false }
  }
  try {
    $digest = (Get-FileHash -LiteralPath $PathValue -Algorithm SHA256).Hash.ToLowerInvariant()
    return @{ state = 'present'; verified = $true; sha256 = $digest }
  }
  catch {
    return @{ state = 'unreadable'; verified = $false }
  }
}

function Test-LoopbackPort([int]$Port) {
  if ($Port -lt 1 -or $Port -gt 65535) {
    return @{ state = 'invalid_port'; verified = $false }
  }
  if ($SkipLocalPortChecks) {
    return @{ state = 'not_checked'; verified = $false }
  }
  $client = [System.Net.Sockets.TcpClient]::new()
  try {
    $pending = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
    if (-not $pending.AsyncWaitHandle.WaitOne(350, $false)) {
      return @{ state = 'unreachable'; verified = $false }
    }
    $client.EndConnect($pending)
    return @{ state = 'listening_only'; verified = $false }
  }
  catch {
    return @{ state = 'unreachable'; verified = $false }
  }
  finally {
    $client.Close()
  }
}

$isWindows = [System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT
$complete = $Option -eq 2 -or $Option -eq 4
$gui = if ($Option -le 2) { 'claude-desktop-code' } else { 'openchamber-desktop' }
$selectedGuiPath = if ($Option -le 2) { $ClaudeGuiExe } else { $OpenChamberGuiExe }
$report = [ordered]@{
  schema = 1
  product = 'Singularity RepoQL'
  platform = 'native-windows'
  is_windows = $isWindows
  option = $Option
  gui = $gui
  feature_office = $complete
  feature_ghost = $complete
  required_repoql_version = '1.7.18'
  required_connector_abi = 1
  repoql = Test-ExplicitFile $RepoqlExe
  bridge = Test-ExplicitFile $BridgeExe
  rust_supervisor = Test-ExplicitFile $SupervisorExe
  rust_supervisor_config = Test-ExplicitFile $SupervisorConfig
  gui_executable = Test-ExplicitFile $selectedGuiPath
  listeners = [ordered]@{}
  repoql_version_verified = $false
  windows_gui_runtime_verified = $false
  connector_abi_verified = $false
  services_healthy_verified = $false
  rust_job_object_runtime_verified = $false
  task_registration_verified = $false
  release_ready = $false
  note = 'Read-only preflight. A listening TCP port does not prove authenticated service health or any GUI integration.'
}
if ($isWindows -and $report.repoql.verified) {
  try {
    # Bounded no-shell probe. A stopped or noisy executable cannot hang preflight.
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $RepoqlExe
    $info.Arguments = '--version'
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $probe = [Diagnostics.Process]::Start($info)
    try {
      if ($probe.WaitForExit(10000) -and $probe.ExitCode -eq 0) {
        $versionText = $probe.StandardOutput.ReadToEnd()
        if ($versionText.Length -le 4096) {
          $bare = [regex]::Match($versionText.Trim(), '^(?i:v)?(\d+\.\d+\.\d+)$')
          if ($bare.Success) { $versions = @($bare.Groups[1].Value) }
          else {
            $bareLines = @($versionText -split "`r?`n" | Where-Object { $_.Trim() -match '^(?i:v)?\d+\.\d+\.\d+$' })
            if ($bareLines.Count -gt 0) { $versions = @() }
            else {
              $found = [regex]::Matches($versionText, '(?im)\b(?:repoql|rql)\b[^\r\n]{0,64}?\bv?(\d+\.\d+\.\d+)\b')
              $versions = @($found | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique)
            }
          }
          $report.repoql_version_verified = ($versions.Count -eq 1 -and $versions[0] -ceq '1.7.18')
        }
      } else { $probe.Kill() }
    } finally { $probe.Dispose() }
  } catch { $report.repoql_version_verified = $false }
}
$report.listeners.repoql = Test-LoopbackPort $RepoqlPort
$report.listeners.tencent = Test-LoopbackPort $TencentPort
$report.listeners.kanzo = Test-LoopbackPort $KanzoPort
$report.listeners.dashboard = Test-LoopbackPort $DashboardPort
$report.listeners.unified_graph = Test-LoopbackPort $GraphPort
if ($complete) { $report.listeners.office = Test-LoopbackPort $OfficePort }
$report | ConvertTo-Json -Depth 6
# Return success only for completion of a READ-ONLY diagnostic. Not release approval.
