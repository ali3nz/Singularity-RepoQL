#!/usr/bin/env python3
"""Knowledge promotion for Singularity.

Promotion is explicit and reversible: a proposal is verified against a source
record, promoted into the curated knowledge store with provenance, indexed into
MemoryCore as a knowledge record (L0 unit under a configurable scope, with
content-hash dedup), and retrievable afterwards. Nothing is auto-promoted.
"""
import argparse
import hashlib
import json
import os
import re
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path

STORE = Path(os.environ.get("KNOWLEDGE_STORE", "./data/knowledge-store"))
AREAS = {
    "truth": STORE / "current-truth",
    "history": STORE / "history",
    "knowledge": STORE / "knowledge",
    "proposals": STORE / "proposals",
    "sources": STORE / "sources",
}
SECRETS = Path(os.environ.get("MEMORY_SECRETS", "./data/opencode/config/product-secrets/memory.json"))

INDEX_BASE = os.environ.get("KNOWLEDGE_INDEX_BASE_URL", "http://127.0.0.1:8420")
INDEX_TEAM = os.environ.get("KNOWLEDGE_INDEX_TEAM", "knowledge")
INDEX_USER = os.environ.get("KNOWLEDGE_INDEX_USER", "operator")
INDEX_AGENT = os.environ.get("KNOWLEDGE_INDEX_AGENT", "knowledge-promotion")
INDEX_SESSION = os.environ.get("KNOWLEDGE_INDEX_SESSION", "knowledge-store")


def load_memory_config():
    return json.loads(SECRETS.read_text())


def slug(text):
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:60]


def fingerprint(text):
    return hashlib.sha256(text.encode()).hexdigest()


def content_hash(title, body, source_ref):
    return hashlib.sha256((title + "\x00" + body + "\x00" + source_ref).encode()).hexdigest()


# ── MemoryCore indexing ─────────────────────────────────────────────────────

def _memory_call(path, payload, timeout=10):
    cfg = load_memory_config()
    base = cfg.get("baseUrl", "")
    req = urllib.request.Request(
        INDEX_BASE.rstrip("/") + "/v3" + path,
        data=json.dumps(payload).encode(),
        headers={
            "Content-Type": "application/json",
            "Authorization": cfg["authPrefix"] + cfg["gatewayKey"],
            "x-tdai-service-id": cfg["serviceId"],
            "x-tdai-user-key": cfg["userKey"],
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def index_knowledge(title, body, truth_path, source_ref, supersedes_task_id=None):
    """Write the promoted note as an L0 unit; skip when the same content is already indexed."""
    chash = content_hash(title, body, source_ref)
    task_id = "kpromo-" + chash[:16]
    marker = "[" + task_id + "]"
    scope = {"team_id": INDEX_TEAM, "user_id": INDEX_USER, "agent_id": INDEX_AGENT}
    try:
        found = _memory_call("/conversation/search", {**scope, "query": marker, "limit": 5})
        msgs = (found.get("data") or {}).get("messages") or []
        if any(marker in (m.get("content") or "") for m in msgs):
            return {"indexed": False, "reason": "already-indexed", "task_id": task_id}
    except Exception as e:
        return {"indexed": False, "reason": "index-unavailable: " + str(e)[:80], "task_id": task_id}
    body_text = (
        f"{marker} Knowledge note '{title}' (promoted to {truth_path}).\n"
        f"Source: {source_ref}\n"
        f"Source fingerprint: {fingerprint(Path(source_ref).read_text()) if Path(source_ref).is_file() else 'dir'}\n"
        + (f"Supersedes: {supersedes_task_id}\n" if supersedes_task_id else "")
        + f"\n{body}"
    )
    try:
        _memory_call("/conversation/add", {
            **scope, "session_id": INDEX_SESSION, "task_id": task_id,
            "messages": [
                {"role": "user", "content": body_text,
                 "recorded_at": time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())},
                {"role": "assistant", "content": f"Recorded knowledge note '{title}' ({task_id}).",
                 "recorded_at": time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())},
            ],
        })
        return {"indexed": True, "task_id": task_id}
    except Exception as e:
        return {"indexed": False, "reason": "index-failed: " + str(e)[:80], "task_id": task_id}


# ── store operations ────────────────────────────────────────────────────────

def find_duplicate_proposal(chash):
    AREAS["proposals"].mkdir(parents=True, exist_ok=True)
    for p in AREAS["proposals"].glob("*.md"):
        try:
            if f"content_hash: {chash}" in p.read_text():
                return p
        except OSError:
            continue
    return None


def write_proposal(title, body, source_ref, verifier):
    AREAS["proposals"].mkdir(parents=True, exist_ok=True)
    chash = content_hash(title, body, source_ref)
    dup = find_duplicate_proposal(chash)
    if dup:
        return dup, True
    path = AREAS["proposals"] / f"{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}-{slug(title)}-{chash[:8]}.md"
    path.write_text(
        "\n".join([
            "---",
            f"title: {title}",
            f"source: {source_ref}",
            f"verifier: {verifier}",
            f"proposed: {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}",
            f"content_hash: {chash}",
            "status: proposed",
            "---",
            "",
            body,
            "",
        ])
    )
    return path, False


def verify_source(source_ref):
    """A source must exist and be non-empty, or the proposal is refused."""
    p = Path(source_ref)
    if not p.exists():
        return False, f"source not found: {source_ref}"
    if p.is_file() and p.stat().st_size == 0:
        return False, f"source is empty: {source_ref}"
    return True, "source present"


def promote(proposal_path, truth_name, supersede=False, index=True):
    text = proposal_path.read_text()
    meta = dict(re.findall(r"^(\w+): (.+)$", text, flags=re.M))
    if meta.get("status") != "proposed":
        return None, "proposal is not in proposed state"
    built, reason = verify_source(meta["source"])
    if not built:
        return None, reason

    superseded_task = None
    AREAS["truth"].mkdir(parents=True, exist_ok=True)
    (AREAS["history"] / "truth-superseded").mkdir(parents=True, exist_ok=True)
    target = AREAS["truth"] / f"{truth_name}.md"
    if target.exists():
        if not supersede:
            return None, f"current truth already exists: {target} (use --supersede to replace)"
        old_text = target.read_text()
        old_meta = dict(re.findall(r"^(\w+): (.+)$", old_text, flags=re.M))
        superseded_task = "kpromo-" + content_hash(
            old_meta.get("title", truth_name), old_text.split("---", 2)[-1].strip(), old_meta.get("source", "")
        )[:16]
        stamp = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())
        archived = AREAS["history"] / "truth-superseded" / f"{truth_name}-{stamp}.md"
        archived.write_text(old_text.replace("promoted:", "superseded:", 1))
        with (AREAS["history"] / "promotions.jsonl").open("a") as fh:
            fh.write(json.dumps({"at": time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), "action": "supersede",
                                 "archived": str(archived), "truth": str(target),
                                 "proposal": str(proposal_path), "source": meta["source"]}) + "\n")

    body = text.split("---", 2)[-1].strip()
    target.write_text("\n".join([
        "---",
        f"title: {meta['title']}",
        f"promoted: {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}",
        f"source: {meta['source']}",
        f"verifier: {meta['verifier']}",
        f"source_fingerprint: {fingerprint(Path(meta['source']).read_text()) if Path(meta['source']).is_file() else 'dir'}",
        "---",
        "",
        f"# {meta['title']}",
        "",
        f"Promoted from `{proposal_path.name}`.",
        "",
        body,
        "",
    ]))
    with (AREAS["history"] / "promotions.jsonl").open("a") as fh:
        fh.write(json.dumps({"at": time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), "action": "promote",
                             "proposal": str(proposal_path), "truth": str(target), "source": meta["source"]}) + "\n")
    proposal_path.write_text(text.replace("status: proposed", "status: promoted"))

    result = {"ok": True, "truth": str(target)}
    if index:
        result["index"] = index_knowledge(meta["title"], body, str(target), meta["source"],
                                          supersedes_task_id=superseded_task)
    return target, result


def main():
    ap = argparse.ArgumentParser(description="Explicit, reversible knowledge promotion with MemoryCore indexing.")
    ap.add_argument("--propose", nargs=3, metavar=("TITLE", "BODY", "SOURCE"))
    ap.add_argument("--promote", metavar="PROPOSAL")
    ap.add_argument("--truth-name")
    ap.add_argument("--supersede", action="store_true", help="replace an existing truth doc (archived to history/truth-superseded)")
    ap.add_argument("--no-index", action="store_true", help="skip MemoryCore indexing")
    ap.add_argument("--list", action="store_true")
    args = ap.parse_args()

    for d in AREAS.values():
        d.mkdir(parents=True, exist_ok=True)
    (AREAS["history"] / "promotions.jsonl").touch()

    if args.propose:
        title, body, source = args.propose
        p, dup = write_proposal(title, body, source, os.environ.get("PROMOTION_VERIFIER", "knowledge-promotion"))
        print(json.dumps({"proposal": str(p), "status": "duplicate" if dup else "proposed"}))
    elif args.promote:
        target, result = promote(Path(args.promote), args.truth_name or "promoted-fact",
                                 supersede=args.supersede, index=not args.no_index)
        if not target:
            print(json.dumps({"ok": False, "reason": result}))
            sys.exit(1)
        print(json.dumps(result))
    elif args.list:
        for area, path in AREAS.items():
            files = sorted(p.name for p in path.glob("*.md")) if path.exists() else []
            print(f"{area}: {len(files)} {files[:5]}")
    else:
        ap.print_help()


if __name__ == "__main__":
    main()
