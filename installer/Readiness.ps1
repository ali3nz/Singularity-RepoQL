#Requires -Version 5.1
<# Read-only product-owned native Windows readiness. Never echoes key content. #>
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'WINDOWS_ONLY' }
$installed=Split-Path -Parent $PSCommandPath
$singularity=Join-Path $env:LOCALAPPDATA 'Singularity'
$memory=Join-Path $singularity 'WindowsNative\memory\state\secrets'
$rows=[ordered]@{
  schema='singularity-setup-readiness/1'
  sourceInstalled=(Test-Path -LiteralPath (Join-Path $installed 'source\native\windows\manage_native_windows.ps1') -PathType Leaf)
  nativeGatewayExeInstalled=(Test-Path -LiteralPath (Join-Path $installed 'bin\unified-repoql-control.exe') -PathType Leaf)
  repoqlInstalled=(Test-Path -LiteralPath (Join-Path $env:LOCALAPPDATA 'rql\rql.exe') -PathType Leaf)
  nodeFound=([bool]((Test-Path -LiteralPath (Join-Path $singularity 'Runtime\node\node.exe') -PathType Leaf) -or (Get-Command 'node.exe' -ErrorAction SilentlyContinue)))
  pythonFound=([bool](Get-Command 'py.exe' -ErrorAction SilentlyContinue))
  providerKeyPresent=((Test-Path -LiteralPath (Join-Path $memory 'groq-api-key') -PathType Leaf) -or (Test-Path -LiteralPath (Join-Path $memory 'cohere-api-key') -PathType Leaf))
  memoryCoreOwnerKeyPresent=(Test-Path -LiteralPath (Join-Path $memory 'admin-user-key') -PathType Leaf)
  dashboardTask='UNKNOWN'
  unifiedGatewayTask='UNKNOWN'
  tunnelTask='UNKNOWN'
  nativeGatewayListener='UNVERIFIED'
  tencentPanelListener='UNVERIFIED'
}
foreach($item in @(@('dashboardTask','Singularity-ClaudeComplete-Dashboard'),@('unifiedGatewayTask','Singularity-Windows-Unified-Gateway'),@('tunnelTask','Singularity-Unified-Tunnel'))) {
  try { $task=Get-ScheduledTask -TaskName $item[1] -ErrorAction SilentlyContinue
        $rows[$item[0]]=if($null -ne $task){[string]$task.State}else{'ABSENT'} }
  catch { $rows[$item[0]]='UNAVAILABLE' }
}
foreach($item in @(@('nativeGatewayListener',18101),@('tencentPanelListener',18126))) {
  try { $listeners=@(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $item[1] -State Listen -ErrorAction SilentlyContinue)
        $rows[$item[0]]=if($listeners.Count -eq 1){'PRESENT_OWNER_NOT_YET_VERIFIED'}elseif($listeners.Count -eq 0){'ABSENT'}else{'AMBIGUOUS'} }
  catch { $rows[$item[0]]='UNAVAILABLE' }
}
$rows['liveSignInAccepted']=$false
$rows['installationAccepted']=$false
$rows | ConvertTo-Json -Depth 5
