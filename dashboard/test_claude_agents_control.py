"""Native Windows Agents Control is scoped, revision checked and credential safe."""
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from claude_agents_control import agent_detail, list_agents, mcp_inventory, policy_inventory, restore_agent, save_agent

BODY = '---\nname: singularity-code-reviewer\ndescription: Review changed code with evidence.\ntools: Read, Grep, Glob\n---\n\nReview the supplied source and report defects.\n'


class AgentsControlTests(unittest.TestCase):
    def test_edit_revision_and_foreign_boundary(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            path = root / 'singularity-code-reviewer.md'
            path.write_text(BODY, encoding='utf8')
            (root / 'foreign.md').write_text('secret = abc', encoding='utf8')
            with patch.dict(os.environ, {'SINGULARITY_WINDOWS_NATIVE': '1', 'SINGULARITY_CLAUDE_AGENTS_DIR': td}):
                items = list_agents()['agents']
                self.assertFalse(next(x for x in items if x['name'] == 'foreign')['editable'])
                a = agent_detail('singularity-code-reviewer')
                with self.assertRaises(ValueError):
                    save_agent({'name': a['name'], 'content': BODY, 'revision': a['revision']})
                updated = BODY.replace('Review the supplied source', 'Review the evidence and source')
                result = save_agent({'confirm': True, 'name': a['name'], 'content': updated, 'revision': a['revision']})
                self.assertTrue(result['saved'])
                self.assertFalse(result['runtimeReloadVerified'])
                self.assertEqual(path.read_text(), updated)
                with self.assertRaises(PermissionError):
                    save_agent({'confirm': True, 'name': a['name'], 'content': BODY, 'revision': a['revision']})
                with self.assertRaises(ValueError):
                    save_agent({'confirm': True, 'name': a['name'],
                                'content': updated.replace('Read, Grep, Glob', 'Read, Grep, Glob, Edit'),
                                'revision': result['revision']})
                self.assertTrue((root / ('.singularity-code-reviewer.' + a['revision'][:16] + '.bak')).is_file())
                with self.assertRaises(ValueError):
                    agent_detail('singularity-fleet-reviewer')
                with self.assertRaises(ValueError):
                    agent_detail('../bad')

    def test_backups_metadata_are_bounded_and_content_is_private(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            path = root / 'singularity-code-reviewer.md'
            path.write_text(BODY, encoding='utf8')
            with patch.dict(os.environ, {'SINGULARITY_WINDOWS_NATIVE': '1', 'SINGULARITY_CLAUDE_AGENTS_DIR': td}):
                old = agent_detail('singularity-code-reviewer')
                changed = BODY + 'New guidance\n'
                save_agent({'confirm': True, 'name': old['name'], 'content': changed, 'revision': old['revision']})
                result = agent_detail('singularity-code-reviewer')
                self.assertEqual(len(result['backups']), 1)
                self.assertEqual(result['backups'][0]['revisionPrefix'], old['revision'][:16])
                self.assertNotIn(BODY, json.dumps(result['backups']))

    def test_policy_inventory_only_names_and_counts(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            claude = root / '.claude'
            (claude / 'rules').mkdir(parents=True)
            (claude / 'rules' / 'review.md').write_text('secret text not returned', encoding='utf8')
            (claude / 'settings.json').write_text(json.dumps({'hooks': {
                'SessionStart': [{'hooks': [{'command': 'secret command'}]}],
                'Stop': [{'hooks': [{'command': 'private stop'}]}],
            }, 'env': {'API_KEY': 'supersecret'}}), encoding='utf8')
            with patch.dict(os.environ, {'SINGULARITY_WINDOWS_NATIVE': '1', 'SINGULARITY_CLAUDE_PROJECT': ''}), patch('claude_agents_control.Path.home', return_value=root):
                result = policy_inventory()
                self.assertEqual(result['rules'], [{'scope': 'user', 'name': 'review.md'}])
                self.assertEqual({i['event'] for i in result['hooks']}, {'SessionStart', 'Stop'})
                self.assertNotIn('secret', json.dumps(result))
                self.assertEqual(result['verification'], 'registration_only_not_execution')

    def test_credentials_not_returned_by_mcp_inventory(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / '.claude.json').write_text(json.dumps({'mcpServers': {
                'repoql': {'command': 'rql', 'env': {'API_KEY': 'private value'}},
                'kanzo': {'url': 'http://127.0.0.1/?token=private value'},
            }}), encoding='utf8')
            with patch.dict(os.environ, {'SINGULARITY_WINDOWS_NATIVE': '1'}, clear=False), patch('claude_agents_control.Path.home', return_value=root):
                data = mcp_inventory()
                self.assertEqual({x['name'] for x in data['servers']}, {'repoql', 'kanzo'})
                self.assertNotIn('private value', json.dumps(data))

    def test_linux_not_available_and_no_symlink_writes(self):
        with patch.dict(os.environ, {'SINGULARITY_WINDOWS_NATIVE': '0'}):
            with self.assertRaises(FileNotFoundError):
                list_agents()
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            path = root / 'singularity-code-reviewer.md'
            target = root / 'target.md'
            target.write_text(BODY)
            path.symlink_to(target)
            with patch.dict(os.environ, {'SINGULARITY_WINDOWS_NATIVE': '1', 'SINGULARITY_CLAUDE_AGENTS_DIR': td}):
                with self.assertRaises(PermissionError):
                    agent_detail('singularity-code-reviewer')

# fleet#993 agents control gap suite: native per-agent permissionMode, value
# validation, guarded restore and required-integration presence without health claims.
EXTENDED = ('---\nname: singularity-code-reviewer\ndescription: Review with evidence.\n'
            'tools: Read, Grep, Glob\nmodel: sonnet\neffort: high\npermissionMode: plan\n---\n\n'
            'Review the supplied source.\n')


class AgentsControlGapTests(unittest.TestCase):
    def test_model_effort_and_permission_mode_round_trip(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            path = root / 'singularity-code-reviewer.md'
            path.write_text(EXTENDED, encoding='utf8')
            with patch.dict(os.environ, {'SINGULARITY_WINDOWS_NATIVE': '1', 'SINGULARITY_CLAUDE_AGENTS_DIR': td}):
                detail = agent_detail('singularity-code-reviewer')
                self.assertEqual(detail['metadata']['model'], 'sonnet')
                self.assertEqual(detail['metadata']['effort'], 'high')
                self.assertEqual(detail['metadata']['permissionMode'], 'plan')
                listed = next(x for x in list_agents()['agents'] if x['name'] == 'singularity-code-reviewer')
                self.assertEqual(listed['permissionMode'], 'plan')
                updated = EXTENDED.replace('Review with evidence.', 'Review with evidence and tests.')
                result = save_agent({'confirm': True, 'name': detail['name'],
                                     'content': updated, 'revision': detail['revision']})
                self.assertTrue(result['saved'])
                after = agent_detail('singularity-code-reviewer')
                self.assertEqual(after['content'], updated)
                self.assertEqual(after['metadata']['model'], 'sonnet')
                self.assertEqual(after['metadata']['effort'], 'high')
                self.assertEqual(after['metadata']['permissionMode'], 'plan')

    def test_escalating_permission_mode_and_invalid_values_are_refused(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            path = root / 'singularity-code-reviewer.md'
            path.write_text(EXTENDED, encoding='utf8')
            with patch.dict(os.environ, {'SINGULARITY_WINDOWS_NATIVE': '1', 'SINGULARITY_CLAUDE_AGENTS_DIR': td}):
                current = agent_detail('singularity-code-reviewer')
                for needle, replacement in (
                        ('permissionMode: plan', 'permissionMode: bypassPermissions'),
                        ('permissionMode: plan', 'permissionMode: auto'),
                        ('effort: high', 'effort: turbo'),
                        ('model: sonnet', 'model: sonnet!')):
                    attempt = EXTENDED.replace(needle, replacement)
                    with self.assertRaises(ValueError):
                        save_agent({'confirm': True, 'name': current['name'],
                                    'content': attempt, 'revision': current['revision']})
                self.assertEqual(path.read_text(), EXTENDED)
                self.assertEqual(agent_detail('singularity-code-reviewer')['revision'], current['revision'])

    def test_restore_is_validated_guarded_and_reversible(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            path = root / 'singularity-code-reviewer.md'
            path.write_text(EXTENDED, encoding='utf8')
            with patch.dict(os.environ, {'SINGULARITY_WINDOWS_NATIVE': '1', 'SINGULARITY_CLAUDE_AGENTS_DIR': td}):
                original = agent_detail('singularity-code-reviewer')
                changed = EXTENDED + '\nAdded guidance.\n'
                saved = save_agent({'confirm': True, 'name': original['name'],
                                    'content': changed, 'revision': original['revision']})
                self.assertTrue(saved['saved'])
                prefix = original['revision'][:16]
                backups = agent_detail('singularity-code-reviewer')['backups']
                self.assertEqual([b['revisionPrefix'] for b in backups], [prefix])
                restored = restore_agent({'confirm': True, 'name': original['name'],
                                          'backup': prefix, 'revision': saved['revision']})
                self.assertTrue(restored['restored'])
                self.assertEqual(restored['revision'], original['revision'])
                self.assertFalse(restored['runtimeReloadVerified'])
                self.assertEqual(path.read_text(), EXTENDED)
                # The replaced content stays recoverable, so a restore is reversible.
                self.assertEqual({b['revisionPrefix'] for b in agent_detail('singularity-code-reviewer')['backups']},
                                 {original['revision'][:16], saved['revision'][:16]})
                # A stale editor revision is refused; the same bytes with the current
                # revision are simply unchanged, never rewritten.
                with self.assertRaises(PermissionError):
                    restore_agent({'confirm': True, 'name': original['name'],
                                   'backup': prefix, 'revision': saved['revision']})
                with self.assertRaises(ValueError):
                    restore_agent({'confirm': True, 'name': original['name'],
                                   'backup': '../escape', 'revision': original['revision']})
                with self.assertRaises(ValueError):
                    restore_agent({'confirm': True, 'name': original['name'],
                                   'backup': prefix})
                bad = root / ('.' + original['name'] + '.' + prefix + '.bak')
                bad.write_text('tampered content', encoding='utf8')
                with self.assertRaises(PermissionError):
                    restore_agent({'confirm': True, 'name': original['name'],
                                   'backup': prefix, 'revision': original['revision']})

    def test_foreign_agent_bytes_survive_an_owned_save(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / 'singularity-code-reviewer.md').write_text(EXTENDED, encoding='utf8')
            foreign = root / 'foreign.md'
            foreign.write_text('user owned bytes\n', encoding='utf8')
            with patch.dict(os.environ, {'SINGULARITY_WINDOWS_NATIVE': '1', 'SINGULARITY_CLAUDE_AGENTS_DIR': td}):
                current = agent_detail('singularity-code-reviewer')
                save_agent({'confirm': True, 'name': current['name'],
                            'content': EXTENDED + '\nMore.\n', 'revision': current['revision']})
                self.assertEqual(foreign.read_text(), 'user owned bytes\n')

    def test_required_integrations_report_presence_without_health_claims(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / '.claude.json').write_text(json.dumps({'mcpServers': {
                'repoql': {'command': 'rql', 'env': {'API_KEY': 'private value'}},
                'kanzo': {'url': 'http://127.0.0.1/?token=private value'},
            }}), encoding='utf8')
            with patch.dict(os.environ, {'SINGULARITY_WINDOWS_NATIVE': '1'}, clear=False), patch('claude_agents_control.Path.home', return_value=root):
                data = mcp_inventory()
                self.assertEqual(data['required']['repoql']['status'], 'configured')
                self.assertEqual(data['required']['kanzo']['status'], 'configured')
                self.assertEqual(data['required']['memorycore']['status'], 'not_verified')
                self.assertEqual(data['required']['openmausbot']['status'], 'missing')
                self.assertEqual(data['required']['memorycore']['reason'],
                                 'connector_registration_not_inspected')
                self.assertEqual(sorted(data['requiredMissing']), ['openmausbot'])
                self.assertFalse(data['liveHealthClaimed'])
                self.assertEqual(data['verification'], 'configuration_only_no_live_tool_calls')
                self.assertNotIn('private value', json.dumps(data))

    def test_lookalike_server_names_never_report_a_required_integration(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / '.claude.json').write_text(json.dumps({'mcpServers': {
                'not-memorycore': {'command': 'x'},
                'repoql-test': {'command': 'x'},
                'combo-tools': {'command': 'x'},
                'kanzo-wrapper': {'command': 'x'},
            }}), encoding='utf8')
            with patch.dict(os.environ, {'SINGULARITY_WINDOWS_NATIVE': '1'}, clear=False), patch('claude_agents_control.Path.home', return_value=root):
                data = mcp_inventory()
                for key in ('repoql', 'kanzo', 'memorycore'):
                    self.assertEqual(data['required'][key]['status'], 'not_verified', key)
                    self.assertEqual(data['required'][key]['servers'], [], key)
                self.assertEqual(data['required']['openmausbot']['status'], 'missing')
                self.assertEqual(sorted(data['requiredMissing']), ['openmausbot'])
                self.assertEqual(sorted(data['requiredNotVerified']), ['kanzo', 'memorycore', 'repoql'])
                self.assertEqual(data['required']['repoql']['unknownWrappers'], ['repoql-test'])
                self.assertEqual(data['required']['kanzo']['unknownWrappers'], ['kanzo-wrapper'])
                self.assertFalse(data['liveHealthClaimed'])

    def test_exact_names_are_case_insensitive_but_never_substring_matched(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / '.claude.json').write_text(json.dumps({'mcpServers': {
                'RepoQL': {'command': 'x'},
                'kanzo': {'command': 'x'},
                'OpenMausBot': {'command': 'x'},
                'openmausbot-legacy': {'command': 'x'},
            }}), encoding='utf8')
            with patch.dict(os.environ, {'SINGULARITY_WINDOWS_NATIVE': '1'}, clear=False), patch('claude_agents_control.Path.home', return_value=root):
                data = mcp_inventory()
                self.assertEqual(data['required']['repoql']['servers'], ['RepoQL'])
                self.assertEqual(data['required']['kanzo']['servers'], ['kanzo'])
                self.assertEqual(data['required']['openmausbot']['servers'], ['OpenMausBot'])
                self.assertEqual(data['required']['openmausbot']['unknownWrappers'], ['openmausbot-legacy'])
                self.assertEqual(data['required']['memorycore']['status'], 'not_verified')


if __name__ == '__main__':
    unittest.main()
