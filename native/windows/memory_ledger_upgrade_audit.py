#!/usr/bin/env python3
"""Read-only documentation-memory upgrade audit for the Windows Claude profile.

This audit NEVER authorizes an upgrade. It checks that every recorded document
has a current verified active revision before any native MemoryCore cutover.
The on-disk ledger, source files, symlink checks and source hashes remain under
Python's authority. The optional Rust process receives boolean facts only and
must return the identical verdict. It never receives names, paths or contents.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import sys

SCHEMA = "singularity-memory-ledger-upgrade/v1"
MAX_LEDGER_BYTES = 16 * 1024 * 1024
MAX_DOCUMENTS = 2048
MAX_REVISIONS = 256


def _load_module():
    # Import the existing policy instead of reinventing root containment,
    # revision hashing, or the semantics of active/verified records.
    scripts = Path(__file__).resolve().parents[2] / "scripts"
    sys.path.insert(0, str(scripts))
    spec = importlib.util.spec_from_file_location("singularity_doc_ingest_policy", scripts / "memory-doc-ingest.py")
    if spec is None or spec.loader is None:
        raise ValueError("documentation ingestion policy unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _read_ledger(path: Path) -> dict:
    if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_LEDGER_BYTES:
        raise ValueError("ledger missing, linked or too large")
    # Do not log ledger content or any path on parse errors.
    try:
        ledger = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, ValueError):
        raise ValueError("ledger cannot be read as JSON") from None
    if not isinstance(ledger, dict) or type(ledger.get("version")) is not int or ledger["version"] != 1 or not isinstance(ledger.get("docs"), dict):
        raise ValueError("ledger schema invalid")
    if len(ledger["docs"]) > MAX_DOCUMENTS:
        raise ValueError("ledger has too many documents")
    return ledger


def _fact(entry: dict, roots: list[Path], module) -> dict:
    # Invalid data stays an unverified fact. It must not be allowed to crash
    # the audit into a successful empty result or leak a path to stdout.
    if not isinstance(entry, dict):
        return dict(root_authorized=False, source_exists=False, active=False, hash_equal=False,
                    indexed=False, verified=False, chunks_complete=False, newer_unresolved=False)
    root = entry.get("root")
    root_allowed = isinstance(root, str) and bool(root) and module.root_is_currently_authorised(root, roots)
    active = entry.get("active_rev")
    active_ok = isinstance(active, str) and re.fullmatch(r"[a-f0-9]{8}", active) is not None
    revs = entry.get("revs")
    if not isinstance(revs, dict) or len(revs) > MAX_REVISIONS:
        revs = {}
        active_ok = False
    rec = revs.get(active, {}) if active_ok else {}
    if not isinstance(rec, dict):
        rec = {}
    source_exists, hash_equal = False, False
    if root_allowed:
        try:
            target = module.resolve_entry_target(entry)
            # Disallow symbolic links even when their destination happens to
            # remain inside the root. A release gate cannot trust a link that
            # might be retargeted after this snapshot.
            anchor = Path(root)
            if target is not None and target.is_file() and not target.is_symlink():
                cursor = target.parent
                while cursor != anchor and cursor != cursor.parent:
                    if cursor.is_symlink():
                        raise ValueError("linked ancestor")
                    cursor = cursor.parent
                if cursor != anchor:
                    raise ValueError("uncontained path")
                size = target.stat().st_size
                if target.suffix.lower() == ".md" and 0 < size <= module.MAX_DOC_BYTES:
                    source_exists = True
                    if active_ok:
                        hash_equal = module.sha(target.read_text(errors="replace"))[:8] == active
        except (OSError, ValueError, module.Blocked):
            source_exists, hash_equal = False, False
    count = rec.get("chunks")
    tasks = rec.get("task_ids")
    hashes = rec.get("hashes")
    chunks_complete = (type(count) is int and 0 < count <= module.MAX_CHUNKS and
                       isinstance(tasks, list) and isinstance(hashes, list) and
                       len(tasks) == count == len(hashes) and
                       all(isinstance(t, str) and t for t in tasks) and
                       len(set(tasks)) == len(tasks) and
                       all(isinstance(h, str) and re.fullmatch(r"[a-f0-9]{8}", h) for h in hashes))
    verified_at = rec.get("verified_at")
    newest = False
    for revision, value in revs.items():
        if revision == active or not isinstance(value, dict):
            continue
        if value.get("status") in ("DOC_INGEST_PENDING", "DOC_INGEST_FAILED") and isinstance(value.get("ingested_at"), str) and isinstance(verified_at, str) and value["ingested_at"] > verified_at:
            newest = True
            break
    return dict(root_authorized=root_allowed, source_exists=source_exists, active=active_ok,
                hash_equal=hash_equal, indexed=rec.get("status") == "DOC_INGEST_INDEXED",
                verified=isinstance(verified_at, str) and bool(verified_at),
                chunks_complete=chunks_complete, newer_unresolved=newest)


def project_reference(facts: list[dict]) -> dict:
    if len(facts) > MAX_DOCUMENTS:
        raise ValueError("too many documentation entries")
    failures = []
    labels = ("root_authorized", "source_exists", "active", "hash_equal", "indexed",
              "verified", "chunks_complete")
    reasons = ("unauthorized_root", "missing_source", "missing_active_revision", "stale_source",
               "not_indexed", "not_verified", "incomplete_chunks")
    for i, row in enumerate(facts):
        if not isinstance(row, dict) or set(row) != set((*labels, "newer_unresolved")) or any(type(v) is not bool for v in row.values()):
            raise ValueError("invalid ledger fact")
        failure = next((reason for name, reason in zip(labels, reasons) if not row[name]), None)
        if failure is None and row["newer_unresolved"]:
            failure = "unresolved_newer_revision"
        if failure is not None:
            failures.append({"index": i, "reason": failure})
    return {"schema": SCHEMA, "checked": len(facts), "ready": bool(facts) and not failures,
            "failures": failures}


def audit(ledger: dict, root: Path, rust_bin: Path | None = None, runner=None) -> dict:
    if not root.is_absolute() or root.is_symlink() or not root.is_dir():
        raise ValueError("authorized root missing or linked")
    if not isinstance(ledger, dict) or not isinstance(ledger.get("docs"), dict):
        raise ValueError("invalid ledger")
    if len(ledger["docs"]) > MAX_DOCUMENTS:
        raise ValueError("too many documentation entries")
    module = _load_module()
    roots = [root.resolve(strict=True)]
    facts = [_fact(row, roots, module) for _, row in sorted(ledger["docs"].items())]
    expected = project_reference(facts)
    if rust_bin:
        from rust_readonly_bridge import run_checked, RustReadOnlyBridgeError
        allowed = {"PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "HOME"}
        safe_env = {key: value for key, value in os.environ.items() if key.upper() in allowed}
        # An injected runner is reserved for the test harness; production
        # always uses the shared strict bridge with its executable guards.
        if runner is not None:
            import subprocess
            result = runner([str(rust_bin)], input=json.dumps({"schema": SCHEMA, "documents": facts}),
                            capture_output=True, text=True, timeout=10, shell=False, check=False, env=safe_env)
            if result.returncode != (0 if expected["ready"] else 2) or json.loads(result.stdout) != expected:
                raise RuntimeError("MEMORY_LEDGER_NATIVE_MISMATCH")
        else:
            try:
                run_checked(rust_bin, [], expected,
                            data={"schema": SCHEMA, "documents": facts}, env=safe_env)
            except RustReadOnlyBridgeError:
                raise RuntimeError("MEMORY_LEDGER_NATIVE_MISMATCH") from None
    return expected


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--ledger", type=Path, required=True)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--rust-cli", type=Path, default=None)
    args = parser.parse_args(argv)
    try:
        result = audit(_read_ledger(args.ledger), args.root, args.rust_cli)
    except (ValueError, RuntimeError, OSError):
        print(json.dumps({"schema": SCHEMA, "ready": False, "error": "READ_ONLY_AUDIT_REFUSED"}))
        return 2
    print(json.dumps(result, separators=(",", ":")))
    return 0 if result["ready"] else 2


if __name__ == "__main__":
    sys.exit(main())
