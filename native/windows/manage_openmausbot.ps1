#Requires -Version 5.1
<# Per-user OpenMausBot lifecycle. Existing foreign tasks and listeners are refused.
   Unregister preserves the installed payload and all user state. #>
[CmdletBinding()]
param(
  [ValidateSet('Plan','Install','Start','Verify','Stop','Unregister')][string]$Mode='Plan',
  [switch]$Apply,
  [switch]$UseRustSupervisor,
  [switch]$ChangeSupervisor
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
$supervisor=Join-Path $base 'WindowsNative\current\bin\singularity-windows-supervisorw.exe'
$consoleSupervisor=Join-Path $base 'WindowsNative\current\bin\singularity-windows-supervisor.exe'
$receiptPath=Join-Path $root 'installation.json'
$taskName='Singularity-OpenMausBot'
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$arguments='"'+$launcher+'" "'+$root+'"'
$rustArguments='openmausbot "'+$root+'"'
$legacySchema='singularity-openmausbot/v1'
$rustSchema='singularity-openmausbot-rust/v1'

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
  if ((Get-Item -LiteralPath $receiptPath).Length -gt 16384) { throw 'OPENMAUSBOT_RECEIPT_DRIFT' }
  $r=Get-Content -LiteralPath $receiptPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($r.ownerSid -cne $identity.User.Value -or $r.root -cne $root -or
      $r.node -cne $node -or $r.payload -cne $payload -or $r.cli -cne $cli -or
      $r.port -ne 18211) { throw 'OPENMAUSBOT_RECEIPT_DRIFT' }
  if ($r.schema -ceq $legacySchema) {
    if ($r.arguments -cne $arguments -or
        $r.launcherHash -cne (Get-FileHash -LiteralPath $launcher -Algorithm SHA256).Hash) { throw 'OPENMAUSBOT_RECEIPT_DRIFT' }
  } elseif ($r.schema -ceq $rustSchema) {
    Assert-PlainPath $supervisor
    if ($r.arguments -cne $rustArguments -or $r.supervisor -cne $supervisor -or
        $r.launcherHash -cne (Get-FileHash -LiteralPath $supervisor -Algorithm SHA256).Hash) { throw 'OPENMAUSBOT_RECEIPT_DRIFT' }
  } else { throw 'OPENMAUSBOT_RECEIPT_DRIFT' }
  return $r
}
function Assert-Task($Receipt) {
  try { $all=@(Get-ScheduledTask -ErrorAction Stop | Where-Object { $_.TaskName -eq $taskName }) }
  catch { throw 'OPENMAUSBOT_SCHEDULER_UNAVAILABLE' }
  if ($all.Count -eq 0) { return $null }
  if ($all.Count -ne 1 -or -not $Receipt) { throw 'OPENMAUSBOT_TASK_FOREIGN' }
  $t=$all[0]
  $execute=if ($Receipt.schema -ceq $rustSchema) { $supervisor } else { $node }
  $taskSid=[string]$t.Principal.UserId
  if ($taskSid -notmatch '^S-1-') {
    try { $taskSid=[Security.Principal.NTAccount]::new($taskSid).Translate([Security.Principal.SecurityIdentifier]).Value }
    catch { throw 'OPENMAUSBOT_TASK_FOREIGN' }
  }
  if ($t.TaskPath -cne '\' -or @($t.Actions).Count -ne 1 -or
      $t.Actions[0].Execute -cne $execute -or $t.Actions[0].Arguments -cne $Receipt.arguments -or
      $t.Actions[0].WorkingDirectory -cne $payload -or
      $taskSid -cne $identity.User.Value -or
      [string]$t.Principal.LogonType -cne 'S4U' -or [string]$t.Principal.RunLevel -cne 'Limited') { throw 'OPENMAUSBOT_TASK_FOREIGN' }
  return $t
}
function Get-Health {
  try { return Invoke-RestMethod 'http://127.0.0.1:18211/api/health' -TimeoutSec 3 }
  catch { return $null }
}
function Assert-Process($Health,$Receipt) {
  if (-not $Health -or $Health.app -cne 'openmausbot' -or -not $Health.pid) { throw 'OPENMAUSBOT_HEALTH_FAILED' }
  $p=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$Health.pid)
  if (-not $p -or $p.ExecutablePath -ine $node -or
      -not $p.CommandLine -or -not $p.CommandLine.Contains($cli)) { throw 'OPENMAUSBOT_PROCESS_FOREIGN' }
  if ($Receipt.schema -ceq $rustSchema) {
    Assert-StagedRustSupervisor
    $proof=@(& $consoleSupervisor 'openmausbot-verify-lease' $root ([string][int]$Health.pid))
    if ($LASTEXITCODE -ne 0 -or $proof.Count -ne 1 -or $proof[0] -cne 'OPENMAUSBOT_LEASE_VERIFIED') {
      throw 'OPENMAUSBOT_LEASE_UNVERIFIED'
    }
    $parent=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$p.ParentProcessId) -ErrorAction Stop
    if (-not $parent -or $parent.ExecutablePath -ine $supervisor -or
        -not $parent.CommandLine -or -not $parent.CommandLine.EndsWith(' '+$rustArguments,[StringComparison]::Ordinal) -or
        $parent.CreationDate -gt $p.CreationDate) { throw 'OPENMAUSBOT_SUPERVISOR_OWNERSHIP_FAILED' }
    $owner=Invoke-CimMethod -InputObject $parent -MethodName GetOwnerSid -ErrorAction Stop
    if ($owner.ReturnValue -ne 0 -or $owner.Sid -cne $identity.User.Value) { throw 'OPENMAUSBOT_SUPERVISOR_OWNERSHIP_FAILED' }
  } else {
    $leasePath=Join-Path $root 'data\openmausbot-server.lease'
    Assert-PlainPath $leasePath
    $lease=Get-Content -LiteralPath $leasePath -Raw | ConvertFrom-Json
    if ($lease.pid -ne [int]$Health.pid) { throw 'OPENMAUSBOT_PROCESS_FOREIGN' }
  }
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

function Assert-StagedRustSupervisor {
  Assert-PlainPath $supervisor
  if (-not (Test-Path -LiteralPath $supervisor -PathType Leaf)) { throw 'OPENMAUSBOT_RUST_SUPERVISOR_MISSING' }
  $stage=Join-Path $base 'WindowsNative\current\STAGING_RECEIPT.json'
  Assert-PlainPath $stage
  $stageReceipt=Get-Content -LiteralPath $stage -Raw | ConvertFrom-Json
  if (-not $stageReceipt.PSObject.Properties['additionalBinaries']) { throw 'OPENMAUSBOT_RUST_SUPERVISOR_NOT_STAGED' }
  $owned=@($stageReceipt.additionalBinaries | Where-Object { $_.path -ceq 'bin/singularity-windows-supervisorw.exe' })
  if ($stageReceipt.schema -ne 1 -or $stageReceipt.repoqlVersion -cne '1.7.18' -or $stageReceipt.state -cne 'STAGED_UNVERIFIED' -or $stageReceipt.option -ne 2 -or
      $owned.Count -ne 1 -or $owned[0].sha256 -ine (Get-FileHash -LiteralPath $supervisor -Algorithm SHA256).Hash) {
    throw 'OPENMAUSBOT_RUST_SUPERVISOR_NOT_STAGED'
  }
  Assert-PlainPath $consoleSupervisor
  if (-not (Test-Path -LiteralPath $consoleSupervisor -PathType Leaf) -or
      -not $stageReceipt.PSObject.Properties['supervisorSha256'] -or
      [string]$stageReceipt.supervisorSha256 -notmatch '^[a-fA-F0-9]{64}$' -or
      (Get-FileHash -LiteralPath $consoleSupervisor -Algorithm SHA256).Hash -ine [string]$stageReceipt.supervisorSha256) {
    throw 'OPENMAUSBOT_RUST_CONSOLE_NOT_STAGED'
  }
}

function Write-SupervisorReceipt([bool]$Rust,[bool]$Replace) {
  $schema=if ($Rust) { $rustSchema } else { $legacySchema }
  $launchArgs=if ($Rust) { $rustArguments } else { $arguments }
  $launchExe=if ($Rust) { $supervisor } else { $launcher }
  $next=[ordered]@{schema=$schema;ownerSid=$identity.User.Value;root=$root;
    node=$node;payload=$payload;cli=$cli;port=18211;arguments=$launchArgs;
    launcherHash=(Get-FileHash -LiteralPath $launchExe -Algorithm SHA256).Hash}
  if ($Rust) { $next['supervisor']=$supervisor }
  $tmp=Join-Path $root ('.receipt-'+[Guid]::NewGuid().ToString('N')+'.tmp')
  $created=$false
  try {
    $bytes=[Text.Encoding]::UTF8.GetBytes(($next | ConvertTo-Json))
    $file=[IO.File]::Open($tmp,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    $created=$true
    try { $file.Write($bytes,0,$bytes.Length); $file.Flush($true) }
    finally { $file.Dispose() }
    if ($Replace) { [IO.File]::Replace($tmp,$receiptPath,[NullString]::Value) }
    else { [IO.File]::Move($tmp,$receiptPath) }
    $created=$false
  } finally {
    if ($created) { [IO.File]::Delete($tmp) }
  }
  return Read-Receipt
}

if (($UseRustSupervisor -or $ChangeSupervisor) -and $Mode -cne 'Install') { throw 'OPENMAUSBOT_RUST_SELECTION_REQUIRES_INSTALL' }
if ($Mode -in @('Install','Start','Stop','Unregister') -and -not $Apply) { throw 'OPENMAUSBOT_APPLY_REQUIRED' }
Assert-Payload
$receipt=Read-Receipt
$task=Assert-Task $receipt
$receiptRust=$receipt -and $receipt.schema -ceq $rustSchema
if ($ChangeSupervisor -and (-not $receipt -or $task)) { throw 'OPENMAUSBOT_CHANGE_REQUIRES_UNREGISTERED_OWNED_RECEIPT' }
if ($UseRustSupervisor -and $receipt -and -not $receiptRust -and -not $ChangeSupervisor) { throw 'OPENMAUSBOT_LAUNCH_MODE_CHANGE_REFUSED' }
if ($Mode -eq 'Plan') {
  [ordered]@{mode='Plan';payloadVerified=$true;installed=[bool]$receipt;taskOwned=[bool]$task;port=18211} | ConvertTo-Json -Compress
  return
}
if ($Mode -eq 'Install') {
  if (-not $receipt) {
    if ($UseRustSupervisor) { Assert-StagedRustSupervisor }
    Assert-PortsFree
    if (Test-Path -LiteralPath $root) { throw 'OPENMAUSBOT_UNOWNED_STATE' }
    $null=New-Item -ItemType Directory -Path $root
    & icacls $root /inheritance:r /grant:r ('*'+$identity.User.Value+':(OI)(CI)F') '*S-1-5-18:(OI)(CI)F' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'OPENMAUSBOT_ACL_FAILED' }
    $receipt=Write-SupervisorReceipt ([bool]$UseRustSupervisor) $false
  } elseif ($ChangeSupervisor -and ([bool]$UseRustSupervisor -ne $receiptRust)) {
    if ($UseRustSupervisor) { Assert-StagedRustSupervisor }
    Assert-PortsFree
    $receipt=Write-SupervisorReceipt ([bool]$UseRustSupervisor) $true
  }
  if (-not $task) {
    if ($receipt.schema -ceq $rustSchema) { Assert-StagedRustSupervisor }
    Assert-PortsFree
    if (Assert-Task $receipt) { throw 'OPENMAUSBOT_REGISTRATION_RACED' }
    $execute=if ($receipt.schema -ceq $rustSchema) { $supervisor } else { $node }
    $action=New-ScheduledTaskAction -Execute $execute -Argument $receipt.arguments -WorkingDirectory $payload
    $triggers=@((New-ScheduledTaskTrigger -AtLogOn -User $identity.Name),(New-ScheduledTaskTrigger -AtStartup))
    $principal=New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType S4U -RunLevel Limited
    $settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    $null=Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $triggers -Principal $principal -Settings $settings
  }
  if (-not (Assert-Task (Read-Receipt))) { throw 'OPENMAUSBOT_REGISTRATION_NOT_VERIFIED' }
  Write-Output 'OPENMAUSBOT_INSTALLED'
  return
}
if (-not $receipt -or -not $task) { throw 'OPENMAUSBOT_NOT_INSTALLED' }
if ($Mode -in @('Stop','Unregister')) {
  $health=Get-Health
  if ($health) { Assert-Process $health $receipt }
  else { Assert-PortsFree }
  Stop-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction Stop
  if ($receipt.schema -ceq $rustSchema) {
    # Closing the task's Rust process closes the Job Object. Never kill a
    # child by a PID from an HTTP response in this mode.
    $deadline=[DateTime]::UtcNow.AddSeconds(10)
    do {
      $currentTask=Assert-Task $receipt
      if (-not $currentTask) { throw 'OPENMAUSBOT_TASK_DISAPPEARED' }
      if ($currentTask.State -ne 'Running') { break }
      Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($currentTask.State -eq 'Running') { throw 'OPENMAUSBOT_RUST_TASK_STILL_RUNNING' }
    Assert-PortsFree
  } elseif ($health -and (Get-Process -Id ([int]$health.pid) -ErrorAction SilentlyContinue)) {
    # End only the exact vendor process verified above, even if it detached.
    Assert-Process $health $receipt
    Stop-Process -Id ([int]$health.pid) -ErrorAction Stop
  }
  if ($Mode -eq 'Unregister') {
    $ownedTask=Assert-Task $receipt
    if (-not $ownedTask -or $ownedTask.State -eq 'Running') { throw 'OPENMAUSBOT_UNREGISTER_STATE_UNVERIFIED' }
    Unregister-ScheduledTask -TaskName $taskName -TaskPath '\' -Confirm:$false -ErrorAction Stop
    if (Assert-Task $receipt) { throw 'OPENMAUSBOT_UNREGISTER_NOT_VERIFIED' }
  }
  Write-Output ('OPENMAUSBOT_'+$Mode.ToUpperInvariant())
  return
}
if ($Mode -eq 'Start') {
  $health=Get-Health
  if ($health) { Assert-Process $health $receipt }
  else {
    Assert-PortsFree
    Start-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction Stop
    $deadline=[DateTime]::UtcNow.AddSeconds(60)
    do { Start-Sleep -Seconds 1; $health=Get-Health } while (-not $health -and [DateTime]::UtcNow -lt $deadline)
  }
}
$health=Get-Health
Assert-Process $health $receipt
$bots=Invoke-RestMethod 'http://127.0.0.1:18211/api/bots?messages=0' -TimeoutSec 5
if ($null -eq $bots.bots) { throw 'OPENMAUSBOT_INVENTORY_INVALID' }
[ordered]@{state='verified';version='0.1.149';pid=[int]$health.pid;port=18211;loopbackOnly=$true;bots=@($bots.bots).Count} | ConvertTo-Json -Compress
