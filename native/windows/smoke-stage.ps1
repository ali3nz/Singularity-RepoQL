#Requires -Version 5.1
# Windows CI-only smoke: validates transactional staging and optional rollback.
# The generated fake RepoQL CLI is ONLY for testing the staging script.
# It is NOT a connector ABI, runtime, or installation acceptance result.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$RepoRoot,
      [Parameter(Mandatory=$true)][string]$BridgeExe,
      [string]$SupervisorExe,
      [string]$DashboardRoutesExe,
      [string]$DocLedgerCommitExe,
      [string]$DashboardListenerExe,
      [string]$DocWriterExe,
      [string]$SetupExe,
      [string]$SourcePackagerExe,
      [string]$UnifiedProxyExe)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Windows runner required' }
$root = [IO.Path]::GetFullPath($RepoRoot)
$bridge = (Resolve-Path -LiteralPath $BridgeExe -ErrorAction Stop).Path
$testRoot = Join-Path $env:LOCALAPPDATA ('Singularity\smoke-' + [guid]::NewGuid().ToString('N'))
$temp = Join-Path $env:TEMP ('singularity-stage-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temp -Force | Out-Null
try {
  $fakeExe = Join-Path $temp 'rql-fake.exe'
  $fakeSrc = @'
public class FakeRepoql {
  public static void Main(string[] args) {
    System.Console.WriteLine("RepoQL 1.7.18 (staging test double only)");
  }
}
'@
  # Match the stager's AMD64 PE32+ requirement even for the version fixture.
  $fixtureSource = Join-Path $temp 'FakeRepoql.cs'
  Set-Content -LiteralPath $fixtureSource -Value $fakeSrc -Encoding ASCII
  $csc = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
  if (-not (Test-Path -LiteralPath $csc -PathType Leaf)) { throw 'STAGING_SMOKE_CSC_MISSING' }
  & $csc '/nologo' '/target:exe' '/platform:x64' ('/out:' + $fakeExe) $fixtureSource
  if ($LASTEXITCODE -ne 0) { throw 'STAGING_SMOKE_FIXTURE_BUILD_FAILED' }
  $archiveDir = Join-Path $temp 'source'
  $dist = Join-Path $temp 'dist'
  python (Join-Path $root 'native/windows/build_source_variants.py') --output-dir $dist --variant 2 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'STAGING_SMOKE_SOURCE_BUILD_FAILED' }
  Expand-Archive -LiteralPath (Join-Path $dist 'singularity-native-windows-option2-SOURCE-ONLY.zip') -DestinationPath $archiveDir
  $script = Join-Path $root 'native/windows/stage-native.ps1'
  $arg = @{ Option=2; SourceRoot=$archiveDir; BridgeExe=$bridge; RepoqlExe=$fakeExe;
    InstallRoot=$testRoot; Confirm=$false }
  $extra=@{}
  if ($DashboardRoutesExe -or $DocLedgerCommitExe -or $SupervisorExe -or $DashboardListenerExe -or $DocWriterExe -or $SetupExe -or $SourcePackagerExe -or $UnifiedProxyExe) {
    if (-not ($DashboardRoutesExe -and $DocLedgerCommitExe -and $SupervisorExe)) { throw 'STAGING_SMOKE_OPTIONAL_INPUTS_INCOMPLETE' }
    $prepared=Join-Path $temp 'bin'
    New-Item -ItemType Directory -Path $prepared | Out-Null
    $supervisor=Join-Path $prepared 'singularity-windows-supervisor.exe'
    Copy-Item -LiteralPath $SupervisorExe -Destination $supervisor
    $arg['SupervisorExe']=$supervisor
    $extra=@{'singularity-dashboard-routes.exe'=$DashboardRoutesExe;'singularity-doc-ledger-commit.exe'=$DocLedgerCommitExe}
    if ($DashboardListenerExe) { $extra['singularity-dashboard-listener.exe']=$DashboardListenerExe }
    if ($DocWriterExe) { $extra['singularity-memorycore-writer.exe']=$DocWriterExe }
    if ($SetupExe) { $extra['singularity-windows-setup.exe']=$SetupExe }
    if ($SourcePackagerExe) { $extra['singularity-source-packager.exe']=$SourcePackagerExe }
    if ($UnifiedProxyExe) { $extra['singularity-unified-proxy.exe']=$UnifiedProxyExe }
    foreach ($name in $extra.Keys) { Copy-Item -LiteralPath $extra[$name] -Destination (Join-Path $prepared $name) }
  }
  # Preview must not mutate installation directory.
  & $script @arg | Out-Null
  if (Test-Path -LiteralPath $testRoot) { throw 'Preview mutated filesystem' }
  & $script @arg -Apply | Out-Null
  $current = Join-Path $testRoot 'current'
  if (-not (Test-Path -LiteralPath (Join-Path $current 'STAGING_RECEIPT.json'))) { throw 'Missing receipt' }
  $receipt = Get-Content -LiteralPath (Join-Path $current 'STAGING_RECEIPT.json') -Raw | ConvertFrom-Json
  if ($receipt.state -ne 'STAGED_UNVERIFIED' -or $receipt.option -ne 2 -or
      $receipt.bridgeFeatureOffice -ne $true -or $receipt.bridgeFeatureGhost -ne $false -or
      $receipt.acceptedOnWindows -ne $false) { throw 'False release acceptance' }
  foreach ($name in $extra.Keys) {
    $expected=(Get-FileHash -LiteralPath $extra[$name] -Algorithm SHA256).Hash
    $rows=@($receipt.additionalBinaries | Where-Object { $_.path -ceq ('bin/'+$name) })
    $actual=(Get-FileHash -LiteralPath (Join-Path $current ('bin/'+$name)) -Algorithm SHA256).Hash
    if ($rows.Count -ne 1 -or $actual -ine $expected -or $rows[0].sha256 -ine $expected) {
      throw 'STAGING_SMOKE_OPTIONAL_BINARY_HASH_DRIFT'
    }
  }
  if ($SourcePackagerExe) {
    & (Resolve-Path -LiteralPath $SourcePackagerExe).Path 'verify-snapshot' $current | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'STAGING_SMOKE_RUST_VERIFY_FAILED' }
    $foreign=Join-Path $current 'bin/foreign-fixture.exe'
    [IO.File]::WriteAllText($foreign,'not in receipt')
    & (Resolve-Path -LiteralPath $SourcePackagerExe).Path 'verify-snapshot' $current 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { throw 'STAGING_SMOKE_FOREIGN_FILE_NOT_REFUSED' }
    # The actual stager must refuse to move a drifted current snapshot.
    # Keep the normal success/rollback fixture separate by cleaning up the
    # pending directory created by this deliberate, isolated negative case.
    $blockedByRust=$false
    try { & $script @arg -Apply | Out-Null }
    catch { $blockedByRust=$_.Exception.Message -match 'RUST_PREVIOUS_SNAPSHOT_VERIFICATION_FAILED' }
    if (-not $blockedByRust -or -not (Test-Path -LiteralPath $foreign) -or
        (Test-Path -LiteralPath (Join-Path $testRoot 'previous'))) {
      throw 'STAGING_SMOKE_DRIFTED_CURRENT_WAS_MOVED'
    }
    Remove-Item -LiteralPath $foreign -Force
    $pending=@(Get-ChildItem -LiteralPath $testRoot -Force -Directory |
      Where-Object { $_.Name -match '^\.pending-[0-9a-fA-F]{32}$' })
    if ($pending.Count -ne 1) { throw 'STAGING_SMOKE_PENDING_FIXTURE_COUNT_INVALID' }
    Remove-Item -LiteralPath $pending[0].FullName -Recurse -Force
  }
  # A second Apply preserves current as previous; no destructive overwrite.
  & $script @arg -Apply | Out-Null
  $previous = Join-Path $testRoot 'previous'
  if (-not (Test-Path -LiteralPath (Join-Path $previous 'STAGING_RECEIPT.json'))) { throw 'Rollback snapshot missing' }
  # A third Apply must fail closed rather than deleting the existing backup.
  $blocked = $false
  try { & $script @arg -Apply | Out-Null } catch { $blocked = ($_.Exception.Message -match 'PREVIOUS_ROLLBACK_SNAPSHOT_EXISTS') }
  if (-not $blocked) { throw 'Expected third apply to fail closed' }
  # Rollback preserves the active stage automatically, without deleting it.
  $held = Join-Path $testRoot 'held-current'
  # Prove rollback is independently operable when source files, GUI and
  # RepoQL executable arguments are unavailable.
  if ($extra.Count) {
    $targetName=if ($DashboardListenerExe) { 'singularity-dashboard-listener.exe' } else { 'singularity-dashboard-routes.exe' }
    $target=Join-Path $previous ('bin/'+$targetName)
    [IO.File]::AppendAllText($target,'smoke drift')
    $refused=$false
    try { & $script -InstallRoot $testRoot -Rollback -Confirm:$false | Out-Null }
    catch { $refused=$_.Exception.Message -match 'ROLLBACK_ADDITIONAL_BINARY_HASH_MISMATCH' }
    if (-not $refused -or (Test-Path -LiteralPath $held) -or -not (Test-Path -LiteralPath $current)) {
      throw 'STAGING_SMOKE_TAMPER_NOT_REFUSED_BEFORE_MOVE'
    }
    Copy-Item -LiteralPath $extra[$targetName] -Destination $target -Force
  }
  & $script -InstallRoot $testRoot -Rollback -Confirm:$false | Out-Null
  if (-not (Test-Path -LiteralPath (Join-Path $current 'STAGING_RECEIPT.json'))) { throw 'Rollback failed' }
  if (-not (Test-Path -LiteralPath (Join-Path $held 'STAGING_RECEIPT.json'))) { throw 'Rollback discarded the previously active stage' }
  Write-Output 'STAGING_SMOKE_PASS: preview, stage, upgrade, conflict, non-destructive rollback'
} finally {
  Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}
