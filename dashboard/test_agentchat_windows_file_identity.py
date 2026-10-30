"""Agent Chat inbox reads must reject swapped files and Windows reparse points."""
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from agentchat_feed import _latest_lines, read_feed, default_state_root


class WindowsAgentChatFileIdentityTests(unittest.TestCase):
    def test_windows_default_state_path(self):
        p=default_state_root(platform='nt',env={'LOCALAPPDATA':r'C:\Users\Example\AppData\Local'})
        self.assertTrue(str(p).endswith('Singularity/AgentChat') or str(p).endswith('Singularity\\AgentChat'))
    def test_valid_durable_envelope_read(self):
        with tempfile.TemporaryDirectory() as d:
            folder=Path(d)/'inbox';folder.mkdir()
            (folder/'engineer.jsonl').write_text(json.dumps({'id':42,'from':'planner','text':'safe evidence'})+'\n')
            result=read_feed(root=Path(d))
            self.assertEqual([row['id'] for row in result['messages']],[42])
            self.assertEqual(result['messages'][0]['text'],'safe evidence')
    def test_symlinked_file_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);private=root/'private.txt';private.write_text('do not read')
            alias=root/'alias.jsonl'
            try:alias.symlink_to(private)
            except (OSError, NotImplementedError):self.skipTest('symlink privileges not available')
            self.assertEqual(_latest_lines(alias),[])
    def test_file_swapped_after_lstat_is_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);inbox=root/'inbox';inbox.mkdir()
            name=inbox/'role.jsonl';name.write_text('{"id": 1, "text": "original"}\n')
            other=root/'other.jsonl';other.write_text('{"id": 2, "text": "wrong file"}\n')
            original=os.open
            def swap_on_open(path,*args,**kwargs):
                if Path(path)==name:
                    name.unlink()
                    other.replace(name)
                return original(path,*args,**kwargs)
            with patch('agentchat_feed.os.open',side_effect=swap_on_open):
                self.assertEqual(_latest_lines(name),[])
    def test_missing_file_is_safe(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(_latest_lines(Path(d)/'missing.jsonl'),[])

if __name__=='__main__':unittest.main()
