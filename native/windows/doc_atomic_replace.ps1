$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$currentOwner = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
function Hash-File([string]$Path) {
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}
function Check-Path([string]$Root, [string]$Path) {
  $at = [IO.Path]::GetFullPath($Path)
  $prefix = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
  if (-not $at.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'DOC_PATH_OUTSIDE_ROOT' }
  while ($at -and $at -ne [IO.Path]::GetPathRoot($at)) {
    if (Test-Path -LiteralPath $at) {
      if (((Get-Item -LiteralPath $at -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'DOC_REPARSE_PATH_REFUSED'
      }
      if ($at.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        $owner = (Get-Acl -LiteralPath $at).GetOwner([Security.Principal.SecurityIdentifier]).Value
        if ($owner -ne $currentOwner -and $owner -ne $script:rootOwner) { throw 'DOC_FOREIGN_OWNER_REFUSED' }
      }
    }
    $at = [IO.Path]::GetDirectoryName($at)
  }
}
try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $root = [IO.Path]::GetFullPath([string]$request.root)
  $script:rootOwner = (Get-Acl -LiteralPath $root).GetOwner([Security.Principal.SecurityIdentifier]).Value
  if ($script:rootOwner -ne $currentOwner -and $script:rootOwner -ne 'S-1-5-32-544') { throw 'DOC_ROOT_OWNER_REFUSED' }
  $rel = [string]$request.path
  if ($rel -notmatch '^docs/[^\\]+\.md$' -or $rel -match '[<>:"|?*\x00-\x1f]' -or
      $rel -match '(?:^|/)\.\.?(/|$)' -or
      $rel -match '(?i)(?:^|/)(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|/|$)' -or
      $rel -match '[. ](?:/|$)' -or
      $rel -match '(?i)(?:AGENTS|SECURITY|CLAUDE|RULES|singularity-workflow|DOC-INGESTION|WINDOWS-RELEASE-ACCEPTANCE|WINDOWS-AGENT-MEMORY-POLICY|memory-capture-promotion)\.md$' -or
      $rel -match '(?i)^docs/(security|governance|policies)(/|$)' -or
      [string]$request.id -notmatch '^doc-[0-9a-f]{24}$') { throw 'DOC_PATH_REFUSED' }
  $target = [IO.Path]::GetFullPath((Join-Path $root $rel))
  $backup = Join-Path $root ('data/agent-backups/doc-program/' + $request.id + '/' + $rel)
  $temp = $target + '.singularity-' + $request.id + '.tmp'
  $manifest = $backup + '.manifest.json'
  Check-Path $root $target
  Check-Path $root $backup
  Check-Path $root $temp
  Check-Path $root $manifest
  if ($request.mode -eq 'verify') {
    if (-not (Test-Path -LiteralPath $manifest)) { throw 'DOC_BACKUP_MANIFEST_MISSING' }
    $record = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
    if ($record.id -ne $request.id -or $record.path -ne $rel -or
        $record.beforeHash -ne $request.beforeHash -or $record.afterHash -ne $request.afterHash -or
        (Hash-File $target) -ne $request.afterHash) { throw 'DOC_RECOVERY_BINDING_MISMATCH' }
    if ($record.beforeHash) {
      if ((Hash-File $backup) -ne $record.beforeHash -or
          (Get-Acl -LiteralPath $backup).Sddl -ne $record.originalAcl -or
          (Get-Acl -LiteralPath $target).Sddl -ne $record.originalAcl -or
          [int](Get-Item -LiteralPath $backup).Attributes -ne $record.originalAttributes -or
          (Get-Item -LiteralPath $backup).CreationTimeUtc.ToString('O') -ne $record.originalCreationTimeUtc -or
          (Get-Item -LiteralPath $target).CreationTimeUtc.ToString('O') -ne $record.originalCreationTimeUtc) {
        throw 'DOC_RECOVERY_METADATA_NOT_VERIFIED'
      }
    }
    @{status='WRITTEN'; recovered=$true; backup=$backup; metadataVerified=$true} | ConvertTo-Json -Compress
    exit 0
  }
  $present = Test-Path -LiteralPath $target
  $beforeAcl = $null
  $beforeInfo = $null
  if ($present) {
    if (-not $request.beforeHash -or (Hash-File $target) -ne $request.beforeHash) { throw 'DOC_BEFORE_HASH_CONFLICT' }
    $beforeInfo = Get-Item -LiteralPath $target -Force
    if (($beforeInfo.Attributes -band [IO.FileAttributes]::ReadOnly) -ne 0) { throw 'DOC_TARGET_READ_ONLY' }
    $beforeAcl = (Get-Acl -LiteralPath $target).Sddl
  } elseif ($null -ne $request.beforeHash) { throw 'DOC_BEFORE_HASH_CONFLICT' }
  [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)) | Out-Null
  [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($backup)) | Out-Null
  if (Test-Path -LiteralPath $backup) { throw 'DOC_BACKUP_ALREADY_EXISTS' }
  if (-not (Test-Path -LiteralPath $manifest)) {
    $record = @{id=$request.id;path=$rel;beforeHash=$request.beforeHash;afterHash=$request.afterHash;
      originalAcl=$beforeAcl;originalAttributes=$(if($beforeInfo){[int]$beforeInfo.Attributes}else{$null});
      originalCreationTimeUtc=$(if($beforeInfo){$beforeInfo.CreationTimeUtc.ToString('O')}else{$null})}
    $recordBytes = [Text.UTF8Encoding]::new($false).GetBytes(($record | ConvertTo-Json -Compress))
    $recordStream = [IO.File]::Open($manifest,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try {$recordStream.Write($recordBytes,0,$recordBytes.Length);$recordStream.Flush($true)} finally {$recordStream.Dispose()}
  } else {
    $record = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
    if ($record.id -ne $request.id -or $record.path -ne $rel -or
        $record.beforeHash -ne $request.beforeHash -or $record.afterHash -ne $request.afterHash -or
        $record.originalAcl -ne $beforeAcl) { throw 'DOC_BACKUP_MANIFEST_CONFLICT' }
  }
  if (-not (Test-Path -LiteralPath $temp)) {
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes([string]$request.after)
    $stream = [IO.File]::Open($temp, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
  }
  if ((Hash-File $temp) -ne $request.afterHash) { throw 'DOC_STAGED_HASH_CONFLICT' }
  if ($present) {
    if ((Hash-File $target) -ne $request.beforeHash) { throw 'DOC_BEFORE_HASH_CONFLICT' }
    [IO.File]::Replace($temp, $target, $backup, $false)
    if ((Hash-File $backup) -ne $request.beforeHash) { throw 'DOC_BACKUP_HASH_MISMATCH' }
    if ((Get-Acl -LiteralPath $backup).Sddl -ne $beforeAcl -or
        (Get-Acl -LiteralPath $target).Sddl -ne $beforeAcl) { throw 'DOC_METADATA_NOT_PRESERVED' }
    if ((Get-Item -LiteralPath $backup).CreationTimeUtc -ne $beforeInfo.CreationTimeUtc -or
        (Get-Item -LiteralPath $target).CreationTimeUtc -ne $beforeInfo.CreationTimeUtc -or
        (Get-Item -LiteralPath $backup).Attributes -ne $beforeInfo.Attributes) { throw 'DOC_METADATA_NOT_PRESERVED' }
  } else {
    [IO.File]::Move($temp, $target)
  }
  if ((Hash-File $target) -ne $request.afterHash) { throw 'DOC_WRITE_HASH_MISMATCH' }
  @{status='WRITTEN'; path=$rel; backup=$(if ($present) {$backup} else {$null});
    beforeHash=$request.beforeHash; afterHash=$request.afterHash; originalAcl=$beforeAcl;
    originalAttributes=$(if ($beforeInfo) {[int]$beforeInfo.Attributes} else {$null});
    originalCreationTimeUtc=$(if ($beforeInfo) {$beforeInfo.CreationTimeUtc.ToString('O')} else {$null});
    backupVerified=$present; metadataVerified=$true} | ConvertTo-Json -Compress
} catch {
  @{status='DOC_BLOCKED'; reason=$_.Exception.Message} | ConvertTo-Json -Compress
  exit 1
}
