# Task Scheduler is an OS boundary; Rust setup owns explicit phase/argument consent.
# Dot-source only from the receipt-owned dashboard manager.
Set-StrictMode -Version Latest
function Get-TransactionHash([byte[]]$Bytes) {
  $sha=[Security.Cryptography.SHA256]::Create()
  try { [BitConverter]::ToString($sha.ComputeHash($Bytes)).Replace('-','').ToLowerInvariant() }
  finally { $sha.Dispose() }
}
function Get-TransactionFileHash([string]$Path) { Get-TransactionHash ([IO.File]::ReadAllBytes($Path)) }
function Get-TaskInvariant([string]$Xml) {
  $doc=[xml]$Xml
  $actions=@($doc.SelectNodes('/*[local-name()="Task"]/*[local-name()="Actions"]'))
  if ($actions.Count -ne 1) { throw 'TASK_TRANSACTION_ACTIONS_SHAPE_INVALID' }
  $null=$actions[0].ParentNode.RemoveChild($actions[0])
  foreach($node in @($doc.SelectNodes('/*[local-name()="Task"]/*[local-name()="RegistrationInfo"]/*[local-name()="Date"]'))) {
    $null=$node.ParentNode.RemoveChild($node)
  }
  Get-TransactionHash ([Text.Encoding]::UTF8.GetBytes($doc.DocumentElement.OuterXml))
}
function Get-TaskSddlHash([string]$Name) {
  $service=New-Object -ComObject 'Schedule.Service'
  $service.Connect()
  $sddl=[string]$service.GetFolder('\').GetTask($Name).GetSecurityDescriptor(7)
  if (-not $sddl) { throw 'TASK_TRANSACTION_SECURITY_DESCRIPTOR_MISSING' }
  Get-TransactionHash ([Text.Encoding]::UTF8.GetBytes($sddl))
}
function Get-TaskActionHash($Action) {
  $json=@([string]$Action.Execute,[string]$Action.Arguments,[string]$Action.WorkingDirectory)|ConvertTo-Json -Compress
  Get-TransactionHash ([Text.Encoding]::UTF8.GetBytes($json))
}
function Read-VerifiedTaskPreimage([string]$BackupReceipt) {
  $BackupReceipt=Assert-Path $BackupReceipt 'TASK_BACKUP_RECEIPT'
  $backup=Get-Content -LiteralPath $BackupReceipt -Raw -Encoding UTF8|ConvertFrom-Json
  if($backup.schema -cne 'wave56-verified-task-preimage/v1' -or $backup.verifiedOnDockerhost -ne $true -or
    $backup.taskName -cne $taskName -or $taskName -cne 'Singularity-ClaudeComplete-Dashboard' -or
    $backup.dockerhostBackup -cne '/mnt/newdata/backups/singularity-wave56/fleet-1266/windows-preimage' -or
    $backup.taskXmlFile -cne 'dashboard-task.xml' -or $backup.ownershipFile -cne 'dashboard-task-ownership.json') {
    throw 'TASK_TRANSACTION_VERIFIED_BACKUP_REQUIRED'
  }
  $dir=Split-Path -Parent $BackupReceipt
  $xmlFile=Assert-Path (Join-Path $dir $backup.taskXmlFile) 'TASK_PREIMAGE'
  $ownerFile=Assert-Path (Join-Path $dir $backup.ownershipFile) 'TASK_RECEIPT_PREIMAGE'
  if((Get-TransactionFileHash $xmlFile) -cne $backup.taskXmlSha256 -or
    (Get-TransactionFileHash $ownerFile) -cne $backup.ownershipSha256) { throw 'TASK_TRANSACTION_PREIMAGE_HASH_DRIFT' }
  $before=[IO.File]::ReadAllText($xmlFile)
  if((Get-TaskInvariant $before) -cne $backup.taskInvariantSha256) { throw 'TASK_TRANSACTION_PREIMAGE_INVARIANT_DRIFT' }
  @{receipt=$backup;xml=$before;ownerFile=$ownerFile;dir=$dir}
}
function Set-TransactionReceipt([byte[]]$Bytes) {
  $tmp=$receiptFile+'.'+[guid]::NewGuid().ToString('N')+'.tmp'
  try {
    [IO.File]::WriteAllBytes($tmp,$Bytes)
    [IO.File]::Replace($tmp,$receiptFile,[System.Management.Automation.Language.NullString]::Value)
    Assert-ReceiptAcl
  } finally { if(Test-Path -LiteralPath $tmp){Remove-Item -LiteralPath $tmp -Force} }
}
function Restore-OwnedDashboardTaskAction([string]$BackupReceipt) {
  $pre=Read-VerifiedTaskPreimage $BackupReceipt
  $live=@(Get-TaskCandidates)
  if($live.Count -ne 1 -or [string]$live[0].State -eq 'Running') { throw 'TASK_TRANSACTION_ROLLBACK_REQUIRES_STOPPED_TASK' }
  Assert-TaskOwned $live[0] (Get-OwnedReceipt)
  $journalFile=Assert-Path (Join-Path $pre.dir 'dashboard-rebind-journal.json') 'TASK_TRANSACTION_JOURNAL'
  $journal=Get-Content -LiteralPath $journalFile -Raw -Encoding UTF8|ConvertFrom-Json
  if($journal.schema -cne 'singularity-dashboard-action-transaction/v1' -or
    $journal.taskName -cne $taskName -or $journal.preimageSha256 -cne $pre.receipt.taskXmlSha256 -or
    $journal.state -notin @('applying','committed') -or
    (Get-TaskActionHash $live[0].Actions[0]) -cne $journal.newActionSha256) { throw 'TASK_TRANSACTION_FOREIGN_ACTION_ROLLBACK_REFUSED' }
  $xml=[string](Export-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction Stop)
  if((Get-TaskInvariant $xml) -cne $pre.receipt.taskInvariantSha256 -or
    (Get-TaskSddlHash $taskName) -cne $pre.receipt.sddlSha256) { throw 'TASK_TRANSACTION_FOREIGN_DEFINITION_ROLLBACK_REFUSED' }
  $old=Get-Content -LiteralPath $pre.ownerFile -Raw -Encoding UTF8|ConvertFrom-Json
  $action=New-ScheduledTaskAction -Execute $old.pythonExe -Argument $old.arguments -WorkingDirectory $old.workspace
  Set-ScheduledTask -TaskName $taskName -TaskPath '\' -Action $action -ErrorAction Stop|Out-Null
  $after=[string](Export-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction Stop)
  $live=@(Get-TaskCandidates)
  if((Get-TaskInvariant $after) -cne $pre.receipt.taskInvariantSha256 -or
    (Get-TaskSddlHash $taskName) -cne $pre.receipt.sddlSha256) { throw 'TASK_TRANSACTION_ROLLBACK_DEFINITION_UNVERIFIED' }
  Assert-TaskOwned $live[0] $old
  Set-TransactionReceipt ([IO.File]::ReadAllBytes($pre.ownerFile))
  if((Get-TransactionFileHash $receiptFile) -cne $pre.receipt.ownershipSha256) { throw 'TASK_TRANSACTION_ROLLBACK_RECEIPT_UNVERIFIED' }
  $journal.state='rolled_back'
  [IO.File]::WriteAllText($journalFile,($journal|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
}
function Invoke-OwnedDashboardTaskRebind([string]$BackupReceipt,$Replacement) {
  $pre=Read-VerifiedTaskPreimage $BackupReceipt
  $live=@(Get-TaskCandidates)
  if($live.Count -ne 1 -or [string]$live[0].State -eq 'Running') { throw 'TASK_TRANSACTION_REQUIRES_STOPPED_TASK' }
  Assert-TaskOwned $live[0] (Get-OwnedReceipt)
  $before=[string](Export-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction Stop)
  if((Get-TaskInvariant $before) -cne $pre.receipt.taskInvariantSha256 -or
    (Get-TaskSddlHash $taskName) -cne $pre.receipt.sddlSha256 -or
    (Get-TransactionFileHash $receiptFile) -cne $pre.receipt.ownershipSha256) { throw 'TASK_TRANSACTION_BACKUP_NO_LONGER_CURRENT' }
  $old=Get-Content -LiteralPath $pre.ownerFile -Raw -Encoding UTF8|ConvertFrom-Json
  Assert-TaskOwned $live[0] $old
  $action=New-ScheduledTaskAction -Execute $Replacement.pythonExe -Argument $Replacement.arguments -WorkingDirectory $Replacement.workspace
  $journalFile=Join-Path $pre.dir 'dashboard-rebind-journal.json'
  if(Test-Path -LiteralPath $journalFile) { throw 'TASK_TRANSACTION_JOURNAL_ALREADY_EXISTS' }
  $journal=[ordered]@{schema='singularity-dashboard-action-transaction/v1';taskName=$taskName;preimageSha256=$pre.receipt.taskXmlSha256;newActionSha256=(Get-TaskActionHash $action);state='applying'}
  [IO.File]::WriteAllText($journalFile,($journal|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
  $applied=$false
  try {
    Set-ScheduledTask -TaskName $taskName -TaskPath '\' -Action $action -ErrorAction Stop|Out-Null
    $applied=$true
    $after=[string](Export-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction Stop)
    if((Get-TaskInvariant $after) -cne $pre.receipt.taskInvariantSha256 -or
      (Get-TaskSddlHash $taskName) -cne $pre.receipt.sddlSha256) { throw 'TASK_TRANSACTION_STARTUP_OR_SECURITY_CHANGED' }
    $live=@(Get-TaskCandidates)
    Assert-TaskOwned $live[0] $Replacement
    Set-TransactionReceipt ([Text.UTF8Encoding]::new($false).GetBytes(($Replacement|ConvertTo-Json -Compress)))
    Assert-TaskOwned (@(Get-TaskCandidates))[0] (Get-OwnedReceipt)
    $journal.state='committed'
    [IO.File]::WriteAllText($journalFile,($journal|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
  } catch {
    if($applied) {
      # The receipt may still be the preimage. Prove our action before restoring.
      $live=@(Get-TaskCandidates)
      if($live.Count -ne 1 -or (Get-TaskActionHash $live[0].Actions[0]) -cne $journal.newActionSha256) {
        throw 'TASK_TRANSACTION_FAILED_WITH_FOREIGN_ACTION_MANUAL_RECOVERY_REQUIRED'
      }
      $xml=[string](Export-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction Stop)
      if((Get-TaskInvariant $xml) -cne $pre.receipt.taskInvariantSha256 -or
        (Get-TaskSddlHash $taskName) -cne $pre.receipt.sddlSha256) {
        throw 'TASK_TRANSACTION_FAILED_WITH_DEFINITION_DRIFT_MANUAL_RECOVERY_REQUIRED'
      }
      $oldAction=New-ScheduledTaskAction -Execute $old.pythonExe -Argument $old.arguments -WorkingDirectory $old.workspace
      Set-ScheduledTask -TaskName $taskName -TaskPath '\' -Action $oldAction -ErrorAction Stop|Out-Null
      Assert-TaskOwned (@(Get-TaskCandidates))[0] $old
      Set-TransactionReceipt ([IO.File]::ReadAllBytes($pre.ownerFile))
      $journal.state='rolled_back'
      [IO.File]::WriteAllText($journalFile,($journal|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
    }
    throw 'TASK_TRANSACTION_REBIND_FAILED'
  }
}
