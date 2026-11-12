"""Focused source and pure helper checks; NOT Windows Task Scheduler acceptance."""
import base64
import tempfile
import unittest
import json
import os
import subprocess
from pathlib import Path
import sys
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[2]
# verify_option2_connectors imports native.windows.repoql_compat, so the repo
# root must be importable no matter which directory discovery started from.
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from claude_complete_dashboard_host import environment, _assert_no_reparse
from verify_option2_connectors import evaluate

class Option2DashboardWiring(unittest.TestCase):
    def test_explicit_runtime_root_preserves_native_paths(self):
        with tempfile.TemporaryDirectory() as t, patch.dict(os.environ, {'LOCALAPPDATA': t}):
            local=Path(t)
            source=local/'Singularity'/'DashboardRuntime'/'release'/'source'
            for name in ('dashboard/server.py','connectors/memorycore/manifest.yaml','connectors/kanzo/manifest.yaml'):
                p=source/name; p.parent.mkdir(parents=True,exist_ok=True); p.write_text('fixture')
            runtime=local/'Singularity'/'WindowsNative'/'current'; runtime.mkdir(parents=True)
            rql=local/'rql.exe'; rql.write_bytes(b'fixture')
            state=local/'state'; state.mkdir()
            owner=runtime.parent/'memory/state/secrets/admin-user-key'
            owner.parent.mkdir(parents=True); owner.write_text('fixture')
            office=runtime.parent/'office'; (office/'service').mkdir(parents=True)
            (office/'office-install.json').write_text(json.dumps({'schema':'singularity-windows-office/v1','installRoot':str(office),'port':18222}))
            (office/'service/service.json').write_text(json.dumps({'port':18222}))
            old=environment(source,rql,local,state,18100,windows=True)
            self.assertEqual(old['SINGULARITY_WINDOWS_GATEWAY_EXE'],str(source.parent/'bin/unified-repoql-control.exe'))
            self.assertNotIn('SINGULARITY_TENCENT_OWNER_KEY_FILE',old)
            env=environment(source,rql,local,state,18100,windows=True,native_runtime_root=runtime)
            self.assertEqual(env['SINGULARITY_WINDOWS_GATEWAY_EXE'],str(runtime/'bin/unified-repoql-control.exe'))
            self.assertEqual(env['SINGULARITY_TENCENT_OWNER_KEY_FILE'],str(owner))
            self.assertEqual(env['SINGULARITY_OFFICE_PORT'],'18222')
            preferred=state.parent/'Office'; (preferred/'service').mkdir(parents=True)
            (preferred/'office-install.json').write_text(json.dumps({'schema':'singularity-windows-office/v1','installRoot':str(preferred),'port':18223}))
            (preferred/'service/service.json').write_text(json.dumps({'port':18223}))
            self.assertEqual(environment(source,rql,local,state,18100,windows=True,native_runtime_root=runtime)['SINGULARITY_OFFICE_PORT'],'18223')
            for unsafe in (Path('relative'), Path(r'\\server\share'), local/'missing', source):
                with self.subTest(unsafe=unsafe), self.assertRaises(ValueError):
                    environment(source,rql,local,state,18100,windows=True,native_runtime_root=unsafe)
            with patch('claude_complete_dashboard_host._assert_no_reparse', side_effect=ValueError('DASHBOARD_REPARSE_PATH_REFUSED')):
                with self.assertRaisesRegex(ValueError,'DASHBOARD_REPARSE_PATH_REFUSED'):
                    environment(source,rql,local,state,18100,windows=True,native_runtime_root=runtime)

    @unittest.skipUnless(os.name == 'nt', 'Windows junction test')
    def test_runtime_root_refuses_junction_ancestor(self):
        with tempfile.TemporaryDirectory() as t:
            root=Path(t); real=root/'real'; real.mkdir(); link=root/'link'
            result=subprocess.run(['cmd.exe','/c','mklink','/J',str(link),str(real)],
                                  stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=False)
            if result.returncode:
                self.skipTest('directory junction creation unavailable')
            child=link/'Singularity'/'WindowsNative'/'current'; child.mkdir(parents=True)
            with self.assertRaisesRegex(ValueError,'DASHBOARD_REPARSE_PATH_REFUSED'):
                _assert_no_reparse(child)

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
            self.assertEqual(env['SINGULARITY_WINDOWS_OMB_PORT'],'18211')
            for selected in (1024,8799,65534):
                result=environment(stage,root/'rql.exe',root,root/'state',18100,windows=True,openmausbot_port=selected)
                self.assertEqual(result['SINGULARITY_WINDOWS_OMB_PORT'],str(selected))
            for selected in (True,False,1023,65535,'8799',None,8799.0):
                with self.subTest(selected=selected), self.assertRaisesRegex(ValueError,'DASHBOARD_OPENMAUSBOT_PORT_INVALID'):
                    environment(stage,root/'rql.exe',root,root/'state',18100,windows=True,openmausbot_port=selected)

            for variant in (1,2,3,4):
                result=environment(stage,root/'rql.exe',root,root/'state',18100,
                                   variant=variant,windows=True,**ghost_args)
                self.assertEqual(result['SINGULARITY_INSTALL_VARIANT'],str(variant))
                self.assertNotIn('SINGULARITY_NATIVE_BRIDGE_EXE',result)
                self.assertNotIn('SINGULARITY_GHOST_CONTROL_CONFIG',result)
                self.assertFalse(any('GHOST' in key or 'NATIVE_BRIDGE' in key for key in result))
            with self.assertRaises(ValueError):environment(stage,root/'rql.exe',root,root/'state',80,windows=True,**ghost_args)
            with self.assertRaises(ValueError):environment(stage,root/'rql.exe',root,root/'state',18100,variant=5,windows=True,**ghost_args)

    @unittest.skipUnless(os.name == 'nt', 'PowerShell receipt contract')
    def test_openmausbot_receipt_port_matches_real_argument_tokens(self):
        manager=ROOT/'native/windows/manage_claude_complete_dashboard.ps1'
        script=r"""
$ast=[System.Management.Automation.Language.Parser]::ParseFile('__MANAGER__',[ref]$null,[ref]$null)
$fn=$ast.Find({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Assert-ReceiptOpenMausBotPort'},$true)
Invoke-Expression $fn.Extent.Text
$cases=@(
  @{json='{"arguments":"legacy --mode serve"}'; ok=$true},
  @{json='{"openMausBotPort":8799,"arguments":"-B host --openmausbot-port 8799 --mode serve"}'; ok=$true},
  @{json='{"openMausBotPort":1024,"arguments":"-B host --openmausbot-port 1024 --mode serve"}'; ok=$true},
  @{json='{"openMausBotPort":65534,"arguments":"-B host --openmausbot-port 65534 --mode serve"}'; ok=$true},
  @{json='{"openMausBotPort":8799,"arguments":"-B host --openmausbot-port 18211 --mode serve"}'; ok=$false},
  @{json='{"openMausBotPort":true,"arguments":"-B host --openmausbot-port 1 --mode serve"}'; ok=$false},
  @{json='{"openMausBotPort":"8799","arguments":"-B host --openmausbot-port 8799 --mode serve"}'; ok=$false},
  @{json='{"openMausBotPort":65535,"arguments":"-B host --openmausbot-port 65535 --mode serve"}'; ok=$false},
  @{json='{"openMausBotPort":8799,"arguments":"-B host --openmausbot-port 8799 --openmausbot-port 8799 --mode serve"}'; ok=$false},
  @{json='{"openMausBotPort":8799,"arguments":"-B host --openmausbot-port 8799 --mode serve extra"}'; ok=$false}
)
foreach ($case in $cases) {
  $accepted=$true
  try { Assert-ReceiptOpenMausBotPort ($case.json | ConvertFrom-Json) } catch { $accepted=$false }
  if ($accepted -ne $case.ok) { exit 1 }
}
"""
        script=script.replace('__MANAGER__',str(manager).replace("'","''"))
        encoded=base64.b64encode(script.encode('utf-16le')).decode('ascii')
        result=subprocess.run(['powershell.exe','-NoProfile','-NonInteractive','-EncodedCommand',encoded],capture_output=True,text=True)
        self.assertEqual(result.returncode,0,result.stderr)

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
        self.assertIn("$NativeRuntimeRoot=Assert-Path $NativeRuntimeRoot 'NATIVE_RUNTIME_ROOT' $true",manager)
        self.assertIn("if ($NativeRuntimeRoot) { $arguments+=' --native-runtime-root",manager)
        self.assertIn("p.add_argument('--native-runtime-root',type=Path)",launcher)
        self.assertIn('native_runtime_root=a.native_runtime_root',launcher)

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
