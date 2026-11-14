#Requires -Version 5.1
<# Rebuild the native installer from a fresh source archive and reviewed runtime payload.
   PayloadRoot is an extracted release payload, never a live user data directory. #>
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$PayloadRoot,
  [Parameter(Mandatory=$true)][string]$BuildRoot,
  [Parameter(Mandatory=$true)][string]$OutputPath
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$payload=[IO.Path]::GetFullPath($PayloadRoot)
$build=[IO.Path]::GetFullPath($BuildRoot)
$output=[IO.Path]::GetFullPath($OutputPath)
if (Test-Path -LiteralPath $build) { throw 'SETUP_BUILD_ROOT_MUST_BE_NEW' }
if (Test-Path -LiteralPath $output) { throw 'SETUP_OUTPUT_ALREADY_EXISTS' }
if ($build.StartsWith($repo+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'SETUP_BUILD_INSIDE_SOURCE_REFUSED' }
$runtime=Join-Path $env:LOCALAPPDATA 'Singularity\Runtime'
$python=Join-Path $runtime 'python\python.exe'
$node=Join-Path $runtime 'node\node.exe'
# The reviewed profile excludes the manager required by Complete-Setup.ps1.
# Do not publish an executable that would fail midway through setup.
$sourcePolicy=Join-Path $repo 'native\windows\windows_source_policy.py'
& $python -B -c "import runpy,sys; p=runpy.run_path(sys.argv[1]); sys.exit(1 if p['windows_variant_excludes']('native/windows/manage_native_windows.ps1',2) else 0)" $sourcePolicy
if ($LASTEXITCODE -ne 0) { throw 'LEGACY_GUI_SETUP_UNAVAILABLE_USE_PHASED_CLAUDE_COMPLETE_INSTALLER' }
$null=New-Item -ItemType Directory -Path $build
$stage=Join-Path $build 'payload'
$null=New-Item -ItemType Directory -Path $stage

function Copy-PublicTree([string]$Source,[string]$Destination) {
  if (-not (Test-Path -LiteralPath $Source -PathType Container)) { throw 'SETUP_PUBLIC_INPUT_MISSING' }
  $items=@(Get-ChildItem -LiteralPath $Source -Recurse -Force)
  if ((Get-Item -LiteralPath $Source -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'SETUP_REPARSE_INPUT' }
  foreach ($item in $items) {
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'SETUP_REPARSE_INPUT' }
    $relative=$item.FullName.Substring($Source.TrimEnd('\').Length+1)
    if ($relative -match '^(state|secrets|logs)(\\|$)|(^|\\)(\.git|\.env)(\\|$)|\.(log|sqlite|sqlite3|db)$') { throw 'SETUP_PRIVATE_INPUT_REFUSED' }
  }
  $null=New-Item -ItemType Directory -Path $Destination
  $null=robocopy $Source $Destination /E /NFL /NDL /NJH /NJS /NP /R:0 /W:0
  if ($LASTEXITCODE -ge 8) { throw 'SETUP_INPUT_COPY_FAILED' }
}

# Existing source packaging owns classification, variant policy, manifest and scan.
$env:PATH=(Split-Path -Parent $node)+';'+$env:PATH
& $python -B -c "import sys,runpy;sys.path.insert(0,sys.argv[1]);sys.argv=sys.argv[2:];runpy.run_path(sys.argv[0],run_name='__main__')" (Join-Path $repo 'native\windows') (Join-Path $repo 'native\windows\build_source_variants.py') --variant 2 --output-dir $build
if ($LASTEXITCODE -ne 0) { throw 'SETUP_SOURCE_BUILD_FAILED' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::ExtractToDirectory((Join-Path $build 'singularity-native-windows-option2-SOURCE-ONLY.zip'),(Join-Path $stage 'source'))
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Complete-Setup.ps1') -Destination $stage
Copy-PublicTree (Join-Path $payload 'bin') (Join-Path $stage 'bin')
Copy-PublicTree (Join-Path $payload 'runtime') (Join-Path $stage 'runtime')

# The pinned OpenMausBot package is verified byte-for-byte by its lifecycle helper.
& powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $repo 'native\windows\manage_openmausbot.ps1') -Mode Plan
if ($LASTEXITCODE -ne 0) { throw 'SETUP_OPENMAUSBOT_UNVERIFIED' }
Copy-PublicTree (Join-Path $runtime 'openmausbot') (Join-Path $stage 'runtime\openmausbot')
Copy-Item -LiteralPath (Join-Path $runtime 'openmausbot-0.1.149.tgz') -Destination (Join-Path $stage 'runtime')

$zip=Join-Path $build 'Payload.zip'
[IO.Compression.ZipFile]::CreateFromDirectory($stage,$zip,[IO.Compression.CompressionLevel]::Optimal,$false)
$compiler=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw 'SETUP_CSHARP_COMPILER_MISSING' }
$null=New-Item -ItemType Directory -Force -Path (Split-Path -Parent $output)
& $compiler /nologo /target:winexe ('/out:'+$output) ('/resource:'+$zip+',Payload.zip') /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.IO.Compression.dll /reference:System.IO.Compression.FileSystem.dll (Join-Path $PSScriptRoot 'Setup.cs')
if ($LASTEXITCODE -ne 0) { throw 'SETUP_COMPILATION_FAILED' }
[ordered]@{file=$output;sha256=(Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash;bytes=(Get-Item -LiteralPath $output).Length;payloadSha256=(Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash} | ConvertTo-Json -Compress
