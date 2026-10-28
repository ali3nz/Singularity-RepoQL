#!/usr/bin/env python3
"""test-doc-program.py — offline synthetic acceptance battery (ticket 776, P1).

Directive 2026-10-23 §12: one compact synthetic end-to-end test, A–H, over a
disposable documentation scope (sandbox root; no real operational procedure
is touched). Run: python3 test-doc-program.py  → PASS/FAIL lines, exit != 0
on any failure.
"""
from __future__ import annotations

import io
import json
import os
import shutil
import sys
import tempfile
import threading
import time
import contextlib

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import doc_program as dp

PASS = 0
FAIL = 0


def check(name: str, cond: bool, detail: str = "") -> None:
    global PASS, FAIL
    tag = "PASS" if cond else "FAIL"
    print("%s %s %s" % (tag, name, detail))
    if cond:
        PASS += 1
    else:
        FAIL += 1


def target_path(root: str, *parts: str) -> str:
    return os.path.join(root, *parts)


class FakeIngest:
    """Destination-index fake: searchability only after explicit ingest."""

    def __init__(self):
        self.terms = set()

    def index(self, subject: str) -> bool:
        slug = dp.slugify(subject)
        self.terms.add(slug)
        return True

    def search(self, subject: str) -> bool:
        return dp.slugify(subject) in self.terms


class FakeWiki:
    """Destination publish fake: returns a receipt (directive 9)."""

    def __init__(self):
        self.pages = {}

    def publish(self, path: str) -> dict:
        rec = {"published": True, "page": "/sandbox" + path,
               "verified": True, "hash": dp.sha256_bytes(b"page")}
        self.pages[path] = rec
        return rec


def main() -> int:
    root = tempfile.mkdtemp(prefix="doc-e2e-")
    try:
        # seed ONE existing ops doc with a warning line, to test maintenance
        seed = ("services/runbooks/mail-sink.md", (
            "# Mail sink — runbook\n\nLast updated: 2026-10-01\nRevision: 5\n\n"
            "## Prerequisites\n\n- target VPS reachable\n\n!WARNING never bounce "
            "the tunnel while an ESO instance is in-world\n\n"
            "## Verify\n\n- smtp round trip untested: placeholder\n\n"
            "## History\n\n- seeded 2026-10-01\n"))
        os.makedirs(os.path.dirname(os.path.join(root, seed[0])), exist_ok=True)
        with open(os.path.join(root, seed[0]), "w", encoding="utf-8") as fh:
            fh.write(seed[1])

        ingest = FakeIngest()
        wiki = FakeWiki()
        t = dp.LocalTransport(root)

        receipt = {"summary": "rotated mail-sink credentials on the target host",
                   "changeType": "recurring-failure",
                   "subject": "mail-sink",
                   "paths": ["work/var/mail-sink/rotate.sh"],
                   "evidenceRefs": ["issues/776#credential-rotation",
                                    "evidence/wiki-2026/"],
                   "verifiedResults": ["credential rotation round-trip 200 OK"]}

        # ---------- A: missing runbook created ----------
        receipt_new = dict(receipt)
        receipt_new["subject"] = "vpn-egress-rotation"
        propA = dp.assess(receipt_new, dp.build_index(t))
        check("A1-assess-create", propA["verb"] == "CREATE" and
              propA["status"] == "DOC_CREATED", json.dumps(propA))
        propA = dp.apply(propA, t)
        check("A3-created-file", propA["status"] == "DOC_CREATED" and
              os.path.exists(dp.LocalTransport(root)._real(propA["targetPath"])),
              propA["status"])
        body = open(os.path.join(root, propA["targetPath"]),
                    encoding="utf-8").read()
        check("A4-body-sections+evidence",
              "## Verify" in body and "## Evidence" in body and
              "issues/776#credential-rotation" in body and
              "Last updated:" in body, "")
        check("A5-journal", os.path.exists(root.rstrip(os.sep) + "-journal/doc-proposals.jsonl"))

        # ---------- B: update-not-duplicate ----------
        n_docs_before = len(dp.build_index(t))
        propB = dp.assess(receipt, dp.build_index(t))   # subject=mail-sink exists
        check("B1-assess-update", propB["verb"] == "UPDATE" and
              propB["targetPath"] == "services/runbooks/mail-sink.md",
              json.dumps(propB))
        propB = dp.apply(propB, t)
        check("B2-updated-status", propB["status"] == "DOC_UPDATED", propB["status"])
        n_docs_after = len(dp.build_index(t))
        check("B3-no-duplicate", n_docs_after == n_docs_before,
              "idx %d -> %d" % (n_docs_before, n_docs_after))
        updated = open(os.path.join(root, propB["targetPath"]),
                       encoding="utf-8").read()
        check("B4-revision-bumped", "Revision: 6" in updated, "")
        check("B5-bak-preserved",
              any(f.startswith("mail-sink.bak-")
                  for f in os.listdir(os.path.dirname(
                      os.path.join(root, propB["targetPath"])))), "")
        check("B6-warning-preserved",
              "!WARNING never bounce" in updated, "")
        check("B7-history-recorded",
              "UPDATE via doc-program" in updated or "doc-program" in updated, "")

        # ---------- C: ingestion genuinely searchable ----------
        propC = dp.ingest(propB, t, ingest.search)
        check("C1-ingest-flow", propC["status"] in ("DOC_INGEST_PENDING",),
              propC["status"])
        ingest.index("mail-sink")     # destination confirms indexing
        propC = dp.ingest(propB, t, ingest.search)
        check("C2-searchable", propC["status"] == "DOC_INGEST_INDEXED" and
              ingest.search("mail-sink"), propC["status"])

        # ---------- D: skill refinement flags affected procedure ----------
        affected = dp.affected_docs_for_skill(
            ["work/var/mail-sink/rotate.sh"], dp.build_index(t))
        check("D1-skill-affected-doc",
              "services/runbooks/mail-sink.md" in affected, str(affected))

        # further verification of full lifecycle with ingest BEFORE publish
        propH = dp.run(receipt, t, search_fn=ingest.search,
                       publish_fn=wiki.publish)
        check("H0-full-cycle-run", propH["status"] == "DOC_PUBLISHED",
              propH["status"])

        # ---------- E: trivial activity creates nothing ----------
        listing_before = {e["path"] for e in dp.build_index(t)}
        with contextlib.redirect_stdout(io.StringIO()):
            propE = dp.run({"summary": "reminder to check inbox",
                            "changeType": "chat-reminder"}, t)
        check("E1-no-doc-for-trivial",
              propE["verb"] == "NO_CHANGE" and
              propE["status"] == "DOC_NOT_REQUIRED", propE["status"])
        listing_after = {e["path"] for e in dp.build_index(t)}
        check("E2-no-files-created", listing_after == listing_before, "")
        # the docs root stays free of operational journal files (Sol #2)
        check("E2b-no-journal-inside-root",
              not os.path.exists(os.path.join(root, "doc-proposals.jsonl")), "")
        check("E3-journaled-no-change",
              any(rec.get("status") == "DOC_NOT_REQUIRED"
                  for rec in json_journal(root)), "")

        # ---------- F: unauthorised/conflicting write blocked ----------
        bad = {"verb": "UPDATE", "status": "DOC_UPDATED",
               "subject": "mail-sink", "changeType": "bugfix",
               "verifyResults": [], "verifiedResults": [],
               "evidenceRefs": ["x"], "paths": [],
               "targetPath": "AGENTS.md", "expectedSha": None, "reason": "test"}
        propF = dp.apply(bad, t)
        check("F1-protected-write-blocked",
              propF["status"] == "DOC_BLOCKED" and
              "directive 8" in propF["reason"], propF["reason"])
        ag = os.path.join(root, "AGENTS.md")
        check("F2-protected-file-untouched", not os.path.exists(ag))
        # stale-hash conflict: doc changed since assessment
        stale = dp.assess(dict(receipt), dp.build_index(t))
        stale["expectedSha"] = "0" * 64   # tampered expectation
        propF2 = dp.apply(stale, t)
        check("F3-stale-hash-blocked",
              propF2["status"] == "DOC_BLOCKED" and
              "hash precondition" in propF2["reason"], propF2["reason"])
        # material work without evidence: blocked, not invented
        propF3 = dp.assess({"summary": "rebuilt webserver container",
                            "changeType": "deployment", "paths": [],
                            "evidenceRefs": [], "verifiedResults": []},
                           dp.build_index(t))
        check("F4-no-evidence-blocked",
              propF3["verb"] == "DOC_BLOCKED" and
              propF3["status"] == "DOC_BLOCKED", json.dumps(propF3))

        # ---------- G: concurrent agents, no lost updates ----------
        my_sha = dp.sha256_bytes(open(
            os.path.join(root, "services/runbooks/mail-sink.md"),
            "rb").read())
        t2 = dp.LocalTransport(root)
        r_g1 = {"summary": "concurrent pass 1", "changeType": "troubleshooting",
                "subject": "mail-sink",
                "paths": ["work/var/mail-sink/one.log"],
                "evidenceRefs": ["evidence/g1"],
                "verifiedResults": ["g1 probe ok"]}
        r_g2 = {"summary": "concurrent pass 2", "changeType": "troubleshooting",
                "subject": "mail-sink",
                "paths": ["work/var/mail-sink/two.log"],
                "evidenceRefs": ["evidence/g2"],
                "verifiedResults": ["g2 probe ok"]}
        res = {}

        def worker(idx, r):
            idx_local = dp.build_index(t2)
            p = dp.assess(r, idx_local)
            res[idx] = dp.apply(p, t2)

        th1 = threading.Thread(target=worker, args=(1, r_g1))
        th2 = threading.Thread(target=worker, args=(2, r_g2))
        th1.start(); th2.start(); th1.join(); th2.join()
        statuses = sorted([res[1]["status"], res[2]["status"]])
        check("G1-both-outcomes-sane",
              statuses == ["DOC_BLOCKED", "DOC_UPDATED"] or
              statuses == ["DOC_UPDATED", "DOC_UPDATED"], str(statuses) +
              " reasons: " + str(res[1].get("reason") or res[2].get("reason"))[:120])
        final = open(os.path.join(root, "services/runbooks/mail-sink.md"),
                     encoding="utf-8").read()
        revs = [int(m) for m in __import__("re").findall(
            r"(?m)^Revision:\s*(\d+)\s*$", final)]
        # exactly one G-write lands (the other is blocked on stale hash):
        applied = [r for r in (res[1], res[2]) if r["status"] == "DOC_UPDATED"]
        blocked = [r for r in (res[1], res[2]) if r["status"] == "DOC_BLOCKED"]
        check("G2-no-lost-update",
              len(applied) == 1 and len(blocked) == 1 and
              revs == sorted(set(revs)) and revs[-1] == 8 and
              applied[0]["verifiedResults"][0] in final and
              blocked[0]["verifiedResults"][0] not in final and
              "credential rotation round-trip 200 OK" in final,
              "revs=%s applied=%s blocked=%s"
              % (revs, applied and applied[0]["verifiedResults"],
                 blocked and blocked[0]["verifiedResults"]))
        check("G4-conflict-journaled",
              any(rec.get("kind") == "conflict" for rec in json_journal(root)),
              "")
        warn_ok = "!WARNING never bounce" in final
        check("G3-warnings-still-intact", warn_ok, "")

        # ---------- H: WikiJS publication verified when configured ----------
        # (full-cycle propH above) destination receipt must be real
        page = wiki.pages.get(propH.get("targetPath") or "")
        check("H1-wikijs-publish-verified",
              bool(page) and page.get("published") and page.get("verified") is True,
              json.dumps(page or {}))
        # second publish run without ingest confirmation stays PENDING
        fresh = {"verb": "CREATE", "status": "DOC_CREATED",
                 "subject": "tmp-probe", "changeType": "implementation",
                 "evidenceRefs": ["e"], "verifiedResults": ["v"],
                 "paths": [], "targetPath": "topics/tmp-probe.md",
                 "expectedSha": None, "reason": "h2"}
        fresh = dp.ingest(fresh, t, lambda s: True)
        fresh2 = dp.publish(fresh, t, lambda p: {"published": False})
        check("H2-nonconfirm-pending",
              fresh2["status"] == "DOC_PUBLISH_PENDING" and fresh["status"] == "DOC_INGEST_INDEXED",
              fresh2["status"])
        # ---------- I: receipt-scoped docDir layout override ----------
        idxI = dp.build_index(t)
        propI = dp.assess({"summary": "doc-programme core", "changeType":
                           "architecture-decision",
                           "paths": ["kit/docs/doc_program.py"],
                           "evidenceRefs": ["e"],
                           "verifiedResults": ["v"],
                           "subject": "doc-program",
                           "docDir": "services"}, idxI)
        check("I1-docdir-services",
              propI["verb"] == "CREATE" and
              propI["targetPath"] == "services/doc-program.md",
              str(propI.get("targetPath")))
        propI2 = dp.assess({"summary": "x", "changeType": "procedure",
                            "paths": ["p"], "evidenceRefs": ["e"],
                            "verifiedResults": ["v"], "subject": "none",
                            "docDir": "../escaped"}, idxI)
        check("I2-docdir-traversal-refused",
              propI2["status"] == "DOC_BLOCKED", str(propI2.get("reason")))
        propI3 = dp.assess({"summary": "x", "changeType": "procedure",
                            "paths": ["p"], "evidenceRefs": ["e"],
                            "verifiedResults": ["v"], "subject": "none",
                            "docDir": "agent-guides"}, idxI)
        check("I3-docdir-protected-dir",
              propI3["verb"] == "CREATE" and
              propI3.get("targetPath", "").startswith("agent-guides/"),
              str(propI3.get("targetPath")))
        _ = target_path, my_sha, propF
        # I4: the protected docDir must also be refused at APPLY time, not
        # only at assess time (compose the CREATE like apply would)
        blocked_apply = dp.apply(dp.assess({"summary": "x",
                                            "changeType": "procedure",
                                            "paths": ["p"],
                                            "evidenceRefs": ["e"],
                                            "verifiedResults": ["v"],
                                            "subject": "none",
                                            "docDir": "agent-guides"},
                                           idxI), t)
        check("I4-apply-protected-refused",
              blocked_apply["status"] == "DOC_BLOCKED" and
              "protected" in (blocked_apply.get("reason") or ""),
              str(blocked_apply.get("reason")))

        # ---------- J: source-grounded authoring (P0 §3) ----------
        # A structured receipt must yield a real runbook: no angle-bracket
        # template markers, actual commands with verified/untested marks,
        # rollback and evidence carried through.
        rich = dp.assess({
            "summary": "hardened the relay fan-out lazy-write path",
            "objective": "Prove no recipient is lost when the relay dies mid-fan-out.",
            "changeType": "deployment",
            "subject": "relay-fanout-durability",
            "paths": ["kit/agentchat/orch-agentchat-relay.py"],
            "systems": ["agentchat relay"],
            "hosts": ["controller"],
            "dependencies": ["python3 >= 3.9", "state.lock available"],
            "commands": [
                {"cmd": "systemctl restart orch-agentchat-relay.service",
                 "verified": True, "note": "ran on controller 2026-10-23"},
                {"cmd": "journalctl -u orch-agentchat-relay -n 20",
                 "verified": False},
            ],
            "rollback": ["cp /usr/local/bin/orch-agentchat-relay.py.bak /usr/local/bin/orch-agentchat-relay.py"],
            "troubleshooting": ["duplicate rows => fanout ledger replayed twice"],
            "limitations": ["ledger files grow append-only; no compaction yet"],
            "revision": "43c1506",
            "evidenceRefs": ["work/plans/singularity-p0-2026-10-23.md"],
            "verifiedResults": ["74 PASS / 0 FAIL relay battery"],
        }, dp.build_index(t))
        body = dp.new_doc_body(rich)
        check("J1-no-template-placeholders",
              "steps go here" not in body and "<" not in body,
              body[:120])
        check("J2-objective-grounded",
              "Prove no recipient is lost" in body)
        check("J3-commands-with-evidence-marks",
              "systemctl restart orch-agentchat-relay.service" in body
              and "(verified)" in body and "(untested)" in body)
        check("J4-rollback-and-limitations",
              "orch-agentchat-relay.py.bak" in body and "no compaction" in body)
        check("J5-revision-and-evidence",
              "Source revision: 43c1506" in body
              and "work/plans/singularity-p0-2026-10-23.md" in body)
        thin = dp.assess({
            "summary": "minor tweak", "changeType": "procedure",
            "subject": "thin-probe", "evidenceRefs": ["e"],
        }, dp.build_index(t))
        thin_body = dp.new_doc_body(thin)
        check("J6-thin-evidence-is-marked-not-invented",
              "untested:" in thin_body
              and "steps go here" not in thin_body)

        print("\n==== %d PASS / %d FAIL ====" % (PASS, FAIL))
        return 0 if FAIL == 0 else 1
    finally:
        shutil.rmtree(root, ignore_errors=True)


def _ordered_unique(text: str) -> bool:
    seen = [ln for ln in text.splitlines() if "via doc-program" in ln]
    return len(seen) == len(set(seen))


def json_journal(root: str) -> list[dict]:
    out = []
    # journal lives OUTSIDE the docs root (Sol correction #2)
    p = root.rstrip(os.sep) + "-journal/doc-proposals.jsonl"
    try:
        for line in open(p, encoding="utf-8"):
            out.append(json.loads(line))
    except FileNotFoundError:
        pass
    return out


if __name__ == "__main__":
    sys.exit(main())
