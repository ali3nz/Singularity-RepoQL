"""Offline, non-mutating Windows MemoryCore ledger upgrade acceptance tests."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import Mock
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from memory_ledger_upgrade_audit import SCHEMA, _read_ledger, audit, project_reference


class LedgerUpgradeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / "workspace"
        self.root.mkdir()
        self.doc = self.root / "documentation" / "current.md"
        self.doc.parent.mkdir()
        self.doc.write_text("# Current documentation\nverified\n", encoding="utf-8")
        from memory_ledger_upgrade_audit import _load_module
        self.mod = _load_module()
        self.rev = self.mod.sha(self.doc.read_text())[:8]
        self.ledger = {"version": 1, "docs": {
            "one": {"root": str(self.root), "rel": "documentation/current.md",
                    "active_rev": self.rev, "revs": {self.rev: {
                        "status": "DOC_INGEST_INDEXED", "verified_at": "2026-11-13T01:00:00Z",
                        "chunks": 1, "task_ids": ["doc-task-01"], "hashes": ["01234567"]
                    }}}
        }}

    def test_verified_current_source_is_eligible_for_further_upgrade_checks(self):
        result = audit(self.ledger, self.root)
        self.assertEqual(result, {"schema":SCHEMA, "checked":1, "ready":True, "failures":[]})

    def test_empty_ledger_is_not_upgrade_evidence(self):
        self.assertFalse(audit({"docs":{}}, self.root)["ready"])

    def test_rejects_stale_and_newer_unresolved_revisions(self):
        self.doc.write_text("# Changed since indexing\n", encoding="utf-8")
        result = audit(self.ledger,self.root)
        self.assertEqual(result["failures"], [{"index":0,"reason":"stale_source"}])
        self.doc.write_text("# Current documentation\nverified\n", encoding="utf-8")
        self.ledger["docs"]["one"]["revs"]["deadbeef"] = {
            "status":"DOC_INGEST_PENDING", "ingested_at":"2026-11-13T02:00:00Z"}
        self.assertEqual(audit(self.ledger,self.root)["failures"],
                         [{"index":0,"reason":"unresolved_newer_revision"}])

    def test_root_and_source_containment_fail_closed(self):
        other = Path(self.tmp.name) / "untrusted"
        other.mkdir()
        self.ledger["docs"]["one"]["root"] = str(other)
        self.assertEqual(audit(self.ledger,self.root)["failures"][0]["reason"], "unauthorized_root")
        self.ledger["docs"]["one"]["root"] = str(self.root)
        self.doc.unlink()
        self.assertEqual(audit(self.ledger,self.root)["failures"][0]["reason"], "missing_source")
        self.doc.symlink_to(self.root / "README.md")
        self.assertEqual(audit(self.ledger,self.root)["failures"][0]["reason"], "missing_source")

    def test_native_receives_only_boolean_facts_and_exact_result_required(self):
        expected = audit(self.ledger,self.root)
        fake = Mock(return_value=subprocess.CompletedProcess([],0,json.dumps(expected),""))
        native = self.root / "bin.exe"
        native.write_bytes(b"fixture")
        result = audit(self.ledger,self.root,native,runner=fake)
        self.assertEqual(result,expected)
        positional,kw = fake.call_args
        self.assertEqual(positional, ([str(native)],))
        self.assertFalse(kw["shell"])
        self.assertEqual(kw["timeout"],10)
        request = json.loads(kw["input"])
        self.assertEqual(request["schema"],SCHEMA)
        self.assertEqual(set(request["documents"][0]),
                         {"root_authorized","source_exists","active","hash_equal",
                          "indexed","verified","chunks_complete","newer_unresolved"})
        self.assertNotIn(str(self.root),kw["input"])
        self.assertNotIn("doc-task-01",kw["input"])
        self.assertNotIn("verified_at",kw["input"])
        fake.return_value=subprocess.CompletedProcess([],0,json.dumps({**expected,"ready":False}),"")
        with self.assertRaisesRegex(RuntimeError,"NATIVE_MISMATCH"):
            audit(self.ledger,self.root,native,runner=fake)

    def test_incomplete_chunk_and_duplicate_task_ids_refused(self):
        rec=self.ledger["docs"]["one"]["revs"][self.rev]
        rec["chunks"]=2
        rec["task_ids"]=["duplicate","duplicate"]
        rec["hashes"]=["01234567","89abcdef"]
        self.assertEqual(audit(self.ledger,self.root)["failures"][0]["reason"], "incomplete_chunks")

    def test_ledger_file_contract_and_limits(self):
        path=Path(self.tmp.name)/"ledger.json"
        path.write_text(json.dumps(self.ledger))
        self.assertEqual(_read_ledger(path)["version"],1)
        path.write_text('{broken')
        with self.assertRaisesRegex(ValueError,"ledger cannot be read"):
            _read_ledger(path)
        path.write_text(json.dumps({"version":True,"docs":{}}))
        with self.assertRaisesRegex(ValueError,"schema invalid"):
            _read_ledger(path)

    def test_python_reference_rejects_private_fields_and_non_boolean(self):
        good={k:True for k in ("root_authorized","source_exists","active", "hash_equal",
                                 "indexed","verified","chunks_complete")}
        good["newer_unresolved"]=False
        self.assertTrue(project_reference([good])["ready"])
        for modified in ({**good,"source_exists":1}, {**good,"content":"secret"},
                         {**good,"newer_unresolved":None}):
            with self.assertRaisesRegex(ValueError,"invalid ledger fact"):
                project_reference([modified])


if __name__ == '__main__':
    unittest.main()
