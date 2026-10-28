#!/usr/bin/env python3
"""doc_program.py — autonomous documentation programme core (ticket 776, P1).

Operator directive 2026-10-23 (AUTONOMOUS DOCUMENTATION AND SELF-CREATING
RUNBOOKS): documentation is a first-class output of agent work. This module
runs the deterministic part of that loop; drafted prose stays agent-authored.

Design contract:
  * NO new documentation database. The hub Markdown tree is the single
    authority (controller:/opt/harness-unset/documentation in production;
    any local root in the offline synthetic suite), accessed via a Transport.
  * assess(receipt) -> proposal: CREATE / UPDATE / CORRECT / MERGE /
    SUPERSEDE / ARCHIVE / NO_CHANGE / DOC_BLOCKED, and the directive-11
    status vocabulary for the lifecycle. Trivial activity never produces
    documentation; material work without verification evidence is
    DOC_BLOCKED, never invented.
  * Writes: atomic tmp+rename, sha256 preconditions (no silent overwrite),
    prior revision preserved as <name>.bak-<tag>, docs-lock protected,
    scoped inside ONE docs root (no cross-project writes). Governance
    carriers and generated derivatives (AGENTS.md, CLAUDE.md, *_web.md,
    issues/, journal/, security/) are hard-denied write targets
    (directive 8): documenting a change never authorises it.
  * Ingest/publish are pluggable strategies with destination-reported
    verification callbacks: a status only ADVANCES after the destination
    confirms results. Existing MemoryCore/RepoQL/WikiJS surfaces are reused.
  * Duplicate prevention: an existing matching doc always wins over CREATE
    (maintain, don't duplicate; directive 2/7).

Stdlib-only; must not execute a main() on import.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import time

# --- vocabulary (directive 11) ----------------------------------------------

VERBS = ("CREATE", "UPDATE", "CORRECT", "MERGE", "SUPERSEDE", "ARCHIVE",
         "NO_CHANGE", "DOC_BLOCKED")
STATUSES = ("DOC_CREATED", "DOC_UPDATED", "DOC_UNCHANGED", "DOC_NOT_REQUIRED",
            "DOC_BLOCKED", "DOC_INGEST_PENDING", "DOC_INGEST_INDEXED",
            "DOC_INGEST_FAILED", "DOC_PUBLISH_PENDING", "DOC_PUBLISHED",
            "DOC_PUBLISH_FAILED")

TRIVIAL_CHANGE_TYPES = ("cosmetic", "comment-only", "reformat", "docs-read",
                        "investigation-no-change", "session-chatter",
                        "chat-reminder", "")
MATERIAL_CHANGE_TYPES = ("deployment", "service-config", "implementation",
                         "bugfix", "security", "incident-resolution",
                         "troubleshooting", "recovery", "architecture-decision",
                         "procedure", "recurring-failure", "skill-learning")
RUNBOOKISH = ("deployment", "recovery", "procedure", "troubleshooting",
              "recurring-failure", "incident-resolution")

# Protected sources of truth outside ops docs (directive 8), plus generated
# derivatives. doc-program refuses these paths even when asked directly.
PROTECTED_PATH_RE = re.compile(
    r"(^|/)(AGENTS\.md|CLAUDE\.md)(\.|$)|_web\.md$|MANIFEST\.json$"
    r"|(^|/)issues/|(^|/)journal/|(^|/)security/|(^|/)engagements/"
    r"|(^|/)agents-guides/|(^|/)agent-guides/",
    re.IGNORECASE)

RUNBOOK_SECTIONS = ("Prerequisites", "Operate", "Verify", "Troubleshoot",
                    "Recover")


def slugify(text: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", str(text).lower()).strip("-")
    return re.sub(r"-{2,}", "-", s)[:80]


def sha256_bytes(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


# --- transport ---------------------------------------------------------------

class LocalTransport:
    """Offline synthetic-suite transport: one sandboxed docs root.

    Lock protocol = mkdir-lease (atomic, identical to SshTransport so both
    paths coordinate through the same protocol — Sol correction 2026-10-23
    03:36Z #1). The lock file lives INSIDE the docs root; the operational
    journal defaults OUTSIDE it (correction #2: statutory docs root must not
    contain operational records)."""

    LOCK_NAME = ".doc-program.lock"

    def __init__(self, root: str, journal_path: str | None = None):
        self.root = os.path.abspath(root)
        os.makedirs(self.root, exist_ok=True)
        self._lock_path = os.path.join(self.root, self.LOCK_NAME)
        self._held = os.path.join(self.root, self.LOCK_NAME + ".held")
        # journal outside the docs root by default (Sol correction #2)
        self.journal_path = os.path.abspath(journal_path) if journal_path \
            else self.root.rstrip(os.sep) + "-journal/doc-proposals.jsonl"
        os.makedirs(os.path.dirname(self.journal_path), exist_ok=True)
        # cross-thread guard: lease is per-path, so two threads of one
        # process must serialize before leasing; flock avoided entirely to
        # keep ONE protocol for local and ssh writers (Sol correction #1).
        import threading
        self._thread_lock = threading.Lock()
        self._fd = None  # retained for release-order safety

    def _real(self, rel: str) -> str:
        p = os.path.abspath(os.path.join(self.root, rel))
        if p != self.root and not p.startswith(self.root + os.sep):
            raise ValueError("path escapes docs root: %r" % rel)
        return p

    def exists(self, rel: str) -> bool:
        return os.path.exists(self._real(rel))

    def read(self, rel: str) -> bytes:
        with open(self._real(rel), "rb") as fh:
            return fh.read()

    def sha256(self, rel: str):
        try:
            return sha256_bytes(self.read(rel))
        except FileNotFoundError:
            return None

    def write_atomic(self, rel: str, data: bytes, mode=0o644) -> None:
        p = self._real(rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        tmp = "%s.tmp-doc-%d-%d" % (p, os.getpid(), time.time_ns())
        with open(tmp, "wb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        os.chmod(tmp, mode)
        os.replace(tmp, p)

    def preserve(self, rel: str, tag: str):
        """Snapshot current content as <base>.bak-<tag> before replacement."""
        try:
            data = self.read(rel)
        except FileNotFoundError:
            return None
        base, ext = os.path.splitext(os.path.basename(rel))
        bak = os.path.join(os.path.dirname(rel),
                           "%s.bak-%s%s" % (base, tag, ext or ".md"))
        self.write_atomic(bak, data)
        return bak

    def walk(self) -> list[str]:
        out = []
        for dirpath, _dirs, files in os.walk(self.root):
            for f in sorted(files):
                if ".tmp-doc-" in f or f == self.LOCK_NAME:
                    continue
                rel = os.path.relpath(os.path.join(dirpath, f), self.root)
                out.append(rel)
        return sorted(out)

    def acquire_lock(self, timeout: float = 30.0) -> bool:
        # mkdir is atomic; failure = another writer holds the lease
        if not self._thread_lock.acquire(timeout=timeout):
            return False
        if os.path.isdir(self._held):
            self._thread_lock.release()
            return False
        try:
            os.mkdir(self._held)
            return True
        except OSError:
            self._thread_lock.release()
            return False

    def release_lock(self) -> None:
        try:
            os.rmdir(self._held)
        except OSError:
            pass
        if hasattr(self, "_thread_lock"):
            try:
                self._thread_lock.release()
            except RuntimeError:
                pass

    def append_journal(self, rel: str, record: dict) -> None:
        p = os.path.abspath(self.journal_path if rel == "doc-proposals.jsonl"
                            else self._real(rel))
        os.makedirs(os.path.dirname(p) or ".", exist_ok=True)
        with open(p, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(record, sort_keys=True) + "\n")
            fh.flush()
            os.fsync(fh.fileno())


def fcntl_lock_release_unused_removed():
    pass

class SshTransport:
    """Production transport over ssh (e.g. controller hub docs root).

    ONE lock protocol shared with LocalTransport (mkdir-lease).
    Operational journal lives OUTSIDE the docs root (Sol correction #2):
    default <root parent>/kit-operational/doc-proposals.jsonl is NOT the
    authoritative tree; override via SshTransport(..., journal_path=...).
    """

    def __init__(self, target: str, root: str,
                 journal_path: str | None = None):
        self.target = target
        self.root = "/" + root.strip("/") + "/"
        self._lock_path = self.root + LocalTransport.LOCK_NAME
        self._held = self._lock_path + ".held"
        self.journal_path = os.path.abspath(journal_path) if journal_path \
            else "/opt/harness-unset/ai-orchestration/kit/runs/" \
                 "docs-proposals.jsonl"

    def _ssh(self, shellcmd: str):
        import subprocess as sp
        return sp.run(["ssh", self.target, shellcmd], capture_output=True,
                      text=True, timeout=120)

    def _q(self, path: str) -> str:
        return "'" + path.replace("'", "'\\''") + "'"

    def exists(self, rel: str) -> bool:
        r = self._ssh("test -e %s && echo y" % self._q(self.root + rel))
        return r.returncode == 0 and r.stdout.strip().startswith("y")

    def read(self, rel: str) -> bytes:
        import subprocess as sp
        r = sp.run(["ssh", self.target, "cat " + self._q(self.root + rel)],
                   capture_output=True, timeout=120)
        if r.returncode != 0:
            raise FileNotFoundError(rel)
        return r.stdout

    def sha256(self, rel: str):
        r = self._ssh("sha256sum %s 2>/dev/null | cut -d' ' -f1"
                      % self._q(self.root + rel))
        s = r.stdout.strip()
        return s if len(s) == 64 else None

    def write_atomic(self, rel: str, data: bytes, mode=0o644) -> None:
        import subprocess as sp
        import base64
        real = self.root + rel
        b64 = base64.b64encode(data).decode()
        script = ("mkdir -p $(dirname %s) && printf %%s '%s' | base64 -d"
                  " > %s.tmp-doc && chmod %o %s.tmp-doc && mv %s.tmp-doc %s"
                  % (self._q(real), b64, self._q(real), mode,
                     self._q(real), self._q(real), self._q(real)))
        r = sp.run(["ssh", self.target, script], capture_output=True,
                   text=True, timeout=120)
        if r.returncode != 0:
            raise IOError("remote docs write failed: " + r.stderr[-300:])

    def preserve(self, rel: str, tag: str):
        real = self.root + rel
        base, ext = os.path.splitext(os.path.basename(real))
        bak = os.path.join(os.path.dirname(real),
                           "%s.bak-%s%s" % (base, tag, ext or ".md"))
        self._ssh("test -e %s && cp %s %s || true"
                  % (self._q(real), self._q(real), self._q(bak)))
        return bak

    def walk(self) -> list[str]:
        r = self._ssh(
            "find %s -name %s -prune -o -type f -print"
            % (self._q(self.root), self._q(LocalTransport.LOCK_NAME)))
        base = self.root
        return [ln.strip()[len(base):] for ln in r.stdout.splitlines()
                if ln.strip().startswith(base) and ".bak-" not in ln.strip()]

    def acquire_lock(self, timeout: float = 30.0) -> bool:
        r = self._ssh("mkdir %s 2>/dev/null && echo leased || echo busy"
                      % self._q(self._held))
        if r.returncode != 0 and "busy" not in r.stdout:
            # Honest failure: an unreachable transport is NOT a busy lease.
            raise RuntimeError("ssh transport unavailable for docs lock: "
                               + (r.stderr or "rc=%s" % r.returncode)[-200:])
        return "leased" in r.stdout

    def release_lock(self) -> None:
        self._ssh("rmdir " + self._q(self._held))

    def append_journal(self, rel: str, record: dict) -> None:
        import subprocess as sp
        real = (self.journal_path if rel == "doc-proposals.jsonl"
                else self.root + rel)
        line = json.dumps(record, sort_keys=True).replace("'", "'\\''")
        sp.run(["ssh", self.target,
                "mkdir -p $(dirname %s) && printf '%%s\\n' '%s' >> %s"
                % (self._q(real), line, self._q(real))],
               capture_output=True, text=True, timeout=60)


# --- existing-docs index (duplicate prevention, directive 2/7) ----------------

def build_index(transport) -> list[dict]:
    idx = []
    for rel in transport.walk():
        if not rel.endswith(".md") or ".bak-" in rel:
            continue
        try:
            head = transport.read(rel).decode("utf-8", "replace")[:4000]
        except FileNotFoundError:
            continue
        m = re.match(r"\s*\W*\s*(h[12]|title):?\s*(.+)", head)
        title = (m.group(2).strip() if m and m.group(2)
                 else os.path.basename(rel))
        first_heading = re.search(r"(?m)^#\s+(.+)$", head)
        if first_heading:
            title = first_heading.group(1).strip()
        idx.append({"path": rel, "title": title, "head": head,
                    "sha": transport.sha256(rel)})
    return idx


def find_targets(subject: str, index: list[dict]) -> list[dict]:
    """Exact-slug match on filename or title, then >=2-token head matches."""
    sslug = slugify(subject)
    if not sslug:
        return []
    toks = [t for t in sslug.split("-") if len(t) >= 4]
    exact, scored = [], []
    for e in index:
        dslug = slugify(os.path.splitext(os.path.basename(e["path"]))[0])
        tslug = slugify(e["title"])
        if (dslug and dslug == sslug) or (tslug and tslug == sslug):
            exact.append(e)
            continue
        text = slugify(e["title"]) + " " + slugify(e["head"][:600])
        hits = sum(1 for t in toks if t in text)
        if toks and hits >= max(2, len(toks) - 1):
            scored.append(e)
    return exact + scored


# --- assessment (directive 1/4) ------------------------------------------------

def assess(receipt: dict, index: list[dict], now: float | None = None) -> dict:
    now = now if now is not None else time.time()
    change_type = str(receipt.get("changeType") or "").strip().lower()
    evidence_refs = list(receipt.get("evidenceRefs") or [])
    verified = list(receipt.get("verifiedResults") or [])
    paths = list(receipt.get("paths") or [])
    subject = str(receipt.get("subject") or _subject_from_paths(paths)
                  or receipt.get("summary") or "")

    # P0 §3 (2026-10-23): the proposal carries the STRUCTURED evidence the body
    # generator needs. A receipt that supplies objective/commands/rollback
    # yields a real runbook; a receipt that does not says so explicitly
    # ("untested:" / "no evidence recorded") rather than emitting a template.
    prop = {
        "verb": None, "status": None, "subject": subject,
        "changeType": change_type, "evidenceRefs": evidence_refs,
        "verifiedResults": verified, "paths": paths,
        "objective": str(receipt.get("objective") or receipt.get("summary")
                         or "").strip(),
        "systems": [str(x) for x in (receipt.get("systems") or []) if x],
        "hosts": [str(x) for x in (receipt.get("hosts") or []) if x],
        "dependencies": [str(x) for x in (receipt.get("dependencies") or []) if x],
        "commands": [c if isinstance(c, dict) else {"cmd": str(c), "verified": False}
                     for c in (receipt.get("commands") or []) if c],
        "rollback": [str(x) for x in (receipt.get("rollback") or []) if x],
        "troubleshooting": [str(x) for x in (receipt.get("troubleshooting") or []) if x],
        "limitations": [str(x) for x in (receipt.get("limitations") or []) if x],
        "revision": str(receipt.get("revision") or "").strip(),
        "assessedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now)),
        "targetPath": None, "expectedSha": None, "reason": "",
    }

    # gate 1: trivial activity is never documented (directive 1)
    if change_type in TRIVIAL_CHANGE_TYPES:
        prop["verb"], prop["status"] = "NO_CHANGE", "DOC_NOT_REQUIRED"
        prop["reason"] = "trivial change type %r: no documentation warranted" \
            % change_type
        return prop
    # gate 2: material work needs verification evidence; else DOC_BLOCKED
    if not evidence_refs and not verified:
        prop["verb"], prop["status"] = "DOC_BLOCKED", "DOC_BLOCKED"
        prop["reason"] = ("material change (%s) lacks evidenceRefs/verified"
                          "Results; record DOC_BLOCKED or verify first"
                          % (change_type or "unspecified"))
        return prop
    if change_type not in MATERIAL_CHANGE_TYPES and not verified:
        prop["verb"], prop["status"] = "DOC_BLOCKED", "DOC_BLOCKED"
        prop["reason"] = ("unrecognized changeType %r without verified "
                          "results" % change_type)
        return prop

    hits = find_targets(subject, index)
    prop["existing"] = [e["path"] for e in hits]

    # Optional receipt-scoped layout override: the hub tree has real
    # conventions (services/, services/runbooks/, topics/…) the change-type
    # heuristic cannot know. Validated + protected-path checked; default
    # behaviour is unchanged.
    doc_dir = str(receipt.get("docDir") or "").strip("/").strip().lower()
    if doc_dir and not re.fullmatch(r"[a-z0-9-]+(/[a-z0-9-]+){0,2}", doc_dir):
        prop.update({"verb": "DOC_BLOCKED", "status": "DOC_BLOCKED",
                     "reason": "docDir %r is not an internal docs path"
                               % doc_dir})
        return prop
    sub = doc_dir if doc_dir else _dir_for(change_type)

    if len(hits) > 1 and change_type == "architecture-decision":
        prop.update({"verb": "MERGE", "status": "DOC_BLOCKED",
                     "reason": "multiple candidate docs (%s) need a governed "
                               "merge decision before any write"
                               % ", ".join(e["path"] for e in hits)})
    elif hits:
        primary = hits[0]
        verb = "CORRECT" if change_type == "bugfix" else "UPDATE"
        prop.update({
            "verb": verb, "status": "DOC_UPDATED",
            "targetPath": primary["path"], "expectedSha": primary["sha"],
            "reason": "existing doc %s covers subject '%s': maintained, not "
                      "duplicated" % (primary["path"], subject),
        })
    else:
        prop.update({
            "verb": "CREATE", "status": "DOC_CREATED",
            "targetPath": _doc_path(slugify(subject), sub,
                                    index),
            "reason": "no existing doc covers subject '%s' (%s)"
                      % (subject, change_type),
        })
    return prop


def _subject_from_paths(paths: list[str]) -> str:
    for p in paths:
        stem = os.path.splitext(os.path.basename(p))[0]
        if stem and stem not in ("index", "README", "main", "config", "test"):
            return stem.replace("_", "-").replace(".", "-")
    return ""


def _dir_for(change_type: str) -> str:
    return "services/runbooks" if change_type in RUNBOOKISH else "topics"


def _doc_path(slug: str, sub: str, index: list[dict]) -> str:
    existing = {e["path"] for e in index}
    cand = "%s/%s.md" % (sub, slug)
    n = 2
    while cand in existing:
        cand = "%s/%s-%d.md" % (sub, slug, n)
        n += 1
    return cand


# --- content drafting (skeleton + evidence; agent fills prose) ---------------

def _bullets(items: list, empty: str) -> list[str]:
    return ["- " + str(i) for i in items] if items else [empty]


def new_doc_body(prop: dict, now: float | None = None) -> str:
    """Source-grounded body. Every line comes from the receipt's structured
    evidence; sections without evidence say exactly that. No template markers
    are ever emitted — an unknown is stated as an unknown.
    """
    now = now if now is not None else time.time()
    ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now))
    runbook = prop["changeType"] in RUNBOOKISH
    kind = "runbook" if runbook else "notes"
    title = subject_title(prop.get("subject"))
    lines = ["# %s — %s" % (title, kind), "",
             "Last updated: %s (doc-program %s)" % (ts, prop.get("verb") or "CREATE"),
             "Revision: 1",
             "Change type: %s" % (prop.get("changeType") or "unspecified")]
    if prop.get("revision"):
        lines.append("Source revision: %s" % prop["revision"])
    lines.append("")
    # S03 (Sol remediation 2026-10-23): a runbook without a recorded procedure
    # must SAY it is incomplete; it may never present itself as executable.
    if runbook and not (prop.get("commands") or []):
        lines += ["Status: INCOMPLETE RUNBOOK — no executable procedure was "
                  "recorded with this change. Treat the sections below as "
                  "verified facts only, not as operating instructions.", ""]
    elif runbook:
        lines += ["Status: executable runbook — the procedure below comes from "
                  "the recorded change evidence.", ""]

    # Purpose and scope
    lines += ["## Purpose and scope", ""]
    if prop.get("objective"):
        lines.append(prop["objective"])
    else:
        lines.append("no objective recorded in the work receipt — scope "
                     "derived from the affected paths below")
    if prop.get("systems"):
        lines += ["", "Systems: " + ", ".join(prop["systems"])]
    if prop.get("hosts"):
        lines.append("Hosts: " + ", ".join(prop["hosts"]))
    if prop.get("paths"):
        lines += ["", "Affected paths:"] + _bullets(prop["paths"], "")
    lines.append("")

    # Preconditions / dependencies
    lines += ["## Prerequisites", ""]
    pre = []
    if prop.get("hosts"):
        pre.append("reachable hosts: " + ", ".join(prop["hosts"]))
    if prop.get("dependencies"):
        pre.extend(prop["dependencies"])
    if pre:
        lines += _bullets(pre, "")
    else:
        lines.append("untested: no prerequisites or dependency evidence was "
                     "recorded with this change")
    lines.append("")

    # Operate — the actual procedure
    lines += ["## Operate", ""]
    cmds = prop.get("commands") or []
    if cmds:
        for c in cmds:
            cmd = str(c.get("cmd") or "").strip()
            if not cmd:
                continue
            mark = "verified" if c.get("verified") else "untested"
            note = str(c.get("note") or "").strip()
            lines += ["```bash", cmd, "```", "(%s)%s" % (mark, (" — " + note) if note else ""), ""]
    else:
        lines += ["untested: the receipt recorded no commands; the procedure "
                  "was not captured and must not be invented.", ""]

    # Verify
    lines += ["## Verify", ""]
    if prop.get("verifiedResults"):
        lines += _bullets(prop["verifiedResults"], "") + [""]
    else:
        lines += ["untested: no verified results were recorded for this change.", ""]

    # Troubleshoot
    lines += ["## Troubleshoot", ""]
    if prop.get("troubleshooting"):
        lines += _bullets(prop["troubleshooting"], "") + [""]
    else:
        lines += ["untested: no failure modes were observed or recorded.", ""]

    # Recover / rollback
    lines += ["## Recover", ""]
    if prop.get("rollback"):
        lines += _bullets(prop["rollback"], "") + [""]
    else:
        lines += ["untested: no rollback path was recorded.", ""]

    lines += ["## Known limitations", ""]
    lines += _bullets(prop.get("limitations") or [],
                      "none recorded with this change.") + [""]

    lines += ["## Evidence", ""]
    lines += _bullets(prop.get("evidenceRefs") or [],
                      "no evidence references recorded.") + [""]
    lines += ["## History", "",
              "- %s — %s from work receipt (changeType=%s)."
              % (ts, prop.get("verb") or "CREATE",
                 prop.get("changeType") or "unspecified")]
    return "\n".join(lines) + "\n"


def update_plan(prop: dict, current: str, now: float | None = None) -> str:
    """Self-maintenance patch: refresh Last updated, bump Revision, append a
    change record. Warnings are never deleted (apply() enforces)."""
    now = now if now is not None else time.time()
    ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now))
    body = current
    lu = re.compile(r"(?m)^Last updated:.*$")
    entry = "Last updated: %s (doc-program %s)" % (ts, prop["verb"])
    if lu.search(body):
        body = lu.sub(entry, body, count=1)
    else:
        parts = body.split("\n", 1)
        body = (parts[0] + "\n" + entry + "\n" +
                (parts[1] if len(parts) > 1 else ""))
    rev = 2
    m = re.search(r"(?m)^Revision:[ \t]*(\d+)[ \t]*$", body)
    if m:
        rev = int(m.group(1)) + 1
        body = re.sub(r"(?m)^Revision:[ \t]*\d+[ \t]*$", "Revision: %d" % rev,
                      body, count=1)
    else:
        body += "\n---\n\nRevision: 2\n"
    body += ("- %s — %s via doc-program: %s\n  Verified: %s\n"
             % (ts, prop["verb"], (prop.get("reason") or "").strip(),
                "; ".join(prop["verifiedResults"]) or "none recorded"))
    return body


def subject_title(subject) -> str:
    return str(subject or "untitled").replace("-", " ").title()


# --- governed write path (directive 10) ---------------------------------------

def apply(prop: dict, transport) -> dict:
    out = dict(prop)
    if out["verb"] in ("NO_CHANGE", "DOC_BLOCKED"):
        transport.append_journal("doc-proposals.jsonl",
                                 {"kind": "decision", **_compact(out)})
        return out
    if PROTECTED_PATH_RE.search(out.get("targetPath") or ""):
        out["status"] = "DOC_BLOCKED"
        out["reason"] = ("protected/governance path refused (directive 8): %s"
                         % out.get("targetPath"))
        transport.append_journal("doc-proposals.jsonl",
                                 {"kind": "decision", **_compact(out)})
        return out
    if not transport.acquire_lock():
        out["status"] = "DOC_BLOCKED"
        out["reason"] = ("concurrent docs write in progress; lease busy — "
                         "retry, no silent overwrite")
        transport.append_journal("doc-proposals.jsonl",
                                 {"kind": "blocked", **_compact(out)})
        return out
    try:
        tag = time.strftime("%Y%m%dT%H%M%S", time.gmtime())
        if out["verb"] == "CREATE":
            if transport.exists(out["targetPath"]):
                out["status"] = "DOC_BLOCKED"
                out["reason"] = ("target appeared since assessment; "
                                 "re-assess (update, not overwrite)")
                return out
            transport.write_atomic(out["targetPath"],
                                   new_doc_body(out).encode())
            out["status"] = "DOC_CREATED"
        else:  # UPDATE / CORRECT
            current = transport.read(out["targetPath"]).decode("utf-8")
            sha = transport.sha256(out["targetPath"])
            if out.get("expectedSha") and sha != out["expectedSha"]:
                out["status"] = "DOC_BLOCKED"
                out["reason"] = ("hash precondition failed: doc changed since "
                                 "assessment (lost-update prevention); "
                                 "re-assess first")
                transport.append_journal("doc-proposals.jsonl",
                                         {"kind": "conflict", **_compact(out)})
                return out
            transport.preserve(out["targetPath"],
                               "%s-%s" % (tag, out["verb"].lower()))
            body = update_plan(out, current)
            transport.write_atomic(out["targetPath"], body.encode())
            out["status"] = "DOC_UPDATED"
            body = body.replace(out["targetPath"], out["targetPath"], 1)
        out["expectedSha"] = transport.sha256(out["targetPath"])
    finally:
        transport.release_lock()
    transport.append_journal("doc-proposals.jsonl",
                             {"kind": "written", **_compact(out)})
    return out


def _compact(prop: dict) -> dict:
    d = {k: prop.get(k) for k in ("verb", "status", "subject", "changeType",
                                  "targetPath", "evidenceRefs", "reason")}
    d["paths"] = prop.get("paths")
    return d


# --- pluggable ingest / publish strategies (directive 9) ----------------------

def ingest(prop: dict, transport, search_fn) -> dict:
    """search_fn(subject) -> bool: destination-reported searchability.
    Non-mutating: returns an advanced copy."""
    prop = dict(prop)
    if prop.get("status") not in ("DOC_CREATED", "DOC_UPDATED"):
        return prop
    if not search_fn:
        prop["status"] = "DOC_INGEST_PENDING"
        return prop
    try:
        ok = bool(search_fn(prop.get("subject") or ""))
    except Exception as e:
        prop["status"] = "DOC_INGEST_FAILED"
        prop["reason"] = "ingest verification error: " + repr(e)
        return prop
    if ok:
        prop["status"] = "DOC_INGEST_INDEXED"
        prop["reason"] = ((prop.get("reason") or "") +
                          " | ingest verified: subject searchable in "
                          "destination index")
    else:
        prop["status"] = "DOC_INGEST_PENDING"
        prop["reason"] = ((prop.get("reason") or "") +
                          " | ingest pending: subject not yet searchable")
    return prop


# --- real WikiJS publication (P0 §5, 2026-10-23) -------------------------------
# Reuses the fleet's PROVEN WikiJS transport (/usr/local/bin/wiki-gql.py,
# token at /root/.wikijs-api-key) — no second publishing service. Publication
# advances to DOC_PUBLISHED only after a READBACK confirms the content, and a
# failure is recorded as DOC_PUBLISH_FAILED with the destination's own message.
WIKI_GQL = "/usr/local/bin/wiki-gql.py"


WIKI_NAMESPACE = "hub-docs"


def wiki_path_for(target_path: str) -> str:
    """Deterministic destination mapping: hub docs relative path under the
    dedicated /hub-docs area (same path stem, no hashes/ids). Automated
    publishing never lands outside this namespace: unsafe segments are refused
    rather than normalized into a different page."""
    rel = str(target_path or "").strip().strip("/")
    if rel.endswith(".md"):
        rel = rel[:-3]
    parts = [p for p in rel.split("/") if p not in ("", ".")]
    if not parts or any(p == ".." for p in parts):
        raise ValueError("unsafe publication target: %r" % (target_path,))
    return "/%s/%s" % (WIKI_NAMESPACE, "/".join(parts))


def wikijs_publish(prop: dict, transport, run=None, now: float | None = None) -> dict:
    """Publish the committed doc to WikiJS and verify by readback.

    run(argv, input_text) -> (rc, stdout, stderr) is injectable for the offline
    suite; production uses `python3 wiki-gql.py …` on the docs host.
    """
    out = dict(prop)
    # Contract (2026-10-24): publication is a DESTINATION fact, independent of
    # index confirmation. The receipt records the ingest state at publish time,
    # so a published-but-not-yet-indexed doc can never be mistaken for a fully
    # terminal closeout (the lifecycle still requires a terminal ingest step).
    ingest_state = str(out.get("status") or "")
    tpath = out.get("targetPath")
    if not tpath:
        out["status"] = "DOC_PUBLISH_FAILED"
        out["reason"] = (out.get("reason") or "") + " | no targetPath to publish"
        return out
    try:
        wpath = wiki_path_for(tpath)
    except ValueError as e:
        out["status"] = "DOC_PUBLISH_FAILED"
        out["reason"] = (out.get("reason") or "") + " | %s" % e
        return out
    if not wpath.startswith("/%s/" % WIKI_NAMESPACE):  # belt-and-braces
        out["status"] = "DOC_PUBLISH_FAILED"
        out["reason"] = ((out.get("reason") or "") +
                         " | refusing to publish outside /%s" % WIKI_NAMESPACE)
        return out
    try:
        content = transport.read(tpath).decode("utf-8")
    except Exception as e:
        out["status"] = "DOC_PUBLISH_FAILED"
        out["reason"] = (out.get("reason") or "") + " | cannot read committed doc: %r" % e
        return out
    title = (re.search(r"(?m)^#\s+(.+)$", content) or [None, tpath])[1].strip()[:80]
    if run is None:
        def run(argv, input_text=None):
            import subprocess as sp
            r = sp.run(argv, input=input_text, capture_output=True,
                       text=True, timeout=120)
            return r.returncode, r.stdout, r.stderr

    # P0 §4 (2026-10-23 remediation): the WikiJS transport lives on the docs
    # host, but docctl is ALSO legitimately invoked from another host over
    # SshTransport (the freebuff worker runs it that way). Refusing remote
    # execution left publication permanently unavailable from the ordinary
    # closeout path, so the same proven wiki-gql call now runs THROUGH the
    # existing ssh transport: stage the content on the docs host, save, read
    # back, remove the temp file. No new service, no credential handling here.
    import subprocess as sp
    import uuid
    remote = transport.__class__.__name__ == "SshTransport"
    if remote:
        import shlex
        q = transport._q
        tmp = "/tmp/doc-publish-%s.md" % uuid.uuid4().hex[:12]
        try:
            st = sp.run(["ssh", transport.target, "cat > %s && chmod 600 %s"
                         % (q(tmp), q(tmp))], input=content.encode("utf-8"),
                        capture_output=True, timeout=120)
            if st.returncode != 0:
                out["status"] = "DOC_PUBLISH_FAILED"
                out["reason"] = ((out.get("reason") or "") +
                                 " | cannot stage doc on docs host rc=%s"
                                 % st.returncode)
                return out
            cmd = "python3 %s save %s %s %s %s %s" % (q(WIKI_GQL), q(wpath.lstrip("/")),
                                                       q(tmp), q(title), q(""), q("private"))
            sr = transport._ssh(cmd)
            rc, so, se = sr.returncode, sr.stdout, sr.stderr
            pr = transport._ssh("python3 %s page %s"
                                % (q(WIKI_GQL), q(wpath.lstrip("/"))))
            rc2, page, se2 = pr.returncode, pr.stdout, pr.stderr
            pm = transport._ssh("python3 %s meta %s"
                                % (q(WIKI_GQL), q(wpath.lstrip("/"))))
            rc3, meta, se3 = pm.returncode, pm.stdout, pm.stderr
        finally:
            try:
                transport._ssh("rm -f %s" % q(tmp))
            except Exception:
                pass
    else:
        try:
            import tempfile
            fd, local_tmp = tempfile.mkstemp(prefix="doc-publish-", suffix=".md")
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write(content)
            rc, so, se = run(["python3", WIKI_GQL, "save", wpath.lstrip("/"),
                              local_tmp, title, "", "private"])
            try:
                os.unlink(local_tmp)
            except OSError:
                pass
            rc2, page, se2 = run(["python3", WIKI_GQL, "page", wpath.lstrip("/")])
            rc3, meta, se3 = run(["python3", WIKI_GQL, "meta", wpath.lstrip("/")])
        except Exception as e:
            out["status"] = "DOC_PUBLISH_FAILED"
            out["reason"] = (out.get("reason") or "") + " | publish error: %r" % e
            return out

    if rc != 0:
        out["status"] = "DOC_PUBLISH_FAILED"
        out["reason"] = ((out.get("reason") or "") +
                         " | wikijs save rc=%s %s" % (rc, (se or so)[-160:]))
        return out
    # Readback confirmation: the destination must return the SAME document,
    # not merely answer 0. Compare normalized content; older revisions that
    # carry an explicit Revision: line must match it too.
    norm = lambda s: "\n".join(x.rstrip() for x in str(s or "").strip().splitlines())
    marker = (re.search(r"(?m)^Revision:\s*\d+\s*$", content) or [None, ""])[0]
    same = norm(page) == norm(content) or (len(norm(content)) > 200 and norm(content)[:400] in norm(page))
    confirmed = rc2 == 0 and bool(page.strip()) and same and (not marker or marker in page)
    if not confirmed:
        out["status"] = "DOC_PUBLISH_FAILED"
        out["reason"] = ((out.get("reason") or "") +
                         " | wikijs readback did not confirm content (rc=%s)" % rc2)
        return out
    # Operator requirement (2026-10-23): automatic publication is never public.
    # The destination's own metadata must say isPrivate=true and the page must
    # live inside the hub-docs namespace; neither is inferred from the request.
    try:
        meta_doc = json.loads(str(meta or "").strip().splitlines()[-1])
    except Exception:
        meta_doc = {}
    if (rc3 != 0 or not meta_doc or meta_doc.get("isPrivate") is not True
            or str(meta_doc.get("path") or "").split("/")[0] != WIKI_NAMESPACE):
        out["status"] = "DOC_PUBLISH_FAILED"
        out["reason"] = ((out.get("reason") or "") +
                         " | privacy/namespace readback failed (rc=%s meta=%s)"
                         % (rc3, str(meta or se3)[-140:]))
        return out
    out["status"] = "DOC_PUBLISHED"
    out["publishReceipt"] = {"engine": "wikijs", "path": wpath,
                             "verified": True, "readback": True,
                             "private": True, "namespace": WIKI_NAMESPACE,
                             "ingestState": ingest_state,
                             "indexUnconfirmed": ingest_state != "DOC_INGEST_INDEXED",
                             "transport": "ssh" if remote else "local"}
    return out


def publish(prop: dict, transport, publish_fn) -> dict:
    """publish_fn(path) -> {'published': bool, ...}: destination receipt.
    Non-mutating: returns an advanced copy."""
    prop = dict(prop)
    if prop.get("status") != "DOC_INGEST_INDEXED":
        return prop
    if not publish_fn:
        prop["status"] = "DOC_PUBLISH_PENDING"
        return prop
    try:
        rec = publish_fn(prop.get("targetPath")) or {}
        if rec.get("published"):
            prop["status"] = "DOC_PUBLISHED"
            prop["publishReceipt"] = rec
        else:
            prop["status"] = "DOC_PUBLISH_PENDING"
            prop["reason"] = ((prop.get("reason") or "") +
                              " | destination did not confirm publication")
    except Exception as e:
        prop["status"] = "DOC_PUBLISH_PENDING"
        prop["reason"] = "publish attempt error: " + repr(e)
    return prop


# --- skill/runbook mutual consistency (directive 6) ---------------------------

def affected_docs_for_skill(change_paths: list[str], index: list[dict]) -> list[str]:
    """Stable-slug back-references: ops docs to review when a skill (or its
    underlying procedure) changes. Candidates come separately from the
    basename and from parent directory names (a procedure typically lives
    under its service dir). Links by identifier, never duplicated body."""
    skip = {"test", "tests", "index", "readme", "main", "config", "work",
            "var", "tmp", "kit", "workflow", "workflows"}
    refs, seen = [], set()
    for p in change_paths:
        path = str(p).replace("\\", "/")
        dirs = [d for d in os.path.dirname(path).split("/") if d] \
            + [os.path.splitext(os.path.basename(path))[0]]
        for c in dirs:
            s = slugify(c)
            if s and len(s) >= 4 and s not in skip and s not in seen:
                seen.add(s)
                refs.append(s)
    if not refs:
        return []
    out = set()
    for e in index:
        dslug = slugify(os.path.splitext(os.path.basename(e["path"]))[0])
        headslug = e["head"].lower().replace("_", "-")
        for r in refs:
            toks = [t for t in r.split("-") if len(t) >= 4]
            if toks and all(t in dslug or t in headslug for t in toks[:2]):
                out.add(e["path"])
    return sorted(out)


def run(receipt: dict, transport, search_fn=None, publish_fn=None) -> dict:
    """Full cycle: assess -> apply -> ingest -> publish, journaled."""
    index = build_index(transport)
    prop = assess(receipt, index)
    prop = apply(prop, transport)
    if prop["verb"] in ("CREATE", "UPDATE", "CORRECT", "MERGE", "SUPERSEDE",
                        "ARCHIVE"):
        prop = ingest(prop, transport, search_fn)
        prop = publish(prop, transport, publish_fn)
    transport.append_journal("doc-proposals.jsonl",
                             {"kind": "cycle", **_compact(prop)})
    return prop
