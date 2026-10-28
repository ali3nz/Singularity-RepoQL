#!/usr/bin/env python3
"""Versioned prompt store for Ghost's scheduled tasks.

Single writer path for editable task prompts. The control service calls
save/revert; the task runners read the current file and render {{placeholders}}
themselves. The in-code defaults remain the fallback when a file is absent, so
a missing or unreadable store can never stop a scheduled run. A product install
owns its own registry below; nothing here is another install's task list.

Layout (root = GHOST_PROMPT_DIR or /var/lib/ghost-control/prompts):

    prompts.json                              manifest: revisions per task/entry
    <task>/<entry>.md                         current text
    .history/<task>/<entry>/r0001.md          append-only revision texts
    .audit.jsonl                              one JSON line per save/revert/seed

Revisions are never destroyed: a revert writes the chosen old text as a NEW
revision, and every save keeps its own revision file.
"""
from __future__ import annotations

import datetime
import fcntl
import hashlib
import json
import os
import re
from pathlib import Path

SCHEMA = "ghost-prompts/1"
DEFAULT_ROOT = Path(os.environ.get("GHOST_PROMPT_DIR") or "/var/lib/ghost-control/prompts")
PLACEHOLDER = re.compile(r"\{\{\s*([A-Za-z0-9_]+)\s*\}\}")
MANIFEST = "prompts.json"
AUDIT = ".audit.jsonl"


class PromptError(ValueError):
    """A save/revert request that must be refused (never a partial write)."""


# --- registry ---------------------------------------------------------------
# The product's own task list. A host that adds a scheduled task adds it here
# and to its runner: the store is the single writer for the text, the runner is
# the single reader. An entry list may be empty when a task has no agent prompt
# (a scripted send); the dashboard then says so.

TASK_PROMPTS = {
    "sweep": [
        {"id": "synthesis", "label": "Sweep synthesis system prompt",
         "placeholders": [], "max_chars": 30000},
        {"id": "review", "label": "Sweep review system prompt",
         "placeholders": [], "max_chars": 12000},
    ],
    "dream": [
        {"id": "reflection", "label": "Dream reflection brief (header; notes and footer are appended by code)",
         "placeholders": ["date"], "max_chars": 12000},
    ],
    "wake": [
        {"id": "instruction", "label": "Scheduled wake instruction (shared policy preamble stays in code)",
         "placeholders": ["date", "slot", "summary"], "max_chars": 24000},
    ],
}


def _root(root=None) -> Path:
    return Path(root) if root else DEFAULT_ROOT


def entries(task: str):
    """Prompt entry specs for a task, or None when the task id is unknown."""
    return TASK_PROMPTS.get(task)


def spec(task: str, entry: str):
    specs = TASK_PROMPTS.get(task)
    if specs is None:
        raise PromptError("unknown_task")
    for item in specs:
        if item["id"] == entry:
            return item
    raise PromptError("unknown_prompt")


def _now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def validate(text, task: str, entry: str) -> str:
    """Refuse anything that could not be rendered safely at run time."""
    item = spec(task, entry)
    if not isinstance(text, str):
        raise PromptError("text_required")
    if not text.strip():
        raise PromptError("empty_prompt")
    if len(text) > item["max_chars"]:
        raise PromptError("too_large")
    for found in re.finditer(r"\{\{", text):
        # A literal '}}' is allowed (the sweep prompt contains one); a '{{' that
        # does not open a complete token would reach the renderer unresolved.
        if not PLACEHOLDER.match(text, found.start()):
            raise PromptError("malformed_placeholder")
    matches = PLACEHOLDER.findall(text)
    unknown = sorted({name for name in matches if name not in item["placeholders"]})
    if unknown:
        raise PromptError("unknown_placeholder:" + ",".join(unknown))
    if "\x00" in text:
        raise PromptError("invalid_character")
    return text


# --- filesystem -------------------------------------------------------------

def _ensure(root: Path) -> None:
    (root / ".history").mkdir(parents=True, exist_ok=True)


class _Lock:
    def __init__(self, root: Path):
        self.path = root / ".lock"
        self.handle = None

    def __enter__(self):
        _ensure(self.path.parent)
        self.handle = open(self.path, "a+b")
        fcntl.flock(self.handle.fileno(), fcntl.LOCK_EX)
        return self

    def __exit__(self, *exc):
        fcntl.flock(self.handle.fileno(), fcntl.LOCK_UN)
        self.handle.close()
        self.handle = None


def _atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "w", encoding="utf-8") as handle:
        handle.write(text)
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(tmp, 0o644)
    os.replace(tmp, path)


def _manifest(root: Path) -> dict:
    path = root / MANIFEST
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {"schema": SCHEMA, "revs": {}}
    except ValueError as exc:
        raise PromptError("manifest_unreadable") from exc
    if not isinstance(data, dict) or not isinstance(data.get("revs"), dict):
        raise PromptError("manifest_invalid")
    return data


def _write_manifest(root: Path, data: dict) -> None:
    _atomic_write(root / MANIFEST, json.dumps(data, indent=1, sort_keys=True) + "\n")


def _audit(root: Path, record: dict) -> None:
    try:
        with open(root / AUDIT, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, sort_keys=True) + "\n")
    except OSError:
        pass  # audit must never fail a completed save


def _current_path(root: Path, task: str, entry: str) -> Path:
    return root / task / (entry + ".md")


def _history_dir(root: Path, task: str, entry: str) -> Path:
    return root / ".history" / task / entry


def read(task: str, entry: str, root=None) -> dict:
    """Current text + revision metadata. `text` is None when never seeded."""
    spec(task, entry)
    base = _root(root)
    man = _manifest(base) if (base / MANIFEST).exists() else {"revs": {}}
    revs = man["revs"].get(f"{task}/{entry}") or []
    path = _current_path(base, task, entry)
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        text = None
    latest = revs[-1] if revs else None
    return {
        "task": task, "entry": entry, "text": text,
        "rev": latest["rev"] if latest else 0,
        "updatedAt": latest["at"] if latest else None,
        "by": latest.get("by") if latest else None,
        "onDisk": bool(text is not None and latest and latest.get("sha256") == _sha(text)),
        "history": list(reversed(revs)),
    }


def history(task: str, entry: str, root=None) -> list:
    return read(task, entry, root)["history"]


def status(task: str, root=None) -> list:
    """Everything the dashboard needs for one task's prompt entries."""
    base = _root(root)
    out = []
    for item in TASK_PROMPTS.get(task, []):
        state = read(task, item["id"], base)
        out.append({
            "id": item["id"], "label": item["label"],
            "placeholders": item["placeholders"], "maxChars": item["max_chars"],
            "text": state["text"], "rev": state["rev"], "updatedAt": state["updatedAt"],
            "by": state["by"], "onDisk": state["onDisk"], "history": state["history"],
        })
    return out


# --- writes -----------------------------------------------------------------

def _commit(base: Path, task: str, entry: str, text: str, by: str, note, action: str) -> dict:
    man = _manifest(base)
    key = f"{task}/{entry}"
    revs = man["revs"].setdefault(key, [])
    rev = (revs[-1]["rev"] + 1) if revs else 1
    _atomic_write(_current_path(base, task, entry), text)
    _atomic_write(_history_dir(base, task, entry) / ("r%04d.md" % rev), text)
    record = {"rev": rev, "at": _now(), "by": by, "sha256": _sha(text),
              "bytes": len(text.encode("utf-8")), "note": note}
    revs.append(record)
    _write_manifest(base, man)
    _audit(base, {"at": record["at"], "action": action, "task": task, "entry": entry,
                  "rev": rev, "by": by, "bytes": record["bytes"], "note": note})
    return {"task": task, "entry": entry, "rev": rev, "updatedAt": record["at"],
            "by": by, "bytes": record["bytes"], "sha256": record["sha256"]}


def save(task: str, entry: str, text, by: str = "operator", note=None, root=None) -> dict:
    text = validate(text, task, entry)
    base = _root(root)
    with _Lock(base):
        return _commit(base, task, entry, text, by, note, "set-prompt")


def revert(task: str, entry: str, rev, by: str = "operator", root=None) -> dict:
    spec(task, entry)
    try:
        rev = int(rev)
    except (TypeError, ValueError) as exc:
        raise PromptError("invalid_revision") from exc
    base = _root(root)
    with _Lock(base):
        man = _manifest(base)
        revs = man["revs"].get(f"{task}/{entry}") or []
        target = next((item for item in revs if item["rev"] == rev), None)
        if target is None:
            raise PromptError("unknown_revision")
        path = _history_dir(base, task, entry) / ("r%04d.md" % rev)
        try:
            text = path.read_text(encoding="utf-8")
        except FileNotFoundError as exc:
            raise PromptError("revision_text_missing") from exc
        if _sha(text) != target.get("sha256"):
            raise PromptError("revision_text_modified")
        return _commit(base, task, entry, text, by, "revert to r%04d" % rev, "revert-prompt")


def seed(task: str, entry: str, text, by: str = "install", root=None) -> dict | None:
    """Write the in-code default only when the entry has no revision yet."""
    text = validate(text, task, entry)
    base = _root(root)
    with _Lock(base):
        man = _manifest(base)
        if man["revs"].get(f"{task}/{entry}"):
            return None
        return _commit(base, task, entry, text, by, "initial default from code", "seed")


# --- CLI (install/seed helper) ---------------------------------------------

def _main(argv) -> int:
    import sys
    if len(argv) >= 2 and argv[1] == "status":
        out = {task: status(task) for task in TASK_PROMPTS}
        print(json.dumps(out, indent=1))
        return 0
    if len(argv) >= 3 and argv[1] == "seed-json":
        payload = json.loads(Path(argv[2]).read_text(encoding="utf-8"))
        written = []
        for item in payload:
            result = seed(item["task"], item["entry"], item["text"])
            if result:
                written.append(result)
        print(json.dumps({"seeded": written}, indent=1))
        return 0
    print("usage: prompt_store.py status | seed-json <file>", file=sys.stderr)
    return 2


if __name__ == "__main__":
    import sys
    raise SystemExit(_main(sys.argv))
