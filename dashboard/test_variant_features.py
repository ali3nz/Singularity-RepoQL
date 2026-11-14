import unittest
from variant_features import features, route_allowed

class FullClaudeCodeDashboard(unittest.TestCase):
    def test_single_complete_windows_profile(self):
        f=features(2,native_windows=True)
        self.assertEqual(f['gui'],'claude-desktop-code')
        self.assertFalse(f['features']['ghost'])
        for key in ('office','memory','repoql_dashboard','kanban','agent_chat','kanzo',
                    'openmausbot','tencent_connector','repoql_mcp'):
            self.assertTrue(f['features'][key],key)
        for path in ('/api/embed/office/handshake','/embed/office/index.html',
                     '/api/harness/office','/api/agentchat/feed','/embed/kanzo/index.html',
                     '/api/embed/kanzo/handshake','/api/connectors'):
            self.assertTrue(route_allowed(path,f),path)
    def test_windows_requires_explicit_single_profile(self):
        with self.assertRaises(ValueError): features('',native_windows=True)
        for value in ('0','1','3','4','5','garbage'):
            with self.assertRaises(ValueError): features(value,native_windows=True)
    def test_legacy_linux_defaults_are_not_changed(self):
        self.assertTrue(features('',native_windows=False)['features']['office'])

if __name__=='__main__':unittest.main()
