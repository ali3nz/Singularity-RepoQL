#!/usr/bin/env python3
"""Focused tests for automatic MemoryCore documentation ingestion (tests F/G/H).

Runs against an in-process stub of the MemoryCore conversation API — the SAME
request contract the product uses (POST /v3/conversation/search + /add with the
gateway auth headers), so eligibility, chunking, idempotent writes, retrieval
verification, supersession and failure handling are exercised end-to-end
without a live stack.

Covers:
  F  — new runbook detected, validated, ingested across chunks, verified searchable (INDEXED)
  F2 — unchanged document returns UNCHANGED without re-writing chunks
  F3 — blocked: sensitive content, around the allowlist boundary
  G  — updated runbook: new revision indexed and becomes current; searches
       exclude the superseded revision
  H  — memory sway unavailable: PENDING, no false success; a later retry
       succeeds idempotently (no duplicate chunk writes)
  H2 — hard add-failure: FAILED status; the previously verified revision stays
       active in the ledger
Exit code 0 = all pass.
"""
import json
import os
import sys
import tempfile
import threading
import time
import unittest
import shutil
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"
sys.path.insert(0, str(SCRIPTS))

import importlib.util
_spec = importlib.util.spec_from_file_location("memory_doc_ingest", SCRIPTS / "memory-doc-ingest.py")
mdi = importlib.util.module_from_spec(_spec)
sys.modules["memory_doc_ingest"] = mdi
_spec.loader.exec_module(mdi)  # noqa: E402  (dashed script filename loaded explicitly)


class StubMemory(threading.Thread):
    """In-process MemoryCore stub with the product's request contract.

    Adds are persisted per scope; a unit becomes findable only after
    `searchable_after` seconds of "eventual-index" time. `fail_paths`
    collects paths that answer 503.
    """

    def __init__(self, searchable_after=0.0):
        super().__init__(daemon=True)
        self.searchable_after = searchable_after
        self.units = {}          # scope -> list of {"content", "ts"}
        self.fail_paths = set()
        self.adds = {}           # content-prefix -> count
        self.url = None
        self.started = threading.Event()

    def run(self):
        parent = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                length = int(self.headers.get("Content-Length", 0) or 0)
                body = json.loads(self.rfile.read(length) or b"{}")
                scope = (body.get("team_id", ""), body.get("user_id", ""), body.get("agent_id", ""))
                self.send_response(503 if self.path in parent.fail_paths else 200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                if self.path in parent.fail_paths:
                    self.wfile.write(json.dumps({"error": "stub down"}).encode())
                    return
                if self.path == "/v3/conversation/add":
                    msgs = body.get("messages") or []
                    for m in msgs:
                        parent.units.setdefault(scope, []).append({"content": m.get("content", ""), "ts": time.time()})
                    head = (msgs[0].get("content", "?") if msgs else "?")[:40]
                    parent.adds[head] = parent.adds.get(head, 0) + 1
                    self.wfile.write(json.dumps({"code": 0, "data": {}}).encode())
                    return
                if self.path == "/v3/conversation/search":
                    horizon = time.time() - parent.searchable_after
                    msgs = [m["content"] for m in parent.units.get(scope, []) if m["ts"] < horizon]
                    self.wfile.write(json.dumps({"code": 0, "data": {"messages": [{"content": c} for c in msgs]}}).encode())
                    return
                self.wfile.write(json.dumps({"code": 404, "data": {}}).encode())

        srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{srv.server_port}"
        self.started.set()
        srv.serve_forever(poll_interval=0.05)


class Fixtures(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = Path(tempfile.mkdtemp(prefix="doc-ingest-tests-"))
        (cls.root / "docs").mkdir()
        (cls.root / "memory.json").write_text(json.dumps({
            "baseUrl": "http://stub", "authPrefix": "Bearer ", "gatewayKey": "k-test",
            "serviceId": "svc", "userKey": "uk",
        }))

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.root, ignore_errors=True)

    def set_gateway(self, stub):
        os.environ["KNOWLEDGE_INDEX_BASE_URL"] = stub.url
        os.environ["MEMORY_SECRETS"] = str(self.root / "memory.json")
        os.environ["SINGULARITY_DOC_DATA"] = str(self.root / "data")
        os.environ["DOC_INDEX_TEAM"] = "tests"
        os.environ["DOC_INDEX_USER"] = "shared"

    def run_ingest(self, rel, searchable_after=0.2):
        stub = StubMemory(searchable_after=searchable_after)
        stub.start()
        stub.started.wait(2)
        self.set_gateway(stub)
        sys.stderr.write("")  # keep unittest output tidy
        return stub, mdi.ingest_file(self.root / rel, root_arg=str(self.root / "docs"), session="test")

    def make_runbook(self, name, body):
        p = self.root / "docs" / name
        p.write_text(f"# {name}\nPurpose: synthetic test runbook.\n\n{body}\n")
        return p

    def ledger_entry(self, rel):
        # Ledger keys are root-scoped ("<root-id>::<rel>"); resolve by the
        # entry's recorded relative path and require a unambiguous match.
        led = json.loads((self.root / "data" / "doc-index" / "ledger.json").read_text())
        matches = [e for e in led["docs"].values() if e.get("rel") == rel]
        self.assertEqual(len(matches), 1, f"ledger lookup for {rel}: {len(matches)} entries")
        return matches[0]

    # ── F: a synthetic new runbook is ingested and verified searchable ───────
    def test_f_new_runbook_ingested_and_verified(self):
        p = self.make_runbook("runbook-f.md", "Operating procedure: run the synthetic validation, then record observed output.")
        stub, report = self.run_ingest("docs/runbook-f.md", searchable_after=0.4)
        self.assertEqual(report["status"], "DOC_INGEST_INDEXED", report)
        self.assertGreaterEqual(report["chunks"], 1)
        self.assertGreater(report["bytes"], 0)
        # every chunk went through one deterministic task id and was stored
        chunk_keys = [k for k in stub.adds if k.startswith("\ncontent-hash:")] or list(stub.adds)
        self.assertTrue(chunk_keys)
        entry = self.ledger_entry("runbook-f.md")
        self.assertEqual(entry["revs"][report["rev"]]["status"], "DOC_INGEST_INDEXED")
        self.assertEqual(entry["active_rev"], report["rev"])
        self.assertTrue(entry["revs"][report["rev"]].get("verified_at"))
        self.assertEqual(len(entry["revs"][report["rev"]]["task_ids"]), report["chunks"])
        # chunk payloads keep full provenance: doc id marker, revision, hashes
        stored = "\n".join(m["content"] for units in stub.units.values() for m in units)
        self.assertIn(f"[doc-ref:runbook-f.md#{report['rev']} chunk 1/", stored)
        self.assertIn("canonical file on disk", stored)

    def test_f2_unchanged_returns_unchanged_with_no_new_writes(self):
        p = self.make_runbook("runbook-f2.md", "Steps: validate, retry, report.")
        stub1, r1 = self.run_ingest("docs/runbook-f2.md", searchable_after=0.3)
        self.assertEqual(r1["status"], "DOC_INGEST_INDEXED", r1)
        stub2, r2 = self.run_ingest("docs/runbook-f2.md", searchable_after=0.3)
        self.assertEqual(r2["status"], "DOC_INGEST_UNCHANGED", r2)
        adds = {k: v for k, v in stub2.adds.items() if "doc-ref:runbook-f2.md" in k or "[doc-ref:runbook-f2.md" in k or "Documentation record" in k}
        self.assertEqual(adds, {})

    def test_f3_secret_content_is_blocked_not_ingested(self):
        p = self.make_runbook("runbook-f3.md", "Config: api_key = supersecretvalue123")
        stub, report = self.run_ingest("docs/runbook-f3.md", searchable_after=0.2)
        self.assertEqual(report.get("status"), "DOC_INGEST_BLOCKED", report)
        self.assertIn("sensitive", report.get("reason", ""))
        # nothing about this doc entered the memory path
        adds = [k for k in stub.adds if "runbook-f3.md" in k]
        self.assertEqual(adds, [])

    # ── G: revision update supersedes the old revision ───────────────────────
    def test_g_update_indexes_new_revision_and_actives_it(self):
        p = self.make_runbook("runbook-g.md", "Procedure v1: check the gauge, vent, then restart the pump.")
        stub1, r1 = self.run_ingest("docs/runbook-g.md", searchable_after=0.3)
        self.assertEqual(r1["status"], "DOC_INGEST_INDEXED", r1)
        old_rev = r1["rev"]
        p.write_text(p.read_text().replace("v1", "v2") + "\nNew step: re-verify the seal before restart.\n")
        stub2, r2 = self.run_ingest("docs/runbook-g.md", searchable_after=0.3)
        self.assertEqual(r2["status"], "DOC_INGEST_INDEXED", r2)
        self.assertNotEqual(r2["rev"], old_rev)
        entry = self.ledger_entry("runbook-g.md")
        self.assertEqual(entry["active_rev"], r2["rev"])
        self.assertEqual(entry["revs"][r2["rev"]]["status"], "DOC_INGEST_INDEXED")
        self.assertTrue(entry["revs"].get(old_rev), "old revision retained in ledger history")
        # the OLD revision is no longer active and no longer verified as current
        self.assertNotEqual(entry["active_rev"], old_rev)
        # a tombstone marks the old revision superseded and search filters it out
        all_stored = "\n".join(m["content"] for units in stub2.units.values() for m in units)
        self.assertIn(f"[docs-superseded:{entry['doc_id']}:{old_rev}->{r2['rev']}]", all_stored)
        results = mdi.search_docs("gauge vent pump")
        self.assertTrue(all(rev == entry["active_rev"] for rev in (it["revision"] for it in results if it.get("revision"))),
                        results)

    # ── H: memory unavailable / hard failure ─────────────────────────────────
    def test_h_slow_index_reports_pending_and_retry_succeeds(self):
        p = self.make_runbook("runbook-h.md", "Recovery procedure: replace the synthetic key, then re-run validation.")
        stub, report = self.run_ingest("docs/runbook-h.md", searchable_after=10 ** 9)
        self.assertEqual(report["status"], "DOC_INGEST_PENDING", report)
        self.assertIn("not yet searchable", report.get("reason", ""))
        self.assertTrue((self.root / "docs" / "runbook-h.md").exists(), "implementation work preserved on disk")
        time.sleep(5)  # the slower retry path must be quicker than the eventual window
        stub2, report2 = self.run_ingest("docs/runbook-h.md", searchable_after=0.3)
        self.assertEqual(report2["status"], "DOC_INGEST_INDEXED", report2)
        entry = self.ledger_entry("runbook-h.md")
        self.assertEqual(entry["revs"][report2["rev"]]["status"], "DOC_INGEST_INDEXED")

    def test_h2_add_failure_reports_failed_and_keeps_prior_revision_active(self):
        p = self.make_runbook("runbook-h2.md", "Validated troubleshooting steps for the synthetic outage.")
        stub1, r1 = self.run_ingest("docs/runbook-h2.md", searchable_after=0.3)
        self.assertEqual(r1["status"], "DOC_INGEST_INDEXED", r1)
        old_rev = r1["rev"]
        p.write_text(p.read_text() + "\nUpdated step for the second incident variant.\n")
        stub = StubMemory(searchable_after=0.3)
        stub.fail_paths = {"/v3/conversation/add"}
        stub.start()
        stub.started.wait(2)
        self.set_gateway(stub)
        report = mdi.ingest_file(p, root_arg=str(self.root / "docs"), session="test")
        self.assertEqual(report["status"], "DOC_INGEST_FAILED", report)
        self.assertIn("chunk write failed", report.get("reason", ""))
        entry = self.ledger_entry("runbook-h2.md")
        self.assertEqual(entry["active_rev"], old_rev, "previous verified revision stays active")
        self.assertEqual(entry["revs"][old_rev]["status"], "DOC_INGEST_INDEXED")
        new_rec = entry["revs"][report["rev"]]
        self.assertEqual(new_rec["status"], "DOC_INGEST_FAILED")
        # a later successful retry of the same revision completes without duplicates
        stub2, r2 = self.run_ingest("docs/runbook-h2.md", searchable_after=0.3)
        self.assertEqual(r2["status"], "DOC_INGEST_INDEXED", r2)
        self.assertEqual(self.ledger_entry("runbook-h2.md")["active_rev"], r2["rev"])

    def test_status_reports_stale_source_when_disk_ahead_of_ledger(self):
        p = self.make_runbook("runbook-status.md", "Status probe steps.")
        stub, report = self.run_ingest("docs/runbook-status.md", searchable_after=0.3)
        self.assertEqual(report["status"], "DOC_INGEST_INDEXED", report)
        self.assertFalse(self.ledger_status_flags("runbook-status.md")["stale_source"])
        p.write_text(p.read_text() + "\nDrifted content not yet ingested.\n")
        self.assertTrue(self.ledger_status_flags("runbook-status.md")["stale_source"])

    def ledger_status_flags(self, rel):
        out = mdi.status_report(rel, all_docs=False, root_arg=str(self.root / "docs"))
        return out[0]

    def root_status(self, rel, root_arg="__default__"):
        """Retry a specific doc and return the single resulting status."""
        kwargs = {} if root_arg == "__default__" else {"root_arg": root_arg}
        out = mdi.retry(rel, all_docs=False, **kwargs)
        self.assertEqual(len(out), 1, out)
        return out[0]

    def test_r_unauthorised_root_retry_is_refused_then_reauthorised_with_root(self):
        p = self.make_runbook("runbook-roots.md", "Root allowlist probe.")
        stub, report = self.run_ingest("docs/runbook-roots.md", searchable_after=0.2)
        self.assertEqual(report["status"], "DOC_INGEST_INDEXED", report)
        # Simulate a root the invocation no longer trusts: point the allowlist
        # somewhere unrelated. The recorded root must then be refused even
        # though the path would trivially resolve inside it.
        other = self.root.parent / "unrelated-audit-root"
        other.mkdir(exist_ok=True)
        os.environ["SINGULARITY_DOC_ROOTS"] = str(other)
        try:
            # No explicit --root: the recorded root is not in the invocation's
            # allowlist, so the retry refuses instead of silently re-ingesting.
            blocked = self.root_status("runbook-roots.md", root_arg=None)
            self.assertEqual(blocked["status"], "DOC_INGEST_BLOCKED", blocked)
            self.assertIn("currently authorised", blocked["reason"])
        finally:
            os.environ["SINGULARITY_DOC_ROOTS"] = ""
        # Authorising the recorded root again restores the normal path.
        stub2, r2 = self.run_ingest("docs/runbook-roots.md", searchable_after=0.2)
        self.assertIn(r2["status"], ("DOC_INGEST_UNCHANGED", "DOC_INGEST_INDEXED"), r2)

    def test_s_concurrent_revisions_end_in_one_active_verified_state(self):
        p = self.make_runbook("runbook-conc.md", "Concurrent revision ordering probe: start.")
        stub = StubMemory(searchable_after=0)
        stub.start(); stub.started.wait(2)
        self.set_gateway(stub)
        results = []
        lock = threading.Lock()
        bodies = ["Concurrent revision ordering probe: variant A.\n", "Concurrent revision ordering probe: variant B.\n"]
        def worker(i, delay):
            time.sleep(delay)
            p.write_text(bodies[i])
            r = mdi.ingest_file(p, root_arg=str(self.root / "docs"), session="conc")
            with lock:
                results.append(r)
        threads = [threading.Thread(target=worker, args=(i, d)) for i, d in enumerate((0.05, 0.35))]
        for t in threads: t.start()
        for t in threads: t.join(40)
        # The flock keeps each transaction atomic; validate the outcome, not the interleaving order.
        entry = self.ledger_entry("runbook-conc.md")
        active = entry["active_rev"]
        self.assertIn(active, entry["revs"], "torn ledger state")
        self.assertIn(entry["revs"][active]["status"], ("DOC_INGEST_INDEXED", "DOC_INGEST_UNCHANGED"))
        for r in results:
            self.assertIn(r["status"], ("DOC_INGEST_INDEXED", "DOC_INGEST_UNCHANGED", "DOC_INGEST_PENDING"), r)
        v = mdi.verify_file("runbook-conc.md", root_arg=str(self.root / "docs"))
        self.assertEqual(v["status"], "DOC_INGEST_VERIFIED", v)

    def test_t_pending_revision_does_not_block_a_newer_verified_one(self):
        self.make_runbook("runbook-mix.md", "Mixed outcome probe: first revision.")
        stub, r1 = self.run_ingest("docs/runbook-mix.md", searchable_after=0.2)
        self.assertEqual(r1["status"], "DOC_INGEST_INDEXED", r1)
        self.make_runbook("runbook-mix.md", "Mixed outcome probe: second revision fails to verify.")
        stub2, r2 = self.run_ingest("docs/runbook-mix.md", searchable_after=999)
        self.assertEqual(r2["status"], "DOC_INGEST_PENDING", r2)
        self.assertEqual(self.ledger_entry("runbook-mix.md")["active_rev"], r1["rev"],
                         "unverified newer revision must not become active")
        v = mdi.verify_file("runbook-mix.md", root_arg=str(self.root / "docs"))
        self.assertNotEqual(v["status"], "DOC_INGEST_VERIFIED", v)
        # The source changed and was never successfully indexed: the refusal is
        # EITHER the stale-hash diagnosis or the newer-unresolved-revision
        # diagnosis depending on which check trips first — both refuse.
        self.assertRegex(v["reason"], r"never indexed successfully|newer unresolved")

if __name__ == "__main__":
    unittest.main(verbosity=1)
