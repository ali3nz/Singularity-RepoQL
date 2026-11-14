"""Read-only Rust validation of parsed agent metadata; Python retains approvals."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from claude_agents_control import _frontmatter

NAME='singularity-code-reviewer'
BODY=('---\nname: singularity-code-reviewer\ndescription: Review code from evidence\n'
      'model: sonnet\neffort: high\ntools: Read, Grep, Glob\npermissionMode: plan\n'
      '---\n\nPRIVATE_AGENT_INSTRUCTIONS must not be passed to Rust.\n')


class ClaudeAgentFieldRustBridgeTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.bin=Path(self.temp.name)/'singularity-claude-agent-fields.exe'
        self.bin.write_bytes(b'fixture')
        self.metadata=_frontmatter(BODY,NAME)

    def test_python_reference_unchanged_without_opt_in(self):
        with patch.dict(os.environ,{'SINGULARITY_CLAUDE_AGENT_FIELDS_RUST_BINARY':''}):
            self.assertEqual(_frontmatter(BODY,NAME),self.metadata)
        self.assertEqual(self.metadata['tools'],'Read, Grep, Glob')
        self.assertEqual(self.metadata['permissionMode'],'plan')

    def test_opt_in_only_forwards_six_fields_not_instructions_or_paths(self):
        response=subprocess.CompletedProcess([],0,json.dumps({'metadata':self.metadata}),'')
        with patch.dict(os.environ,{'SINGULARITY_CLAUDE_AGENT_FIELDS_RUST_BINARY':str(self.bin),
                                     'PRIVATE_API_KEY':'private'}), \
             patch('claude_agents_control.subprocess.run',return_value=response) as run:
            self.assertEqual(_frontmatter(BODY,NAME),self.metadata)
        opts=run.call_args.kwargs
        request=json.loads(opts['input'])
        self.assertEqual(request,{'schema':'singularity-claude-agent-fields/v1',
                                  'owner_name':NAME,'metadata':self.metadata})
        self.assertNotIn('PRIVATE_AGENT_INSTRUCTIONS',opts['input'])
        self.assertNotIn('PRIVATE_API_KEY',opts['env'])
        self.assertEqual(opts['timeout'],8)
        self.assertFalse(opts['shell'])

    def test_mismatch_and_process_failure_rejected(self):
        for result,code in ((json.dumps({'metadata':dict(self.metadata, permissionMode='bypassPermissions')}),0),
                            (json.dumps({'metadata':self.metadata,'verified':True}),0),
                            ('not-json',0),('',1)):
            with self.subTest(result=result), patch.dict(os.environ,
                {'SINGULARITY_CLAUDE_AGENT_FIELDS_RUST_BINARY':str(self.bin)}), \
                 patch('claude_agents_control.subprocess.run',return_value=
                       subprocess.CompletedProcess([],code,result,'')):
                with self.assertRaises(RuntimeError):_frontmatter(BODY,NAME)

    def test_binary_path_and_symlink_guards(self):
        for path in ('relative.exe',str(self.bin.parent/'missing.exe')):
            with patch.dict(os.environ,{'SINGULARITY_CLAUDE_AGENT_FIELDS_RUST_BINARY':path}):
                with self.assertRaisesRegex(RuntimeError,'binary_invalid'):
                    _frontmatter(BODY,NAME)
        link=self.bin.parent/'symlink.exe'
        try:link.symlink_to(self.bin)
        except (OSError,NotImplementedError):return
        with patch.dict(os.environ,{'SINGULARITY_CLAUDE_AGENT_FIELDS_RUST_BINARY':str(link)}):
            with self.assertRaisesRegex(RuntimeError,'binary_invalid'):
                _frontmatter(BODY,NAME)

    def test_original_privilege_and_reviewer_guards_still_run_first(self):
        with patch.dict(os.environ,{'SINGULARITY_CLAUDE_AGENT_FIELDS_RUST_BINARY':str(self.bin)}), \
             patch('claude_agents_control.subprocess.run') as run:
            for bad in (BODY.replace('permissionMode: plan','permissionMode: bypassPermissions'),
                        BODY.replace('Read, Grep, Glob','Read, Bash'),
                        BODY.replace('model: sonnet','model: bogus;escape')):
                with self.assertRaises(ValueError):_frontmatter(bad,NAME)
            run.assert_not_called()


if __name__=='__main__':unittest.main()
