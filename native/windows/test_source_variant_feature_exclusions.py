"""The sole Windows product has all requested components and no retired source."""
from __future__ import annotations
import json
from pathlib import Path
import tempfile
import unittest
import zipfile
from build_source_variants import build
from windows_source_policy import windows_retired_source

class FullClaudeCodeSource(unittest.TestCase):
    def test_full_profile_is_the_only_buildable_archive(self):
        with tempfile.TemporaryDirectory(prefix="full-claude-") as directory:
            path=Path(directory)/'full.zip'
            build(2,path)
            with zipfile.ZipFile(path) as archive:
                names=set(archive.namelist())
                manifest=json.loads(archive.read('NATIVE_WINDOWS_SOURCE_MANIFEST.json'))
            self.assertEqual(manifest['variant'],2)
            self.assertEqual(manifest['gui'],'claude-desktop-code')
            for feature in ('office','repoql_dashboard','tencent_connector','kanzo','openmausbot','memory','repoql_mcp'):
                self.assertIs(manifest['features'][feature],True)
            self.assertIs(manifest['features']['ghost'],False)
            self.assertIs(manifest['rustGhostFeature'],False)
            self.assertIs(manifest['rustOfficeFeature'],True)
            self.assertFalse(any(windows_retired_source(name) for name in names))
            for prefix in ('office/','dashboard/','native/windows/openmausbot/',
                           'adapters/claude-code/','connectors/kanzo/','connectors/memorycore/'):
                self.assertTrue(any(name.startswith(prefix) for name in names),prefix)
            for retired in ('native/windows/manage_native_windows.ps1', 'native/windows/bootstrap_runtime.ps1',
                            'scripts/install-claude-code.mjs', 'scripts/provision-secrets.py'):
                self.assertNotIn(retired,names)
            for old_option in (1,3,4):
                with self.assertRaises(ValueError):
                    build(old_option,Path(directory)/f'old{old_option}.zip')
    def test_retired_paths_are_excluded_even_under_core(self):
        for name in ('ghost/dream.mjs','openchamber/config.json',
                     'native/desktop-bridge/src/ghost.rs',
                     'dashboard/static/ghost/dashboard.js',
                     'harness/kit/lib/ghostwake.mjs',
                     'office/patches/windows-ghost-only.patch'):
            self.assertTrue(windows_retired_source(name),name)

if __name__=='__main__': unittest.main()
