import json
import unittest
from native_readiness import report
from variant_features import features

class NativeReadinessTests(unittest.TestCase):
    def test_all_options_correct_components_no_false_release_ready(self):
        for variant in (1,2,3,4):
            f=features(variant,native_windows=True)
            data=report(None,profile=f,probes={name:lambda:True for name in (
                'repoql_version','tencent_session','kanban_http','agent_chat_state',
                'unified_graph_gateway','claude_office_http','ghost_control_http','harness_rust_coordinator')})
            with self.subTest(option=variant):
                self.assertEqual(data['variant'],variant)
                self.assertFalse(data['release_ready'])
                self.assertEqual(data['repoql_required_version'],'1.7.18')
                for feature in ('claude_office_http','claude_office_event_delivery'):
                    self.assertEqual(data['services'][feature]['state']=='excluded',variant in (1,3))
                # Ghost is retired from the Windows product: excluded in every variant.
                for feature in ('ghost_control_http','ghost_prompt_editing'):
                    self.assertEqual(data['services'][feature]['state'],'excluded')
                self.assertEqual(data['services']['native_gui_session']['state'],'unverified')
                self.assertEqual(data['services']['harness_rust_coordinator']['state'],'reachable')
                self.assertEqual(data['services']['claude_office_event_delivery']['verified'], False)
                self.assertNotIn('api_key',json.dumps(data).lower())
                self.assertNotIn('password=',json.dumps(data).lower())

    def test_fail_closed_if_service_probe_throws(self):
        broken=lambda: (_ for _ in ()).throw(RuntimeError('sensitive-password'))
        probes={n:broken for n in ['repoql_version','tencent_session','kanban_http','agent_chat_state','harness_rust_coordinator','unified_graph_gateway','ghost_control_http','claude_office_http']}
        data=report(None,profile=features(4,native_windows=True),probes=probes)
        self.assertTrue(all(not row['verified'] for row in data['services'].values()))
        self.assertNotIn('sensitive-password',json.dumps(data))

if __name__=='__main__':unittest.main()
