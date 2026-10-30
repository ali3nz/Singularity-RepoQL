"""Only focused Option 2 read-only orchestration contract tests."""
from pathlib import Path
import json
import tempfile
import unittest
from unittest.mock import Mock

from claude_complete_windows_probe import inspect_inputs, _config
from native_runtime_acceptance import SCHEMA as CONFIG_SCHEMA

class WindowsProbeTests(unittest.TestCase):
    def setUp(self):
        temp=tempfile.TemporaryDirectory(); self.addCleanup(temp.cleanup)
        self.root=Path(temp.name);self.config=self.root/'config.json'
        self.config.write_text(json.dumps({
            'schema':CONFIG_SCHEMA,'variant':2,'repoql_version':'1.7.18',
            'files':{
                'repoql':'C:\\RepoQL\\rql.exe',
                'bridge':'C:\\Singularity\\singularity-desktop-bridge.exe',
                'supervisor':'C:\\Singularity\\singularity-windows-supervisor.exe',
                'gui':'C:\\Claude\\Claude.exe',
            },'health':[]}))
        self.bundle=self.root/'candidate.zip'
        self.inspect=Mock(return_value={'option':2,'bundle_sha256':'a'*64})
        self.prepared=Mock(return_value={'status':'PREPARED_CONTENT_VERIFIED_NOT_INSTALLED','release_ready':False,'verified_source_files':760,'verified_native_binaries':2})
        self.runtime=Mock(return_value={'variant':2,'public_release_ready':False,
            'binary_observations':{'repoql':{'status':'OBSERVED_VERSION_MATCH'}},'service_observations':{}})
        self.matrix=Mock(return_value={'release_ready':False,'required_gates':17,
            'not_run':17,'reported_pass_unreviewed':0,'reported_fail':0,'mixed_source_revisions':False})
    def call(self,**kwargs):
        return inspect_inputs(bundle=self.bundle,runtime_config=self.config,
            bundle_inspector=self.inspect,prepared_verifier=self.prepared,
            runtime_observer=self.runtime,evidence_matrix=self.matrix,**kwargs)
    def test_offline_never_runs_windows_observations(self):
        result=self.call(windows_host=False)
        self.assertEqual(result['mode'],'offline-plan'); self.assertFalse(result['release_ready'])
        self.prepared.assert_not_called();self.runtime.assert_not_called()
        self.assertNotIn(str(self.config),json.dumps(result))
    def test_live_requires_windows(self):
        with self.assertRaisesRegex(ValueError,'NATIVE_WINDOWS_REQUIRED'):
            self.call(live=True,prepared=self.root/'prepared',windows_host=False)
        self.prepared.assert_not_called()
    def test_live_requires_prepared(self):
        with self.assertRaisesRegex(ValueError,'PREPARED_CANDIDATE_REQUIRED'):
            self.call(live=True,windows_host=True)
    def test_valid_live_reports_observations_not_release(self):
        out=self.call(live=True,prepared=self.root/'prepared',windows_host=True,
                      evidence_dir=self.root)
        self.assertEqual(out['prepared_verification']['verified_native_binaries'],2)
        self.assertEqual(out['runtime_observation']['status'],'OBSERVED_NOT_CERTIFIED')
        self.assertEqual(out['acceptance_matrix']['not_run'],17)
        self.assertFalse(out['release_ready'])
        self.assertFalse(out['claude_gui_functionally_verified'])
        self.assertNotIn('C:\\',json.dumps(out))
    def test_invalid_variant_rejected_before_bundle_calls(self):
        data=json.loads(self.config.read_text());data['variant']=1
        self.config.write_text(json.dumps(data))
        with self.assertRaisesRegex(ValueError,'CLAUDE_CODE_COMPLETE_ONLY'):
            self.call()
        self.inspect.assert_not_called()
    def test_invalid_bundle_scope_rejected(self):
        self.inspect.return_value={'option':4}
        with self.assertRaisesRegex(ValueError,'OPTION2_ACCEPTANCE_BUNDLE_REQUIRED'):
            self.call()
    def test_prepared_verifier_must_not_claim_release(self):
        self.prepared.return_value={'status':'PREPARED_CONTENT_VERIFIED_NOT_INSTALLED','release_ready':True}
        with self.assertRaisesRegex(ValueError,'PREPARED_VERIFICATION_NOT_ACCEPTED'):
            self.call(live=True,prepared=self.root/'p',windows_host=True)
    def test_runtime_report_must_not_claim_release(self):
        self.runtime.return_value={'variant':2,'public_release_ready':True}
        with self.assertRaisesRegex(ValueError,'RUNTIME_REPORT_INVALID'):
            self.call(live=True,prepared=self.root/'p',windows_host=True)
    def test_matrix_must_not_claim_release(self):
        self.matrix.return_value={'release_ready':True}
        with self.assertRaisesRegex(ValueError,'EVIDENCE_REPORT_MUST_NOT_CERTIFY'):
            self.call(evidence_dir=self.root)

if __name__=='__main__':unittest.main()
