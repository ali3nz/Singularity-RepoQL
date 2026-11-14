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
control), protected by a shared owner-tagged lock directory and atomic replacement.

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
import hashlib
import json
import os
import re
import secrets
import shutil
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from memory_client import memory_call, ensure_success

# All configuration is read at call time (not import time) so wrappers, tests
# and installers can retarget the stack without re-importing the module.


def _ledger():
    return Path(os.environ.get("SINGULARITY_DOC_DATA", "./data")) / "doc-index" / "ledger.json"


def _lock():
    # A lock DIRECTORY (not a flocked file) so the Node engine, which has no
    # fcntl, can serialise against this helper on the SAME ledger.
    return Path(os.environ.get("SINGULARITY_DOC_DATA", "./data")) / "doc-index" / ".ledger.lock.d"


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


def _config_path():
    return Path(os.environ.get("MEMORY_SECRETS", "./data/opencode/config/product-secrets/memory.json")).absolute()


def load_cfg():
    p = _config_path()
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

LOCK_TIMEOUT_S = 10


def acquire_ledger_lock(lock_dir, timeout=LOCK_TIMEOUT_S, stale=None):
    """Shared Node/Python atomic lock. Never delete a live lock based on mtime.

    An active ingestion may exceed two minutes. Automatic stale reaping can
    race that writer and corrupt the shared ledger. A crashed owner requires
    manual recovery after stopping ALL writers and examining its owner file.
    The `stale` parameter is retained only for old callers; it is ignored.
    """
    lock_dir.parent.mkdir(parents=True, exist_ok=True)
    start = time.monotonic()
    while True:
        try:
            os.mkdir(lock_dir)
        except FileExistsError:
            if time.monotonic() - start > timeout:
                raise RuntimeError(f"ledger lock busy: {lock_dir} (never auto-reaped; stop both writers before manual recovery)")
            time.sleep(0.05)
            continue
        owner = secrets.token_hex(16)
        try:
            (lock_dir / "owner").write_text(owner, encoding="utf-8")
        except Exception:
            try:
                lock_dir.rmdir()
            except OSError:
                pass  # no safe removal when owner is uncertain
            raise
        return owner


def release_ledger_lock(lock_dir, owner):
    owner_file = lock_dir / "owner"
    try:
        recorded = owner_file.read_text(encoding="utf-8")
    except OSError as e:
        raise RuntimeError(f"ledger lock owner cannot be verified: {lock_dir}") from e
    if recorded != owner:
        raise RuntimeError(f"ledger lock ownership changed: {lock_dir}")
    owner_file.unlink()
    lock_dir.rmdir()


def with_ledger(fn, *, checkpoint=False):
    """Run fn under the ledger lock, with an optional in-lock publication callback."""
    lp = _ledger()
    lp.parent.mkdir(parents=True, exist_ok=True)
    lock_dir = _lock()
    owner = acquire_ledger_lock(lock_dir)
    try:
        ledger = _load_ledger()
        def publish():
            _publish_locked_ledger(lp, lock_dir, owner, ledger)
        result = fn(ledger, publish) if checkpoint else fn(ledger)
        publish()
        return result
    finally:
        release_ledger_lock(lock_dir, owner)


def _publish_locked_ledger(lp, lock_dir, owner, ledger):
    # Use a private, exclusive sibling. Never truncate a stale or foreign
    # ledger.tmp before publishing the new ledger.
    data = (json.dumps(ledger, indent=2, sort_keys=True) + "\n").encode("utf-8")
    tmp = None
    try:
        with tempfile.NamedTemporaryFile(dir=lp.parent, prefix=".ledger-",
                                         suffix=".tmp", delete=False) as pending:
            tmp = Path(pending.name)
            pending.write(data)
            pending.flush()
            os.fsync(pending.fileno())
        if (lock_dir / "owner").read_text(encoding="utf-8") != owner:
            raise RuntimeError(f"ledger lock ownership changed: {lock_dir}")
        if os.environ.get("SINGULARITY_DOC_LEDGER_COMMIT_RUST_BIN"):
            try:
                _rust_doc_policy("doc-ledger-commit", {
                    "schema": "singularity-doc-ledger-commit/v1",
                    "temp": str(tmp.absolute()), "owner": owner,
                }, {"ok": True, "published": True},
                   binary_env="SINGULARITY_DOC_LEDGER_COMMIT_RUST_BIN", args=[])
                if tmp.exists() or not lp.is_file():
                    raise RuntimeError("document ledger publication could not be confirmed")
                with lp.open("rb") as published:
                    if published.read(len(data) + 1) != data:
                        raise RuntimeError("document ledger publication differs")
            except Exception:
                # A child may have committed before its response failed.
                # Never retry the commit or fall back to the host writer.
                raise Blocked("native document ledger commit unconfirmed; inspect ledger before retry") from None
        else:
            os.replace(tmp, lp)
        tmp = None
    finally:
        if tmp is not None:
            tmp.unlink(missing_ok=True)

# ── eligibility and safety ───────────────────────────────────────────────────

def doc_roots(root_arg):
    roots = []
    # An explicit --root is an exclusive scope: environment roots are a default
    # only when the invocation did not choose a workspace.
    candidates = (root_arg,) if root_arg else tuple(
        p for p in os.environ.get("SINGULARITY_DOC_ROOTS", "").split(os.pathsep) if p)
    for item in candidates:
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

def _rust_doc_policy(command, request, reference, *, binary_env="SINGULARITY_DOC_RUST_BIN", args=None):
    """Opt-in native leaf only. The Python decision remains an independent oracle.

    This process never receives gateway credentials. A failed or mismatched
    native response blocks the ingestion before the first MemoryCore write.
    """
    binary = os.environ.get(binary_env, "")
    if not binary:
        return reference
    # Reuse the Windows native read-only bridge; no independent subprocess
    # policy that could relax its bounds or acceptance rules.
    import importlib.util
    module_path = Path(__file__).resolve().parent.parent / "native" / "windows" / "rust_readonly_bridge.py"
    try:
        spec = importlib.util.spec_from_file_location("singularity_doc_rust_bridge", module_path)
        if spec is None or spec.loader is None:
            raise ValueError("bridge unavailable")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        # Pure Rust documentation policies need no memory credentials, root
        # allowlists or gateway configuration. Never inherit the full process
        # environment, including during ingestion planning and retrieval.
        allowed = {"PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "HOME"}
        safe_env = {k: v for k, v in os.environ.items() if k.upper() in allowed}
        return module.run_checked(Path(binary), [command] if args is None else args,
                                  reference, data=request, env=safe_env)
    except Exception as exc:
        # Include only a fixed category, never native stderr or document data.
        raise Blocked("native documentation policy unavailable or disagrees with the source contract") from None


def _chunk_markdown_reference(text):
    """Split without truncation, guaranteeing <=7000 Unicode characters per chunk.

    Short normal documents retain the established heading/fence policy. Long
    physical lines are emitted as independent bounded chunks, not silently
    accumulated into an oversize chunk, and the 64-chunk cap fails closed.
    """
    chunks, cur, cur_chars, fence = [], [], 0, False

    def flush():
        nonlocal cur, cur_chars
        if cur:
            chunks.append("\n".join(cur))
            cur, cur_chars = [], 0

    for line in text.splitlines():
        if line.strip().startswith("```"):
            fence = not fence
        is_heading = not fence and re.match(r"^#{1,3} ", line)
        if is_heading and cur and cur_chars >= MAX_CHUNK_CHARS * 0.6:
            flush()
        if len(line) + 1 > MAX_CHUNK_CHARS:
            flush()
            for index in range(0, len(line), MAX_CHUNK_CHARS):
                piece = line[index:index + MAX_CHUNK_CHARS]
                if len(piece) == MAX_CHUNK_CHARS:
                    chunks.append(piece)
                else:
                    cur = [piece]
                    cur_chars = len(piece) + 1
                if len(chunks) > MAX_CHUNKS:
                    raise Blocked(f"document needs more than {MAX_CHUNKS} chunks; split it into smaller docs")
            continue
        if cur and cur_chars + len(line) + 1 > MAX_CHUNK_CHARS:
            flush()
        cur.append(line)
        cur_chars += len(line) + 1
        if len(chunks) > MAX_CHUNKS:
            raise Blocked(f"document needs more than {MAX_CHUNKS} chunks; split it into smaller docs")
    flush()
    if len(chunks) > MAX_CHUNKS:
        raise Blocked(f"document needs {len(chunks)} chunks (max {MAX_CHUNKS}); split it into smaller docs")
    return chunks


def chunk_markdown(text):
    chunks = _chunk_markdown_reference(text)
    native = _rust_doc_policy("doc-index-chunks", {"text": text}, {"ok": True, "chunks": chunks})
    return native["chunks"]


def _chunk_tasks_reference(chunks, rel, title, root_id, doc_id8, rev, ts, team, user):
    tasks = []
    for i, body in enumerate(chunks, start=1):
        chash = sha(body)[:8]
        task_id = f"docs-{doc_id8}-r{rev}-c{i:02d}"
        marker = f"[doc-ref:{rel}#{rev} chunk {i}/{len(chunks)} hash {chash}]"
        header = (f"{marker}\ntitle: {title}\nsource: {rel} (canonical file on disk — this memory record "
                  f"is its indexed copy)\nrevision: {rev}\nroot-id: {root_id}\nchunk: {i}/{len(chunks)}\n"
                  f"content-hash: {chash}\nscope: {team}/{user}\ningested: {ts}\n\n")
        tasks.append({"task_id": task_id, "marker": marker, "text": header + body, "hash": chash})
    return tasks


def doc_chunk_tasks(chunks, rel, title, root_id, doc_id8, rev, ts):
    team = os.environ.get("DOC_INDEX_TEAM", "singularity-docs")
    user = os.environ.get("DOC_INDEX_USER", "shared")
    reference = _chunk_tasks_reference(chunks, rel, title, root_id, doc_id8, rev, ts, team, user)
    native = _rust_doc_policy("doc-index-plan", {
        "chunks": chunks, "rel": rel, "title": title, "rootId": root_id, "docId": doc_id8,
        "rev": rev, "timestamp": ts, "team": team, "user": user,
    }, {"ok": True, "tasks": reference})
    return native["tasks"]


# ── memory writes (single path, idempotent by deterministic task ids) ────────

def search_once(cfg, query, limit=5):
    found = ensure_success(
        memory_call(_base(), cfg, "/conversation/search", {**_scope(), "query": query, "limit": limit}),
        "documentation search")
    return (found.get("data") or {}).get("messages") or []


def _marker_visible(cfg, marker, limit=5):
    binary = os.environ.get("SINGULARITY_DOC_WRITE_RUST_BIN")
    if binary:
        return _write_native_chunk(binary, {**_scope(), "query": marker, "limit": limit},
                                   service_id=cfg.get("serviceId"), marker=True)
    return any(marker in (m.get("content") or "") for m in search_once(cfg, marker, limit))


def marker_searchable(cfg, marker, deadline):
    while True:
        try:
            if _marker_visible(cfg, marker):
                return True
        except Exception:
            pass  # transient gateway errors during eventual indexing: keep polling
        if time.time() >= deadline:
            return False
        time.sleep(VERIFY_POLL_S)


def _write_native_chunk(binary, payload, *, service_id, verify=False, marker=False):
    path = Path(binary)
    if not path.is_absolute() or (os.name == "nt" and not re.fullmatch(r"[A-Za-z]:", path.drive)):
        raise ValueError("DOC_NATIVE_BINARY_INVALID")
    for entry in (path, *path.parents):
        info = entry.lstat()
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            raise ValueError("DOC_NATIVE_BINARY_INVALID")
    if not stat.S_ISREG(path.lstat().st_mode):
        raise ValueError("DOC_NATIVE_BINARY_INVALID")
    digest = os.environ.get("SINGULARITY_DOC_WRITE_RUST_SHA256")
    if digest is not None:
        if not re.fullmatch(r"[a-f0-9]{64}", digest) or path.stat().st_size > 100 * 1024 * 1024:
            raise ValueError("DOC_NATIVE_BINARY_HASH_DRIFT")
        actual = hashlib.sha256()
        with path.open("rb") as exe:
            for chunk in iter(lambda: exe.read(1024 * 1024), b""):
                actual.update(chunk)
        if actual.hexdigest() != digest:
            raise ValueError("DOC_NATIVE_BINARY_HASH_DRIFT")
    env = {k: v for k, v in os.environ.items() if k.upper() in {"SYSTEMROOT", "WINDIR"}}
    env.update(SINGULARITY_DOC_WRITE_CONFIG=str(_config_path()), SINGULARITY_DOC_WRITE_ORIGIN=_base())
    data = json.dumps({"operation": "docFindMarker" if marker else "docVerify" if verify else "docWrite",
                       "path": "/v3/conversation/search" if marker else "/v3/conversation/query" if verify else "/v3/conversation/add",
                       "expected_service": service_id, "body": payload},
                      ensure_ascii=False).encode("utf-8")
    if len(data) > 128 * 1024:
        raise ValueError("DOC_NATIVE_WRITE_LIMIT")
    result = subprocess.run([str(path)], input=data, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                            env=env, timeout=23, check=False, shell=False,
                            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if result.returncode or len(result.stdout) > 4096:
        raise ValueError("DOC_NATIVE_WRITE_UNCONFIRMED")
    reply = json.loads(result.stdout)
    field = "visible" if marker else "verified" if verify else "accepted"
    if (type(reply) is not dict or set(reply) != {"ok", field} or reply["ok"] is not True
            or (type(reply[field]) is not bool if verify or marker else reply[field] is not True)):
        raise ValueError("DOC_NATIVE_WRITE_UNCONFIRMED")
    return reply[field]


def _native_intent_verified(cfg, task, messages):
    """Verify the full pair under the exact persisted task, not a search hit."""
    binary = os.environ.get("SINGULARITY_DOC_WRITE_RUST_BIN")
    if binary:
        return _write_native_chunk(binary, {**_scope(), "session_id": DOCS_SESSION,
                                           "task_id": task, "messages": messages}, service_id=cfg.get("serviceId"), verify=True)
    response = ensure_success(memory_call(_base(), cfg, "/conversation/query", {
        **_scope(), "session_id": DOCS_SESSION, "task_id": task, "offset": 0, "limit": 100,
    }), "documentation task readback")
    data = response.get("data")
    rows = data.get("messages") if isinstance(data, dict) else None
    if not isinstance(rows, list) or len(rows) >= 100:
        return False
    present = {(m.get("role"), m.get("content")) for m in rows
               if isinstance(m, dict) and m.get("task_id") == task
               and isinstance(m.get("role"), str) and isinstance(m.get("content"), str)}
    def normalize(content):
        header, sep, body = content.partition("\n\n")
        return re.sub(r"(?m)^ingested: [^\n]+$", "ingested:", header) + sep + body
    wanted = {(m["role"], normalize(m["content"])) for m in messages}
    return wanted.issubset({(role, normalize(content)) for role, content in present})


def _native_target(cfg):
    scope = _scope()
    values = [_base().rstrip("/"), scope["team_id"], scope["user_id"], scope["agent_id"], cfg.get("serviceId")]
    return sha(json.dumps(values, ensure_ascii=False, separators=(",", ":")))


def write_chunk(cfg, chunk_task, chunk_text, recorded_at, rec, intent, publish):
    """Search before writes and preserve any unresolved native send."""
    binary = os.environ.get("SINGULARITY_DOC_WRITE_RUST_BIN")
    task = chunk_task["task_id"]
    try:
        try:
            searchable = _marker_visible(cfg, chunk_task["marker"], 10)
        except Exception:
            if binary:
                return "uncertain"
            raise
        messages = [
            {"role": "user", "content": chunk_text, "recorded_at": recorded_at},
            {"role": "assistant", "content": f"Documentation record {chunk_task['marker']} acknowledged.",
             "recorded_at": recorded_at},
        ]
        if task in intent:
            # Check the complete role/content pair. Only the generated header
            # timestamp may differ when reconstructing a revision on retry.
            try:
                if searchable and _native_intent_verified(cfg, task, messages):
                    return "present"
            except Exception:
                pass
            return "uncertain"
        if searchable:
            return "present"
        payload = {**_scope(), "session_id": DOCS_SESSION, "task_id": task, "messages": messages}
        if binary:
            rec["write_target"] = _native_target(cfg)
            intent.append(task)
            publish()
            try:
                _write_native_chunk(binary, payload, service_id=cfg.get("serviceId"))
                if not _native_intent_verified(cfg, task, messages):
                    return "uncertain"
            except Exception:
                return "uncertain"
        else:
            ensure_success(memory_call(_base(), cfg, "/conversation/add", payload), f"chunk add {task}")
        return "written"
    except Blocked:
        raise
    except Exception as e:
        raise RuntimeError(f"chunk write failed ({task}): {e}")



def write_supersession(cfg, doc_id8, old_rev, new_rev, rec, publish):
    """Publish or verify one tombstone; never replay an uncertain native send."""
    task_id = f"docs-superseded:{doc_id8}:{old_rev}->{new_rev}"
    marker = f"[{task_id}]"
    messages = [{
        "role": "user",
        "content": (f"{marker} Documentation revision {old_rev} of document {doc_id8} is SUPERSEDED "
                    f"by revision {new_rev}. Never present revision {old_rev} as current guidance."),
        "recorded_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }]
    binary = os.environ.get("SINGULARITY_DOC_WRITE_RUST_BIN")
    pending = "supersession_intent" in rec
    try:
        searchable = _marker_visible(cfg, marker)
        if pending:
            return "present" if searchable and _native_intent_verified(cfg, task_id, messages) else "uncertain"
        if searchable:
            return "present"
        payload = {**_scope(), "session_id": DOCS_SESSION, "task_id": task_id, "messages": messages}
        if binary:
            rec["supersession_intent"] = task_id
            rec["write_target"] = _native_target(cfg)
            publish()
            try:
                _write_native_chunk(binary, payload, service_id=cfg.get("serviceId"))
                return "written" if _native_intent_verified(cfg, task_id, messages) else "uncertain"
            except Exception:
                return "uncertain"
        ensure_success(memory_call(_base(), cfg, "/conversation/add", payload), "supersession tombstone")
        return "written"
    except Blocked:
        raise
    except Exception as e:
        return "uncertain" if pending or binary else f"failed: {e}"



# ── core ingest ──────────────────────────────────────────────────────────────

def ingest_file(path, root_arg=None, session=None, now=None):
    """Ingest one document end-to-end. Returns a status dict; expected refusals
    (eligibility/security/size) are returned as DOC_INGEST_BLOCKED, never raised."""
    ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", now or time.gmtime())
    try:
        rel, title, root_dir = classify_source(path, doc_roots(root_arg))
        text = path.read_text(errors="replace")
        reject_sensitive(text, rel)
    except Blocked as e:
        return {"status": "DOC_INGEST_BLOCKED", "file": str(path), "reason": str(e)}
    # Root-scoped identity: digest(root)::rel means two DIFFERENT workspaces with
    # the same relative path never collapse into one document identity, and the
    # stored root lets retry/status reconstruct the path without the caller's cwd.
    root_id = sha(Path(root_dir).resolve().as_posix())[:8]
    key = f"{root_id}::{rel}"
    rev = sha(text)[:8]
    doc_id8 = sha(key)[:8]

    def proceed(ledger, publish):
        entry = ledger["docs"].setdefault(key, {"rel": rel, "root": Path(root_dir).resolve().as_posix(),
                                                "root_id": root_id, "doc_id": doc_id8,
                                                "title": title, "active_rev": None, "revs": {}})
        entry["root"] = Path(root_dir).resolve().as_posix()  # full path: cwd-independent retry reconstruction
        entry["root_id"] = root_id
        entry["rel"] = rel
        entry["doc_id"] = doc_id8  # stable across restarts; root-scoped (sha(root)::rel)
        entry["title"] = title
        report = {"file": rel, "root": root_id, "identity": key, "doc_id": doc_id8, "rev": rev, "title": title, "session": session}

        if entry["active_rev"] == rev and entry["revs"].get(rev, {}).get("status") == "DOC_INGEST_INDEXED":
            report.update(status="DOC_INGEST_UNCHANGED", reason="verified active revision matches source hash")
            entry["last_checked"] = ts
            return report

        # A pending tombstone may already have changed the remote revision
        # chain. A later edit cannot commit around that uncertain transition.
        if any(other != rev and "supersession_intent" in row
               for other, row in entry["revs"].items()):
            raise Blocked("DOC_NATIVE_PRIOR_SUPERSESSION_UNCONFIRMED")

        try:
            chunks = chunk_markdown(text)
        except Blocked as e:
            rec = entry["revs"].get(rev, {})
            rec.update(status="DOC_INGEST_BLOCKED", reason=str(e)[:400])
            entry["revs"][rev] = rec
            report.update(status="DOC_INGEST_BLOCKED", reason=rec["reason"])
            return report
        try:
            chunk_tasks = doc_chunk_tasks(chunks, rel, title, root_id, doc_id8, rev, ts)
        except Blocked as e:
            rec = entry["revs"].get(rev, {})
            rec.update(status="DOC_INGEST_BLOCKED", reason=str(e)[:400])
            entry["revs"][rev] = rec
            report.update(status="DOC_INGEST_BLOCKED", reason=rec["reason"])
            return report

        rec = entry["revs"].setdefault(rev, {"status": "DOC_INGEST_PENDING", "chunks": len(chunks),
                                             "task_ids": [t["task_id"] for t in chunk_tasks],
                                             "hashes": [t["hash"] for t in chunk_tasks],
                                             "ingested_at": ts})
        rec["task_ids"] = [t["task_id"] for t in chunk_tasks]
        rec["chunks"] = len(chunks)
        intent = rec.get("write_intents", [])
        if (not isinstance(intent, list) or any(not isinstance(i, str) or i not in rec["task_ids"] for i in intent)
                or len(set(intent)) != len(intent)):
            raise Blocked("DOC_LEDGER_WRITE_INTENT_INVALID")
        if intent or os.environ.get("SINGULARITY_DOC_WRITE_RUST_BIN"):
            rec["write_intents"] = intent
        rec["session"] = session or rec.get("session")

        rec["status"] = "DOC_INGEST_PENDING"
        rec.pop("reason", None)
        try:
            cfg = load_cfg()
        except Blocked as e:
            rec["status"] = "DOC_INGEST_BLOCKED"
            rec["reason"] = str(e)[:400]
            report.update(status=rec["status"], reason=rec["reason"])
            return report

        old_rev = entry["active_rev"]
        expected_supersession = f"docs-superseded:{doc_id8}:{old_rev}->{rev}" if old_rev and old_rev != rev else None
        if "supersession_intent" in rec and rec["supersession_intent"] != expected_supersession:
            raise Blocked("DOC_LEDGER_SUPERSESSION_INTENT_INVALID")
        if "write_target" in rec and rec["write_target"] != _native_target(cfg):
            raise Blocked("DOC_NATIVE_WRITE_TARGET_CHANGED")

        # Persist intent before any remote write. Keep the prior active
        # revision until the new one is independently searchable.
        publish()
        recorded_at = ts
        try:
            for t in chunk_tasks:
                if write_chunk(cfg, t, t["text"], recorded_at, rec, intent, publish) == "uncertain":
                    rec["reason"] = "DOC_NATIVE_WRITE_UNCONFIRMED: wait for readback or reconcile before retry"
                    report.update(status=rec["status"], reason=rec["reason"])
                    return report
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

        sup = None
        if expected_supersession:
            sup = write_supersession(cfg, doc_id8, old_rev, rev, rec, publish)
            if sup == "uncertain":
                rec["reason"] = "DOC_NATIVE_SUPERSESSION_UNCONFIRMED: verify the prior revision before retry"
                report.update(status=rec["status"], reason=rec["reason"])
                return report
        rec.pop("write_intents", None)
        rec.pop("write_target", None)
        rec.pop("supersession_intent", None)
        rec["status"] = "DOC_INGEST_INDEXED"
        rec["verified_at"] = ts
        entry["active_rev"] = rev
        entry["last_verified"] = ts
        report.update(status="DOC_INGEST_INDEXED", chunks=len(chunks), bytes=len(text), superseded=sup)
        return report

    return with_ledger(proceed, checkpoint=True)

# ── retry / status / verify / search (root-persisted path resolution) ────────

def _load_ledger():
    lp = _ledger()
    if not lp.exists():
        return {"version": 1, "docs": {}}
    try:
        ledger = json.loads(lp.read_text())
    except json.JSONDecodeError as exc:
        raise Blocked("DOC_LEDGER_CORRUPT: invalid JSON; preserve the file and recover it manually") from exc
    if not isinstance(ledger, dict) or type(ledger.get("version")) is not int or ledger["version"] != 1 or not isinstance(ledger.get("docs"), dict):
        raise Blocked("DOC_LEDGER_CORRUPT: invalid ledger structure; preserve the file and recover it manually")
    return ledger


def _root_id_of(root_arg):
    return sha(Path(os.path.abspath(root_arg)).as_posix())[:8]


def _locate_entry_index_reference(candidates, root_pinned):
    """Keep existing single-match and first same-root tie behavior."""
    first = None
    for index, (matches, root_matches) in enumerate(candidates):
        if not matches:
            continue
        if root_pinned:
            if root_matches:
                return index
        elif first is None:
            first = index
        else:
            return None
    return first


def locate_entry_key(ledger, path, root_arg=None):
    """Match recorded paths, never the caller's cwd. A root pin resolves ties.

    Compute path and root equality locally. The optional Rust process sees
    only booleans and returns an index, never a path or root identifier.
    """
    given = Path(path).as_posix()
    root_pin = _root_id_of(root_arg) if root_arg is not None else None
    keys, candidates = [], []
    for key, entry in ledger.get("docs", {}).items():
        rel = entry.get("rel") or key.split("::", 1)[-1]
        root_abs = entry.get("root")
        matches = (given == rel or given.endswith("/" + rel) or
                   (os.path.isabs(given) and bool(root_abs) and
                    given == (Path(root_abs) / rel).as_posix()))
        keys.append(key)
        candidates.append([matches, root_pin is not None and key.split("::", 1)[0] == root_pin])
    pinned = root_pin is not None
    index = _locate_entry_index_reference(candidates, pinned)
    checked = _rust_doc_policy("doc-index-locate", {"candidates": candidates, "rootPinned": pinned},
                               {"ok": True, "index": index})
    if checked["index"] is not None and type(checked["index"]) is not int:
        raise Blocked("native documentation policy unavailable or disagrees with the source contract")
    return None if index is None else keys[checked["index"]]


def resolve_entry_target(entry):
    """Reconstruct root/rel for a ledger entry; refuse paths escaping the root."""
    root_abs, rel = entry.get("root"), entry.get("rel")
    if not root_abs or not rel or not Path(root_abs).is_absolute():
        return None  # legacy entry without persisted root: cannot be resolved safely
    root = Path(root_abs)
    target = root / rel
    try:
        Path(os.path.realpath(target)).relative_to(Path(os.path.realpath(root)))
    except ValueError:
        raise Blocked(f"stored document path escaped its authorised root ({root}); retry refused")
    return target


def root_is_currently_authorised(entry_root, roots):
    """True when the recorded root still belongs to this invocation's allowlist.

    Realpath containment proves the path stays INSIDE its own stored root, but
    a ledger can outlive its workspace: a moved/demoted test workspace or an
    abandoned install would otherwise keep retrying without anyone intending
    it. When roots are configured for the invocation (one passed --root or
    SINGULARITY_DOC_ROOTS), the recorded root must equal one of them or resolve
    inside one. No roots configured -> legacy permissive behaviour.
    """
    if not entry_root:
        return False
    if not roots:
        return True
    ap = Path(os.path.abspath(entry_root))
    for r in roots:
        if ap == r or ap.is_relative_to(r):
            return True
    return False


def retry(path=None, all_docs=False, root_arg=None):
    """Re-attempt PENDING/FAILED ingests (idempotent; never duplicates records).

    Path resolution uses the ROOT PERSISTED IN THE LEDGER, never the caller's
    cwd: a retry launched from any working directory reconstructs the original
    authorised path (entry.root / entry.rel), revalidates that it still
    resolves inside that same authorised root, and only then ingests. Legacy
    entries without a stored root are skipped (they cannot be resolved safely).
    """
    results = []
    roots = doc_roots(root_arg)
    ledger = _load_ledger()
    wanted_key = None
    if not all_docs and path:
        wanted_key = locate_entry_key(ledger, path, root_arg)
        if wanted_key is None:
            return [{"status": "DOC_INGEST_BLOCKED", "file": str(path),
                     "reason": "no ledger record matches --file (nothing recorded for this document)"}]
    for key, entry in sorted(ledger.get("docs", {}).items()):
        if not all_docs and key != wanted_key:
            continue
        if not root_is_currently_authorised(entry.get("root"), roots):
            results.append({"status": "DOC_INGEST_BLOCKED", "file": entry.get("rel") or key,
                            "reason": "recorded root is not inside the currently authorised documentation "
                                      "roots — pass the matching --root or update SINGULARITY_DOC_ROOTS"})
            continue
        try:
            target = resolve_entry_target(entry)
        except Blocked as e:
            results.append({"status": "DOC_INGEST_BLOCKED", "file": entry.get("rel") or key,
                            "reason": str(e)})
            continue
        if target is None:
            continue
        results.append(ingest_file(Path(target), root_arg=entry.get("root")))
    return results


def _status_row(entry, rel):
    active = entry.get("active_rev")
    rec = entry["revs"].get(active, {}) if active else {}
    stale = None
    root_abs = entry.get("root")
    rel = entry.get("rel") or rel
    if root_abs and rel:
        p = Path(root_abs) / rel
        if p.is_file():
            stale = sha(p.read_text(errors="replace"))[:8] != active
    return {"file": rel, "root": entry.get("root_id"), "doc_id": entry.get("doc_id"),
            "active_rev": active, "status": rec.get("status", "DOC_INGEST_PENDING"),
            "chunks": rec.get("chunks"), "verified_at": rec.get("verified_at"),
            "stale_source": stale, "title": entry.get("title")}


def status_report(rel=None, all_docs=False, root_arg=None):
    """Ledger status vs current sources; resolution never touches the caller cwd."""
    ledger = _load_ledger()
    root_pin = _root_id_of(root_arg) if root_arg is not None else None
    out = []
    if rel and not all_docs:
        wanted = locate_entry_key(ledger, rel, root_arg)
        if wanted is not None:
            out.append(_status_row(ledger["docs"][wanted], rel))
        return out
    for key, entry in sorted(ledger.get("docs", {}).items()):
        if root_pin is not None and entry.get("root_id") != root_pin:
            continue  # scope the report to the requested workspace
        out.append(_status_row(entry, entry.get("rel") or key.split("::", 1)[-1]))
    return out


def verify_file(rel, root_arg=None):
    """Independent completion evidence for one document — the LEDGER decides.

    A caller-claimed ingestion status (e.g. a pasted DOC_INGEST_INDEXED) is
    never trusted: verification re-derives every fact from recorded ledger
    evidence plus the current source hash. Returns

        DOC_INGEST_VERIFIED      all evidence checks below hold
        DOC_INGEST_NOT_VERIFIED  otherwise, with a precise reason

    Checks (all required):
        1. a ledger record exists for this workspace/scope
        2. the source file exists inside its authorised root
        3. the current source hash equals the active recorded revision
        4. the active revision is DOC_INGEST_INDEXED *and* has verified_at
        5. chunk records are complete (task ids and hashes accounted for)
        6. no newer unresolved pending/failed revision exists
    """
    ledger = _load_ledger()
    roots = doc_roots(root_arg)
    candidates = []
    for key, entry in sorted(ledger.get("docs", {}).items()):
        rel_e = entry.get("rel") or key.split("::", 1)[-1]
        if rel_e != rel:
            continue
        if not root_is_currently_authorised(entry.get("root"), roots):
            continue  # recorded root is outside this invocation's allowlist
        if root_arg is not None:
            expected = Path(os.path.abspath(root_arg)).as_posix()
            if entry.get("root") and entry["root"] != expected:
                return {"status": "DOC_INGEST_NOT_VERIFIED", "file": rel_e, "reason":
                        "recorded under a different workspace root; wrong workspace/scope"}
            if entry.get("root_id") and entry["root_id"] != _root_id_of(root_arg):
                continue
        candidates.append((key, entry))
    if not candidates:
        return {"status": "DOC_INGEST_NOT_VERIFIED", "file": rel,
                "reason": "no ledger record for this document in this workspace/scope"}
    if len(candidates) > 1:
        return {"status": "DOC_INGEST_NOT_VERIFIED", "file": rel,
                "reason": "ambiguous: the same relative path is recorded under several roots; pass --root"}
    _key, entry = candidates[0]
    rel_e = entry.get("rel") or _key.split("::", 1)[-1]
    return _entry_evidence(entry, rel_e)


def _ledger_evidence_reference(facts):
    """Read-only verdict on redacted revision facts, not the ledger or files.

    This is deliberately independent of _entry_evidence's existing return
    branches. Any enabled Rust disagreement blocks a VERIFIED claim.
    """
    unresolved = [i for i, row in enumerate(facts["revisions"])
                  if not row["active"] and row["unresolved"] and row["newer"]]
    if facts["active"] and not facts["hash_equal"]:
        verdict = "stale_hash"
    elif not facts["indexed"] or not facts["verified"]:
        verdict = "not_indexed"
    elif not facts["chunks_complete"]:
        verdict = "incomplete_chunks"
    elif unresolved:
        verdict = "unresolved_revisions"
    else:
        verdict = "verified"
    return {"ok": True, "verdict": verdict, "newer_unresolved_indices": unresolved}


def _ledger_evidence_rust_check(entry, active, rec, current):
    """Cross-check durable completion without sending names, paths or content.

    Python remains the sole source/ledger authority and constructs the answer.
    Rust sees only booleans and positional revision indexes; it never receives
    the root, revision hash, timestamps, task identifiers or MemoryCore data.
    """
    if not os.environ.get("SINGULARITY_DOC_LEDGER_RUST_BINARY"):
        return
    revisions = sorted(entry["revs"].items())
    if len(revisions) > 256:
        raise Blocked("native documentation evidence revision limit exceeded")
    chunks = rec.get("chunks") or 0
    task_ids = rec.get("task_ids") or []
    hashes = rec.get("hashes") or []
    facts = {
        "schema": "singularity-doc-ledger-evidence/v1",
        "active": bool(active),
        "hash_equal": current == active,
        "indexed": rec.get("status") == "DOC_INGEST_INDEXED",
        "verified": bool(rec.get("verified_at")),
        "chunks_complete": bool(chunks) and len(task_ids) == chunks
                           and len(hashes) == chunks and all(bool(h) for h in hashes),
        "revisions": [
            {"active": r == active,
             "unresolved": v.get("status") in ("DOC_INGEST_PENDING", "DOC_INGEST_FAILED"),
             "newer": str(v.get("ingested_at", "")) > str(rec.get("verified_at", ""))}
            for r, v in revisions
        ],
    }
    _rust_doc_policy("doc-index-evidence", facts, _ledger_evidence_reference(facts),
                     binary_env="SINGULARITY_DOC_LEDGER_RUST_BINARY", args=[])


def _entry_evidence(entry, rel_e):
    """Re-derive completion evidence for one exact ledger entry."""
    try:
        target = resolve_entry_target(entry)
    except Blocked as e:
        return {"status": "DOC_INGEST_NOT_VERIFIED", "file": rel_e, "reason": str(e)}
    if target is None:
        return {"status": "DOC_INGEST_NOT_VERIFIED", "file": rel_e,
                "reason": "ledger record has no stored authorised root (legacy entry); re-ingest with --root"}
    if not target.is_file():
        return {"status": "DOC_INGEST_NOT_VERIFIED", "file": rel_e,
                "reason": "documented source file missing on disk"}
    active = entry.get("active_rev")
    rec = entry["revs"].get(active, {}) if active else {}
    current = sha(target.read_text(errors="replace"))[:8]
    _ledger_evidence_rust_check(entry, active, rec, current)
    if active and current != active:
        return {"status": "DOC_INGEST_NOT_VERIFIED", "file": rel_e,
                "reason": "changed source was never indexed successfully (stale hash)"}
    if rec.get("status") != "DOC_INGEST_INDEXED" or not rec.get("verified_at"):
        claimed = rec.get("status") if active else "missing active revision"
        return {"status": "DOC_INGEST_NOT_VERIFIED", "file": rel_e,
                "reason": f"active revision verification record is {claimed!r}, not a verified index"}
    chunks = rec.get("chunks") or 0
    task_ids = rec.get("task_ids") or []
    hash_list = rec.get("hashes") or []
    if not chunks or len(task_ids) != chunks or len(hash_list) != chunks or any(not h for h in hash_list):
        return {"status": "DOC_INGEST_NOT_VERIFIED", "file": rel_e,
                "reason": "incomplete chunk records (task ids/hashes not accounted for)"}
    newer_unresolved = [r for r, v in sorted(entry["revs"].items())
                        if r != active
                        and v.get("status") in ("DOC_INGEST_PENDING", "DOC_INGEST_FAILED")
                        and str(v.get("ingested_at", "")) > str(rec.get("verified_at", ""))]
    if newer_unresolved:
        return {"status": "DOC_INGEST_NOT_VERIFIED", "file": rel_e,
                "reason": f"newer unresolved revision(s) {newer_unresolved}; retry ingestion before claiming completion"}
    return {"status": "DOC_INGEST_VERIFIED", "file": rel_e, "root": entry.get("root_id"),
            "revision": active, "chunks": chunks, "verified_at": rec.get("verified_at")}


def _select_retrieval_indices_reference(rows, limit, include_stale, roots_restricted):
    """Independent source contract for native documentation retrieval selection."""
    selected, seen = [], set()
    for row in rows:
        if row["superseded"] or not row["validMarker"]:
            continue
        if roots_restricted and (not row["hasEntry"] or not row["rootAllowed"]):
            continue
        if not include_stale and (not row["activeRevMatches"] or not row["verifiedActive"]):
            continue
        key = (row["rootId"], row["rel"], row["rev"])
        if key in seen:
            continue
        seen.add(key)
        selected.append(row["index"])
        if len(selected) >= limit:
            break
    return selected


def _doc_retrieval_facts(msgs, ledger, roots, *, require_current):
    """Parse and independently verify source provenance, never a caller claim.

    Rows contain only redacted decision metadata. MemoryCore message contents,
    ledger paths, credentials and document bodies never enter the Rust policy.
    """
    entries = {}
    for key, entry in ledger.get("docs", {}).items():
        entries[(entry.get("root_id"), entry.get("rel") or key.split("::", 1)[-1])] = entry
    rows, display = [], {}
    for index, message in enumerate(msgs):
        content = message.get("content") or ""
        superseded = "docs-superseded:" in content
        m_ref = re.search(r"\[doc-ref:([^#\]]+)#([0-9a-f]{8})", content) if not superseded else None
        valid = m_ref is not None
        rel = m_ref.group(1) if valid else ""
        rev = m_ref.group(2) if valid else ""
        m_root = re.search(r"^root-id: ([0-9a-f]{8})$", content, re.M) if valid else None
        root_hit = m_root.group(1) if m_root else None
        matching = entries.get((root_hit, rel)) if valid else None
        active = matching.get("active_rev") if matching else None
        allowed = bool(matching and root_is_currently_authorised(matching.get("root"), roots)) if roots else bool(matching)
        matches = bool(active is not None and active == rev)
        verified = False
        if require_current and matches and matching is not None and (not roots or allowed):
            evidence = _entry_evidence(matching, rel)
            verified = evidence.get("status") == "DOC_INGEST_VERIFIED" and evidence.get("revision") == rev
        rows.append({"index": index, "validMarker": valid, "superseded": superseded,
                     "hasEntry": matching is not None, "rootAllowed": allowed,
                     "activeRevMatches": matches, "verifiedActive": verified,
                     "rootId": root_hit or "", "rel": rel, "rev": rev})
        if valid:
            display[index] = {"source": rel, "root": root_hit, "revision": rev, "content": content[:1200]}
    return rows, display


def _native_retrieval_facts(facts):
    """Replace source/revision identity with nonreversible, per-call group IDs.

    The Rust selection policy needs only equality between triples for dedup.
    The Python reference and canonical ledger keep the real identity values.
    """
    groups = {}
    private_fields = {"rootId", "rel", "rev"}
    projected = []
    for row in facts:
        identity = (row["rootId"], row["rel"], row["rev"])
        if identity not in groups:
            groups[identity] = str(len(groups))
        projected.append({**{key: value for key, value in row.items()
                             if key not in private_fields},
                          "rootId": groups[identity], "rel": "", "rev": ""})
    return projected


def search_docs(query, limit=SEARCH_LIMIT_DEFAULT, include_stale=False, root_arg=None):
    """Return only verified active documents unless stale history was requested.

    The network and filesystem authority stay in Python. Native Rust receives
    a bounded list of provenance decisions and returns selected indices only,
    which are checked against the independent Python reference before use.
    """
    cfg = load_cfg()
    msgs = search_once(cfg, query, limit * 2 if not include_stale else limit * 4)
    ledger = _load_ledger()
    roots = doc_roots(root_arg)
    facts, display = _doc_retrieval_facts(msgs, ledger, roots, require_current=not include_stale)
    selection = _select_retrieval_indices_reference(facts, limit, include_stale, bool(roots))
    native = _rust_doc_policy("doc-index-select", {
        "candidates": _native_retrieval_facts(facts), "limit": limit,
        "includeStale": bool(include_stale), "rootsRestricted": bool(roots),
    }, {"ok": True, "indices": selection})
    return [display[i] for i in native["indices"]]


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--root", help="documentation allowlist root; ledger state defaults to <root>/data")
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

    v = sub.add_parser("verify", help="independent ledger-evidence verification for one document")
    v.add_argument("--file", required=True)
    v.add_argument("--root")

    q = sub.add_parser("search", help="bounded search of shared documentation knowledge")
    q.add_argument("query")
    q.add_argument("--limit", type=int, default=SEARCH_LIMIT_DEFAULT)
    q.add_argument("--stale", action="store_true", help="include superseded/unledgered revisions")
    q.add_argument("--root", help="workspace/root whose ledger filters what counts as current")

    args = ap.parse_args()
    if args.root and not os.environ.get("SINGULARITY_DOC_DATA"):
        os.environ.setdefault("SINGULARITY_DOC_DATA", str(Path(os.path.abspath(args.root)) / "data"))
    try:
        if args.cmd == "ingest":
            print(json.dumps(ingest_file(Path(args.file), root_arg=args.root, session=args.session)))
        elif args.cmd == "retry":
            print(json.dumps({"results": retry(args.file, args.all, root_arg=args.root)}))
        elif args.cmd == "status":
            print(json.dumps(status_report(args.file, args.all, root_arg=args.root)))
        elif args.cmd == "verify":
            print(json.dumps(verify_file(args.file, root_arg=args.root)))
        else:
            print(json.dumps({"items": search_docs(args.query, args.limit, args.stale, root_arg=args.root)}))
    except Blocked as e:
        print(json.dumps({"status": "DOC_INGEST_BLOCKED", "reason": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
