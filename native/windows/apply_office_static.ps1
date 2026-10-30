#Requires -Version 5.1
<#
Applies the built Claude Office static frontend (frontend/out) to the backend that serves it
(backend/static), replacing the target so a stale Next.js build id cannot keep serving old chunks.

Read-only unless -Apply is supplied. Refuses while the backend port accepts TCP connections,
because the static mount is resolved at process start (SERVE_STATIC=1) and a live backend would
keep serving the old build. It does not start, stop or register anything; that stays with the
lifecycle entrypoint and the operator.

Port check note (2026-10-30, live .241): Get-NetTCPConnection returned no listener on 18128 while
uvicorn answered /health on that port, so a TCP connect is the authority here; the cmdlet is only
used for diagnostics.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$OfficeRoot,
  [switch]$Apply,
  [ValidateRange(1024, 65535)][int]$BackendPort = 18128,
  [string]$ReceiptPath = ''
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-NoReparse([string]$PathValue) {
  $full = [IO.Path]::GetFullPath($PathValue)
  $cursor = $full
  while ($cursor) {
    if (Test-Path -LiteralPath $cursor) {
      $item = Get-Item -LiteralPath $cursor -Force
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "REPARSE_PATH_REFUSED: $cursor"
      }
    }
    $parent = [IO.Path]::GetDirectoryName($cursor)
    if (-not $parent -or $parent -eq $cursor) { break }
    $cursor = $parent
  }
  return $full
}

function Get-BuildId([string]$NextDir) {
  $dirs = @(Get-ChildItem -LiteralPath $NextDir -Directory -Force |
    Where-Object { $_.Name -ne 'static' } | Sort-Object Name)
  if ($dirs.Count -ne 1) {
    throw ("BUILD_ID_AMBIGUOUS: expected exactly one build directory under {0}, found {1}" -f $NextDir, $dirs.Count)
  }
  return $dirs[0].Name
}

function Get-Sha256([string]$PathValue) {
  return (Get-FileHash -LiteralPath $PathValue -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-PortOwnerHint([int]$Port) {
  try {
    $lines = @((& netstat.exe -ano) | Select-String -SimpleMatch (':' + $Port) | ForEach-Object { $_.Line.Trim() })
    if ($lines.Count -eq 0) { return 'netstat: no rows' }
    return ($lines -join ' | ')
  }
  catch {
    return ('netstat unavailable: ' + $_.Exception.Message)
  }
}

function Assert-BackendStopped([int]$Port) {
  $client = New-Object Net.Sockets.TcpClient
  try {
    $task = $client.ConnectAsync('127.0.0.1', $Port)
    $completed = $task.Wait(1500)
  }
  catch {
    $client.Close()
    throw ("PORT_STATE_UNKNOWN_REFUSE: cannot probe port {0}: {1}" -f $Port, $_.Exception.Message)
  }
  $accepts = ($completed -and $client.Connected)
  $inner = $null
  if ($task.IsFaulted -and $task.Exception) { $inner = $task.Exception.GetBaseException() }
  $client.Close()
  if ($accepts) {
    throw ("OFFICE_BACKEND_RUNNING_STOP_FIRST: port {0} accepts TCP ({1}); stop the owned Office backend, apply, then start it again with SERVE_STATIC=1" -f $Port, (Get-PortOwnerHint $Port))
  }
  if ($completed -and $inner -and ($inner -isnot [Net.Sockets.SocketException])) {
    throw ("PORT_STATE_UNKNOWN_REFUSE: probe of port {0} failed: {1}" -f $Port, $inner.Message)
  }
}

$root = Assert-NoReparse $OfficeRoot
$source = Assert-NoReparse (Join-Path $root 'frontend/out')
$target = [IO.Path]::GetFullPath((Join-Path $root 'backend/static'))
$sourceIndex = Join-Path $source 'index.html'
$sourceNext = Join-Path $source '_next'
if (-not (Test-Path -LiteralPath $sourceIndex -PathType Leaf)) { throw 'FRONTEND_OUT_NOT_BUILT: index.html missing' }
if (-not (Test-Path -LiteralPath $sourceNext -PathType Container)) { throw 'FRONTEND_OUT_INVALID: _next missing' }
if (-not (Test-Path -LiteralPath (Join-Path $sourceNext 'static') -PathType Container)) { throw 'FRONTEND_OUT_INVALID: _next/static missing' }

$sourceBuildId = Get-BuildId $sourceNext
$sourceIndexSha = Get-Sha256 $sourceIndex

$plan = [ordered]@{
  schema            = 'singularity-office-static-apply/v1'
  officeRoot        = $root
  source            = $source
  target            = $target
  sourceBuildId     = $sourceBuildId
  sourceIndexSha256 = $sourceIndexSha
  backendPort       = $BackendPort
  applied           = $false
  verified          = $false
}

if (-not $Apply) {
  $plan.planOnly = $true
  $plan | ConvertTo-Json -Compress
  return
}

Assert-BackendStopped $BackendPort

if (-not (Test-Path -LiteralPath $target -PathType Container)) {
  throw 'BACKEND_STATIC_MISSING: expected the Office backend static directory; refusing to create a new layout'
}
$null = Assert-NoReparse $target
if ($target -eq $source) { throw 'SOURCE_EQUALS_TARGET_REFUSED' }
if ($target.StartsWith($source + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'TARGET_INSIDE_SOURCE_REFUSED'
}

# /MIR removes files that are not in the source, which is what prevents an old build id from
# lingering next to the new one. Robocopy exit codes 0-7 are success, 8+ is a real failure.
$robocopy = @($source, $target, '/MIR', '/E', '/R:2', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS', '/NP')
& robocopy.exe @robocopy | Out-Null
$rc = $LASTEXITCODE
if ($rc -ge 8) { throw ("ROBOCOPY_FAILED: exit {0}" -f $rc) }

$targetIndex = Join-Path $target 'index.html'
$targetNext = Join-Path $target '_next'
if (-not (Test-Path -LiteralPath $targetIndex -PathType Leaf)) { throw 'APPLY_VERIFY_FAILED: target index.html missing' }
$targetBuildId = Get-BuildId $targetNext
$targetIndexSha = Get-Sha256 $targetIndex
if ($targetBuildId -ne $sourceBuildId) {
  throw ("APPLY_VERIFY_FAILED: build id {0} != {1}" -f $targetBuildId, $sourceBuildId)
}
if ($targetIndexSha -ne $sourceIndexSha) {
  throw 'APPLY_VERIFY_FAILED: index.html hash differs after copy'
}

$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
if (-not $ReceiptPath) {
  if (-not $env:LOCALAPPDATA) { throw 'RECEIPT_PATH_REQUIRED: LOCALAPPDATA unavailable, pass -ReceiptPath' }
  $receiptDir = Join-Path $env:LOCALAPPDATA 'Singularity\OfficeStatic'
  $null = New-Item -ItemType Directory -Path $receiptDir -Force
  $ReceiptPath = Join-Path $receiptDir ("apply-{0}.json" -f $stamp)
}
$receiptDirPath = Split-Path -Parent ([IO.Path]::GetFullPath($ReceiptPath))
if ($receiptDirPath -and -not (Test-Path -LiteralPath $receiptDirPath)) {
  $null = New-Item -ItemType Directory -Path $receiptDirPath -Force
}

$plan.applied = $true
$plan.verified = $true
$plan.targetBuildId = $targetBuildId
$plan.targetIndexSha256 = $targetIndexSha
$plan.robocopyExit = $rc
$plan.receiptPath = [IO.Path]::GetFullPath($ReceiptPath)
$plan.appliedAtUtc = $stamp
$plan | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $ReceiptPath -Encoding UTF8
$plan | ConvertTo-Json -Compress
