"""Regression contracts for explicit staged product-binary ownership."""
from pathlib import Path
import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent


class AdditionalBinaryOwnership(unittest.TestCase):
    def test_optional_inventory_stays_allowlisted_and_hash_pinned(self):
        manager = (ROOT / 'manage_native_windows.ps1').read_text()
        self.assertIn("$stageReceipt.PSObject.Properties['additionalBinaries']", manager)
        for marker in ("$extras.Count -gt 2", "NATIVE_STAGE_ADDITIONAL_BINARY_INVALID",
                       "NATIVE_STAGE_ADDITIONAL_BINARY_HASH_MISMATCH",
                       "$expected.ContainsKey($relative.ToUpperInvariant())",
                       "[string]$extra.sha256 -cnotmatch '^[0-9a-f]{64}$'",
                       "'bin/singularity-windows-supervisorw.exe','bin/unified-repoql-control.exe'",
                       "NATIVE_STAGE_UNOWNED_FILE_REFUSED"):
            self.assertIn(marker, manager)

    def test_stage_and_rollback_verify_additional_binary_bytes(self):
        source = (ROOT / 'stage-native.ps1').read_text()
        for marker in ("additionalBinaries=$additionalBinaries", "Assert-PortableExecutable $extraPath",
                       "Assert-LocalExistingFile $extraPath", "ROLLBACK_ADDITIONAL_BINARY_HASH_MISMATCH",
                       "ROLLBACK_ADDITIONAL_BINARY_INVALID", "Get-FileSha256 $extraDestination"):
            self.assertIn(marker, source)

    def test_setup_keeps_lifecycle_ownership_checks(self):
        setup = (ROOT / 'setup' / 'Complete-Setup.ps1').read_text()
        for marker in ('Reset-InstallStage', 'Restore-Watchdog', 'Ensure-Autostart'):
            self.assertNotIn(marker, setup)
        self.assertIn('EXISTING_STAGE_REQUIRES_VERIFIED_OWNERSHIP', setup)


@unittest.skipUnless(os.name == 'nt' and shutil.which('pwsh'), 'Windows PowerShell required')
class AdditionalBinaryReadback(unittest.TestCase):
    def test_actual_manager_reads_old_and_extended_receipts(self):
        with tempfile.TemporaryDirectory() as directory:
            stage = Path(directory)
            source = stage / 'source'
            source.mkdir()
            (stage / 'bin').mkdir()
            digest = hashlib.sha256(b'fixture').hexdigest()
            files = []
            for index in range(201):
                name = f'fixture-{index}.txt'
                (source / name).write_bytes(b'fixture')
                files.append({'path': name, 'sha256': digest, 'bytes': 7})
            manifest = {
                'schema': 1, 'variant': 1, 'release_status': 'SOURCE_ONLY_UNCOMPILED_NOT_INSTALLER',
                'repoql': {'requiredVersion': '1.7.18', 'connectorContract': 'fetch-render'},
                'features': {'ghost': False, 'office': False},
                'rustGhostFeature': False, 'rustOfficeFeature': False, 'files': files,
            }
            manifest_path = source / 'NATIVE_WINDOWS_SOURCE_MANIFEST.json'
            manifest_path.write_text(json.dumps(manifest))
            for name in ('singularity-desktop-bridge.exe', 'singularity-windows-supervisor.exe'):
                (stage / 'bin' / name).write_bytes(b'fixture')
            receipt = {
                'schema': 1, 'state': 'STAGED_UNVERIFIED', 'option': 1, 'repoqlVersion': '1.7.18',
                'sourceManifestSha256': hashlib.sha256(manifest_path.read_bytes()).hexdigest(),
                'bridgePackageVersion': '1.0.0', 'bridgeFeatureGhost': False,
                'bridgeFeatureOffice': False, 'bridgeSha256': digest, 'supervisorSha256': digest,
            }
            extra_path = stage / 'bin' / 'unified-repoql-control.exe'
            extra = {'path': 'bin/unified-repoql-control.exe', 'sha256': digest}
            cases = [
                ('legacy', None, False, 'PASS'),
                ('extended', [extra], True, 'PASS'),
                ('unrecorded', None, True, 'NATIVE_STAGE_UNOWNED_FILE_REFUSED'),
                ('duplicate', [extra, extra], True, 'NATIVE_STAGE_ADDITIONAL_BINARY_INVALID'),
                ('wrong-hash', [dict(extra, sha256='0' * 64)], True,
                 'NATIVE_STAGE_ADDITIONAL_BINARY_HASH_MISMATCH'),
                ('unknown-name', [dict(extra, path='bin/other.exe')], True,
                 'NATIVE_STAGE_ADDITIONAL_BINARY_INVALID'),
            ]
            script = r'''
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$ast=[Management.Automation.Language.Parser]::ParseFile($env:MANAGER_SOURCE,[ref]$null,[ref]$null)
foreach ($name in @('Assert-LocalPath','Get-FileSha256','Read-Stage')) {
  $function=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true)
  . ([scriptblock]::Create($function.Extent.Text))
}
try { $null=Read-Stage $env:FIXTURE_STAGE 1; 'PASS' }
catch { $_.Exception.Message }
'''
            environment = dict(os.environ, MANAGER_SOURCE=str(ROOT / 'manage_native_windows.ps1'),
                               FIXTURE_STAGE=str(stage))
            for name, extras, present, expected in cases:
                with self.subTest(name=name):
                    current = dict(receipt)
                    if extras is not None:
                        current['additionalBinaries'] = extras
                    (stage / 'STAGING_RECEIPT.json').write_text(json.dumps(current))
                    if present:
                        extra_path.write_bytes(b'fixture')
                    else:
                        extra_path.unlink(missing_ok=True)
                    result = subprocess.run(
                        ['pwsh', '-NoProfile', '-NonInteractive', '-Command', script],
                        env=environment, capture_output=True, text=True, timeout=45,
                        creationflags=subprocess.CREATE_NO_WINDOW,
                    )
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(result.stdout.strip(), expected)


if __name__ == '__main__':
    unittest.main()
