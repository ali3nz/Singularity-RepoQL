"""Claude Code MCP registration projection; Python retains local config ownership."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from claude_agents_control import _REQUIRED_INTEGRATIONS, _project_required_native, _required_entry, mcp_inventory


def reference(names):
    servers = [{'name': name, 'scope': 'user', 'configured': True, 'connected': None} for name in names]
    required = {k: _required_entry(spec, servers) for k, spec in _REQUIRED_INTEGRATIONS.items()}
    return _project_required_native(servers, required)


class ClaudeMcpInventoryRustTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.binary = Path(self.temp.name) / 'singularity-claude-mcp-inventory.exe'
        self.binary.write_bytes(b'fixture')
        self.names = ['RepoQL', 'repoql-test', 'not-memorycore', 'kanzo', 'OpenMausBot']
        self.expected = reference(self.names)

    def test_python_default_matches_existing_registration_rules(self):
        with patch.dict(os.environ, {'SINGULARITY_CLAUDE_MCP_INVENTORY_RUST_BINARY': ''}):
            got = reference(self.names)
        self.assertEqual(got['required']['repoql']['status'], 'configured')
        self.assertEqual(got['required']['memorycore']['status'], 'not_verified')
        self.assertFalse(got['liveHealthClaimed'])
        self.assertEqual(got['requiredMissing'], [])
        self.assertEqual(got['requiredNotVerified'], ['memorycore'])

    def test_opt_in_sends_only_registration_names(self):
        servers = [{'name': name, 'scope':'project','configured': True,'connected': None}
                   for name in self.names]
        required = {k:_required_entry(spec,servers) for k,spec in _REQUIRED_INTEGRATIONS.items()}
        fake = subprocess.CompletedProcess([],0,json.dumps(self.expected),'')
        with patch.dict(os.environ, {'SINGULARITY_CLAUDE_MCP_INVENTORY_RUST_BINARY':str(self.binary),
                                      'PRIVATE_KEY':'must_not_forward'}), \
             patch('claude_agents_control.subprocess.run',return_value=fake) as runner:
            actual = _project_required_native(servers,required)
        self.assertEqual(actual,self.expected)
        opts=runner.call_args.kwargs
        self.assertEqual(opts['timeout'],8)
        self.assertFalse(opts['shell'])
        self.assertNotIn('PRIVATE_KEY',opts['env'])
        self.assertEqual(json.loads(opts['input']),{
            'schema':'singularity-claude-mcp-inventory/v1','names':self.names})
        for key in ('password','env','command','configPath','PRIVATE_KEY','tokens'):
            self.assertNotIn(key, opts['input'])

    def test_bad_binary_and_forged_output_refused(self):
        for binary in ('relative.exe',str(self.binary.parent/'missing.exe')):
            with patch.dict(os.environ, {'SINGULARITY_CLAUDE_MCP_INVENTORY_RUST_BINARY':binary}):
                with self.assertRaisesRegex(RuntimeError,'binary_invalid'):
                    reference(self.names)
        link=self.binary.parent/'symlink.exe'
        try:link.symlink_to(self.binary)
        except (OSError,NotImplementedError):pass
        else:
            with patch.dict(os.environ,{'SINGULARITY_CLAUDE_MCP_INVENTORY_RUST_BINARY':str(link)}):
                with self.assertRaisesRegex(RuntimeError,'binary_invalid'):
                    reference(self.names)
        for stdout, code in ((json.dumps(dict(self.expected,liveHealthClaimed=True)),0),
                             (json.dumps({}),0),('not-json',0),('',1)):
            with patch.dict(os.environ,{'SINGULARITY_CLAUDE_MCP_INVENTORY_RUST_BINARY':str(self.binary)}), \
                 patch('claude_agents_control.subprocess.run',return_value=subprocess.CompletedProcess([],code,stdout,'')):
                with self.assertRaises(RuntimeError):reference(self.names)

    def test_invalid_name_rejected_only_when_native_enabled(self):
        with patch.dict(os.environ,{'SINGULARITY_CLAUDE_MCP_INVENTORY_RUST_BINARY':str(self.binary)}):
            for name in ('\nprivate','x'*101):
                with self.assertRaisesRegex(RuntimeError,'invalid_names'):
                    reference([name])
            with self.assertRaisesRegex(RuntimeError,'invalid_names'):
                reference(['repoql']*1025)
        self.assertEqual(reference(['\nprivate'])['required']['repoql']['status'],'missing')

    def test_config_owned_by_python_no_credentials_returned(self):
        home=Path(self.temp.name)
        (home/'.claude.json').write_text(json.dumps({'mcpServers': {
            'repoql':{'command':'PRIVATE_COMMAND','env':{'API_KEY':'PRIVATE_VALUE'}},
            'kanzo': {'url':'http://127.0.0.1/?token=PRIVATE_VALUE'},
            'repoql-clone':{'command':'other'},
        }}))
        with patch.dict(os.environ, {'SINGULARITY_WINDOWS_NATIVE':'1',
                                      'SINGULARITY_CLAUDE_MCP_INVENTORY_RUST_BINARY':''}), \
             patch('claude_agents_control.Path.home',return_value=home):
            result=mcp_inventory()
        self.assertEqual(result['required']['repoql']['status'],'configured')
        self.assertEqual(result['required']['kanzo']['status'],'configured')
        self.assertNotIn('PRIVATE_VALUE',json.dumps(result))
        self.assertNotIn('PRIVATE_COMMAND',json.dumps(result))


if __name__=='__main__':unittest.main()
