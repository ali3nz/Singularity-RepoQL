"""OpenMausBot Rust projection is optional, public-field-only, and exact-parity."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from native_openmausbot import (_project_models_python, _project_overview_python,
                                _public_models, _public_bots, _native_checked_inventory,
                                models, overview)


MODEL_DATA = {'instances': [{'instanceId':'provider1', 'displayName':'Provider One',
                             'snapshot':{'state':'available', 'sessionToken':'PRIVATE_SESSION_TOKEN'},
                             'models':{'options':[{'id':'model1','label':'Model One','secret':'PRIVATE_SECRET'}]},
                             'credentials':'PRIVATE_CREDENTIALS'}]}
BOT_DATA = {'bots':[{'id':'bot_A','name':'Alpha','busy':True,'threadId':'thread_A',
                     'modelSelection':{'instanceId':'provider1','model':'model1'},
                     'prompt':'PRIVATE_BOT_INSTRUCTIONS','token':'PRIVATE_TOKEN'}]}


class OpenMausInventoryRustBridge(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.binary = Path(self.tmp.name)/'singularity-openmaus-inventory.exe'
        self.binary.write_bytes(b'fixture')

    def test_public_models_and_bots_never_forward_private_fields(self):
        for kind, payload in [('models',_public_models(MODEL_DATA)), ('bots',_public_bots(BOT_DATA))]:
            with self.subTest(kind=kind):
                raw = json.dumps(payload)
                self.assertNotIn('PRIVATE_',raw)
                self.assertNotIn('sessionToken',raw)
                self.assertNotIn('credentials',raw)
                self.assertNotIn('prompt',raw)
                self.assertNotIn('token',raw)

    def test_default_python_and_exact_opt_in(self):
        for mode, data, public, project in [
            ('models',MODEL_DATA,_public_models,_project_models_python),
            ('bots',BOT_DATA,_public_bots,_project_overview_python)]:
            with self.subTest(mode=mode):
                expected=project(data)
                with patch.dict(os.environ,{'SINGULARITY_OPENMAUS_INVENTORY_RUST_BINARY':''}):
                    self.assertEqual(_native_checked_inventory(mode,public(data),expected),expected)
                with patch.dict(os.environ,{'SINGULARITY_OPENMAUS_INVENTORY_RUST_BINARY':str(self.binary)}), \
                     patch('native_openmausbot.subprocess.run') as run:
                    run.return_value=subprocess.CompletedProcess([],0,json.dumps(expected),'')
                    self.assertEqual(_native_checked_inventory(mode,public(data),expected),expected)
                    kwargs=run.call_args.kwargs
                    self.assertFalse(kwargs['shell']);self.assertEqual(kwargs['timeout'],10)
                    req=json.loads(kwargs['input'])
                    self.assertEqual(set(req),{'mode','payload'})
                    self.assertEqual(req['mode'],mode)
                    self.assertNotIn('PRIVATE_',kwargs['input'])

    def test_bad_binary_and_symlink_rejected(self):
        expected=_project_models_python(MODEL_DATA)
        for path in ('relative.exe', str(self.binary.parent/'missing.exe')):
            with patch.dict(os.environ,{'SINGULARITY_OPENMAUS_INVENTORY_RUST_BINARY':path}):
                with self.assertRaisesRegex(RuntimeError,'openmaus_inventory_rust_binary_invalid'):
                    _native_checked_inventory('models',_public_models(MODEL_DATA),expected)
        link=self.binary.parent/'alias.exe'
        try:
            link.symlink_to(self.binary)
        except (OSError,NotImplementedError):
            return
        with patch.dict(os.environ,{'SINGULARITY_OPENMAUS_INVENTORY_RUST_BINARY':str(link)}):
            with self.assertRaisesRegex(RuntimeError,'openmaus_inventory_rust_binary_invalid'):
                _native_checked_inventory('models',_public_models(MODEL_DATA),expected)

    def test_forged_output_and_process_failure(self):
        expected=_project_models_python(MODEL_DATA)
        for stdout, exitcode in ((json.dumps({'available':True,'providers':[]}),0),('bad json',0),('',2)):
            with self.subTest(stdout=stdout), \
                 patch.dict(os.environ,{'SINGULARITY_OPENMAUS_INVENTORY_RUST_BINARY':str(self.binary)}), \
                 patch('native_openmausbot.subprocess.run',return_value=subprocess.CompletedProcess([],exitcode,stdout,'')):
                with self.assertRaises(RuntimeError):
                    _native_checked_inventory('models',_public_models(MODEL_DATA),expected)

    def test_wrapper_failure_is_unavailable_not_unverified_permission(self):
        def reader(path):
            return MODEL_DATA if path=='/api/instances' else (
                {'app':'openmausbot'} if path=='/api/health' else BOT_DATA)
        with patch('native_openmausbot._reader',return_value=reader), \
             patch.dict(os.environ,{'SINGULARITY_OPENMAUS_INVENTORY_RUST_BINARY':str(self.binary)}), \
             patch('native_openmausbot.subprocess.run',return_value=subprocess.CompletedProcess([],0,'{}','')):
            self.assertEqual(models(Path('.')), {'available':False,'providers':[]})
            self.assertEqual(overview(Path('.')), {'available':False,'reason':'unavailable','bots':[]})

    def test_input_size_limit(self):
        expected={'available':True,'providers':[]}
        payload={'instances':[], 'public': 'x'*(2*1024*1024)}
        with patch.dict(os.environ,{'SINGULARITY_OPENMAUS_INVENTORY_RUST_BINARY':str(self.binary)}):
            with self.assertRaisesRegex(RuntimeError,'openmaus_inventory_rust_input_too_large'):
                _native_checked_inventory('models',payload,expected)


if __name__ == '__main__': unittest.main()
