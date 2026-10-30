import json
from pathlib import Path
import tempfile
import unittest
from plan_option2_upgrade import upgrade_plan


class UpgradePlanTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.stage = self.root / 'stage'
        self.home = self.root / 'home'
        self.workspace = self.root / 'workspace'
        for p in (self.stage, self.home, self.workspace): p.mkdir()

    def receipt(self, at, rel, payload=None):
        p = at / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(payload or {'schema':'test'}), encoding='utf8')

    def plan(self, state='ABSENT'):
        return upgrade_plan(self.stage, self.home, self.workspace, state, 'ABSENT')

    def test_dashboard_task_blocks_stage_replacement(self):
        p=upgrade_plan(self.stage,self.home,self.workspace,'ABSENT','REGISTERED')
        self.assertFalse(p['dependencies_cleared_for_stage_replacement'])
        self.assertIn('REMOVE_OWNED_DASHBOARD_AFTER_VERIFYING_TASK_OWNER',p['ordered_operator_actions'])
        self.assertFalse(upgrade_plan(self.stage,self.home,self.workspace,'ABSENT','UNKNOWN')['first_stage_clear'])

    def test_clean_first_stage(self):
        p = self.plan()
        self.assertTrue(p['first_stage_clear'])
        self.assertFalse(p['release_ready'])
        self.assertFalse(p['performed_changes'])

    def test_missing_scheduler_evidence_blocks_promotion(self):
        self.assertFalse(self.plan('UNKNOWN')['dependencies_cleared_for_stage_replacement'])
        self.assertIn('VERIFY_NATIVE_SCHEDULER_TASK_OWNERSHIP', self.plan('UNKNOWN')['ordered_operator_actions'])

    def test_owned_stage_with_managed_references(self):
        self.receipt(self.stage, 'current/STAGING_RECEIPT.json')
        self.receipt(self.home, '.claude/.singularity-native-claude-journal.json')
        self.receipt(self.workspace, '.singularity-native-mcp-receipt.json')
        self.receipt(self.home, '.claude/.singularity-parent-memory-proxy-receipt.json',
                     {'schema':'singularity-option2-parent-proxy/v1'})
        p = self.plan('REGISTERED')
        self.assertFalse(p['existing_owned_stage_can_be_replaced'])
        self.assertEqual(p['ordered_operator_actions'][:3], [
            'REMOVE_OWNED_SUPERVISOR_AFTER_VERIFYING_TASK_OWNER',
            'ROLLBACK_RECEIPT_OWNED_PARENT_PROXY',
            'ROLLBACK_RECEIPT_OWNED_CLAUDE_AND_KANZO'])

    def test_owned_stage_clear_for_replacement(self):
        self.receipt(self.stage, 'current/STAGING_RECEIPT.json')
        self.assertTrue(self.plan()['existing_owned_stage_can_be_replaced'])

    def test_unknown_stage_directory_refused(self):
        (self.stage / 'current').mkdir()
        with self.assertRaisesRegex(ValueError, 'UNOWNED_STAGE'): self.plan()

    def test_upgrade_snapshot_not_claimed_safe_for_replace(self):
        self.receipt(self.stage, 'current/STAGING_RECEIPT.json')
        self.receipt(self.stage, 'previous/STAGING_RECEIPT.json')
        p = self.plan()
        self.assertFalse(p['existing_owned_stage_can_be_replaced'])
        self.assertIn('REVIEW_UPGRADE_SNAPSHOT_BEFORE_STAGE_REPLACEMENT',p['ordered_operator_actions'])

    def test_symlinked_document_refused(self):
        target=self.root / 'original';target.write_text('{}')
        link=self.stage / 'current'
        try: link.symlink_to(target)
        except OSError: self.skipTest('symlinks unavailable')
        with self.assertRaisesRegex(ValueError,'REPARSE'):self.plan()

    def test_bad_parent_schema_refused(self):
        self.receipt(self.home, '.claude/.singularity-parent-memory-proxy-receipt.json')
        with self.assertRaisesRegex(ValueError,'SCHEMA_INVALID'):self.plan()

if __name__ == '__main__':unittest.main()
