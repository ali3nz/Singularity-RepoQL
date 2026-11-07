#Requires -Version 5.1
<#
Start the installed Fleet861 release candidate: local backends first, then the
dashboard. Zero manual steps beyond installing the candidate and, for the
third-party Office/Ghost surfaces, the owner's own login.

  * RepoQL host on an RC-owned workspace (RC-owned marker + import of this
    candidate's source, loopback only);
  * MemoryCore + MemoryPanel from the machine's vendor build dirs, configured
    into the RC root and started on RC ports;
  * a real Kanzo board staged into the RC root and started with an RC-owned
    `--home` and RC port (never the production board or 4242);
  * the locally installed Claude Office distribution started from RC-owned
    service config, state, logs and port (never the production port).

Nothing here binds a production port (18100/18101/18126/18128), touches the
production tree, or imports a production credential.
#>
[CmdletBinding()]
param(
    [string]$Root = '',
    [switch]$NoDashboard
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $Root) { $Root = Split-Path -Parent $PSCommandPath }
$source = Join-Path $Root 'source'
$runner = Join-Path $source 'native\windows\rc_services.py'
if (-not (Test-Path -LiteralPath $runner -PathType Leaf)) { throw ('RC_SOURCE_MISSING: ' + $runner) }

function Get-Python {
    $candidates = @()
    if ($env:SINGULARITY_RC_PYTHON) { $candidates += $env:SINGULARITY_RC_PYTHON }
    $candidates += (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312\python.exe')
    $candidates += (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python313\python.exe')
    $candidates += (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python311\python.exe')
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { return $candidate }
    }
    $launcher = Get-Command py.exe -ErrorAction SilentlyContinue
    if ($launcher) { return $launcher.Source }
    throw 'PYTHON_REQUIRED: install Python 3.11+ or set SINGULARITY_RC_PYTHON'
}

$python = Get-Python
$env:SINGULARITY_RC_ROOT = $Root
# Keep the installed tree free of bytecode directories: the MSI cannot own
# runtime __pycache__, so do not create it in the first place.
$env:PYTHONDONTWRITEBYTECODE = '1'

if ($NoDashboard) {
    & $python $runner start
    exit $LASTEXITCODE
}
Write-Host ('Starting Fleet861 RC services from ' + $Root) -ForegroundColor Cyan
& $python $runner launch
exit $LASTEXITCODE
