import json
import unittest
from native_readiness import report
from variant_features import features

class NativeReadinessTests(unittest.TestCase):
    def test_single_full_profile_no_false_release_ready(self):
        variant = 2
        f = features(variant, native_windows=True)
        data = report(None, profile=f, probes={name: lambda: True for name in (
            'repoql_version', 'tencent_session', 'kanban_http', 'agent_chat_state',
            'unified_graph_gateway', 'claude_office_http', 'harness_rust_coordinator')})
        self.assertEqual(data['variant'], 2)
        self.assertFalse(data['release_ready'])
        self.assertEqual(data['repoql_required_version'], '1.7.18')
        self.assertEqual(data['services']['claude_office_http']['state'], 'reachable')
        self.assertEqual(data['services']['claude_office_event_delivery']['state'], 'unverified')
        self.assertFalse([k for k in data['services'] if 'ghost' in k])
        self.assertEqual(data['services']['native_gui_session']['state'], 'unverified')
        self.assertEqual(data['services']['harness_rust_coordinator']['state'], 'reachable')
        self.assertFalse(data['services']['claude_office_event_delivery']['verified'])
        self.assertNotIn('api_key', json.dumps(data).lower())
        self.assertNotIn('password=', json.dumps(data).lower())

    def test_retired_install_profiles_rejected(self):
        for option in (1, 3, 4):
            with self.subTest(option=option), self.assertRaises(ValueError):
                features(option, native_windows=True)

    def test_fail_closed_if_service_probe_throws(self):
        broken=lambda: (_ for _ in ()).throw(RuntimeError('sensitive-password'))
        probes={n:broken for n in ['repoql_version','tencent_session','kanban_http','agent_chat_state','harness_rust_coordinator','unified_graph_gateway','claude_office_http']}
        data=report(None,profile=features(2,native_windows=True),probes=probes)
        self.assertTrue(all(not row['verified'] for row in data['services'].values()))
        self.assertNotIn('sensitive-password',json.dumps(data))

if __name__=='__main__':unittest.main()
