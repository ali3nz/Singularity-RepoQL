"""Ensure the shipped CI runs against the source profile it packages."""
from pathlib import Path
import re
import unittest

from build_source_variants import component_files
from windows_source_policy import linux_deployment_asset, windows_variant_excludes

ROOT = Path(__file__).resolve().parents[2]
WORKFLOWS = ROOT / '.github/workflows'
# Match test files and archive names, not Cargo build outputs or upload artifacts.
TEST_INPUT = re.compile(
    r'(?<![\w./-])(?:adapters|dashboard|ghost|harness|native|openchamber|scripts|tests)'
    r'/[\w./*-]+?\.(?:mjs|py|ps1|sh)\b'
)
DISCOVERY = re.compile(r"discover -s ([\w/]+) -p ['\"]?([\w.*-]+\.py)")
LOCAL_MODULE = re.compile(r'\bpython -m unittest (test_[\w ]+)')


class WindowsSourceCI(unittest.TestCase):
    def test_workflow_script_inputs_are_shipped(self):
        parts = component_files()
        shipped = {name for part in ('core', 'dashboard', 'office') for name in parts[part]
                   if not linux_deployment_asset(name) and not windows_variant_excludes(name, 2)}
        for workflow in sorted(WORKFLOWS.glob('*.yml')):
            for number, line in enumerate(workflow.read_text(encoding='utf-8').splitlines(), 1):
                if line.lstrip().startswith(('#', '- ', 'path:')):
                    continue
                for path in TEST_INPUT.findall(line):
                    with self.subTest(workflow=workflow.name, line=number, path=path):
                        self.assertTrue(any(p.relative_to(ROOT).as_posix() in shipped
                                            for p in ROOT.glob(path)))
                for directory, pattern in DISCOVERY.findall(line):
                    with self.subTest(workflow=workflow.name, line=number, pattern=pattern):
                        self.assertTrue(any(p.relative_to(ROOT).as_posix() in shipped
                                            for p in (ROOT / directory).glob(pattern)))
                if 'python -m unittest' in line and workflow.name == 'rust-memory-upgrade-acceptance.yml':
                    # The two relative unittest invocations use Push-Location.
                    directory = 'dashboard' if 'test_rust_telemetry_model' in line else 'native/windows'
                    for group in LOCAL_MODULE.findall(line):
                        for module in group.split():
                            with self.subTest(workflow=workflow.name, line=number, module=module):
                                self.assertIn(f'{directory}/{module}.py', shipped)
                self.assertNotRegex(line, r'singularity-native-windows-option[134]-SOURCE-ONLY\.zip')

    def test_retired_setup_fails_before_mutations(self):
        setup = (ROOT / 'native/windows/setup/Complete-Setup.ps1').read_text(encoding='utf-8')
        build = (ROOT / 'native/windows/setup/Build-Setup.ps1').read_text(encoding='utf-8')
        marker = 'LEGACY_GUI_SETUP_UNAVAILABLE_USE_PHASED_CLAUDE_COMPLETE_INSTALLER'
        self.assertTrue(windows_variant_excludes('native/windows/manage_native_windows.ps1', 2))
        self.assertLess(setup.index(marker), setup.index('function Invoke-Install'))
        self.assertLess(build.index(marker), build.index('New-Item -ItemType Directory -Path $build'))

    def test_lock_resolution_workflow_is_manual_and_produces_candidates_only(self):
        workflow = (WORKFLOWS / 'windows-rust-lock-candidates.yml').read_text(encoding='utf-8')
        self.assertIn('workflow_dispatch:', workflow)
        self.assertNotRegex(workflow, r'(?m)^  (push|pull_request|schedule):')
        self.assertIn('contents: read', workflow)
        self.assertIn('prepare_rust_locks.ps1 -GenerateMissing', workflow)
        self.assertIn('git diff --exit-code', workflow)
        self.assertIn('if-no-files-found: error', workflow)
        for name in ('memory-parity-rust', 'rc-stack-rust', 'source-packager-rust', 'release-evidence-rust'):
            self.assertIn(f'native/windows/{name}/Cargo.lock', workflow)
        self.assertNotIn('git push', workflow)
        self.assertNotIn('verify_rust_upgrade.ps1 -Native', workflow)

    def test_staging_smoke_uses_compiled_full_bridge_and_retains_rollback(self):
        smoke = (ROOT / 'native/windows/smoke-stage.ps1').read_text(encoding='utf-8')
        workflow = (WORKFLOWS / 'native-desktop-rust.yml').read_text(encoding='utf-8')
        self.assertIn('--variant 2', smoke)
        self.assertIn('Option=2; SourceRoot=$archiveDir; BridgeExe=$bridge; RepoqlExe=$fakeExe', smoke)
        self.assertIn("bridgeFeatureOffice -ne $true", smoke)
        self.assertIn("'/platform:x64'", smoke)
        self.assertIn("acceptedOnWindows -ne $false", smoke)
        self.assertIn('PREVIOUS_ROLLBACK_SNAPSHOT_EXISTS', smoke)
        self.assertIn('-InstallRoot $testRoot -Rollback', smoke)
        self.assertIn('-RepoRoot $PWD.Path -BridgeExe $bridge', workflow)
        self.assertNotIn('BridgeExe=$fakeExe', smoke)


if __name__ == '__main__':
    unittest.main()
