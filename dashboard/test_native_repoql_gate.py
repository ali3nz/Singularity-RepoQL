import os
from pathlib import Path
from subprocess import CompletedProcess
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from native_repoql_gate import check_native_repoql

class GateTests(unittest.TestCase):
    def setUp(self): self.config = SimpleNamespace(rql=Path('C:/Tools/rql.exe'))
    def test_native_only_118(self):
        for version, valid in [('1.7.18',True),('1.7.17',False),('1.7.15',False)]:
            with self.subTest(version=version):
                result=check_native_repoql(self.config,native=True,runner=lambda *a,**k: CompletedProcess(a[0],0,f'rql {version}',''))
                self.assertEqual(result['ok'],valid)
    def test_legacy_does_not_probe_executable(self):
        self.assertTrue(check_native_repoql(self.config,native=False)['ok'])
    def test_wrong_binary_format_refused(self):
        self.config.rql=Path('/usr/bin/rql')
        self.assertFalse(check_native_repoql(self.config,native=True)['ok'])

if __name__=='__main__': unittest.main()
