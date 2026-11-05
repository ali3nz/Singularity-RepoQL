#Requires -Version 5.1
<#
Read-only native Kanzo status audit. Does not change tasks, claims or Kanzo configuration.
Call only after verifying the Windows-local Kanzo binary and that 127.0.0.1:4242
belongs to the intended installation. No synthetic successes or remote fallback.
#>
[CmdletBinding()]
param([string]$SourceRoot='', [int]$Port=4242)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'WINDOWS_ONLY' }
if ($Port -lt 1024 -or $Port -gt 65535) { throw 'KANZO_LOCAL_PORT_INVALID' }
if (-not $SourceRoot) { $SourceRoot=(Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path }
$SourceRoot=[IO.Path]::GetFullPath($SourceRoot)
if ($SourceRoot.StartsWith('\\')) { throw 'KANZO_SOURCE_MUST_BE_LOCAL' }
$auditor=Join-Path $SourceRoot 'native\windows\unified-gateway-rust\target\release\kanzo_board_audit.exe'
if (-not (Test-Path -LiteralPath $auditor -PathType Leaf)) {
    throw 'KANZO_RUST_AUDITOR_NOT_BUILT_RUN_CARGO_BUILD_LOCKED_BINS'
}
$listener=@(Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
if ($listener.Count -ne 1) { throw 'EXPECTED_LOCAL_KANZO_LISTENER_NOT_FOUND' }
$owner=Get-CimInstance Win32_Process -Filter ('ProcessId='+$listener[0].OwningProcess)
if ($null -eq $owner -or [IO.Path]::GetFileName([string]$owner.ExecutablePath) -ine 'kanzo.exe') {
    throw 'KANZO_LISTENER_NOT_NATIVE_KANZO_BINARY'
}
$origin="http://127.0.0.1:$Port"
$ping=Invoke-WebRequest -UseBasicParsing -Uri "$origin/api/ping" -TimeoutSec 8
if ($ping.StatusCode -ne 200 -or $ping.Content.Trim() -ne 'kanzo') { throw 'KANZO_PING_CONTRACT_INVALID' }
$board=Invoke-WebRequest -UseBasicParsing -Uri "$origin/api/board?project=all&done=all" -TimeoutSec 15
if ($board.StatusCode -ne 200) { throw 'KANZO_BOARD_UNAVAILABLE' }
# Write JSON to STDIN, not a shared temp file; the Rust auditor reports counts only.
$board.Content | & $auditor --stdin
if ($LASTEXITCODE -ne 0) { throw 'KANZO_NATIVE_BOARD_AUDIT_FAILED' }
