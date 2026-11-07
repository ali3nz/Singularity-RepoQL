"""Source contract for consistent dashboard and Rust gateway local Windows identity."""
from pathlib import Path
import unittest
ROOT=Path(__file__).resolve().parents[2]

class GatewayPairing(unittest.TestCase):
    def test_gateway_registration_reuses_the_dashboard_state_and_token(self):
        launcher=(ROOT/'native/windows/claude_complete_dashboard_host.py').read_text()
        manager=(ROOT/'native/windows/manage_unified_gateway.ps1').read_text()
        self.assertIn(r"'Singularity\Dashboard'",manager)
        self.assertIn("$RepoqlTokenFile=Join-Path $StateDir 'token'",manager)
        self.assertIn('GATEWAY_REPOQL_TOKEN_MUST_MATCH_DASHBOARD',manager)
        self.assertIn('GATEWAY_STATE_MUST_MATCH_OPTION2_DASHBOARD',manager)
        self.assertIn("$keyFile=Join-Path $StateDir 'unified-gateway.token'",manager)
        self.assertIn("'UNIFIED_GATEWAY_TOKEN_FILE':str(state_dir / 'unified-gateway.token')",launcher)
        self.assertIn("'UNIFIED_SERVICE_BASE':'http://127.0.0.1:18101'",launcher)
    def test_verify_checks_repoql_source_not_only_rust_health(self):
        manager=(ROOT/'native/windows/manage_unified_gateway.ps1').read_text()
        self.assertIn('GATEWAY_WINDOWS_REPOQL_READ_UNAVAILABLE',manager)
        self.assertIn('/v1/graph?repoql=true&tencent=false&limit=10',manager)
        self.assertIn("sourceLocality='REQUIRES_UNIQUE_FIXTURE'",manager)
        self.assertIn("tencentSource='NOT_TESTED'",manager)

if __name__=='__main__':unittest.main()
