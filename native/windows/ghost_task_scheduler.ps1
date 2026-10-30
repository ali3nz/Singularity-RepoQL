#Requires -Version 5.1
<#
Narrow Task Scheduler adapter for ghost_scheduler_host.py.
Only fixed project task names are considered. Mutating operations require an
exact owner/action/trigger/principal/settings match and perform a fresh
enumeration/readback. Source tests use a fake Python adapter and never run this
script against the real scheduler.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)]
  [ValidateSet('identity','verify-private-path','timezone','list','create-disabled',
               'replace-disabled','enable','disable','remove')]
  [string]$Operation
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$prefix='Singularity-Ghost-Schedule-'
$taskPath='\'
$schema='singularity-ghost-scheduler-task/v1'
$jobFields=@('jobId','revision','draftId','draftRevision','date','time','timezone',
  'recurrence','ownerSid','executionIdentitySid','promptRevision','promptSha256',
  'pythonExe','hostScript','configPath','workspace')

function Read-Payload {
  $raw=[Console]::In.ReadToEnd()
  if ($raw.Length -gt 131072) { throw 'REQUEST_TOO_LARGE' }
  if ([string]::IsNullOrWhiteSpace($raw)) { return [pscustomobject]@{} }
  try { $payload=ConvertFrom-Json -InputObject $raw -ErrorAction Stop }
  catch { throw 'REQUEST_JSON_INVALID' }
  if ($null -eq $payload -or $payload -isnot [pscustomobject]) { throw 'REQUEST_OBJECT_REQUIRED' }
  return $payload
}

function Assert-Fields($Object,[string[]]$Expected) {
  if ($null -eq $Object -or $Object -isnot [pscustomobject]) {
    throw 'REQUEST_FIELDS_INVALID'
  }
  # Enumerate PSObject.Properties explicitly. Under Windows PowerShell 5.1
  # StrictMode Latest, projecting .Name from an empty property collection
  # throws PropertyNotFoundStrict, which broke the empty-object read-only
  # operations (identity, timezone, and list).
  $actual=@()
  foreach ($property in $Object.PSObject.Properties) {
    $actual+=,[string]$property.Name
  }
  $expectedNames=@($Expected)
  if ($actual.Count -ne $expectedNames.Count) {
    throw 'REQUEST_FIELDS_INVALID'
  }
  foreach ($expectedName in $expectedNames) {
    $found=$false
    foreach ($actualName in $actual) {
      if ([string]::Equals([string]$actualName,[string]$expectedName,[StringComparison]::Ordinal)) {
        $found=$true
        break
      }
    }
    if (-not $found) {
      throw 'REQUEST_FIELDS_INVALID'
    }
  }
}

function Is-Reparse([string]$PathValue) {
  if (-not (Test-Path -LiteralPath $PathValue)) { return $false }
  return (((Get-Item -LiteralPath $PathValue -Force -ErrorAction Stop).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)
}

function Assert-LocalPath([string]$PathValue,[bool]$MustExist=$true) {
  if (-not $PathValue -or -not [IO.Path]::IsPathRooted($PathValue) -or $PathValue.StartsWith('\\')) {
    throw 'LOCAL_ABSOLUTE_PATH_REQUIRED'
  }
  $full=[IO.Path]::GetFullPath($PathValue)
  for ($cursor=$full;$cursor;$cursor=[IO.Path]::GetDirectoryName($cursor)) {
    if (Is-Reparse $cursor) { throw 'REPARSE_PATH_REFUSED' }
    if ([IO.Path]::GetDirectoryName($cursor) -eq $cursor) { break }
  }
  if ($MustExist -and -not (Test-Path -LiteralPath $full)) { throw 'LOCAL_PATH_MISSING' }
  return $full
}

function Current-Sid {
  $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
  if (-not $identity -or -not $identity.User) { throw 'WINDOWS_IDENTITY_UNAVAILABLE' }
  return $identity.User.Value
}

function Verify-PrivatePath($Payload) {
  Assert-Fields $Payload @('path','ownerSid')
  $current=Current-Sid
  if ($Payload.ownerSid -cne $current -or $Payload.ownerSid -notmatch '^S-1-[0-9]+(-[0-9]+)+$') {
    throw 'OWNER_SID_MISMATCH'
  }
  $path=Assert-LocalPath ([string]$Payload.path) $true
  $acl=Get-Acl -LiteralPath $path -ErrorAction Stop
  if (-not $acl.AreAccessRulesProtected) { throw 'ACL_NOT_PROTECTED' }
  $allowed=@($Payload.ownerSid,'S-1-5-18')
  $rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
  if ($rules.Count -eq 0) { throw 'ACL_EMPTY' }
  foreach($rule in $rules) {
    if ($rule.IsInherited -or $rule.IdentityReference.Value -notin $allowed) {
      throw 'ACL_PRINCIPAL_UNEXPECTED'
    }
  }
  return $true
}

function Assert-Job($Job) {
  Assert-Fields $Job $jobFields
  if ([string]$Job.jobId -notmatch '^[0-9a-f]{32}$' -or
      [int]$Job.revision -lt 1 -or [string]$Job.draftId -notmatch '^[0-9a-f]{32}$' -or
      [int]$Job.draftRevision -lt 1 -or [int]$Job.promptRevision -lt 1 -or
      [string]$Job.promptSha256 -notmatch '^[0-9a-f]{64}$' -or
      [string]$Job.timezone -cne 'Pacific/Auckland' -or
      [string]$Job.recurrence -notin @('once','daily','weekly') -or
      [string]$Job.ownerSid -notmatch '^S-1-[0-9]+(-[0-9]+)+$' -or
      [string]$Job.executionIdentitySid -cne [string]$Job.ownerSid) {
    throw 'TASK_SPEC_INVALID'
  }
  try {
    [void][datetime]::ParseExact(
      ([string]$Job.date + ' ' + [string]$Job.time),
      'yyyy-MM-dd HH:mm',
      [Globalization.CultureInfo]::InvariantCulture
    )
  } catch { throw 'TASK_BOUNDARY_INVALID' }
  $null=Assert-LocalPath ([string]$Job.pythonExe) $true
  $null=Assert-LocalPath ([string]$Job.hostScript) $true
  $null=Assert-LocalPath ([string]$Job.configPath) $true
  $null=Assert-LocalPath ([string]$Job.workspace) $true
  $null=Verify-PrivatePath ([pscustomobject]@{
    path=[string]$Job.configPath
    ownerSid=[string]$Job.ownerSid
  })
  if ([IO.Path]::GetFileName([string]$Job.pythonExe) -notin @('python.exe','python3.exe') -or
      [IO.Path]::GetExtension([string]$Job.hostScript) -ine '.py' -or
      -not (Test-Path -LiteralPath ([string]$Job.workspace) -PathType Container)) {
    throw 'TASK_EXECUTABLE_INVALID'
  }
}

function Convert-PrincipalSid([string]$PrincipalValue) {
  if (-not $PrincipalValue -or $PrincipalValue.Length -gt 256) {
    throw 'TASK_PRINCIPAL_IDENTITY_INVALID'
  }
  if ($PrincipalValue -match '^S-1-[0-9]+(-[0-9]+)+$') {
    return $PrincipalValue
  }
  try {
    # Windows PowerShell's Task Scheduler CIM provider returns UserId as a
    # local account name on some systems even when the task XML stores a SID.
    # Resolve only through Windows' NTAccount -> SID translation, then keep
    # every ownership comparison exact against the configured execution SID.
    $resolved=([Security.Principal.NTAccount]::new($PrincipalValue)).Translate(
      [Security.Principal.SecurityIdentifier]
    ).Value
  } catch {
    throw 'TASK_PRINCIPAL_IDENTITY_INVALID'
  }
  if ([string]$resolved -notmatch '^S-1-[0-9]+(-[0-9]+)+$') {
    throw 'TASK_PRINCIPAL_IDENTITY_INVALID'
  }
  return [string]$resolved
}

function Get-TaskName([string]$JobId) { return $prefix + $JobId }

function Get-TaskCandidates([string]$Name) {
  try { $all=@(Get-ScheduledTask -ErrorAction Stop) }
  catch { throw 'SCHEDULER_QUERY_FAILED' }
  return @($all | Where-Object { $_.TaskName -ieq $Name })
}

function Convert-TaskSnapshot($Task) {
  $actions=@($Task.Actions | ForEach-Object {
    [ordered]@{
      execute=[string]$_.Execute
      arguments=[string]$_.Arguments
      workingDirectory=[string]$_.WorkingDirectory
    }
  })
  $triggers=@($Task.Triggers | ForEach-Object {
    $kind='Unknown'
    $className=''
    if ($_.CimClass -and $_.CimClass.CimClassName) { $className=[string]$_.CimClass.CimClassName }
    if ($className -match 'TimeTrigger') { $kind='Time' }
    elseif ($className -match 'DailyTrigger') { $kind='Daily' }
    elseif ($className -match 'WeeklyTrigger') { $kind='Weekly' }
    $boundary=[string]$_.StartBoundary
    try {
      $boundary=[datetime]::Parse(
        $boundary,
        [Globalization.CultureInfo]::InvariantCulture,
        [Globalization.DateTimeStyles]::RoundtripKind
      ).ToString("yyyy-MM-dd'T'HH:mm:ss",[Globalization.CultureInfo]::InvariantCulture)
    } catch { }
    $days=@()
    if ($kind -eq 'Weekly') {
      # The Task Scheduler CIM surface returns a UInt16 day bitmask (Sunday=1,
      # Monday=2, ... Saturday=64), not a comma-separated weekday string.
      $mask=[uint16]$_.DaysOfWeek
      $weekdays=@('Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday')
      for ($index=0;$index -lt $weekdays.Count;$index++) {
        $bit=[uint16](1 -shl $index)
        if (($mask -band $bit) -ne 0) { $days+= $weekdays[$index] }
      }
    }
    [ordered]@{
      kind=$kind
      startBoundary=$boundary
      enabled=([bool]$_.Enabled)
      daysInterval=$(if ($kind -eq 'Daily') { [int]$_.DaysInterval } else { $null })
      weeksInterval=$(if ($kind -eq 'Weekly') { [int]$_.WeeksInterval } else { $null })
      daysOfWeek=$days
    }
  })
  [ordered]@{
    taskName=[string]$Task.TaskName
    taskPath=[string]$Task.TaskPath
    state=[string]$Task.State
    enabled=([bool]$Task.Settings.Enabled)
    description=[string]$Task.Description
    actions=$actions
    triggers=$triggers
    principal=[ordered]@{
      userId=(Convert-PrincipalSid ([string]$Task.Principal.UserId))
      logonType=[string]$Task.Principal.LogonType
      runLevel=[string]$Task.Principal.RunLevel
    }
    settings=[ordered]@{
      startWhenAvailable=([bool]$Task.Settings.StartWhenAvailable)
      multipleInstances=[string]$Task.Settings.MultipleInstances
      executionTimeLimit=[string]$Task.Settings.ExecutionTimeLimit
    }
  }
}

function Expected-Arguments($Job) {
  $script=[string]$Job.hostScript
  $config=[string]$Job.configPath
  if ($script.Contains('"') -or $script.Contains([char]10) -or $script.Contains([char]13) -or
      $config.Contains('"') -or $config.Contains([char]10) -or $config.Contains([char]13)) {
    throw 'TASK_SCRIPT_ARGUMENT_INVALID'
  }
  return '-B "' + $script + '" --config "' + $config + '" --execute-job ' + [string]$Job.jobId +
    ' --revision ' + [string]$Job.revision +
    ' --prompt-revision ' + [string]$Job.promptRevision +
    ' --prompt-sha256 ' + [string]$Job.promptSha256
}

function Expected-Description($Job) {
  return $schema + ';jobId=' + [string]$Job.jobId +
    ';ownerSid=' + [string]$Job.ownerSid +
    ';revision=' + [string]$Job.revision +
    ';promptRevision=' + [string]$Job.promptRevision +
    ';promptSha256=' + [string]$Job.promptSha256
}

function Expected-TriggerKind($Job) {
  switch ([string]$Job.recurrence) {
    'once' { return 'Time' }
    'daily' { return 'Daily' }
    'weekly' { return 'Weekly' }
  }
}

function Expected-Weekday($Job) {
  $boundary=[datetime]::ParseExact(
    ([string]$Job.date + ' ' + [string]$Job.time),
    'yyyy-MM-dd HH:mm',
    [Globalization.CultureInfo]::InvariantCulture
  )
  return $boundary.DayOfWeek.ToString()
}

function Assert-TaskMatches($Task,$Job,[bool]$Enabled) {
  Assert-Job $Job
  $snap=Convert-TaskSnapshot $Task
  if ($snap.taskName -cne (Get-TaskName ([string]$Job.jobId)) -or
      $snap.taskPath -cne $taskPath -or
      $snap.description -cne (Expected-Description $Job) -or
      $snap.enabled -ne $Enabled -or
      $snap.actions.Count -ne 1 -or
      [string]$snap.actions[0].execute -ine [string]$Job.pythonExe -or
      [string]$snap.actions[0].arguments -cne (Expected-Arguments $Job) -or
      [string]$snap.actions[0].workingDirectory -ine [string]$Job.workspace -or
      $snap.principal.userId -cne [string]$Job.executionIdentitySid -or
      $snap.principal.logonType -notin @('InteractiveToken','Interactive') -or
      $snap.principal.runLevel -notin @('LeastPrivilege','Limited') -or
      $snap.settings.startWhenAvailable -ne $false -or
      $snap.settings.multipleInstances -ine 'IgnoreNew' -or
      $snap.triggers.Count -ne 1) {
    throw 'TASK_OWNERSHIP_OR_CONFIGURATION_MISMATCH'
  }
  $trigger=$snap.triggers[0]
  $boundary=([string]$Job.date + 'T' + [string]$Job.time + ':00')
  if ($trigger.kind -cne (Expected-TriggerKind $Job) -or
      $trigger.startBoundary -cne $boundary -or -not $trigger.enabled) {
    throw 'TASK_TRIGGER_MISMATCH'
  }
  if ($Job.recurrence -eq 'daily' -and $trigger.daysInterval -ne 1) {
    throw 'TASK_DAILY_TRIGGER_MISMATCH'
  }
  if ($Job.recurrence -eq 'weekly' -and
      ($trigger.weeksInterval -ne 1 -or $trigger.daysOfWeek.Count -ne 1 -or
       $trigger.daysOfWeek[0] -cne (Expected-Weekday $Job))) {
    throw 'TASK_WEEKLY_TRIGGER_MISMATCH'
  }
  return $snap
}

function Get-XmlEscaped([string]$Value) {
  return [Security.SecurityElement]::Escape($Value)
}

function New-TaskXml($Job) {
  Assert-Job $Job
  $current=Current-Sid
  if ([string]$Job.ownerSid -cne $current) { throw 'TASK_OWNER_SID_MISMATCH' }
  $boundary=Get-XmlEscaped ([string]$Job.date + 'T' + [string]$Job.time + ':00')
  $weekday=(Expected-Weekday $Job)
  $triggerXml=''
  if ($Job.recurrence -eq 'once') {
    $triggerXml='<TimeTrigger><StartBoundary>'+$boundary+'</StartBoundary><Enabled>true</Enabled></TimeTrigger>'
  } elseif ($Job.recurrence -eq 'daily') {
    $triggerXml='<CalendarTrigger><StartBoundary>'+$boundary+'</StartBoundary><Enabled>true</Enabled><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger>'
  } else {
    $triggerXml='<CalendarTrigger><StartBoundary>'+$boundary+'</StartBoundary><Enabled>true</Enabled><ScheduleByWeek><DaysOfWeek><'+$weekday+'/></DaysOfWeek><WeeksInterval>1</WeeksInterval></ScheduleByWeek></CalendarTrigger>'
  }
  $name=Get-TaskName ([string]$Job.jobId)
  $description=Get-XmlEscaped (Expected-Description $Job)
  $command=Get-XmlEscaped ([string]$Job.pythonExe)
  $arguments=Get-XmlEscaped (Expected-Arguments $Job)
  $working=Get-XmlEscaped ([string]$Job.workspace)
  $sid=Get-XmlEscaped ([string]$Job.executionIdentitySid)
  return '<?xml version="1.0" encoding="UTF-16"?>' +
    '<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">' +
    '<RegistrationInfo><URI>\Singularity\GhostSchedule\'+$name+'</URI><Description>'+$description+'</Description></RegistrationInfo>' +
    '<Triggers>'+$triggerXml+'</Triggers>' +
    '<Principals><Principal id="Author"><UserId>'+$sid+'</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>' +
    '<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>' +
    '<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>false</StartWhenAvailable>' +
    '<Enabled>false</Enabled><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><AllowStartOnDemand>true</AllowStartOnDemand></Settings>' +
    '<Actions Context="Author"><Exec><Command>'+$command+'</Command><Arguments>'+$arguments+'</Arguments><WorkingDirectory>'+$working+'</WorkingDirectory></Exec></Actions></Task>'
}

function Emit($Value) {
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $Value -Depth 12 -Compress))
}

function Get-AllGhostTasks {
  try { $all=@(Get-ScheduledTask -ErrorAction Stop) }
  catch { throw 'SCHEDULER_QUERY_FAILED' }
  return @($all | Where-Object { $_.TaskName -like ($prefix+'*') })
}

try {
  $payload=Read-Payload
  switch ($Operation) {
    'identity' {
      Assert-Fields $payload @()
      Emit ([ordered]@{ok=$true;currentSid=(Current-Sid)})
      exit 0
    }
    'verify-private-path' {
      $verified=Verify-PrivatePath $payload
      Emit ([ordered]@{ok=$true;verified=$verified})
      exit 0
    }
    'timezone' {
      Assert-Fields $payload @()
      $zone=Get-TimeZone -ErrorAction Stop
      Emit ([ordered]@{ok=$true;timeZoneId=[string]$zone.Id})
      exit 0
    }
    'list' {
      Assert-Fields $payload @()
      $tasks=@(Get-AllGhostTasks | ForEach-Object { Convert-TaskSnapshot $_ })
      Emit ([ordered]@{ok=$true;tasks=$tasks})
      exit 0
    }
    'create-disabled' {
      Assert-Fields $payload @('job')
      $job=$payload.job
      Assert-Job $job
      $name=Get-TaskName ([string]$job.jobId)
      if (@(Get-TaskCandidates $name).Count -ne 0) { throw 'TASK_NAME_ALREADY_EXISTS' }
      Register-ScheduledTask -TaskName $name -TaskPath $taskPath -Xml (New-TaskXml $job) -ErrorAction Stop | Out-Null
      $after=@(Get-TaskCandidates $name)
      if ($after.Count -ne 1) { throw 'TASK_REGISTRATION_NOT_VERIFIED' }
      $null=Assert-TaskMatches $after[0] $job $false
      Emit ([ordered]@{ok=$true})
      exit 0
    }
    'replace-disabled' {
      Assert-Fields $payload @('oldJob','newJob')
      $old=$payload.oldJob
      $new=$payload.newJob
      Assert-Job $old; Assert-Job $new
      if ($old.jobId -cne $new.jobId -or [int]$new.revision -le [int]$old.revision) { throw 'TASK_REPLACEMENT_INVALID' }
      $matches=@(Get-TaskCandidates (Get-TaskName ([string]$old.jobId)))
      if ($matches.Count -ne 1) { throw 'TASK_NOT_UNIQUE' }
      if ($matches[0].State -eq 'Running') { throw 'TASK_RUNNING_UPDATE_REFUSED' }
      $null=Assert-TaskMatches $matches[0] $old $false
      Register-ScheduledTask -TaskName (Get-TaskName ([string]$new.jobId)) -TaskPath $taskPath -Xml (New-TaskXml $new) -Force -ErrorAction Stop | Out-Null
      $after=@(Get-TaskCandidates (Get-TaskName ([string]$new.jobId)))
      if ($after.Count -ne 1) { throw 'TASK_REPLACEMENT_NOT_VERIFIED' }
      $null=Assert-TaskMatches $after[0] $new $false
      Emit ([ordered]@{ok=$true})
      exit 0
    }
    { $_ -in 'enable','disable','remove' } {
      Assert-Fields $payload @('job')
      $job=$payload.job
      Assert-Job $job
      $name=Get-TaskName ([string]$job.jobId)
      $matches=@(Get-TaskCandidates $name)
      if ($matches.Count -ne 1) { throw 'TASK_NOT_UNIQUE' }
      $task=$matches[0]
      if ($task.State -eq 'Running' -and $Operation -in @('disable','remove')) { throw 'TASK_RUNNING_REFUSED' }
      if ($Operation -eq 'enable') {
        $null=Assert-TaskMatches $task $job $false
        Enable-ScheduledTask -TaskName $name -TaskPath ([string]$task.TaskPath) -ErrorAction Stop | Out-Null
        $after=@(Get-TaskCandidates $name)
        if ($after.Count -ne 1) { throw 'TASK_ENABLE_NOT_VERIFIED' }
        $null=Assert-TaskMatches $after[0] $job $true
      } elseif ($Operation -eq 'disable') {
        $snap=Convert-TaskSnapshot $task
        $null=Assert-TaskMatches $task $job ([bool]$snap.enabled)
        Disable-ScheduledTask -TaskName $name -TaskPath ([string]$task.TaskPath) -ErrorAction Stop | Out-Null
        $after=@(Get-TaskCandidates $name)
        if ($after.Count -ne 1) { throw 'TASK_DISABLE_NOT_VERIFIED' }
        $null=Assert-TaskMatches $after[0] $job $false
      } else {
        $null=Assert-TaskMatches $task $job $false
        Unregister-ScheduledTask -TaskName $name -TaskPath ([string]$task.TaskPath) -Confirm:$false -ErrorAction Stop
        if (@(Get-TaskCandidates $name).Count -ne 0) { throw 'TASK_REMOVAL_NOT_VERIFIED' }
      }
      Emit ([ordered]@{ok=$true})
      exit 0
    }
  }
  throw 'OPERATION_INVALID'
} catch {
  # Never emit command lines, paths, credentials, prompt text or exception data.
  [Console]::Error.WriteLine('TASK_SCHEDULER_OPERATION_FAILED')
  exit 2
}
