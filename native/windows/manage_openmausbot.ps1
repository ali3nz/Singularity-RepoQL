#Requires -Version 5.1
<# Per-user OpenMausBot lifecycle. Existing foreign tasks and listeners are refused.
   Unregister preserves the installed payload and all user state. #>
[CmdletBinding()]
param(
  [ValidateSet('Plan','Install','Start','Verify','Stop','Unregister')][string]$Mode='Plan',
  [switch]$Apply
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$base=Join-Path $env:LOCALAPPDATA 'Singularity'
$runtime=Join-Path $base 'Runtime'
$root=Join-Path $base 'WindowsNative\openmausbot'
$payload=Join-Path $runtime 'openmausbot'
$archive=Join-Path $runtime 'openmausbot-0.1.149.tgz'
$node=Join-Path $runtime 'node\node.exe'
$python=Join-Path $runtime 'python\python.exe'
$launcher=Join-Path $PSScriptRoot 'start_openmausbot.mjs'
$cli=Join-Path $payload 'cli.js'
$receiptPath=Join-Path $root 'installation.json'
$taskName='Singularity-OpenMausBot'
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$arguments='"'+$launcher+'" "'+$root+'"'

function Assert-PlainPath([string]$Path) {
  $item=[IO.Path]::GetFullPath($Path)
  while ($item) {
    if (Test-Path -LiteralPath $item) {
      if ((Get-Item -LiteralPath $item -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'OPENMAUSBOT_REPARSE_PATH' }
    }
    $item=[IO.Path]::GetDirectoryName($item)
  }
}
function Assert-Payload {
  foreach ($p in @($node,$python,$launcher,$payload,$archive,$root)) { Assert-PlainPath $p }
  # Compare every shipped file with the integrity-pinned official archive.
  # No package scripts or downloaded commands execute during verification.
  $check=@'
import base64,hashlib,json,pathlib,sys,tarfile
archive,payload=map(pathlib.Path,sys.argv[1:])
expected='VLcqGGl1pkOJ4qzWMH42ugXiVLAQmI2syLaBWIkyGEg4z+tUHs2/1GLhy6TAPwK5NTWOZXpJhNpAhgKqlEvHOg=='
assert base64.b64encode(hashlib.sha512(archive.read_bytes()).digest()).decode()==expected,'archive integrity'
with tarfile.open(archive) as package:
    names=set()
    for member in package.getmembers():
        path=pathlib.PurePosixPath(member.name)
        assert not path.is_absolute() and '..' not in path.parts and path.parts[0]=='package','archive path'
        assert member.isdir() or member.isfile(),'archive member type'
        if member.isdir(): continue
        relative=pathlib.Path(*path.parts[1:]); actual=payload/relative
        assert not any(p.is_symlink() for p in [actual,*actual.parents]),'payload symlink'
        assert actual.is_file() and actual.stat().st_size==member.size,'payload file'
        assert hashlib.sha256(actual.read_bytes()).digest()==hashlib.sha256(package.extractfile(member).read()).digest(),'payload hash'
        names.add(relative.as_posix())
    assert {p.relative_to(payload).as_posix() for p in payload.rglob('*') if p.is_file()}==names,'extra payload file'
assert json.loads((payload/'package.json').read_text())['version']=='0.1.149','package version'
print('OPENMAUSBOT_PAYLOAD_VERIFIED')
'@
  $result=@(& $python -B -c $check $archive $payload 2>&1)
  if ($LASTEXITCODE -ne 0 -or $result -notcontains 'OPENMAUSBOT_PAYLOAD_VERIFIED') { throw 'OPENMAUSBOT_PAYLOAD_UNVERIFIED' }
  $version=& $node --version
  if ($LASTEXITCODE -ne 0 -or $version -notmatch '^v(2[4-9]|[3-9][0-9])\.') { throw 'OPENMAUSBOT_NODE_UNSUPPORTED' }
}
function Read-Receipt {
  Assert-PlainPath $receiptPath
  if (-not (Test-Path -LiteralPath $receiptPath -PathType Leaf)) { return $null }
  $r=Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
  if ($r.schema -cne 'singularity-openmausbot/v1' -or $r.ownerSid -cne $identity.User.Value -or
      $r.root -cne $root -or $r.node -cne $node -or $r.payload -cne $payload -or
      $r.cli -cne $cli -or $r.port -ne 18211 -or $r.arguments -cne $arguments -or
      $r.launcherHash -cne (Get-FileHash -LiteralPath $launcher -Algorithm SHA256).Hash) { throw 'OPENMAUSBOT_RECEIPT_DRIFT' }
  return $r
}
function Assert-Task($Receipt) {
  $t=Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if (-not $t) { return $null }
  $taskSid=[string]$t.Principal.UserId
  if ($taskSid -notmatch '^S-1-') {
    try { $taskSid=[Security.Principal.NTAccount]::new($taskSid).Translate([Security.Principal.SecurityIdentifier]).Value }
    catch { throw 'OPENMAUSBOT_TASK_FOREIGN' }
  }
  if (-not $Receipt -or $t.TaskPath -cne '\' -or @($t.Actions).Count -ne 1 -or
      $t.Actions[0].Execute -cne $node -or $t.Actions[0].Arguments -cne $arguments -or
      $taskSid -cne $identity.User.Value -or
      [string]$t.Principal.LogonType -cne 'S4U' -or [string]$t.Principal.RunLevel -cne 'Limited') { throw 'OPENMAUSBOT_TASK_FOREIGN' }
  return $t
}
function Get-Health {
  try { return Invoke-RestMethod 'http://127.0.0.1:18211/api/health' -TimeoutSec 3 }
  catch { return $null }
}
function Assert-Process($Health) {
  if (-not $Health -or $Health.app -cne 'openmausbot' -or -not $Health.pid) { throw 'OPENMAUSBOT_HEALTH_FAILED' }
  $p=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$Health.pid)
  $leasePath=Join-Path $root 'data\openmausbot-server.lease'
  Assert-PlainPath $leasePath
  $lease=Get-Content -LiteralPath $leasePath -Raw | ConvertFrom-Json
  if (-not $p -or $p.ExecutablePath -ine $node -or
      -not $p.CommandLine.Contains($payload) -or $lease.pid -ne [int]$Health.pid) { throw 'OPENMAUSBOT_PROCESS_FOREIGN' }
  $listeners=@(Get-NetTCPConnection -ErrorAction Stop | Where-Object {
    $_.LocalPort -in @(18211,18212) -and $_.RemotePort -eq 0
  })
  if (-not ($listeners | Where-Object {$_.LocalPort -eq 18211}) -or
      ($listeners | Where-Object {$_.LocalAddress -notin @('127.0.0.1','::1') -or $_.OwningProcess -ne [int]$Health.pid})) { throw 'OPENMAUSBOT_LISTENER_OWNERSHIP_FAILED' }
}
function Assert-PortsFree {
  $used=@(Get-NetTCPConnection -ErrorAction Stop | Where-Object { $_.LocalPort -in @(18211,18212) -and $_.RemotePort -eq 0 })
  if ($used.Count) { throw 'OPENMAUSBOT_PORT_BUSY' }
}

if ($Mode -in @('Install','Start','Stop','Unregister') -and -not $Apply) { throw 'OPENMAUSBOT_APPLY_REQUIRED' }
Assert-Payload
$receipt=Read-Receipt
$task=Assert-Task $receipt
if ($Mode -eq 'Plan') {
  [ordered]@{mode='Plan';payloadVerified=$true;installed=[bool]$receipt;taskOwned=[bool]$task;port=18211} | ConvertTo-Json -Compress
  return
}
if ($Mode -eq 'Install') {
  if (-not $receipt) {
    Assert-PortsFree
    if (Test-Path -LiteralPath $root) { throw 'OPENMAUSBOT_UNOWNED_STATE' }
    $null=New-Item -ItemType Directory -Path $root
    & icacls $root /inheritance:r /grant:r ('*'+$identity.User.Value+':(OI)(CI)F') '*S-1-5-18:(OI)(CI)F' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'OPENMAUSBOT_ACL_FAILED' }
    $receipt=[ordered]@{schema='singularity-openmausbot/v1';ownerSid=$identity.User.Value;root=$root;
      node=$node;payload=$payload;cli=$cli;port=18211;arguments=$arguments;
      launcherHash=(Get-FileHash -LiteralPath $launcher -Algorithm SHA256).Hash}
    $receipt | ConvertTo-Json | Set-Content -LiteralPath $receiptPath -Encoding UTF8
  }
  if (-not $task) {
    $action=New-ScheduledTaskAction -Execute $node -Argument $arguments -WorkingDirectory $payload
    $triggers=@((New-ScheduledTaskTrigger -AtLogOn -User $identity.Name),(New-ScheduledTaskTrigger -AtStartup))
    $principal=New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType S4U -RunLevel Limited
    $settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    $null=Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $triggers -Principal $principal -Settings $settings
  }
  $null=Assert-Task (Read-Receipt)
  Write-Output 'OPENMAUSBOT_INSTALLED'
  return
}
if (-not $receipt -or -not $task) { throw 'OPENMAUSBOT_NOT_INSTALLED' }
if ($Mode -in @('Stop','Unregister')) {
  $health=Get-Health
  if ($health) { Assert-Process $health }
  else { Assert-PortsFree }
  Stop-ScheduledTask -TaskName $taskName -ErrorAction Stop
  if ($health -and (Get-Process -Id ([int]$health.pid) -ErrorAction SilentlyContinue)) {
    # End only the exact vendor process verified above, even if it detached.
    Assert-Process $health
    Stop-Process -Id ([int]$health.pid) -ErrorAction Stop
  }
  if ($Mode -eq 'Unregister') { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false }
  Write-Output ('OPENMAUSBOT_'+$Mode.ToUpperInvariant())
  return
}
if ($Mode -eq 'Start') {
  $health=Get-Health
  if ($health) { Assert-Process $health }
  else {
    Assert-PortsFree
    Start-ScheduledTask -TaskName $taskName
    $deadline=[DateTime]::UtcNow.AddSeconds(60)
    do { Start-Sleep -Seconds 1; $health=Get-Health } while (-not $health -and [DateTime]::UtcNow -lt $deadline)
  }
}
$health=Get-Health
Assert-Process $health
$bots=Invoke-RestMethod 'http://127.0.0.1:18211/api/bots?messages=0' -TimeoutSec 5
if ($null -eq $bots.bots) { throw 'OPENMAUSBOT_INVENTORY_INVALID' }
[ordered]@{state='verified';version='0.1.149';pid=[int]$health.pid;port=18211;loopbackOnly=$true;bots=@($bots.bots).Count} | ConvertTo-Json -Compress
