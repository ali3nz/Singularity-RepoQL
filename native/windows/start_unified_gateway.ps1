#Requires -Version 5.1
<#
Scheduled-task entrypoint. File paths and local service identifiers only are
stored in an ACL-protected JSON config. No credential bytes appear in the task
arguments, output, or script environment export.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$Config,
    [ValidateSet('Check','Run')][string]$Mode='Run'
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'WINDOWS_ONLY' }
if (-not [IO.Path]::IsPathRooted($Config) -or $Config.StartsWith('\\')) { throw 'CONFIG_LOCAL_ABSOLUTE_REQUIRED' }
$payload=Get-Content -LiteralPath $Config -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
$expected=@('binary','repoqlBase','repoqlTokenFile','tencentBase','tencentServiceId','tencentUserKeyFile','wikiIds','hubDocUriPrefix','gatewayTokenFile','usageDir','port')
$actual=@($payload.PSObject.Properties.Name | Sort-Object)
if ((@($expected | Sort-Object) -join '|') -cne ($actual -join '|')) { throw 'GATEWAY_CONFIG_SCHEMA_INVALID' }
$base=[uri]$payload.repoqlBase
if ($base.Scheme -ne 'http' -or $base.Host -ne '127.0.0.1' -or $base.Port -lt 1024 -or $base.AbsolutePath -ne '/' -or $base.Query -or $base.Fragment) { throw 'REPOQL_REMOTE_ORIGIN_REFUSED' }
if ($payload.tencentBase) {
    $tx=[uri]$payload.tencentBase
    if ($tx.Scheme -ne 'http' -or $tx.Host -ne '127.0.0.1' -or $tx.Port -lt 1024 -or $tx.AbsolutePath -ne '/' -or $tx.Query -or $tx.Fragment) { throw 'TENCENT_REMOTE_ORIGIN_REFUSED' }
}
if ($payload.hubDocUriPrefix -and ([string]$payload.hubDocUriPrefix -cnotmatch '^github://[^\s?#]+/$' -or ([string]$payload.hubDocUriPrefix).Length -gt 512)) { throw 'EXPLICIT_HUB_IMPORT_PREFIX_INVALID' }
if ([IO.Path]::GetFileName([string]$payload.binary) -cne 'unified-repoql-control.exe') { throw 'GATEWAY_BINARY_INVALID' }
foreach ($key in @('binary','repoqlTokenFile','gatewayTokenFile')) {
    if (-not [IO.Path]::IsPathRooted([string]$payload.$key) -or [string]$payload.$key -like '\\*') { throw 'LOCAL_ABSOLUTE_PATH_REQUIRED' }
    if (-not (Test-Path -LiteralPath ([string]$payload.$key) -PathType Leaf)) { throw 'GATEWAY_DEPENDENCY_MISSING' }
}
if ($payload.tencentBase -and -not (Test-Path -LiteralPath ([string]$payload.tencentUserKeyFile) -PathType Leaf)) { throw 'TENCENT_KEY_FILE_MISSING' }
if ([int]$payload.port -ne 18101) { throw 'GATEWAY_EXPECTED_PORT_18101' }
$env:UNIFIED_PORT=[string]$payload.port
$env:UNIFIED_REPOQL_BASE=[string]$payload.repoqlBase
$env:UNIFIED_REPOQL_TOKEN_FILE=[string]$payload.repoqlTokenFile
$env:UNIFIED_TENCENT_BASE=[string]$payload.tencentBase
$env:UNIFIED_TENCENT_SERVICE_ID=[string]$payload.tencentServiceId
$env:UNIFIED_TENCENT_USER_KEY_FILE=[string]$payload.tencentUserKeyFile
$env:UNIFIED_TENCENT_WIKI_IDS=(@($payload.wikiIds) -join ',')
$env:UNIFIED_HUB_DOC_URI_PREFIX=[string]$payload.hubDocUriPrefix
$env:UNIFIED_GATEWAY_TOKEN_FILE=[string]$payload.gatewayTokenFile
$env:UNIFIED_USAGE_DIR=[string]$payload.usageDir
$env:UNIFIED_TENCENT_WRITES='false'
if ($Mode -eq 'Check') { & $payload.binary --check; exit $LASTEXITCODE }
& $payload.binary
exit $LASTEXITCODE
