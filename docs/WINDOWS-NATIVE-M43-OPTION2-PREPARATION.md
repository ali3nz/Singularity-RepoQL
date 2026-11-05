# Milestone 43: Windows Option 2 candidate inspection and preparation

**Scope:** Claude Code Complete (Option 2), native Windows acceptance **candidate only**. No installer, service registration, Claude configuration change, Tencent write, RepoQL update, Office/Ghost launch or authorization is performed.

## Change

The Milestone 42 acceptance archive compiled the Rust bridge and supervisor but required hand-extracting a second source ZIP before the existing `stage-native.ps1` could preview staging. Milestone 43 provides a guarded preparation path:

- `native/windows/prepare_option2_candidate.py` verifies the **entire outer acceptance bundle**, checks the nested Option 2 source archive and its individual file hashes, and performs a Windows-only extraction into a **new** preview directory.
- The acceptance ZIP now embeds four **byte-identical** bootstrap Python modules from its verified source: `bootstrap/prepare_option2_candidate.py`, `bootstrap/build_option2_acceptance_bundle.py`, `bootstrap/scan_source_archive.py`, and `bootstrap/windows_source_policy.py`. The assembler checks that their bytes match the nested source; it refuses a divergent helper even if somebody has rewritten the outer receipt to match.
- Preparation refuses non-Windows extraction, unexpected destination names, symlinks/reparse points, existing destinations, invalid archives, corrupted nested files and paths outside the operator's `%LOCALAPPDATA%\Singularity\WindowsNativePreview` root.
- A fresh preparation contains `bin/` with two compiled binaries, expanded `source/` with the verified Option 2 source files, and `PREPARATION_RECEIPT.json`. It is **not** a stage or installation. Rust binary identity and publisher signatures must still be verified independently.
- The Windows CI acceptance-candidate job tests the bootstrap extracted from the **actual generated outer bundle** and prepares the candidate into the runner's LocalAppData preview root. It does not start or register services.

## Operator use on native Windows

Download the Windows CI acceptance candidate only after reviewing the source commit and the build artifact provenance. Python 3 and PowerShell are needed for the developer acceptance flow. Do not run unreviewed unsigned scripts as administrator.

1. Extract **only the outer** `claude-code-complete-option2-WINDOWS-ACCEPTANCE-NOT-INSTALLER.zip` with Explorer or PowerShell, to a new directory.
2. Read `ACCEPTANCE_BUNDLE_MANIFEST.json`, compare its source commit and hashes with the intended reviewed build, and inspect the `bootstrap/` code. The archive manifest is not a cryptographic publisher signature.
3. Run the *read-only* inspection:

```powershell
python .\bootstrap\prepare_option2_candidate.py --bundle C:\path\to\claude-code-complete-option2-WINDOWS-ACCEPTANCE-NOT-INSTALLER.zip
```

4. Create the preview root, then prepare into a **new** uniquely named subfolder:

```powershell
$root = Join-Path $env:LOCALAPPDATA 'Singularity\WindowsNativePreview'
New-Item -ItemType Directory -Force -Path $root | Out-Null
python .\bootstrap\prepare_option2_candidate.py --bundle C:\path\to\claude-code-complete-option2-WINDOWS-ACCEPTANCE-NOT-INSTALLER.zip --extract --destination (Join-Path $root 'option2-test-001')
```

5. Compare the receipt and `source/NATIVE_WINDOWS_SOURCE_MANIFEST.json` with the expected revision. The expanded source contains `native/windows/stage-native.ps1`, which has its own read-only preview and distinct, explicit opt-in `-Apply`. Before even previewing stage, acquire and independently version-verify real RepoQL **1.7.18**, the native Claude Desktop executable, and their publisher provenance. Do **not** run `-Apply` on a production account without a reviewed backup and rollback.

## Evidence and limitations

The offline tests use synthetic PE header fixtures for the extraction logic; they do not authenticate a compiler, publisher, Windows executable, or native application. CI must actually run on Windows to establish native extraction. Neither a successful inspection nor a successful preparation can satisfy service, plugin, memory, Office, Ghost, reboot or uninstall acceptance. All such gates remain **BLOCKED** until independent runtime receipts exist.
