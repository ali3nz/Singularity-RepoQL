"""Source and policy regression gates, NOT a substitute for a Windows build.

These tests refuse Dockerhost credential defaults and enforce honest local
startup constraints; real Task Scheduler, Tencent and RepoQL need live proof.
"""
import hashlib
import importlib.util
import os
from pathlib import Path
import unittest

ROOT = Path(__file__).absolute().parents[2]


class WindowsMemoryGatewaySourceTests(unittest.TestCase):
    def text(self, relative):
        return (ROOT / relative).read_text(encoding='utf-8')

    def test_compiled_gateway_uses_local_sources_and_no_dockerhost_secrets(self):
        rust = self.text('native/windows/unified-gateway-rust/src/main.rs')
        self.assertIn('UNIFIED_REPOQL_TOKEN_FILE', rust)
        self.assertIn('UNIFIED_GATEWAY_TOKEN_FILE', rust)
        self.assertIn('UNIFIED_TENCENT_USER_KEY_FILE', rust)
        self.assertIn('parsed.host_str()==Some("127.0.0.1")', rust)
        self.assertIn('writes: false', rust)
        self.assertIn('UNIFIED_HUB_DOC_URI_PREFIX', rust)
        self.assertIn('hub_document_join(&nodes, &mut edges, &c.hub_doc_prefix)', rust)
        self.assertNotIn('const HUB_DOC_PREFIX: &str =', rust)
        self.assertIn('Server::http(format!("127.0.0.1:{}",c.port))', rust)
        self.assertNotIn('/home/private-owner', rust)
        self.assertNotIn('root@', rust)
        self.assertIn('"/v1/graph"', rust)
        self.assertIn('"/v1/health"', rust)
        self.assertIn('"/v1/tencent/invoke"', rust)
        self.assertIn('redirects(0)', rust)

    def test_launcher_pins_port_token_and_exe_to_local_stage(self):
        code = self.text('native/windows/claude_complete_dashboard_host.py')
        for fragment in ('SINGULARITY_WINDOWS_GATEWAY_EXE',
                         "'UNIFIED_SERVICE_BASE':'http://127.0.0.1:18101'",
                         "state_dir / 'unified-gateway.token'",
                         "source_root.parent / 'bin' / 'unified-repoql-control.exe'"):
            self.assertIn(fragment, code)
        self.assertNotIn('192.168.', code)

    def test_tunnel_has_no_implicit_cutover(self):
        script = self.text('native/windows/disable_unified_tunnel.ps1')
        self.assertIn('[switch]$Apply', script)
        self.assertIn('Singularity-Unified-Tunnel', script)
        self.assertIn('ssh.exe', script)
        self.assertNotIn('Remove-Item -Recurse', script)

    def test_native_manager_is_opt_in_and_owner_scoped(self):
        manager = self.text('native/windows/manage_unified_gateway.ps1')
        self.assertIn('EXISTING_GATEWAY_TASK_REQUIRES_RECONCILIATION', manager)
        self.assertIn('FOREIGN_TASK_REFUSED', manager)
        self.assertIn('GATEWAY_PORT_BUSY_VERIFY_OWNER_NO_AUTOMATIC_KILL', manager)
        self.assertIn('Register-ScheduledTask', manager)
        self.assertIn('Stop-ScheduledTask', manager)
        self.assertIn('graphEndToEnd=\'NOT_TESTED\'', manager)
        self.assertNotIn('Singularity-Unified-Tunnel\' -Confirm', manager)
        starter = self.text('native/windows/start_unified_gateway.ps1')
        self.assertIn("$env:UNIFIED_TENCENT_WRITES='false'", starter)
        self.assertIn('REMOTE_ORIGIN_REFUSED', starter)
        self.assertIn('UNIFIED_HUB_DOC_URI_PREFIX', starter)
        self.assertIn('EXPLICIT_HUB_IMPORT_PREFIX_INVALID', manager)

    def test_memory_policy_is_installed_and_separates_authorities(self):
        policy=self.text('docs/WINDOWS-AGENT-MEMORY-POLICY.md')
        for fragment in ('RepoQL', 'Kanzo', 'MemoryCore', 'Agent Chat',
                         'SubagentStart', 'SessionEnd', 'L1', 'L0', 'ttlDays',
                         'NOT_TESTED', 'independent session', 'MEX'):
            self.assertIn(fragment.lower(), policy.lower())
        for relative in ('AGENTS.md', 'openchamber/AGENTS.md',
                         'adapters/claude-code/singularity-workflow.md'):
            self.assertIn('memory', self.text(relative).lower())

    def test_kanzo_stage_semantics_and_auditor_are_in_source(self):
        rules=self.text('adapters/claude-code/singularity-workflow.md')
        for item in ('check_work','claim_work','close_work','doing','done',
                     'read back','administrative closure'):
            self.assertIn(item, rules)
        board=self.text('dashboard/static/kanban_native.js')
        self.assertIn("doing:'In progress'", board)
        self.assertIn("done:'Closed'", board)
        self.assertIn("/embed/kanzo/api", board)
        auditor=self.text('native/windows/unified-gateway-rust/src/bin/kanzo_board_audit.rs')
        for item in ('closedAtLeast','doneHidden','doingMeans','doneMeans','--stdin'):
            self.assertIn(item, auditor)
        script=self.text('native/windows/audit_kanzo_board.ps1')
        for item in ('/api/board?project=all&done=all','KANZO_LISTENER_NOT_NATIVE_KANZO_BINARY',
                     'kanzo_board_audit.exe','-LocalAddress 127.0.0.1'):
            self.assertIn(item, script)
        self.assertNotIn('Move-Item', script)

    def test_releases_use_pinned_gateway_source_and_lock(self):
        from check_rust_lock_provenance import inspect
        gate=inspect(ROOT)
        rows=[r for r in gate['checks'] if r['crate']=='native/windows/unified-gateway-rust']
        self.assertEqual(len(rows),1)
        self.assertTrue(rows[0]['lockfileValid'], rows)


if __name__ == '__main__':
    unittest.main()
