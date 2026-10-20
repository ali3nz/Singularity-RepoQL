#!/usr/bin/env python3
"""Automatic MemoryCore documentation ingestion for Singularity.

The ONLY component of the product that ingests current approved documentation
content into the Tencent memory stack. A runbook becomes genuinely searchable
through the SAME proven L0 conversation path the knowledge promotion engine
uses (scripts/memory_client.py) — never a metadata-only record, never a bare
filename, never an unverified LLM summary.

Designed for automatic invocation (documentation completion workflows in both
OpenChamber and Claude Code), idempotent retries and explicit statuses:

    DOC_INGEST_INDEXED    ingested, all chunks persisted AND verified searchable
    DOC_INGEST_UNCHANGED  source hash equals the verified active revision — no write
    DOC_INGEST_PENDING    persisted but not yet verified searchable (retryable)
    DOC_INGEST_FAILED     write/verification failed; previous revision stays active
    DOC_INGEST_BLOCKED    eligibility/security/size refusal; nothing partial is claimed

Pipeline: eligibility -> sensitive-content rejection -> content hash -> ledger
check -> chunk by markdown headings -> idempotent chunk writes -> bounded
retrieval verification -> supersession tombstone for the previous revision ->
atomic ledger activation. The filesystem document remains the source of truth;
a retrieval failure never overwrites the authoritative file, and a failed
ingestion never deactivates a previously verified revision.

State: data/doc-index/ledger.json (product-local runtime data, outside version
control), protected by flock and atomic replacement.

Identity: documentation knowledge lives under a DEDICATED shared scope
(DOC_INDEX_TEAM/DOC_INDEX_USER, agent_id "docs-keeper") — never under the
personal identity of whichever agent edited the file, so different agents can
retrieve the same shared documentation without sharing private experience.

Commands:
    ingest --file DOC [--root ROOT] [--session S]
    retry  [--file DOC | --all] [--root ROOT]
    status [--file DOC] [--all] [--root ROOT]
    search QUERY [--limit N]

Environment:
    MEMORY_SECRETS              memory.json path (as knowledge-promotion.py)
    KNOWLEDGE_INDEX_BASE_URL    memory gateway base (default http://127.0.0.1:8420)
    SINGULARITY_DOC_DATA        state dir (default ./data)
    DOC_INDEX_TEAM / DOC_INDEX_USER   shared documentation scope
"""
import argparse
import fcntl
import hashlib
import json
import os
import re
import sys
import time
from pathlib import Path

from memory_client import memory_call

# All configuration is read at call time (not import time) so wrappers, tests
# and installers can retarget the stack without re-importing the module.


def _ledger():
    return Path(os.environ.get("SINGULARITY_DOC_DATA", "./data")) / "doc-index" / "ledger.json"


def _lock():
    return Path(os.environ.get("SINGULARITY_DOC_DATA", "./data")) / "doc-index" / ".ledger.lock"


def _base():
    return os.environ.get("KNOWLEDGE_INDEX_BASE_URL", "http://127.0.0.1:8420")


def _scope():
    return {
        "team_id": os.environ.get("DOC_INDEX_TEAM", "singularity-docs"),
        "user_id": os.environ.get("DOC_INDEX_USER", "shared"),
        "agent_id": "docs-keeper",
    }


DOCS_SESSION = "singularity-documentation"

MAX_DOC_BYTES = 200 * 1024
MAX_CHUNK_CHARS = 7000
MAX_CHUNKS = 64
VERIFY_TIMEOUT_S = 30
VERIFY_POLL_S = 3
SEARCH_LIMIT_DEFAULT = 5

# Secret-shaped content is rejected, never redacted silently into the store.
SECRET_PATTERNS = [
    re.compile(r"\bsk-[A-Za-z0-9][A-Za-z0-9_-]{8,}\b"),
    re.compile(r"\b(?:ghp|gho|github_pat)_[A-Za-z0-9_]{16,}\b"),
    re.compile(r"\bAKIA[A-Z0-9]{12,}\b"),
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
]
SECRET_FILENAMES = re.compile(
    r"(^|/)(\.env[^/]*|id_rsa[^/]*|secrets?[^/]*|credentials*\.md|.*\.pem|.*\.key[^/]*|"
    r".*password.*|.*\.secrets\..*)$", re.IGNORECASE)


class Blocked(Exception):
    pass


def sha(text):
    return hashlib.sha256(text.encode()).hexdigest()


def load_cfg():
    p = Path(os.environ.get("MEMORY_SECRETS", "./data/opencode/config/product-secrets/memory.json"))
    try:
        cfg = json.loads(p.read_text())
        if not cfg.get("gatewayKey"):
            raise Blocked(f"memory secrets have no gatewayKey: {p}")
        return cfg
    except Blocked:
        raise
    except Exception as e:
        raise Blocked(f"cannot read memory secrets ({p}): {e}")


# ── ledger (the revision manifest; atomic + flock) ───────────────────────────

def with_ledger(fn):
    """Run fn(ledger) under the ledger lock and persist with atomic replace."""
    lp = _ledger()
    lp.parent.mkdir(parents=True, exist_ok=True)
    with _lock().open("w+") as lockf:
        fcntl.flock(lockf, fcntl.LOCK_EX)
        try:
            ledger = json.loads(lp.read_text()) if lp.exists() else {"version": 1, "docs": {}}
        except ValueError:
            ledger = {"version": 1, "docs": {}}
        result = fn(ledger)
        tmp = lp.with_suffix(".tmp")
        tmp.write_text(json.dumps(ledger, indent=2, sort_keys=True) + "\n")
        os.replace(tmp, lp)  # atomic: no torn ledger on crash
        return result


# ── eligibility and safety ───────────────────────────────────────────────────

def doc_roots(root_arg):
    roots = []
    for item in ((root_arg,) if root_arg else ()) + tuple(
            p for p in os.environ.get("SINGULARITY_DOC_ROOTS", "").split(":") if p):
        rp = Path(item).resolve()
        if rp not in roots:
            roots.append(rp)
    return roots


def classify_source(path, roots):
    """Return (rel_path, title, root) or raise Blocked. Symlink-traversal safe."""
    try:
        p = path.resolve(strict=True)
    except OSError as e:
        raise Blocked(f"cannot resolve document: {e}")
    if SECRET_FILENAMES.search(path.name):
        raise Blocked(f"secret-like filename refused: {path.name}")
    if p.suffix.lower() != ".md":
        raise Blocked(f"only .md documentation is eligible: {path.name}")
    if p.stat().st_size == 0:
        raise Blocked("document is empty")
    if p.stat().st_size > MAX_DOC_BYTES:
        raise Blocked(f"document too large to ingest safely ({p.stat().st_size} > {MAX_DOC_BYTES} bytes); split it")
    inside = [r for r in roots if p.is_relative_to(r)] if roots else []
    if not inside:
        raise Blocked("path is outside the documentation allowlist roots (pass --root)")
    root = inside[0]
    lexical = os.path.abspath(path)
    if not lexical.startswith(str(root) + os.sep):
        raise Blocked("symlink traversal outside the authorized root")
    rel = p.relative_to(root).as_posix()
    title = next((ln.lstrip("# ").strip() for ln in p.read_text(errors="replace").splitlines()
                  if ln.strip().startswith("#")), rel)
    return rel, title, root


def reject_sensitive(text, rel):
    if text.count("```") % 2 != 0:
        raise Blocked("unbalanced code fences — refusing to guess chunk boundaries")
    for pattern in SECRET_PATTERNS:
        m = pattern.search(text)
        if m:
            raise Blocked(
                f"sensitive content detected in {rel} (pattern {pattern.pattern[:28]}...); "
                "reject or redact per local policy before ingestion")
    if re.search(r"\b(?:api[_-]?key|secret|password|token)\b\s*[:=]\s*\"?[\w./+=-]{8,}\"?", text, re.IGNORECASE):
        raise Blocked(f"sensitive assignment detected in {rel}; reject or redact per local policy")


# ── chunking (by markdown headings; never silently truncated) ────────────────

def chunk_markdown(text):
    """Split into <=MAX_CHUNK_CHARS chunks on headings, respecting fenced blocks.

    Fences are never split mid-block by a heading break; a single line longer
    than the cap is wrapped (content preserved, never truncated). More than
    MAX_CHUNKS chunks is a Blocked refusal, not a silent truncation.
    """
    lines = text.splitlines()
    chunks, cur, cur_chars, fence = [], [], 0, False
    for line in lines:
        if line.strip().startswith("```"):
            fence = not fence
        is_heading = not fence and re.match(r"^#{1,3} ", line)
        if is_heading and cur_chars >= MAX_CHUNK_CHARS * 0.6 and cur:
            chunks.append("\n".join(cur))
            cur, cur_chars = [], 0
        if len(line) + 1 > MAX_CHUNK_CHARS and cur_chars > 0:
            chunks.append("\n".join(cur))
            cur, cur_chars = [], 0
        if len(line) + 1 > MAX_CHUNK_CHARS:
            for i in range(0, len(line), MAX_CHUNK_CHARS - 1):
                cur.append(line[i:i + MAX_CHUNK_CHARS - 1])
        else:
            cur.append(line)
        cur_chars += len(line) + 1
    if cur:
        chunks.append("\n".join(cur))
    if len(chunks) > MAX_CHUNKS:
        raise Blocked(f"document needs {len(chunks)} chunks (max {MAX_CHUNKS}); split it into smaller docs")
    return chunks


# ── memory writes (single path, idempotent by deterministic task ids) ────────

def search_once(cfg, query, limit=5):
    found = memory_call(_base(), cfg, "/conversation/search", {**_scope(), "query": query, "limit": limit})
    return (found.get("data") or {}).get("messages") or []


def marker_searchable(cfg, marker, deadline):
    while True:
        try:
            if any(marker in (m.get("content") or "") for m in search_once(cfg, marker)):
                return True
        except Exception:
            pass  # transient gateway errors during eventual indexing: keep polling
        if time.time() >= deadline:
            return False
        time.sleep(VERIFY_POLL_S)


def write_chunk(cfg, chunk_task, chunk_text, recorded_at):
    """Idempotent L0 write: marker search first; add only when absent."""
    try:
        if any(chunk_task["marker"] in (m.get("content") or "") for m in search_once(cfg, chunk_task["marker"], 10)):
            return "present"
        memory_call(_base(), cfg, "/conversation/add", {
            **_scope(), "session_id": DOCS_SESSION, "task_id": chunk_task["task_id"],
            "messages": [
                {"role": "user", "content": chunk_text, "recorded_at": recorded_at},
                {"role": "assistant", "content": f"Documentation record {chunk_task['marker']} acknowledged.",
                 "recorded_at": recorded_at},
            ]})
        return "written"
    except Exception as e:
        raise RuntimeError(f"chunk write failed ({chunk_task['task_id']}): {e}")


def write_supersession(cfg, doc_id8, old_rev, new_rev):
    """Record that old_rev of doc_id8 is no longer current (idempotent tombstone)."""
    marker = f"[docs-superseded:{doc_id8}:{old_rev}->{new_rev}]"
    try:
        if any(marker in (m.get("content") or "") for m in search_once(cfg, marker, 5)):
            return "present"
        memory_call(_base(), cfg, "/conversation/add", {
            **_scope(), "session_id": DOCS_SESSION, "task_id": marker.strip("[]"),
            "messages": [
                {"role": "user", "content": (
                    f"{marker} Documentation revision {old_rev} of document {doc_id8} is SUPERSEDED "
                    f"by revision {new_rev}. Never present revision {old_rev} as current guidance."),
                 "recorded_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())},
            ]})
        return "written"
    except Exception as e:
        return f"failed: {e}"


# ── core ingest ──────────────────────────────────────────────────────────────

def ingest_file(path, root_arg=None, session=None, now=None):
    """Ingest one document end-to-end. Returns a status dict; expected refusals
    (eligibility/security/size) are returned as DOC_INGEST_BLOCKED, never raised."""
    ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", now or time.gmtime())
    try:
        rel, title, _root = classify_source(path, doc_roots(root_arg))
        text = path.read_text(errors="replace")
        reject_sensitive(text, rel)
    except Blocked as e:
        return {"status": "DOC_INGEST_BLOCKED", "file": str(path), "reason": str(e)}
    rev = sha(text)[:8]
    doc_id8 = sha(rel)[:8]

    def proceed(ledger):
        entry = ledger["docs"].setdefault(rel, {"doc_id": doc_id8, "title": title, "active_rev": None, "revs": {}})
        entry["doc_id"] = doc_id8  # stable across restarts: same rel -> same id
        entry["title"] = title
        report = {"file": rel, "doc_id": doc_id8, "rev": rev, "title": title, "session": session}

        if entry["active_rev"] == rev and entry["revs"].get(rev, {}).get("status") == "DOC_INGEST_INDEXED":
            report.update(status="DOC_INGEST_UNCHANGED", reason="verified active revision matches source hash")
            entry["last_checked"] = ts
            return report

        try:
            chunks = chunk_markdown(text)
        except Blocked as e:
            rec = entry["revs"].get(rev, {})
            rec.update(status="DOC_INGEST_BLOCKED", reason=str(e)[:400])
            entry["revs"][rev] = rec
            report.update(status="DOC_INGEST_BLOCKED", reason=rec["reason"])
            return report
        chunk_tasks = []
        for i, body in enumerate(chunks, start=1):
            chash = sha(body)[:8]
            task_id = f"docs-{doc_id8}-r{rev}-c{i:02d}"
            marker = f"[doc-ref:{rel}#{rev} chunk {i}/{len(chunks)} hash {chash}]"
            header = (f"{marker}\ntitle: {title}\nsource: {rel} (canonical file on disk — this memory record "
                      f"is its indexed copy)\nrevision: {rev}\nchunk: {i}/{len(chunks)}\n"
                      f"content-hash: {chash}\nscope: {os.environ.get('DOC_INDEX_TEAM', 'singularity-docs')}/"
                      f"{os.environ.get('DOC_INDEX_USER', 'shared')}\ningested: {ts}\n\n")
            chunk_tasks.append({"task_id": task_id, "marker": marker, "text": header + body, "hash": chash})

        rec = entry["revs"].setdefault(rev, {"status": "DOC_INGEST_PENDING", "chunks": len(chunks),
                                             "task_ids": [t["task_id"] for t in chunk_tasks],
                                             "hashes": [t["hash"] for t in chunk_tasks],
                                             "ingested_at": ts})
        rec["task_ids"] = [t["task_id"] for t in chunk_tasks]
        rec["chunks"] = len(chunks)
        rec["session"] = session or rec.get("session")

        # Failure path: mark PENDING/FAILED and persist BEFORE any write so
        # crashes/retries are visible and idempotent.
        rec["status"] = "DOC_INGEST_PENDING"
        try:
            cfg = load_cfg()
        except Blocked as e:
            rec["status"] = "DOC_INGEST_BLOCKED"
            rec["reason"] = str(e)[:400]
            report.update(status=rec["status"], reason=rec["reason"])
            return report

        recorded_at = ts
        try:
            for t in chunk_tasks:
                write_chunk(cfg, t, t["text"], recorded_at)  # raises on hard failure
        except RuntimeError as e:
            rec["status"] = "DOC_INGEST_FAILED"
            rec["reason"] = str(e)[:400]
            report.update(status=rec["status"], reason=rec["reason"])
            return report

        # Persisted; now verify each chunk is genuinely searchable.
        deadline = time.time() + VERIFY_TIMEOUT_S
        missing = [t["task_id"] for t in chunk_tasks if not marker_searchable(cfg, t["marker"], deadline)]
        if missing:
            rec["status"] = "DOC_INGEST_PENDING"
            rec["reason"] = f"persisted but not yet searchable: {len(missing)}/{len(chunk_tasks)} chunks (retry)"
            report.update(status="DOC_INGEST_PENDING", reason=rec["reason"])
            return report

        rec["status"] = "DOC_INGEST_INDEXED"
        rec["verified_at"] = ts
        sup = None
        if entry["active_rev"] and entry["active_rev"] != rev:
            sup = write_supersession(cfg, doc_id8, entry["active_rev"], rev)
        entry["active_rev"] = rev
        entry["last_verified"] = ts
        report.update(status="DOC_INGEST_INDEXED", chunks=len(chunks), bytes=len(text), superseded=sup)
        return report

    return with_ledger(proceed)


def retry(path=None, all_docs=False, root_arg=None):
    """Re-attempt PENDING/FAILED ingests (idempotent; never duplicates records)."""
    want = None
    if not all_docs and path:
        want = classify_source(Path(path), doc_roots(root_arg))[0]
    results = []
    ledger = json.loads(_ledger().read_text()) if _ledger().exists() else {"docs": {}}
    for rel in sorted(ledger.get("docs", {})):
        if want and rel != want:
            continue
        results.append(ingest_file(Path(rel), root_arg=root_arg))
    return results


def status_report(rel=None, all_docs=False, root_arg=None):
    from_file = json.loads(_ledger().read_text()) if _ledger().exists() else {"docs": {}}
    roots = doc_roots(root_arg)
    out = []
    for r, e in sorted(from_file["docs"].items()):
        if rel and r != rel:
            continue
        active = e.get("active_rev")
        rec = e["revs"].get(active, {}) if active else {}
        stale = None
        for root in roots:
            p = root / r
            if p.is_file():
                stale = sha(p.read_text(errors="replace"))[:8] != active
                break
        out.append({"file": r, "doc_id": e.get("doc_id"), "active_rev": active,
                    "status": rec.get("status", "DOC_INGEST_PENDING"), "chunks": rec.get("chunks"),
                    "verified_at": rec.get("verified_at"), "stale_source": stale, "title": e.get("title")})
    return out


def search_docs(query, limit=SEARCH_LIMIT_DEFAULT, include_stale=False):
    """Bounded search of the shared documentation knowledge for agents."""
    cfg = load_cfg()
    msgs = search_once(cfg, query, limit * 2 if not include_stale else limit * 4)
    ledger = json.loads(_ledger().read_text()) if _ledger().exists() else {"docs": {}}
    active_by_doc = {d.get("doc_id"): d.get("active_rev") for d in ledger.get("docs", {}).values() if d.get("active_rev")}
    items, seen = [], set()
    for m in msgs:
        content = m.get("content") or ""
        if "docs-superseded:" in content:
            continue  # supersession tombstones are never presented as guidance
        m_ref = re.search(r"\[doc-ref:([^#\]]+)#([0-9a-f]{8})", content)
        if m_ref:
            d_rel, d_rev = m_ref.group(1), m_ref.group(2)
            if not include_stale and active_by_doc.get(sha(d_rel)[:8]) not in (None, d_rev):
                continue  # old revision: excluded from current retrieval
            key = (d_rel, d_rev)
            if key in seen:
                continue
            seen.add(key)
            items.append({"source": d_rel, "revision": d_rev, "content": content[:1200]})
        else:
            items.append({"source": "(unattributed)", "revision": None, "content": content[:600]})
        if len(items) >= limit:
            break
    return items


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--root", help="documentation allowlist root (paths are stored relative to it)")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("ingest", help="ingest one document (idempotent; status JSON)")
    p.add_argument("--file", required=True)
    p.add_argument("--root")
    p.add_argument("--session", help="invocation/session provenance")

    r = sub.add_parser("retry", help="re-attempt pending/failed ingests")
    r.add_argument("--file")
    r.add_argument("--all", action="store_true")
    r.add_argument("--root")

    s = sub.add_parser("status", help="ledger status vs current sources")
    s.add_argument("--file")
    s.add_argument("--all", action="store_true")
    s.add_argument("--root")

    q = sub.add_parser("search", help="bounded search of shared documentation knowledge")
    q.add_argument("query")
    q.add_argument("--limit", type=int, default=SEARCH_LIMIT_DEFAULT)
    q.add_argument("--stale", action="store_true", help="include superseded revisions")

    args = ap.parse_args()
    try:
        if args.cmd == "ingest":
            print(json.dumps(ingest_file(Path(args.file), root_arg=args.root, session=args.session)))
        elif args.cmd == "retry":
            print(json.dumps({"results": retry(args.file, args.all, root_arg=args.root)}))
        elif args.cmd == "status":
            print(json.dumps(status_report(args.file, args.all, root_arg=args.root)))
        else:
            print(json.dumps({"items": search_docs(args.query, args.limit, args.stale)}))
    except Blocked as e:
        print(json.dumps({"status": "DOC_INGEST_BLOCKED", "reason": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
