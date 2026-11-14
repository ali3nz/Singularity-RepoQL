#requires -Version 7
[CmdletBinding()]
param([ValidateSet('Inspect','Apply','Rollback','Build','Verify')][string]$Mode='Inspect',
 [string]$Binary,[string]$Policy,[string]$ExpectedSettingsSha256,[string]$ExpectedBinarySha256,[string]$ExpectedPolicySha256,[string]$RestoreSettings)
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
$Root=Join-Path $env:LOCALAPPDATA 'Singularity/CapabilityGate-fleet1307'
$Settings=Join-Path $env:USERPROFILE '.claude/settings.json'
$Receipt=Join-Path $Root 'INSTALLATION.json'
function Hash([string]$P){(Get-FileHash -LiteralPath $P -Algorithm SHA256).Hash.ToLowerInvariant()}
function Safe([string]$P){
 $item=Get-Item -LiteralPath $P -Force
 while($null -ne $item){if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'REPARSE_POINT_REFUSED'};$item=if($item -is [IO.DirectoryInfo]){$item.Parent}else{$item.Directory}}
}
function NoAffectedSessions {
 $active=@(Get-Process -Name claude -ErrorAction SilentlyContinue | Where-Object {-not $_.Path -or $_.Path -notmatch '\\WindowsApps\\Claude_[^\\]+\\app\\claude\.exe$'})
 $node=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {$_.CommandLine -match '(?i)(@anthropic[\\/]claude-code|claude-code[\\/]cli|[\\/]claude[\\/]cli)'})
 if($active.Count -or $node.Count){throw 'ACTIVE_CLAUDE_CODE_SESSION_REFUSED'}
}
function Private([string]$P){
 $acl=[Security.AccessControl.DirectorySecurity]::new();$acl.SetAccessRuleProtection($true,$false)
 $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$acl.SetOwner($sid)
 foreach($s in @($sid,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'))){$rule=[Security.AccessControl.FileSystemAccessRule]::new($s,'FullControl','ContainerInherit,ObjectInherit','None','Allow');$acl.AddAccessRule($rule)}
 Set-Acl -LiteralPath $P -AclObject $acl
}
function Json($v){ConvertTo-Json -InputObject $v -Depth 100 -Compress}
function ReplaceSettings([byte[]]$Bytes,[string]$Expected){
 NoAffectedSessions;Safe $Settings
 if((Hash $Settings) -cne $Expected){throw 'SETTINGS_PREIMAGE_CHANGED'}
 $acl=Get-Acl -LiteralPath $Settings;$sddl=[string]$acl.Sddl
 $tmp=Join-Path (Split-Path $Settings) ('settings.capability.'+[guid]::NewGuid().ToString('N')+'.tmp')
 try {
  $stream=[IO.File]::Open($tmp,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try{$stream.Write($Bytes,0,$Bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
  Set-Acl -LiteralPath $tmp -AclObject $acl
  if((Hash $Settings) -cne $Expected){throw 'SETTINGS_PREIMAGE_CHANGED'}
  [IO.File]::Replace($tmp,$Settings,[System.Management.Automation.Language.NullString]::Value)
  if([string](Get-Acl -LiteralPath $Settings).Sddl -cne $sddl){throw 'SETTINGS_ACL_CHANGED'}
 }finally{if(Test-Path -LiteralPath $tmp){Remove-Item -LiteralPath $tmp}}
}
if($Mode -eq 'Verify'){
 Safe $Binary
 if((Hash $Binary) -cne $ExpectedBinarySha256){throw 'FIXTURE_BINARY_DIGEST_MISMATCH'}
 $Fixture=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../../gate1307-protocol-fixture-console'))
 if(Test-Path -LiteralPath $Fixture){throw 'FIXTURE_ALREADY_EXISTS'}
 $null=New-Item -ItemType Directory -Path $Fixture;Private $Fixture
 $null=New-Item -ItemType Directory -Path (Join-Path $Fixture 'state')
 $Transcript=Join-Path $Fixture 'transcript.jsonl';[IO.File]::WriteAllText($Transcript,'')
 function InvokeGate([string]$Kind,$Payload){$raw=(Json $Payload)|& $Binary $Kind --root $Fixture;if($LASTEXITCODE -ne 0){throw 'NATIVE_HOOK_EXIT_FAILED'};($raw -join "`n")|ConvertFrom-Json -AsHashtable}
 $inputPayload=@{session_id='fixture-fleet1307';transcript_path=$Transcript;prompt='Do you have access to my Google Drive?'}
 $out=InvokeGate 'prompt' $inputPayload
 if($out.hookSpecificOutput.hookEventName -cne 'UserPromptSubmit' -or $out.systemMessage -notmatch 'armed'){throw 'PROMPT_PROTOCOL_FAILED'}
 $stop=@{session_id='fixture-fleet1307';transcript_path=$Transcript;last_assistant_message='Yes';stop_hook_active=$false}
 $out=InvokeGate 'stop' $stop;if($out.decision -cne 'block'){throw 'UNSUPPORTED_ANSWER_NOT_BLOCKED'}
 $stop.stop_hook_active=$true;$out=InvokeGate 'stop' $stop;if($out['continue'] -ne $false -or $out.Contains('decision')){throw 'RETRY_NOT_BOUNDED'}
 $calls=@{type='assistant';message=@{content=@(@{type='tool_use';id='doc1';name='Read';input=@{file_path='C:/policy/access-surfaces.md'}},@{type='tool_use';id='doc2';name='Read';input=@{file_path='C:/policy/skills/google-drive.md'}})}}
 $results=@{type='user';message=@{content=@(@{type='tool_result';tool_use_id='doc1';content='Verified fixture: fleet access index documentation with named owning surfaces.'},@{type='tool_result';tool_use_id='doc2';content='Verified fixture: owning skill documentation with bounded identity and permission scope.'})}}
 [IO.File]::WriteAllText($Transcript,((Json $calls)+"`n"+(Json $results)+"`n"))
 $stop.last_assistant_message='Documented in Hub documentation: as Ben, read access has scope limited to fleet folders; not live-verified.'
 $out=InvokeGate 'stop' $stop;if($out.Count -ne 0){throw 'EVIDENCED_ANSWER_REJECTED'}
 $inputPayload.prompt='Summarize these logs';$out=InvokeGate 'prompt' $inputPayload;if($out.Count -ne 0){throw 'ORDINARY_REQUEST_ROUTED'}
 $stop.last_assistant_message='Summary';$out=InvokeGate 'stop' $stop;if($out.Count -ne 0){throw 'UNKNOWN_STATE_BLOCKED'}
 [pscustomobject]@{schema='singularity-capability-protocol-fixture/v1';promptInjection=$true;missingEvidenceBlocked=$true;retryBounded=$true;successfulDocReceiptsAccepted=$true;ordinaryAndUnknownSessionAllowed=$true;modelRequests=0;binarySha256=$ExpectedBinarySha256}|ConvertTo-Json
 exit 0
}
if($Mode -eq 'Build'){
 $env:PATH=(Join-Path $env:USERPROFILE '.cargo/bin')+';'+$env:PATH
 Push-Location (Join-Path $PSScriptRoot 'rust-supervisor')
 try {
  & cargo test --locked --offline --bin singularity-capability-gate *> (Join-Path $PSScriptRoot 'gate1307-test.log')
  if($LASTEXITCODE -ne 0){throw 'CAPABILITY_FOCUSED_TESTS_FAILED'}
  & cargo build --locked --offline --release --bin singularity-capability-gate *> (Join-Path $PSScriptRoot 'gate1307-build.log')
  if($LASTEXITCODE -ne 0){throw 'CAPABILITY_BUILD_FAILED'}
  [pscustomobject]@{schema='singularity-capability-build/v1';tests=6;binarySha256=(Hash 'target/release/singularity-capability-gate.exe')}|ConvertTo-Json
 }finally{Pop-Location}
 exit 0
}
Safe $Settings
$BeforeHash=Hash $Settings
if($Mode -eq 'Inspect'){
 NoAffectedSessions
 $s=Get-Content -LiteralPath $Settings -Raw|ConvertFrom-Json -AsHashtable
 [pscustomobject]@{schema='singularity-capability-inspect/v1';settingsSha256=$BeforeHash;settingsSddl=(Get-Acl -LiteralPath $Settings).Sddl;affectedClaudeSessions=0;desktopUnaffected=$true;root=$Root;settingsPath=$Settings;promptHookGroups=@($s.hooks.UserPromptSubmit).Count;stopHookGroups=@($s.hooks.Stop).Count}|ConvertTo-Json -Depth 10
 exit 0
}
NoAffectedSessions
if($BeforeHash -cne $ExpectedSettingsSha256){throw 'SETTINGS_PREIMAGE_CHANGED'}
if($Mode -eq 'Rollback'){
 Safe $Receipt;Safe $RestoreSettings
 $rec=Get-Content -LiteralPath $Receipt -Raw|ConvertFrom-Json -AsHashtable
 if($rec.schema -cne 'singularity-capability-install/v1' -or $BeforeHash -cne $rec.afterSha256 -or (Hash $RestoreSettings) -cne $rec.beforeSha256){throw 'ROLLBACK_OWNERSHIP_OR_PREIMAGE_MISMATCH'}
 ReplaceSettings ([IO.File]::ReadAllBytes($RestoreSettings)) $BeforeHash
 if((Hash $Settings) -cne $rec.beforeSha256){throw 'ROLLBACK_READBACK_FAILED'}
 [pscustomobject]@{schema='singularity-capability-rollback/v1';restored=$true;settingsSha256=(Hash $Settings)}|ConvertTo-Json
 exit 0
}
if(Test-Path -LiteralPath $Root){throw 'CAPABILITY_DESTINATION_EXISTS'}
Safe $Binary;Safe $Policy
if((Hash $Binary) -cne $ExpectedBinarySha256 -or (Hash $Policy) -cne $ExpectedPolicySha256){throw 'INSTALL_INPUT_DIGEST_MISMATCH'}
$before=Get-Content -LiteralPath $Settings -Raw|ConvertFrom-Json -AsHashtable
$beforeCanonical=Json $before
$null=New-Item -ItemType Directory -Path $Root;Private $Root
foreach($d in @('state','policy')){$null=New-Item -ItemType Directory -Path (Join-Path $Root $d)}
$Exe=Join-Path $Root 'singularity-capability-gate.exe';Copy-Item -LiteralPath $Binary -Destination $Exe
Copy-Item -LiteralPath $Policy -Destination (Join-Path $Root 'policy/access-surfaces.md')
if((Hash $Exe) -cne $ExpectedBinarySha256){throw 'INSTALLED_BINARY_DIGEST_MISMATCH'}
$cmdExe=$Exe.Replace('\','/');$cmdRoot=$Root.Replace('\','/')
if($cmdExe -match '["`$%\r\n;&|<>]' -or $cmdRoot -match '["`$%\r\n;&|<>]'){throw 'UNSAFE_COMMAND_PATH'}
$events=@{UserPromptSubmit='prompt';Stop='stop'};$owned=@{}
if(-not $before.Contains('hooks')){$before['hooks']=[ordered]@{}}
if($before.hooks -isnot [System.Collections.IDictionary]){throw 'INVALID_EXISTING_HOOKS'}
foreach($event in $events.Keys){
 $groups=@();if($before.hooks.Contains($event)){$groups=@($before.hooks[$event])}
 foreach($group in $groups){if($null -eq $group -or -not $group.Contains('hooks')){throw 'INVALID_EXISTING_HOOK_GROUP'}}
 $command='"'+$cmdExe+'" '+$events[$event]+' --root "'+$cmdRoot+'"'
 $entry=[ordered]@{hooks=@([ordered]@{type='command';command=$command;timeout=10})}
 $owned[$event]=$entry
 $before.hooks[$event]=@($groups)+@($entry)
}
# Prove the candidate differs only by the two appended groups.
$candidate=Json $before;$proof=$candidate|ConvertFrom-Json -AsHashtable
foreach($event in $events.Keys){$all=@($proof.hooks[$event]);$last=$all[-1];if((Json $last) -cne (Json $owned[$event])){throw 'APPENDED_HOOK_MISMATCH'};$proof.hooks[$event]=@($all|Select-Object -SkipLast 1)}
if((Json $proof) -cne $beforeCanonical){throw 'FOREIGN_SETTINGS_CHANGED'}
$bytes=[Text.UTF8Encoding]::new($false).GetBytes($candidate+"`n")
$afterSha=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
$rec=[ordered]@{schema='singularity-capability-install/v1';task='fleet#1307';beforeSha256=$BeforeHash;afterSha256=$afterSha;binarySha256=$ExpectedBinarySha256;policySha256=$ExpectedPolicySha256;settingsSddl=(Get-Acl -LiteralPath $Settings).Sddl;onlyAppendedHooks=$true;activeSessionsModified=$false;alreadyStreamedAnswersRetracted=$false;createdUtc=[DateTime]::UtcNow.ToString('o')}
# Durable ownership record precedes the settings swap for recoverability.
[IO.File]::WriteAllText($Receipt,(Json $rec),[Text.UTF8Encoding]::new($false))
ReplaceSettings $bytes $BeforeHash
if((Hash $Settings) -cne $afterSha){throw 'SETTINGS_READBACK_FAILED'}
$actual=Get-Content -LiteralPath $Settings -Raw|ConvertFrom-Json -AsHashtable
foreach($event in $events.Keys){$all=@($actual.hooks[$event]);if((Json $all[-1]) -cne (Json $owned[$event])){throw 'HOOK_READBACK_FAILED'};$actual.hooks[$event]=@($all|Select-Object -SkipLast 1)}
if((Json $actual) -cne $beforeCanonical){throw 'FOREIGN_SETTINGS_READBACK_CHANGED'}
$rec|ConvertTo-Json -Depth 10
