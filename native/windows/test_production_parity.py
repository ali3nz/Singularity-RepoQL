import copy
from datetime import datetime, timezone, timedelta
import unittest
from compare_production_parity import SCHEMA, mandatory, compare

NOW=datetime(2026,10,29,1,0,tzinfo=timezone.utc)

def fixture(runtime, variant=1):
    keys=mandatory(variant)
    return {'schema':SCHEMA,'product':'Singularity RepoQL','runtime':runtime,
            'repoql_version':'1.7.15' if runtime == 'production-linux-docker' else '1.7.18','connector_abi':1,'variant':variant,
            'checks':{name:{'result':'PASS','evidence_id':'local-test-receipt-001',
                             'observed_at':NOW.isoformat()} for name in keys}}

class ParityGate(unittest.TestCase):
    def setUp(self):
        self.a=fixture('production-linux-docker')
        self.b=fixture('native-windows-no-wsl')
    def test_evidence_both_hosts_required(self):
        self.assertTrue(compare(self.a,self.b,now=NOW)['ready'])
        del self.b['checks']['new_session_recall']
        self.assertFalse(compare(self.a,self.b,now=NOW)['ready'])
    def test_stale_and_missing_are_not_pass(self):
        self.b['checks']['verified_doc_ingestion']['observed_at']=(NOW-timedelta(days=90)).isoformat()
        self.assertFalse(compare(self.a,self.b,now=NOW)['ready'])
        self.b['checks']['verified_doc_ingestion']['observed_at']=NOW.isoformat()
        self.b['checks']['verified_doc_ingestion']['evidence_id']=''
        self.assertFalse(compare(self.a,self.b,now=NOW)['ready'])
    def test_synthetic_cannot_authorize_release(self):
        self.b['checks']['automatic_capture']['synthetic']=True
        self.assertFalse(compare(self.a,self.b,now=NOW)['ready'])
    def test_complete_options_require_ghost_office(self):
        a=fixture('production-linux-docker',2);b=fixture('native-windows-no-wsl',2)
        self.assertTrue(compare(a,b,now=NOW)['ready'])
        del b['checks']['ghost_dream_recovery']
        self.assertFalse(compare(a,b,now=NOW)['ready'])
    def test_wrong_versions_or_runtime_block(self):
        self.b['repoql_version']='1.7.15'
        self.assertFalse(compare(self.a,self.b,now=NOW)['ready'])
        self.b['repoql_version']='1.7.15';self.b['runtime']='wsl'
        self.assertFalse(compare(self.a,self.b,now=NOW)['ready'])
    def test_existing_production_version_can_remain_115(self):
        self.assertEqual(self.a['repoql_version'], '1.7.15')
        self.assertEqual(self.b['repoql_version'], '1.7.18')
        self.assertTrue(compare(self.a, self.b, now=NOW)['ready'])
        self.a['repoql_version'] = '1.7.18'
        self.assertTrue(compare(self.a, self.b, now=NOW)['ready'])
        self.a['repoql_version'] = '1.7.17'
        self.assertFalse(compare(self.a, self.b, now=NOW)['ready'])
    def test_default_no_evidence_never_passes(self):
        self.assertFalse(compare({'schema':SCHEMA},{'schema':SCHEMA,'variant':4},now=NOW)['ready'])
    def test_invalid_options(self):
        for value in (0, 5, '1', True, None):
            with self.assertRaises(ValueError):mandatory(value)

if __name__=='__main__': unittest.main()
