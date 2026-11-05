"""Offline cross-language release policy consistency (not runtime connector proof)."""
import json
from pathlib import Path
import unittest
from repoql_compat import (
    MANIFESTS,
    REQUIRED_CALLS,
    REQUIRED_CONNECTOR_CONTRACT,
    REQUIRED_VERSION,
    manifest_contract,
)

ROOT=Path(__file__).resolve().parents[2]

class ReleaseVersionPolicy(unittest.TestCase):
    def test_windows_requires_118(self):
        policy=json.loads((ROOT/'native/windows/variants.json').read_text())
        self.assertEqual((REQUIRED_VERSION,REQUIRED_CONNECTOR_CONTRACT),('1.7.18','fetch-render'))
        self.assertEqual(policy['repoql']['requiredVersion'],REQUIRED_VERSION)
        self.assertEqual(policy['repoql']['connectorContract'],REQUIRED_CONNECTOR_CONTRACT)
        self.assertNotIn('connectorAbi',policy['repoql'])
        for relative, scheme in MANIFESTS.items():
            with self.subTest(manifest=relative):
                contract, errors = manifest_contract(ROOT / relative, scheme)
                self.assertEqual(errors, [])
                self.assertIsNotNone(contract)
                self.assertEqual(tuple(contract['calls']),REQUIRED_CALLS)
        self.assertEqual(json.loads((ROOT/'MANIFEST.json').read_text())['native_windows_wip']['repoql_required_version'],REQUIRED_VERSION)

    def test_native_implementations_share_pin(self):
        for path, required in {
            'native/desktop-bridge/src/repoql_compat.rs':'pub const VERSION: &str = "1.7.18";',
            'native/windows/rust-supervisor/src/lib.rs':'repoql_version != "1.7.18"',
            'native/windows/stage-native.ps1':'REPOQL_1_7_18_REQUIRED',
            'native/windows/preflight.ps1':"required_repoql_version = '1.7.18'",
            'native/windows/scan_source_archive.py':"!= '1.7.18'",
            'dashboard/native_readiness.py':"'repoql_required_version':'1.7.18'",
            'dashboard/native_repoql_gate.py':'RepoQL 1.7.18',
        }.items():
            with self.subTest(file=path):
                text=(ROOT/path).read_text(encoding='utf-8')
                self.assertIn(required,text)
                self.assertNotIn('REPOQL_1_7_15_REQUIRED',text)
                self.assertNotIn('repoql_1_7_15_not_verified',text)

    def test_production_not_forced_to_upgrade(self):
        from compare_production_parity import compare
        t=(ROOT/'native/windows/compare_production_parity.py').read_text()
        self.assertIn("production.get('repoql_version') not in ('1.7.15', '1.7.18')",t)
        self.assertIn("windows.get('repoql_version') != '1.7.18'",t)
        a=json.loads((ROOT/'native/windows/parity-receipt-production.example.json').read_text())
        b=json.loads((ROOT/'native/windows/parity-receipt-windows.example.json').read_text())
        self.assertEqual(a['repoql_version'],'1.7.15')
        self.assertEqual(b['repoql_version'],'1.7.18')
        self.assertIn('repoql_cli_connector_compatibility',a['checks'])
        self.assertIn('repoql_cli_connector_compatibility',b['checks'])

if __name__=='__main__':unittest.main()
