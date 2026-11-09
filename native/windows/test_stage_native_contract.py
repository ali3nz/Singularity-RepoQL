"""Static tests: actual Windows transactional stage/rollback is CI-only."""
import pathlib
import unittest

SRC=pathlib.Path(__file__).with_name('stage-native.ps1').read_text(encoding='utf-8')

class StageNativeContracts(unittest.TestCase):
    def test_safe_defaults(self):
        for marker in ('#Requires -Version 5.1', "[switch]$Apply", "[switch]$Rollback", 'if (-not $Apply) { return }', 'ShouldProcess', "GUI_VARIANT_MISMATCH", "SOURCE_HASH_MISMATCH", "Set-PrivateDirectoryAcl", "REPOQL_1_7_18_REQUIRED"):
            with self.subTest(marker=marker): self.assertIn(marker,SRC)
    def test_preview_explicitly_not_installed(self):
        for marker in ("state='SOURCE_STAGING_ONLY'", 'guiIntegrationInstalled=$false', 'servicesInstalled=$false', 'releaseReady=$false'):
            self.assertIn(marker,SRC)
    def test_staging_rollback_retains_previous(self):
        for marker in ('PREVIOUS_ROLLBACK_SNAPSHOT_EXISTS', 'Move-Item -LiteralPath $current -Destination $previous', 'Move-Item -LiteralPath $staging -Destination $current', 'Move-Item -LiteralPath $previous -Destination $current'):
            self.assertIn(marker,SRC)
    def test_rollback_does_not_require_original_binaries(self):
        self.assertIn("if (-not $Rollback -and $Option -notin @(1,2,3,4))", SRC)
        for name in ('SourceRoot', 'BridgeExe', 'RepoqlExe', 'GuiExe'):
            self.assertNotIn(f'[Parameter(Mandatory = $true)][string]${name}', SRC)
        self.assertIn('ROLLBACK_RECEIPT_INVALID', SRC)
        self.assertIn('WINDOWS_SOURCE_NAME_COLLISION', SRC)
        self.assertIn('ROLLBACK_HELD_SNAPSHOT_EXISTS', SRC)
        self.assertIn('Preserve active staged files, then restore previous snapshot', SRC)
        self.assertIn('Move-Item -LiteralPath $current -Destination $held', SRC)
        self.assertIn('Move-Item -LiteralPath $held -Destination $current', SRC)

    def test_interrupted_stage_is_preserved_and_blocks_new_stage(self):
        self.assertIn('UNRESOLVED_PENDING_STAGE_REQUIRES_MANUAL_REVIEW', SRC)
        self.assertIn('STAGE_RECOVERY_INCOMPLETE_REVIEW_PREVIOUS_AND_PENDING', SRC)
        self.assertIn('ROLLBACK_RECOVERY_INCOMPLETE_REVIEW_HELD_CURRENT', SRC)
        self.assertIn('Get-ChildItem -LiteralPath $targetRoot -Directory -Force -ErrorAction Stop', SRC)
        self.assertNotIn('Move-Item -LiteralPath $held -Destination $current -ErrorAction SilentlyContinue', SRC)
        self.assertNotIn('Move-Item -LiteralPath $previous -Destination $current -ErrorAction SilentlyContinue', SRC)
        self.assertNotIn('Remove-Item -LiteralPath $staging', SRC)

    def test_candidate_requires_amd64_pe32plus_not_just_signature(self):
        self.assertIn('$reader.ReadUInt16() -ne 0x8664', SRC)
        self.assertIn('$reader.ReadUInt16() -ne 0x020B', SRC)
        self.assertIn('WINDOWS_AMD64_EXE_REQUIRED', SRC)
        self.assertIn('WINDOWS_PE32_PLUS_REQUIRED', SRC)

    def test_gui_is_optional_and_never_claimed_as_configured(self):
        self.assertIn("'WindowsNative'", SRC)
        self.assertIn("if ($GuiExe) { Assert-LocalExistingFile $GuiExe 'GUI executable' }", SRC)
        self.assertIn('guiOptional=$true; guiExecutableProvided=[bool]$GuiExe; guiIntegrationInstalled=$false', SRC)
        self.assertIn('guiExecutableProvided=[bool]$GuiExe; guiConfigured=$false', SRC)

    def test_bridge_build_features_are_bounded_and_match_source_variant(self):
        self.assertIn("$start.Arguments='build-info'", SRC)
        self.assertIn("$outputLimit=4096", SRC)
        self.assertIn("$watch.Elapsed.TotalSeconds -gt 10", SRC)
        self.assertIn("$info.schema -cne 'singularity-native-build-info/v1'", SRC)
        self.assertIn("throw 'BRIDGE_BUILD_FEATURE_MISMATCH'", SRC)
        self.assertIn("$m.rustOfficeFeature -ne $complete", SRC)
        self.assertIn("[bool]$m.rustGhostFeature) { throw 'SOURCE_RUST_FEATURE_MISMATCH'", SRC)
        self.assertIn("[bool]$info.featureGhost) { throw 'BRIDGE_BUILD_FEATURE_MISMATCH'", SRC)

    def test_no_reparse_and_credential_copy(self):
        self.assertIn('REPARSE_PATH_REFUSED',SRC)
        self.assertIn('PRIVATE_SOURCE_FILE_REFUSED',SRC)
        self.assertNotIn('Set-ExecutionPolicy',SRC)
        self.assertNotIn('Invoke-WebRequest',SRC)
        self.assertNotIn('wsl.exe',SRC.lower())

if __name__=='__main__': unittest.main()
