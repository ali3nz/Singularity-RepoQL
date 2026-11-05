"""Check the known Kanzo historical indexed-view source defect without claiming binary acceptance."""
from pathlib import Path
import hashlib
import json
import unittest

ROOT=Path(__file__).resolve().parents[2]

class KanzoImportedViewSource(unittest.TestCase):
    def test_view_reads_json_from_node_not_derived_task_projection(self):
        sql=(ROOT/'connectors/kanzo/sql/imported_tasks.sql').read_text()
        self.assertIn("FROM node",sql)
        self.assertNotIn('FROM kanzo_tasks',sql)
        self.assertIn("kind = 'document'",sql)
        self.assertIn("uri LIKE 'kanzo://%/tasks/%.md'",sql)
        self.assertIn("$.frontmatter.migrated",sql)
        for field in ('key','title','status','outcome','closure_reason','operator_signoff',
                      'legacy_number','legacy_owner','source_key','source_sha256','imported_at'):
            self.assertIn(f"'$.frontmatter.{field}'",sql)
    def test_source_manifest_hash_is_correct_and_package_pin_not_fabricated(self):
        sql=(ROOT/'connectors/kanzo/sql/imported_tasks.sql').read_bytes()
        hashes=(ROOT/'connectors/kanzo/SOURCE-SHA256').read_text().splitlines()
        matches=[line for line in hashes if line.endswith('  sql/imported_tasks.sql')]
        self.assertEqual(matches,[hashlib.sha256(sql).hexdigest()+'  sql/imported_tasks.sql'])
        lock=json.loads((ROOT/'connectors/packages.lock.json').read_text())
        kanzo=next(p for p in lock['packages'] if p['scheme']=='kanzo')
        self.assertEqual(kanzo['version'],'1.0.0')
        self.assertEqual(kanzo['sha256'],'d2997efd778ad02925c0cd6b3742cb2e57f6b0d8ee8cb42fd5e7ef1e962ad2e7')
        # A new package has not been rebuilt, so publication remains gated.

if __name__=='__main__':unittest.main()
