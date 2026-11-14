# Isolated Windows test of the actual Rust launcher and Job Object.
# The JavaScript fixture does not start a listener or access a real installation.
param([Parameter(Mandatory=$true)][string]$SupervisorExe)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if (-not $IsWindows) { throw 'NATIVE_WINDOWS_REQUIRED' }
$previousLocal=$env:LOCALAPPDATA
$previousSentinel=$env:SINGULARITY_OMB_CI_SENTINEL
$testRoot=Join-Path ([IO.Path]::GetTempPath()) ('openmaus-job-'+[guid]::NewGuid().ToString('N'))
$process=$null
try {
  $env:LOCALAPPDATA=$testRoot
  $env:SINGULARITY_OMB_CI_SENTINEL='should-not-reach-child'
  $base=Join-Path $testRoot 'Singularity'
  $root=Join-Path $base 'WindowsNative/openmausbot'
  $bin=Join-Path $base 'WindowsNative/current/bin'
  $payload=Join-Path $base 'Runtime/openmausbot'
  $nodeDir=Join-Path $base 'Runtime/node'
  foreach ($dir in @($root,$bin,$payload,$nodeDir)) {
    $null=New-Item -ItemType Directory -Path $dir -Force
  }
  $exe=Join-Path $bin 'singularity-windows-supervisorw.exe'
  $node=Join-Path $nodeDir 'node.exe'
  $cli=Join-Path $payload 'cli.js'
  $data=Join-Path $root 'data'
  $marker=Join-Path $data 'fixture.json'
  Copy-Item -LiteralPath $SupervisorExe -Destination $exe
  Copy-Item -LiteralPath (Get-Command node.exe -CommandType Application).Source -Destination $node
  @'
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const data = args[4];
if (JSON.stringify(args) !== JSON.stringify(['serve','--no-pair','--local','--data-dir',data,'--port','18211','--label','Singularity'])) process.exit(30);
if (process.env.OMB_PORT !== '18211' || process.env.OMB_WEBHOOK_PORT !== '18212' ||
    process.env.SINGULARITY_OMB_CI_SENTINEL !== undefined) process.exit(31);
fs.mkdirSync(data, {recursive: true});
const target = path.join(data, 'fixture.json');
fs.writeFileSync(target + '.tmp', JSON.stringify({pid:process.pid, parent:process.ppid}));
fs.renameSync(target + '.tmp', target);
setInterval(() => {}, 1000);
'@ | Set-Content -LiteralPath $cli -Encoding ascii
  $receipt=@{schema='singularity-openmausbot-rust/v1';root=$root;node=$node;payload=$payload;
    cli=$cli;port=18211;supervisor=$exe}
  $receiptPath=Join-Path $root 'installation.json'
  $receipt.port=18212
  $receipt | ConvertTo-Json | Set-Content -LiteralPath $receiptPath -Encoding utf8
  $argv='openmausbot "'+$root+'"'
  $bad=Start-Process -FilePath $exe -ArgumentList $argv -PassThru
  try {
    if (-not $bad.WaitForExit(10000) -or $bad.ExitCode -ne 1 -or (Test-Path -LiteralPath $marker)) {
      throw 'OPENMAUSBOT_BAD_RECEIPT_WAS_NOT_REFUSED'
    }
  } finally {
    if (-not $bad.HasExited) { $bad.Kill(); $bad.WaitForExit() }
    $bad.Dispose()
  }
  $receipt.port=18211
  $receipt | ConvertTo-Json | Set-Content -LiteralPath $receiptPath -Encoding utf8
  $process=Start-Process -FilePath $exe -ArgumentList $argv -PassThru
  $deadline=[DateTime]::UtcNow.AddSeconds(15)
  while (-not (Test-Path -LiteralPath $marker)) {
    if ($process.HasExited -or [DateTime]::UtcNow -ge $deadline) { throw 'OPENMAUSBOT_RUST_CHILD_DID_NOT_START' }
    Start-Sleep -Milliseconds 100
  }
  $observed=Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json
  if ($observed.parent -ne $process.Id) { throw 'OPENMAUSBOT_WRONG_PARENT' }
  $console=Join-Path (Split-Path -Parent (Resolve-Path -LiteralPath $SupervisorExe).Path) 'singularity-windows-supervisor.exe'
  $lease=Join-Path $data 'openmausbot-server.lease'
  [IO.File]::WriteAllText($lease, ('{"pid":' + [int]$observed.pid + '}'))
  $proof=@(& $console 'openmausbot-verify-lease' $root ([string][int]$observed.pid))
  if ($LASTEXITCODE -ne 0 -or $proof.Count -ne 1 -or $proof[0] -cne 'OPENMAUSBOT_LEASE_VERIFIED') {
    throw 'OPENMAUSBOT_NATIVE_LEASE_NOT_VERIFIED'
  }
  & $console 'openmausbot-verify-lease' $root '0' | Out-Null
  if ($LASTEXITCODE -eq 0) { throw 'OPENMAUSBOT_NATIVE_WRONG_LEASE_ACCEPTED' }
  $child=Get-Process -Id ([int]$observed.pid) -ErrorAction Stop
  try {
    # Retain the exact process handle before stopping the Rust parent.
    $null=$child.Handle
    $process.Kill()
    if (-not $process.WaitForExit(5000) -or -not $child.WaitForExit(5000)) {
      throw 'OPENMAUSBOT_JOB_DID_NOT_CLOSE_CHILD'
    }
  } finally { $child.Dispose() }
  'OPENMAUSBOT_RUST_JOB_PASS: refusal, fixed launch contract, environment isolation and job cleanup'
} finally {
  if ($process) {
    if (-not $process.HasExited) { $process.Kill(); $process.WaitForExit() }
    $process.Dispose()
  }
  $env:LOCALAPPDATA=$previousLocal
  $env:SINGULARITY_OMB_CI_SENTINEL=$previousSentinel
  Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}
