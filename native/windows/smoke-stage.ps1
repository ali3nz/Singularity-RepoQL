#Requires -Version 5.1
# Windows CI-only smoke: validates transactional staging and optional rollback.
# The generated fake RepoQL CLI is ONLY for testing the staging script.
# It is NOT a connector ABI, runtime, or installation acceptance result.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$RepoRoot)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Windows runner required' }
$root = [IO.Path]::GetFullPath($RepoRoot)
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
  Add-Type -TypeDefinition $fakeSrc -Language CSharp -OutputAssembly $fakeExe -OutputType ConsoleApplication
  $archiveDir = Join-Path $temp 'source'
  $dist = Join-Path $temp 'dist'
  python (Join-Path $root 'native/windows/build_source_variants.py') --output-dir $dist | Out-Null
  Expand-Archive -LiteralPath (Join-Path $dist 'singularity-native-windows-option1-SOURCE-ONLY.zip') -DestinationPath $archiveDir
  $script = Join-Path $root 'native/windows/stage-native.ps1'
  $arg = @{ Option=1; SourceRoot=$archiveDir; BridgeExe=$fakeExe; RepoqlExe=$fakeExe;
    GuiExe=$fakeExe; InstallRoot=$testRoot; Confirm=$false }
  # Preview must not mutate installation directory.
  & $script @arg | Out-Null
  if (Test-Path -LiteralPath $testRoot) { throw 'Preview mutated filesystem' }
  & $script @arg -Apply | Out-Null
  $current = Join-Path $testRoot 'current'
  if (-not (Test-Path -LiteralPath (Join-Path $current 'STAGING_RECEIPT.json'))) { throw 'Missing receipt' }
  $receipt = Get-Content -LiteralPath (Join-Path $current 'STAGING_RECEIPT.json') -Raw | ConvertFrom-Json
  if ($receipt.state -ne 'STAGED_UNVERIFIED' -or $receipt.acceptedOnWindows -ne $false) { throw 'False release acceptance' }
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
  & $script -InstallRoot $testRoot -Rollback -Confirm:$false | Out-Null
  if (-not (Test-Path -LiteralPath (Join-Path $current 'STAGING_RECEIPT.json'))) { throw 'Rollback failed' }
  if (-not (Test-Path -LiteralPath (Join-Path $held 'STAGING_RECEIPT.json'))) { throw 'Rollback discarded the previously active stage' }
  Write-Output 'STAGING_SMOKE_PASS: preview, stage, upgrade, conflict, non-destructive rollback'
} finally {
  Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}
