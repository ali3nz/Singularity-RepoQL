"""Selected Rust Agent Chat reads cannot forge a feed or presence status.

Reference tests use a fake executable, not a compiled Rust binary. Actual Rust
compatibility is checked by native Windows differential_agentchat_feed.py.
"""
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch

from agentchat_feed import read_feed, read_presence


class AgentChatRustBridgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'inbox').mkdir()
        (self.root / 'inbox' / 'builder.jsonl').write_text(
            json.dumps({'id': 41, 'from': 'builder', 'text': 'harmless',
                        'createdAt': '2026-11-12T00:00:00Z'}) + '\n', encoding='utf-8')

    def _script(self, output, exit_code=0):
        if os.name == 'nt':
            self.skipTest('fake executable uses a POSIX shebang; native Windows gate runs the actual Rust binary')
        script = self.root / 'agentchat_fake'
        script.write_text('#!/usr/bin/env python3\nimport sys\n'
                          f'print({output!r})\n'
                          f'sys.exit({exit_code})\n', encoding='utf-8')
        script.chmod(script.stat().st_mode | stat.S_IXUSR)
        return script

    def test_normal_python_feed(self):
        with patch.dict(os.environ, {'SINGULARITY_AGENTCHAT_RUST_BINARY': ''}):
            self.assertEqual(read_feed(root=self.root)['messages'][0]['id'], 41)

    def test_matching_native_output_accepted(self):
        with patch.dict(os.environ, {'SINGULARITY_AGENTCHAT_RUST_BINARY': ''}):
            reference = read_feed(root=self.root)
        script = self._script(json.dumps(reference))
        with patch.dict(os.environ, {'SINGULARITY_AGENTCHAT_RUST_BINARY': str(script)}):
            self.assertEqual(read_feed(root=self.root), reference)

    def test_forged_message_rejected(self):
        forged = {'available': True, 'messages': [{'id': 999, 'text': 'spoofed'}], 'last_id': 999}
        script = self._script(json.dumps(forged))
        with patch.dict(os.environ, {'SINGULARITY_AGENTCHAT_RUST_BINARY': str(script)}):
            with self.assertRaisesRegex(RuntimeError, 'agentchat_native_mismatch'):
                read_feed(root=self.root)

    def test_forged_presence_rejected(self):
        script = self._script(json.dumps({'available': True, 'agents': [{'role': 'fake', 'status': 'working'}]}))
        with patch.dict(os.environ, {'SINGULARITY_AGENTCHAT_RUST_BINARY': str(script)}):
            with self.assertRaisesRegex(RuntimeError, 'agentchat_native_mismatch'):
                read_presence(root=self.root)

    def test_native_nonzero_exit_is_error(self):
        script = self._script('{}', exit_code=1)
        with patch.dict(os.environ, {'SINGULARITY_AGENTCHAT_RUST_BINARY': str(script)}):
            with self.assertRaisesRegex(RuntimeError, 'agentchat_native_execution_failed'):
                read_feed(root=self.root)

    def test_missing_native_executable_rejected(self):
        with patch.dict(os.environ, {'SINGULARITY_AGENTCHAT_RUST_BINARY': str(self.root / 'absent.exe')}):
            with self.assertRaisesRegex(RuntimeError, 'agentchat_native_binary_invalid'):
                read_feed(root=self.root)

    def test_extra_private_fields_rejected(self):
        with patch.dict(os.environ, {'SINGULARITY_AGENTCHAT_RUST_BINARY': ''}):
            reference = read_feed(root=self.root)
        reference['private'] = 'credential'
        script = self._script(json.dumps(reference))
        with patch.dict(os.environ, {'SINGULARITY_AGENTCHAT_RUST_BINARY': str(script)}):
            with self.assertRaisesRegex(RuntimeError, 'agentchat_native_mismatch'):
                read_feed(root=self.root)


if __name__ == '__main__':
    unittest.main()
