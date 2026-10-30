param([ValidateSet('Plan','Install','Start','Status','Stop','Uninstall','Reinstall')][string]$Mode='Plan')
$ErrorActionPreference='Continue'
$ConfirmPreference='None'
$R=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$W=Join-Path $R 'release'
$S=Join-Path $R 'toolchain\native-source-option2-a4\option2-stage-source'
$m=Join-Path $W 'native\windows\manage_native_windows.ps1'
$ev=Join-Path $R 'evidence\lifecycle'
New-Item -ItemType Directory -Path $ev -Force | Out-Null
$nodeCmd=Get-Command 'node.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
$node=if($nodeCmd -and $nodeCmd.Source){$nodeCmd.Source}else{(Join-Path $env:USERPROFILE 'tools\node22\node-v22.23.4-win-x64\node.exe')}
$memRuntime=Join-Path $env:USERPROFILE 'tools\singularity-native-runtime'
$p=@{Mode=$Mode;SkipOffice=$true;SourceRoot=$S;BridgeExe=(Join-Path $R 'bin\singularity-desktop-bridge.exe');SupervisorExe=(Join-Path $W 'native\windows\rust-supervisor\target\release\singularity-windows-supervisor.exe');PythonExe=(Join-Path $R 'venv\Scripts\python.exe');NodeExe=$node;MemorySourceRoot=(Join-Path $memRuntime 'source');MemoryBuildRoot=(Join-Path $memRuntime 'build');MemorySecretsSource=(Join-Path $R 'provider-state\secrets');Workspace=(Join-Path $env:LOCALAPPDATA 'Singularity\Workspace')}
if($Mode -in @('Install','Start','Stop','Uninstall','Reinstall')){ $p.Apply=$true }
$a=@($p.GetEnumerator()|ForEach-Object{'-'+$_.Key; [string]$_.Value})
$utc=(Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
try { $raw=& $m @p 2>&1; $code=0 } catch { $raw=@($_.Exception.Message); $code=1 }
$text=($raw|ForEach-Object{[string]$_}) -join "`n"
$obj=$null
$idx=$text.LastIndexOf('{')
if($idx -ge 0){try{$obj=$text.Substring($idx)|ConvertFrom-Json -ErrorAction Stop}catch{}}
$receipt=[ordered]@{schema='singularity-native-a4-lifecycle-step/v1';mode=$Mode;atUtc=(Get-Date).ToUniversalTime().ToString('o');exitCode=$code;manager=$m;sourceRoot=$S;args=$a;parsed=$obj;raw=$text}
$path=Join-Path $ev ("a4-{0}-{1}.json" -f $Mode.ToLower(),$utc)
$receipt|ConvertTo-Json -Depth 8|Set-Content -LiteralPath $path -Encoding UTF8
"RECEIPT=$path"
if($obj){$obj|ConvertTo-Json -Depth 6 -Compress}else{"EXIT=$code";$text|Select-Object -Last 8}
exit $code
