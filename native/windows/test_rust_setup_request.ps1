# Windows compiled frontend check. No setup dialog, script execution or staging.
param([Parameter(Mandatory=$true)][string]$SetupExe)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'NATIVE_WINDOWS_REQUIRED' }
$binary=(Resolve-Path -LiteralPath $SetupExe).Path
$driverRoot=(Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$temp=Join-Path $env:TEMP ('singularity-setup-request-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temp | Out-Null
try {
  $path=Join-Path $temp 'request.json'
  foreach ($case in @(
    @{phase='Plan';expect=0},
    @{phase='Stage';expect=0},
    @{phase='UninstallPlan';expect=0},
    @{phase='Run';expect=2},
    @{phase='Plan';expect=2;unexpected=$true}
  )) {
    $request=@{schema='singularity-windows-setup/v1';phase=$case.phase;driverRoot=$driverRoot}
    if ($case.ContainsKey('unexpected')) { $request['apply']=$true }
    $request | ConvertTo-Json -Compress | Set-Content -LiteralPath $path -Encoding UTF8
    $proc=Start-Process -FilePath $binary -ArgumentList @('--validate-request',('"'+$path+'"')) -PassThru -Wait
    if ($proc.ExitCode -ne $case.expect) { throw 'RUST_SETUP_REQUEST_BOUNDARY_FAILED' }
  }
  Write-Output 'RUST_SETUP_REQUEST_BOUNDARY_PASS: compiled Windows request parsing only'
} finally {
  Remove-Item -LiteralPath $temp -Recurse -Force
}
