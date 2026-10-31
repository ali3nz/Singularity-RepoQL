<#
.SYNOPSIS
  Create, check or remove the "Singularity Dashboard" desktop shortcut.
.DESCRIPTION
  Writes a per-user .lnk on the current user's Desktop with the Singularity icon. Opening it runs
  open_dashboard.ps1, which opens the loopback dashboard with its private capability key (the
  key is read locally and never printed). The icon and launcher live in a folder owned by this
  script. Never overwrites a shortcut it did not create; Remove only deletes what it owns.
  Needs no administrator rights and touches only the current user's profile.
#>
[CmdletBinding()]
param(
  [ValidateSet('Create','Status','Remove')][string]$Mode='Create',
  [ValidateRange(1024,65535)][int]$DashboardPort=18100,
  [string]$DesktopPath='',
  [string]$AssetRoot='',
  [string]$StateDir=''
)
$ErrorActionPreference='Stop'
$marker='managed-by=singularity-dashboard-shortcut'
$name='Singularity Dashboard.lnk'
if (-not $DesktopPath) { $DesktopPath=[Environment]::GetFolderPath('Desktop') }
if (-not $AssetRoot) { $AssetRoot=Join-Path $env:LOCALAPPDATA 'Singularity\DashboardShortcut' }
if (-not $StateDir) { $StateDir=Join-Path $env:LOCALAPPDATA 'Singularity\Dashboard' }
if (-not $DesktopPath -or -not (Test-Path -LiteralPath $DesktopPath -PathType Container)) { throw 'SHORTCUT_DESKTOP_NOT_FOUND' }
$shortcut=Join-Path $DesktopPath $name
$iconDest=Join-Path $AssetRoot 'singularity-dashboard.ico'
$launcherDest=Join-Path $AssetRoot 'open_dashboard.ps1'
$iconSrc=Join-Path $PSScriptRoot 'assets\singularity-dashboard.ico'
$launcherSrc=Join-Path $PSScriptRoot 'open_dashboard.ps1'
$url="http://127.0.0.1:$DashboardPort/"
function Get-LinkInfo([string]$Path) {
  $sh=New-Object -ComObject WScript.Shell
  try { $l=$sh.CreateShortcut($Path); return @{Description=$l.Description;Arguments=$l.Arguments} }
  finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($sh) }
}
function Test-Owned([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
  try { return ((Get-LinkInfo $Path).Description -eq $marker) } catch { return $false }
}
function Emit($o) { $o | ConvertTo-Json -Compress }
switch ($Mode) {
  'Status' {
    $port=$null
    if (Test-Owned $shortcut) { $m=[regex]::Match((Get-LinkInfo $shortcut).Arguments,'-DashboardPort (\d+)'); if ($m.Success) { $port=[int]$m.Groups[1].Value } }
    Emit @{mode='Status';exists=(Test-Path -LiteralPath $shortcut);owned=(Test-Owned $shortcut);path=$shortcut;url=$(if($port){"http://127.0.0.1:$port/"}else{$null});iconPresent=(Test-Path -LiteralPath $iconDest);launcherPresent=(Test-Path -LiteralPath $launcherDest)}
  }
  'Create' {
    if ((Test-Path -LiteralPath $shortcut) -and -not (Test-Owned $shortcut)) { throw 'SHORTCUT_FOREIGN_FILE_REFUSED' }
    foreach ($s in @($iconSrc,$launcherSrc)) { if (-not (Test-Path -LiteralPath $s -PathType Leaf)) { throw 'SHORTCUT_SOURCE_MISSING' } }
    New-Item -ItemType Directory -Force -Path $AssetRoot | Out-Null
    Copy-Item -LiteralPath $iconSrc -Destination $iconDest -Force
    Copy-Item -LiteralPath $launcherSrc -Destination $launcherDest -Force
    $sh=New-Object -ComObject WScript.Shell
    try {
      $l=$sh.CreateShortcut($shortcut)
      $l.TargetPath=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
      $l.Arguments='-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "'+$launcherDest+'" -DashboardPort '+$DashboardPort+' -StateDir "'+$StateDir+'"'
      $l.IconLocation=$iconDest+',0'
      $l.Description=$marker
      $l.WorkingDirectory=$AssetRoot
      $l.Save()
    } finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($sh) }
    Emit @{mode='Create';created=$true;path=$shortcut;url=$url;icon=$iconDest}
  }
  'Remove' {
    $removed=$false
    if (Test-Owned $shortcut) { Remove-Item -LiteralPath $shortcut -Force; $removed=$true }
    elseif (Test-Path -LiteralPath $shortcut) { throw 'SHORTCUT_FOREIGN_FILE_REFUSED' }
    if ($removed) { foreach ($f in @($iconDest,$launcherDest)) { if (Test-Path -LiteralPath $f) { Remove-Item -LiteralPath $f -Force } } }
    Emit @{mode='Remove';removed=$removed;path=$shortcut}
  }
}
