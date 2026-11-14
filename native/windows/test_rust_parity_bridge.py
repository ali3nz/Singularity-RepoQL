"""Ensures the Rust comparator is opt-in and cannot override negative evidence."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from compare_production_parity import compare
from rust_readonly_bridge import run_checked, RustReadOnlyBridgeError

class RustParityBridgeTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.binary=Path(self.tmp.name)/'release-evidence.exe'
        self.binary.write_bytes(b'fixture')

    def test_parity_is_still_blocked_without_receipts(self):
        ref=compare({}, {})
        self.assertFalse(ref['ready'])
        with patch('rust_readonly_bridge.subprocess.run',
                   return_value=subprocess.CompletedProcess([],2,stdout=json.dumps(ref),stderr='')):
            self.assertEqual(run_checked(self.binary,['parity','--production','a','--windows','b'],ref),ref)

    def test_forged_rust_ready_result_is_refused(self):
        ref=compare({}, {})
        forged=dict(ref, ready=True)
        with patch('rust_readonly_bridge.subprocess.run',
                   return_value=subprocess.CompletedProcess([],0,stdout=json.dumps(forged),stderr='')):
            with self.assertRaises(RustReadOnlyBridgeError):
                run_checked(self.binary,['parity'],ref)

if __name__=='__main__':unittest.main()
