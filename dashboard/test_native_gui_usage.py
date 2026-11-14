"""The single Windows Claude Code profile must show only its own receipts."""
import os
import unittest
from unittest.mock import patch
from native_gui_usage import project
from variant_features import features
from unified_bridge import forward_unified


class NativeGuiUsageTests(unittest.TestCase):
    def setUp(self):
        self.payload = {
            'available': True, 'input_tokens_recorded': 999999, 'output_tokens_recorded': 888888,
            'daily': [{'day': '2026-10-28', 'input_tokens': 999999}],
            'freebuff': {'token': 'SECRET_NEVER_LEAK'},
            'sources': [
                {'id': 'freebuff', 'events': 500},
                {'id': 'claude-desktop-code', 'events': 7, 'status': 'ok'},
                {'id': 'openchamber-desktop-subscription', 'events': 4, 'status': 'ok'},
            ],
            'recent': [
                {'source':'freebuff', 'input_tokens':999999, 'model':'test'},
                {'source':'claude-desktop-code','timestamp':'2026-10-28T09:00:00Z', 'input_tokens':35, 'output_tokens':11, 'token': 'SECRET_NEVER_LEAK'},
                {'source':'openchamber-desktop-subscription','timestamp':'2026-10-28T10:00:00Z', 'input_tokens':48, 'output_tokens':15},
            ], 'collected_at':'2026-10-28T11:00:00Z'
        }

    def test_single_full_claude_profile_excludes_other_gui_and_aggregates(self):
        got = project(self.payload, profile=features(2, native_windows=True))
        self.assertTrue(got['available'])
        self.assertEqual(got['expected_source'], 'claude-desktop-code')
        self.assertEqual(len(got['recent']), 1)
        self.assertEqual(got['recent'][0]['source'], 'claude-desktop-code')
        self.assertEqual([row['id'] for row in got['sources']], ['claude-desktop-code'])
        self.assertIsNone(got['input_tokens_recorded'])
        self.assertIsNone(got['output_tokens_recorded'])
        self.assertIsNone(got['allowance'])
        self.assertIsNone(got['freebuff'])
        self.assertEqual(got['daily'], [])
        self.assertNotIn('SECRET_NEVER_LEAK', str(got))
        self.assertNotIn('freebuff', str(got['sources']))

    def test_empty_is_unknown_not_zero(self):
        got=project({'available':True,'sources':[],'recent':[]},profile=features(2,native_windows=True))
        self.assertEqual(got['measurement_status'],'NO_VERIFIED_GUI_RECEIPTS')
        self.assertIsNone(got['input_tokens_recorded'])

    def test_missing_source_and_malicious_tokens_fail_closed(self):
        got=project({'available':True,'recent':[{'source':'claude-desktop-code','input_tokens':True,'output_tokens':-15,
                                                  'model':'X'*10000,'url':'https://secret/'}]},profile=features(2,native_windows=True))
        self.assertIsNone(got['recent'][0]['input_tokens'])
        self.assertIsNone(got['recent'][0]['output_tokens'])
        self.assertIsNone(got['recent'][0]['model'])
        self.assertNotIn('https://secret',str(got))

    def test_unconfigured_source_cannot_be_claimed(self):
        got=project(self.payload,profile={'gui':'unknown'})
        self.assertFalse(got['available'])

    def test_upstream_error_stays_unavailable(self):
        got=project({'available':False,'recent':self.payload['recent']},profile=features(2,native_windows=True))
        self.assertFalse(got['available'])
        self.assertEqual(got['recent'],[])

    def test_request_path_uses_variant_scoping(self):
        from unittest.mock import patch as mock_patch
        with patch.dict(os.environ,{'SINGULARITY_WINDOWS_NATIVE':'1','SINGULARITY_INSTALL_VARIANT':'2'}), \
             mock_patch('unified_bridge._native_origin_failure',return_value=None), \
             mock_patch('unified_bridge._fetch_upstream',return_value=self.payload):
            result=forward_unified('GET','/api/unified/usage',{'days':'30'})
            self.assertEqual(result['recent'][0]['source'],'claude-desktop-code')
            self.assertEqual(result['gui'],'claude-desktop-code')

if __name__=='__main__':unittest.main()
