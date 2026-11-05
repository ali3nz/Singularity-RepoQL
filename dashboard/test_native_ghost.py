import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from native_ghost import control_request

class NativeGhostTests(unittest.TestCase):
    def test_no_dangerous_or_unconfirmed_action(self):
        self.assertEqual(control_request('POST',{'action':'set-prompt','confirm':False,'requestId':'r_1'})[0],400)
        self.assertEqual(control_request('POST',{'action':'run-shell','confirm':True,'requestId':'r_1'})[0],400)
        self.assertEqual(control_request('POST',{'action':'set-prompt','confirm':True,'requestId':'../bad'})[0],400)
        self.assertEqual(control_request('PATCH')[0],405)

    def test_native_ghost_is_not_silent_success_when_daemon_missing(self):
        self.assertEqual(control_request('GET',executable='')[0],503)
        self.assertEqual(control_request('POST',{'action':'set-prompt','confirm':True,'requestId':'r1'},executable='')[0],503)

    def test_rust_transport_only_with_explicit_acknowledgment(self):
        with tempfile.TemporaryDirectory() as folder:
            exe=Path(folder)/'singularity-desktop-bridge.exe';exe.write_bytes(b'not executed')
            captured=[]
            def fake(args,**kwargs):
                captured.append((args,kwargs))
                return SimpleNamespace(returncode=0,stdout=b'{"status":200,"body":{"ok":true}}')
            with patch.dict(os.environ,{'SINGULARITY_GHOST_CONTROL_CONFIG':str(Path(folder)/'ghost.json')}):
                code,payload=control_request('POST',{'action':'set-prompt','confirm':True,'requestId':'r_123'},executable=str(exe),runner=fake)
            self.assertEqual(code,200)
            self.assertTrue(payload['ok'])
            self.assertEqual(captured[0][0][1:],['ghost-control','POST'])
            self.assertFalse(captured[0][1]['shell'])
            self.assertNotIn('set-prompt',' '.join(captured[0][0]))

    def test_schedule_actions_are_forwarded_to_the_native_bridge(self):
        cases = [
            {
                'action': 'register-schedule', 'confirm': True, 'requestId': 'register_0001',
                'draftId': 'a' * 32, 'expectedDraftRevision': 1,
            },
            {
                'action': 'update-schedule', 'confirm': True, 'requestId': 'update_0001',
                'jobId': 'b' * 32, 'expectedRevision': 2,
                'draftId': 'a' * 32, 'expectedDraftRevision': 3,
            },
            {
                'action': 'cancel-schedule', 'confirm': True, 'requestId': 'cancel_0001',
                'jobId': 'b' * 32, 'expectedRevision': 2,
            },
        ]
        with tempfile.TemporaryDirectory() as folder:
            exe=Path(folder)/'singularity-desktop-bridge.exe';exe.write_bytes(b'not executed')
            with patch.dict(os.environ,{'SINGULARITY_GHOST_CONTROL_CONFIG':str(Path(folder)/'ghost.json')}):
                for body in cases:
                    captured=[]
                    def fake(args,**kwargs):
                        captured.append((args,kwargs))
                        return SimpleNamespace(returncode=0,stdout=b'{"status":200,"body":{"ok":true}}')
                    status,payload=control_request('POST',body,executable=str(exe),runner=fake)
                    self.assertEqual(status,200)
                    self.assertTrue(payload['ok'])
                    self.assertEqual(json.loads(captured[0][1]['input']),body)
                    self.assertEqual(captured[0][0][1:],['ghost-control','POST'])

    def test_rejected_or_unconfirmed_mutation_fails_closed(self):
        with tempfile.TemporaryDirectory() as folder:
            exe=Path(folder)/'singularity-desktop-bridge.exe';exe.write_bytes(b'x')
            with patch.dict(os.environ,{'SINGULARITY_GHOST_CONTROL_CONFIG':'C:/secrets/ghost.json'}):
                for msg in [b'{"status":200,"body":{"ok":false}}',b'{}',b'not json']:
                    code,_=control_request('POST',{'confirm':True,'action':'hold','requestId':'r1'},
                        executable=str(exe),runner=lambda *a,**k:SimpleNamespace(returncode=0,stdout=msg))
                    self.assertGreaterEqual(code,400)

if __name__=='__main__':unittest.main()
