import tempfile
import unittest
from pathlib import Path
from audit_portability import inspect, ROOT
from compare_production_parity import mandatory

class PortabilityAuditTests(unittest.TestCase):
    def test_never_declares_native_release_ready(self):
        result=inspect(ROOT,[])
        self.assertFalse(result['native_release_ready'])
        self.assertEqual(result['windows_native_runtime_test_evidence'],'NOT_RUN')
        self.assertGreaterEqual(len(result['findings']),10)
    def test_all_four_options_require_capture_recall_and_learning(self):
        for n in (1,2,3,4):
            needed=set(mandatory(n))
            self.assertTrue({'automatic_capture','new_session_recall',
                             'verified_doc_ingestion','gated_knowledge_promotion'}.issubset(needed))
    def test_full_requires_ghost_and_office(self):
        for n in (2,4):
            self.assertIn('ghost_dream_recovery',mandatory(n))
            self.assertIn('office_dashboard_embed',mandatory(n))

if __name__=='__main__':unittest.main()
