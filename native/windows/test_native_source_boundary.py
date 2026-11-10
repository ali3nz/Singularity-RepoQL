import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from windows_source_policy import linux_deployment_asset, windows_variant_excludes

ROOT=Path(__file__).resolve().parents[2]

class NativeSourceBoundary(unittest.TestCase):
    def test_linux_deployment_artifacts_not_allowed(self):
        for name in ('compose/compose.yml','systemd/ghost.timer',
                     'scripts/start-memory-stack.sh','dashboard/docker-compose.yml',
                     'dashboard/collector.py','memory/portable/systemd/tencent-capture.timer',
                     'office/office.compose.yml','ghost/setup-ghost.sh',
                     'openchamber/opencode.jsonc'):
            with self.subTest(name=name):
                self.assertTrue(linux_deployment_asset(name))
        for name in ('scripts/orch-chat','native/windows/rust-supervisor/src/main.rs',
                     'dashboard/.env.windows.example','dashboard/server.py'):
            with self.subTest(name=name):
                self.assertFalse(linux_deployment_asset(name))
    def test_ghost_scheduler_sources_are_excluded_from_all_windows_variants(self):
        names=('native/windows/ghost_scheduler_host.py','native/windows/ghost_task_scheduler.ps1',
               'native/windows/manage_ghost_scheduler.ps1','native/windows/test_ghost_scheduler_host.py')
        for name in names:
            for variant in (1,2,3,4):
                self.assertTrue(windows_variant_excludes(name,variant))
    def test_legacy_installer_refuses_native_windows(self):
        code=(ROOT/'scripts/install-claude-code.mjs').read_text()
        self.assertIn('NATIVE_WINDOWS_INSTALLER_INCOMPLETE', code)
        self.assertIn('process.platform === "win32"', code)
    def test_agentchat_cli_can_read_cold_state_without_linux_host(self):
        with tempfile.TemporaryDirectory() as d:
            env=os.environ.copy()
            env.update(AGENTCHAT_STATE_DIR=d, AGENTCHAT_DISCORD_ENV='')
            result=subprocess.run([sys.executable,str(ROOT/'scripts/orch-chat'),'status'],
                                  capture_output=True,text=True,timeout=8,env=env)
            self.assertEqual(result.returncode,0,result.stderr)
    def test_windows_agentchat_consult_is_fail_closed(self):
        code=(ROOT/'scripts/orch-chat').read_text()
        self.assertIn("native Windows consult dispatch requires Rust owner verification",code)
        self.assertIn('msvcrt.LK_NBLCK',code)
        self.assertIn("if os.name == 'nt'",code)
    def test_windows_dashboard_state_root(self):
        sys.path.insert(0,str(ROOT/'dashboard'))
        from agentchat_feed import default_state_root
        self.assertEqual(str(default_state_root(platform='nt',
                         env={'LOCALAPPDATA':'C:/Temp/Local'},home='C:/Users/a')).replace('\\','/'),
                         'C:/Temp/Local/Singularity/AgentChat')

if __name__=='__main__':unittest.main()
