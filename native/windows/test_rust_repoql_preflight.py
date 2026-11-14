"""Verifies the optional native Rust connector contract veto, not Rust itself."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from repoql_compat import preflight, REQUIRED_VERSION, REQUIRED_CONNECTOR_CONTRACT


class RustRepoqlBridgeTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.binary=Path(self.tmp.name)/'desktop-bridge.exe'
        self.binary.write_bytes(b'source-fixture')
        self.source_root=Path(__file__).resolve().parents[2]

    def runner(self,*args,**kwargs):
        return subprocess.CompletedProcess(args,0,stdout='1.7.18\n',stderr='')

    def preflight(self,native_output,rc=0):
        with patch('repoql_compat.subprocess.run',return_value=subprocess.CompletedProcess([],rc,stdout=json.dumps(native_output),stderr='')):
            return preflight(binary='C:/Tools/rql.exe',root=self.source_root,runner=self.runner,
                             system='win32',rust_binary=self.binary)

    def test_native_valid_verdict_must_match_live_source(self):
        report=self.preflight({'ok':True,'kanzo_contract_compatible':True,
            'memorycore_contract_compatible':True,'native_binary':True,
            'connector_installation_allowed':True,'required_version':REQUIRED_VERSION,
            'actual_version':REQUIRED_VERSION,
            'required_connector_contract':REQUIRED_CONNECTOR_CONTRACT})
        self.assertTrue(report['ok'],report['errors'])

    def test_native_mismatch_refuses_even_when_python_passes(self):
        valid={'ok':True,'kanzo_contract_compatible':True,
            'memorycore_contract_compatible':True,'native_binary':True,
            'connector_installation_allowed':True,'required_version':REQUIRED_VERSION,
            'actual_version':REQUIRED_VERSION,
            'required_connector_contract':REQUIRED_CONNECTOR_CONTRACT}
        for key,other in [('actual_version','1.7.17'),('memorycore_contract_compatible',False),('ok',False)]:
            with self.subTest(key=key):
                self.assertFalse(self.preflight(dict(valid,**{key:other}))['ok'])
        self.assertFalse(self.preflight(valid,rc=2)['ok'])

    def test_missing_and_relative_native_executable_refused(self):
        for path in [Path('relative.exe'),Path(self.tmp.name)/'missing.exe']:
            self.assertFalse(preflight(binary='C:/Tools/rql.exe',runner=self.runner,
                 system='win32',root=self.source_root,rust_binary=path)['ok'])

    def test_original_preflight_does_not_require_rust(self):
        self.assertTrue(preflight(binary='C:/Tools/rql.exe',runner=self.runner,
              system='win32',root=self.source_root)['ok'])


if __name__=='__main__':unittest.main()
