"""Focused source and pure helper checks; NOT Windows Task Scheduler acceptance."""
import tempfile
import unittest
from pathlib import Path
import sys

ROOT=Path(__file__).resolve().parents[2]
# verify_option2_connectors imports native.windows.repoql_compat, so the repo
# root must be importable no matter which directory discovery started from.
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from claude_complete_dashboard_host import environment
from verify_option2_connectors import evaluate

class Option2DashboardWiring(unittest.TestCase):
    def test_launcher_pins_option_two_and_loopback(self):
        with tempfile.TemporaryDirectory() as t:
            root=Path(t)
            stage=root/'stage'
            (stage/'dashboard').mkdir(parents=True)
            (stage/'dashboard/server.py').write_text('')
            for name in ('memorycore','kanzo'):
                p=stage/'connectors'/name
                p.mkdir(parents=True)
                scheme = name
                (p/'manifest.yaml').write_text(
                    f'scheme: {scheme}\n'
                    'title: Test connector\n'
                    'summary: Test fetch and render manifest.\n'
                    'calls: [parse, fetch, render]\n'
                    'recordsVersion: 2\n'
                    'fetchIntervalSeconds: 900\n'
                    'fullFetchIntervalSeconds: 900\n'
                )
            (root/'rql.exe').write_bytes(b'fake test only')
            (root/'state').mkdir()
            untrusted=root/'untrusted'/'missing-bridge.exe'
            untrusted_config=root/'untrusted'/'missing-client.json'
            ghost_args={'native_bridge_exe':untrusted,'ghost_control_config':untrusted_config}
            env=environment(stage,root/'rql.exe',root,root/'state',18100,windows=True)
            self.assertEqual(env['SINGULARITY_INSTALL_VARIANT'],'2')
            self.assertEqual(env['SINGULARITY_BIND'],'127.0.0.1')
            for variant in (1,2,3,4):
                result=environment(stage,root/'rql.exe',root,root/'state',18100,
                                   variant=variant,windows=True,**ghost_args)
                self.assertEqual(result['SINGULARITY_INSTALL_VARIANT'],str(variant))
                self.assertNotIn('SINGULARITY_NATIVE_BRIDGE_EXE',result)
                self.assertNotIn('SINGULARITY_GHOST_CONTROL_CONFIG',result)
                self.assertFalse(any('GHOST' in key or 'NATIVE_BRIDGE' in key for key in result))
            with self.assertRaises(ValueError):environment(stage,root/'rql.exe',root,root/'state',80,windows=True,**ghost_args)
            with self.assertRaises(ValueError):environment(stage,root/'rql.exe',root,root/'state',18100,variant=5,windows=True,**ghost_args)

    def test_dashboard_registration_keeps_option_two_default_and_sets_selected_variant(self):
        manager=(ROOT/'native/windows/manage_claude_complete_dashboard.ps1').read_text()
        launcher=(ROOT/'native/windows/claude_complete_dashboard_host.py').read_text()
        self.assertIn("[ValidateRange(1,4)][int]$Variant=2",manager)
        self.assertIn("--variant '+$Variant",manager)
        self.assertIn("'Singularity-ClaudeComplete-Dashboard'",manager)
        self.assertIn("'--variant',type=int,choices=(1,2,3,4),default=2",launcher)
        self.assertIn("'SINGULARITY_INSTALL_VARIANT':str(variant)",launcher)
        self.assertIn("'PYTHONDONTWRITEBYTECODE':'1'",launcher)
        self.assertIn("sys.dont_write_bytecode = True",launcher)
        self.assertIn("$arguments='-B \"'+$silentHost",manager)
        self.assertIn("$Mode -eq 'Register' -and ($NativeBridgeExe -or $GhostControlConfig)",manager)
        self.assertNotIn('--native-bridge-exe',manager)
        self.assertNotIn('--ghost-control-config',manager)
        self.assertIn('if ($legacyNativeBridgeExe -or $legacyGhostControlConfig)',manager)
        self.assertIn('if ($Variant -notin @(2,4) -or -not $legacyNativeBridgeExe -or -not $legacyGhostControlConfig)',manager)
        self.assertIn('Assert-TaskOwned $existing[0] $owned',manager)
        self.assertIn('Assert-TaskOwned $task[0] $owned',manager)

    def test_connector_inventory_fails_without_two_active_unique_rows(self):
        one=lambda scheme,active: {'id':scheme,'status':'active' if active else 'installed','active':active}
        good={'available':True,'truncated':False,'connectors':[one('memorycore',True),one('kanzo',True)]}
        self.assertTrue(evaluate(good)['bothConnectorsActive'])
        for other in ({'available':False}, {'available':True,'truncated':False,'connectors':[one('kanzo',True)]},
                      {'available':True,'truncated':False,'connectors':[one('kanzo',True),one('kanzo',True),one('memorycore',True)]},
                      {'available':True,'truncated':False,'connectors':[one('kanzo',False),one('memorycore',True)]}):
            self.assertFalse(evaluate(other)['bothConnectorsActive'])

    def test_installer_uninstall_and_gates_include_dashboard(self):
        install=(ROOT/'native/windows/install_claude_complete.ps1').read_text()
        uninstall=(ROOT/'native/windows/uninstall_claude_complete.ps1').read_text()
        manager=(ROOT/'native/windows/manage_claude_complete_dashboard.ps1').read_text()
        for mode in ('DashboardPlan','DashboardRegister','DashboardVerify','DashboardRemove','DashboardStart'):
            self.assertIn(mode,install)
        self.assertIn('Assert-DashboardTaskAbsent',install)
        self.assertLess(uninstall.index('-Mode DashboardRemove'),uninstall.index('-Mode RemoveSupervisor'))
        for term in ('Get-ScheduledTask -ErrorAction Stop','New-ScheduledTaskPrincipal','Set-Acl','DASHBOARD_EXPLICIT_APPLY_REQUIRED','DASHBOARD_REPOQL_VERSION_OR_CONTRACT_REFUSED'):
            self.assertIn(term,manager)
        matrix=(ROOT/'native/windows/claude_complete_acceptance_matrix.py').read_text()
        self.assertIn('native_dashboard_authenticated_http',matrix)
        self.assertIn('repoql_connectors_kanzo_memorycore_active',matrix)
        self.assertIn('SINGULARITY_INSTALL_VARIANT=2',(ROOT/'dashboard/.env.windows.example').read_text())

    def test_agents_are_runtime_rules_not_auto_loaded_repo_instructions(self):
        agents=(ROOT/'AGENTS.md').read_text()
        self.assertIn('adapters/claude-code/singularity-workflow.md',agents)
        self.assertIn('automatically loaded by Claude Desktop',agents)
        self.assertIn('RepoQL MCP',agents)
        agent=(ROOT/'adapters/claude-code/agents/singularity-super.md').read_text()
        self.assertIn('.claude/rules/singularity-workflow.md',agent)

if __name__=='__main__':unittest.main()
