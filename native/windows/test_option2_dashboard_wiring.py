"""Focused source and pure helper checks; NOT Windows Task Scheduler acceptance."""
import tempfile
import os
import unittest
from unittest import mock
import base64
import json
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
            stage=root/'WindowsNative'/'current'/'source'
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
            bridge=stage.parent/'bin'/'singularity-desktop-bridge.exe'
            bridge.parent.mkdir(parents=True)
            bridge.write_bytes(b'fake bridge test only')
            ghost_config=root/'GhostScheduler'/'native-bridge-client.json'
            ghost_config.parent.mkdir()
            ghost_config.write_text(json.dumps({
                'endpoint':'http://127.0.0.1:19991',
                'controlKey':base64.b64encode(bytes(range(48))).decode('ascii'),
            }))
            ghost_args={'native_bridge_exe':bridge,'ghost_control_config':ghost_config}
            office_config=root/'WindowsNative'/'office'/'service'/'service.json'
            office_config.parent.mkdir(parents=True)
            office_config.write_text(json.dumps({'port':18128}),encoding='utf-8')
            office_root = office_config.parent.parent
            (office_root / 'office-install.json').write_text(json.dumps({
                'schema': 'singularity-windows-office/v1', 'installRoot': str(office_root), 'port': 18128,
            }), encoding='utf-8')
            office_keys = office_root / 'state' / 'keys.json'
            office_keys.parent.mkdir()
            office_keys.write_text('{}', encoding='utf-8')
            tencent_owner = office_root.parent / 'memory' / 'state' / 'secrets' / 'admin-user-key'
            tencent_owner.parent.mkdir(parents=True)
            tencent_owner.touch()
            env=environment(stage,root/'rql.exe',root,root/'state',18100,windows=True,**ghost_args)
            self.assertEqual(env['SINGULARITY_INSTALL_VARIANT'],'2')
            self.assertEqual(env['SINGULARITY_BIND'],'127.0.0.1')
            self.assertEqual(env['SINGULARITY_NATIVE_BRIDGE_EXE'],str(bridge))
            self.assertEqual(env['SINGULARITY_GHOST_CONTROL_CONFIG'],str(ghost_config))
            self.assertEqual(env['REPOQL_NATIVE_EMBED_URL'],'/embed/repoql')
            self.assertEqual(env['REPOQL_NATIVE_WORKSPACE'],str(root))
            self.assertEqual(env['CLAUDE_OFFICE_HEALTH_PORT'],'18128')
            self.assertEqual(env['SINGULARITY_OFFICE_PORT'],'18128')
            self.assertEqual(env['SINGULARITY_OFFICE_NATIVE_AUTH_MODE'], 'service_keys')
            self.assertEqual(env['SINGULARITY_OFFICE_PANEL_KEY_FILE'], str(office_keys))
            variant4=environment(stage,root/'rql.exe',root,root/'state',18100,variant=4,windows=True,**ghost_args)
            self.assertEqual(variant4['SINGULARITY_INSTALL_VARIANT'],'4')
            self.assertEqual(variant4['SINGULARITY_NATIVE_BRIDGE_EXE'],str(bridge))
            self.assertEqual(variant4['SINGULARITY_GHOST_CONTROL_CONFIG'],str(ghost_config))
            self.assertEqual(variant4['SINGULARITY_OFFICE_PORT'],'18128')
            variant1=environment(stage,root/'rql.exe',root,root/'state',18100,variant=1,windows=True)
            self.assertEqual(variant1['REPOQL_NATIVE_EMBED_URL'],'/embed/repoql')
            self.assertNotIn('SINGULARITY_OFFICE_PORT',variant1)
            self.assertEqual(variant1['SINGULARITY_TENCENT_OWNER_KEY_FILE'], str(tencent_owner))
            self.assertEqual(variant1['TENCENT_PANEL_BASE'], 'http://127.0.0.1:18126')
            variant3 = environment(stage, root/'rql.exe', root, root/'state', 18100, variant=3, windows=True)
            self.assertEqual(variant3['SINGULARITY_TENCENT_OWNER_KEY_FILE'], str(tencent_owner))
            self.assertNotIn('SINGULARITY_OFFICE_PORT', variant3)
            self.assertNotIn('CLAUDE_OFFICE_HEALTH_PORT',variant1)
            self.assertNotIn('SINGULARITY_NATIVE_BRIDGE_EXE',variant1)
            self.assertNotIn('SINGULARITY_GHOST_CONTROL_CONFIG',variant1)
            for bad in (18129, True, 80, 65536, '18128', None):
                office_config.write_text(json.dumps({'port':bad}),encoding='utf-8')
                invalid = environment(stage, root/'rql.exe', root, root/'state', 18100,
                                      windows=True, **ghost_args)
                self.assertNotIn('SINGULARITY_OFFICE_PORT', invalid)
                self.assertEqual(invalid['REPOQL_NATIVE_EMBED_URL'], '/embed/repoql')
            office_config.write_bytes(bytes([255]))
            invalid = environment(stage, root/'rql.exe', root, root/'state', 18100,
                                  windows=True, **ghost_args)
            self.assertNotIn('SINGULARITY_OFFICE_PORT', invalid)
            # Variants without Office must ignore its configuration entirely.
            self.assertNotIn('SINGULARITY_OFFICE_PORT',
                             environment(stage,root/'rql.exe',root,root/'state',18100,variant=3,windows=True))
            office_config.write_text(json.dumps({'port':18128}),encoding='utf-8')
            with self.assertRaisesRegex(ValueError,'DASHBOARD_NATIVE_GHOST_CONFIG_REQUIRED'):
                environment(stage,root/'rql.exe',root,root/'state',18100,windows=True)
            with self.assertRaises(ValueError):environment(stage,root/'rql.exe',root,root/'state',80,windows=True,**ghost_args)
            with self.assertRaises(ValueError):environment(stage,root/'rql.exe',root,root/'state',18100,variant=5,windows=True,**ghost_args)

    def test_current_office_layout_takes_precedence_over_legacy(self):
        from claude_complete_dashboard_host import _native_office_environment

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'custom-install' / 'current' / 'source'
            dashboard = root / 'Singularity' / 'Dashboard'
            current = dashboard.parent / 'Office'
            legacy = source.parent.parent / 'office'
            for office, port in ((current, 18128), (legacy, 18129)):
                (office / 'service').mkdir(parents=True)
                (office / 'state').mkdir()
                (office / 'office-install.json').write_text(json.dumps({
                    'schema': 'singularity-windows-office/v1', 'installRoot': str(office), 'port': port,
                }), encoding='utf-8')
                (office / 'service' / 'service.json').write_text(
                    json.dumps({'port': port}), encoding='utf-8')
                (office / 'state' / 'keys.json').touch()
            result = _native_office_environment(source, dashboard)
            self.assertEqual(result['SINGULARITY_OFFICE_PORT'], '18128')
            self.assertEqual(result['SINGULARITY_OFFICE_PANEL_KEY_FILE'],
                             str(current / 'state' / 'keys.json'))
            option4 = _native_office_environment(source, dashboard / 'Option4')
            self.assertEqual(option4['SINGULARITY_OFFICE_PORT'], '18128')
            for var, value in (('SINGULARITY_OFFICE_NATIVE_AUTH_MODE', 'legacy_url'),
                               ('SINGULARITY_OFFICE_NATIVE_AUTH_MODE', 'key_file'),
                               ('SINGULARITY_OFFICE_PANEL_KEY_FILE', 'explicit-fixture-path'),
                               ('CLAUDE_OFFICE_EMBED_URL', 'https://office.example.test/')):
                with mock.patch.dict(os.environ, {var: value}):
                    explicit = _native_office_environment(source, dashboard)
                    self.assertEqual(explicit['SINGULARITY_OFFICE_PORT'], '18128')
                    self.assertNotIn('SINGULARITY_OFFICE_NATIVE_AUTH_MODE', explicit)
                    self.assertNotIn('SINGULARITY_OFFICE_PANEL_KEY_FILE', explicit)
            (current / 'state' / 'keys.json').unlink()
            self.assertEqual(_native_office_environment(source, dashboard)['SINGULARITY_OFFICE_PORT'],
                             '18128')
            (current / 'office-install.json').unlink()
            self.assertEqual(_native_office_environment(source, dashboard)['SINGULARITY_OFFICE_PORT'],
                             '18129')

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
        self.assertIn("-- \"'+$entry",manager)

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
        agent=(ROOT/'adapters/claude-code/agents/singularity-standalone.md').read_text()
        self.assertIn('.claude/rules/singularity-workflow.md',agent)

if __name__=='__main__':unittest.main()
