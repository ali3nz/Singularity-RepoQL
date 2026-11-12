#Requires -RunAsAdministrator
<# Make the headless Singularity tasks start at boot (S4U, no password, no desktop needed). The RepoQL host is NOT included: it must stay an interactive logon task. Run after register-supervisor-service.ps1. #>
[CmdletBinding()] param([string]$User = "$env:USERDOMAIN\$env:USERNAME")
$ErrorActionPreference = "Stop"
$names = 'Singularity-ClaudeComplete-Dashboard','Singularity-Cloudflare-Dashboard-Adapter','Singularity-Memory-Knowledge','Singularity-OMB-Office-Bridge','Singularity-Windows-Unified-Gateway'

foreach ($n in $names) {
  $t = Get-ScheduledTask $n
  $boot = New-ScheduledTaskTrigger -AtStartup; $boot.Delay = 'PT45S'
  $keep = @($t.Triggers | ? { $_.CimClass.CimClassName -match 'Logon' })
  $princ = New-ScheduledTaskPrincipal -UserId $User -LogonType S4U -RunLevel Limited
  $set = $t.Settings; $set.DisallowStartIfOnBatteries=$false; $set.StopIfGoingOnBatteries=$false; $set.ExecutionTimeLimit='PT0S'; $set.RestartCount=3; $set.RestartInterval='PT1M'
  Set-ScheduledTask -TaskName $n -Trigger (@($boot)+$keep) -Principal $princ -Settings $set | Out-Null
  "updated $n"
}
