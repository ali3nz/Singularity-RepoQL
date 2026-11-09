"""Local Claude Code Agents Control for native Windows Singularity.

Only edits Singularity-owned agent files. Other Claude agents and MCP entries are
listed without revealing their prompts or credentials. All mutations require
normal dashboard authentication and the existing same-origin protections.
"""
from __future__ import annotations

import hashlib
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import tempfile
import threading

_LOCK = threading.Lock()
_NAME = re.compile(r"singularity-[a-z0-9][a-z0-9_-]{0,78}\Z")
_OWNED_NAMES = {
    "singularity-code-reviewer", "singularity-thinker",
    "singularity-explore", "singularity-general", "singularity-board",
    "singularity-duel-coordinator", "singularity-quad-coordinator",
    "singularity-duo", "singularity-super",
}
_MAX_BYTES = 65536
# Values Claude Code reads from subagent frontmatter that this editor may write.
# permissionMode is restricted to the NON-escalating values: bypassPermissions and
# auto would widen an agent's authority behind the operator's back, so they are
# refused explicitly instead of being dropped or silently coerced.
_PERMISSION_MODES = ("default", "plan", "acceptEdits", "dontAsk")
_EFFORTS = ("low", "medium", "high", "max")
_MODEL = re.compile(r"\A(?:inherit|sonnet|opus|haiku|[A-Za-z0-9][A-Za-z0-9._:-]{0,79})\Z")
# Required integrations are CONFIGURATION requirements. Presence is computed from
# the configured server names only; connection health and tool availability are
# never implied.
#
# Matching is EXACT (case-insensitive) against the names the product's own config
# authority writes (native/windows/configure_project_mcp.mjs: repoql, kanzo,
# openmausbot). A name that merely contains a product word is an UNKNOWN WRAPPER:
# "not-memorycore", "repoql-test" or "combo-tools" establish neither presence nor
# absence, so they are reported not_verified instead of configured or missing.
_REQUIRED_INTEGRATIONS = {
    "repoql": {"requirement": "official_plugin_or_mcp", "aliases": ("repoql",),
               "pluginAlternative": True, "mcpServer": True},
    "kanzo": {"requirement": "project_mcp", "aliases": ("kanzo",),
              "pluginAlternative": False, "mcpServer": True},
    # MemoryCore is a RepoQL connector scheme (native/windows/provision_connectors.py),
    # not an MCP server. No server name can establish it, so aliases stay empty and
    # this panel never claims the connector is configured.
    "memorycore": {"requirement": "repoql_memorycore_connector", "aliases": (),
                   "pluginAlternative": False, "mcpServer": False},
    "openmausbot": {"requirement": "local_paired_mcp", "aliases": ("openmausbot",),
                    "pluginAlternative": False, "mcpServer": True},
}


def _native():
    if os.environ.get("SINGULARITY_WINDOWS_NATIVE") != "1":
        raise FileNotFoundError("native_windows_only")


def _agents_dir() -> Path:
    # User profile is not supplied by the HTTP caller. Explicitly configured
    # test/provisioning paths are permitted only through the host environment.
    path = Path(os.environ.get("SINGULARITY_CLAUDE_AGENTS_DIR", str(Path.home() / ".claude" / "agents")))
    if not path.is_absolute():
        raise ValueError("agents_directory_not_absolute")
    if path.is_symlink() or (hasattr(path, "is_junction") and path.is_junction()):
        raise PermissionError("agents_directory_reparse_refused")
    return path


def _safe(name: str) -> Path:
    if not isinstance(name, str) or not _NAME.fullmatch(name) or name not in _OWNED_NAMES:
        raise ValueError("invalid_or_excluded_agent")
    directory = _agents_dir()
    if not directory.is_dir():
        raise FileNotFoundError("claude_agents_not_installed")
    path = directory / (name + ".md")
    if path.is_symlink():
        raise PermissionError("agent_symlink_refused")
    return path


def _digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _frontmatter(data: str, name: str) -> dict:
    match = re.match(r"\A---\r?\n([\s\S]*?)\r?\n---\r?\n", data)
    if not match or not data[match.end():].strip():
        raise ValueError("invalid_agent_frontmatter_or_instructions")
    result = {}
    for line in match.group(1).splitlines():
        m = re.match(r"^([a-zA-Z][a-zA-Z0-9_-]*):\s*(.*)$", line)
        if m:
            result[m.group(1)] = m.group(2).strip().strip('"\'')
    if result.get("name") != name or not result.get("description"):
        raise ValueError("agent_name_or_description_invalid")
    if "permissions" in result or "mode" in result:
        raise ValueError("openchamber_only_agent_fields_refused")
    permission = result.get("permissionMode", "")
    if permission and permission not in _PERMISSION_MODES:
        raise ValueError("unsafe_permission_mode_refused")
    effort = result.get("effort", "")
    if effort and effort not in _EFFORTS:
        raise ValueError("invalid_agent_effort")
    model = result.get("model", "")
    if model and not _MODEL.fullmatch(model):
        raise ValueError("invalid_agent_model")
    if name == "singularity-code-reviewer" and re.search(r"\b(?:Edit|Write|Bash)\b", result.get("tools", "")):
        raise ValueError("reviewer_must_remain_read_only")
    return {key: result.get(key, "") for key in
            ("name", "description", "model", "effort", "tools", "permissionMode")}


def _read(path: Path) -> bytes:
    if path.is_symlink() or not path.is_file():
        raise FileNotFoundError("agent_unavailable")
    if path.stat().st_size > _MAX_BYTES:
        raise ValueError("agent_too_large")
    return path.read_bytes()


def list_agents() -> dict:
    _native()
    folder = _agents_dir()
    if not folder.is_dir():
        return {"available": False, "reason": "claude_agents_not_installed", "agents": []}
    entries = []
    for path in sorted(folder.glob("*.md"))[:200]:
        name = path.stem
        managed = name in _OWNED_NAMES
        if path.is_symlink() or not path.is_file():
            continue
        entry = {"name": name, "managed": managed, "editable": managed}
        if managed:
            try:
                data = _read(path)
                entry.update(_frontmatter(data.decode("utf-8"), name))
                entry["revision"] = _digest(data)
            except (ValueError, UnicodeDecodeError, OSError):
                entry["editable"] = False
                entry["error"] = "invalid_definition"
        entries.append(entry)
    return {"available": True, "agents": entries, "source": "local_claude_agents_directory"}


def backup_history(name: str) -> list[dict]:
    """Read-only local backup metadata. Never return saved prompt text or paths."""
    path = _safe(name)
    prefix = "." + name + "."
    result = []
    for candidate in path.parent.glob(prefix + "*.bak"):
        if candidate.is_symlink() or not candidate.is_file():
            continue
        hash_part = candidate.name[len(prefix):-4]
        if not re.fullmatch(r"[0-9a-f]{16}", hash_part):
            continue
        try:
            stat = candidate.stat()
            if stat.st_size > _MAX_BYTES or stat.st_size == 0:
                continue
            result.append({"revisionPrefix": hash_part,
                           "savedAt": datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(),
                           "bytes": stat.st_size})
        except (OSError, OverflowError, ValueError):
            continue
    result.sort(key=lambda x: x["savedAt"], reverse=True)
    return result[:20]


def agent_detail(name: str) -> dict:
    _native()
    path = _safe(name)
    data = _read(path)
    try:
        content = data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ValueError("invalid_utf8") from exc
    return {"name": name, "content": content, "revision": _digest(data),
            "metadata": _frontmatter(content, name), "backups": backup_history(name),
            "source": "local_claude_agents_directory"}


def _commit(name: str, payload: bytes, revision: str) -> dict:
    """The single guarded write path shared by save and restore.

    Validation of the definition itself happens in the callers, before any lock or
    filesystem change; this keeps the restore path byte-identical to a save.
    """
    if len(payload) > _MAX_BYTES:
        raise ValueError("agent_too_large")
    path = _safe(name)
    if not re.fullmatch(r"[0-9a-f]{64}", revision):
        raise ValueError("valid_revision_required")
    with _LOCK:
        previous = _read(path)
        if _digest(previous) != revision:
            raise PermissionError("stale_agent_revision")
        if payload == previous:
            return {"saved": False, "unchanged": True, "revision": revision}
        # Preserve a private, revision-specific recovery copy before replacement.
        backup = path.with_name("." + name + "." + revision[:16] + ".bak")
        if backup.is_symlink():
            raise PermissionError("agent_backup_reparse_refused")
        if not backup.exists():
            backup_fd = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            try:
                with os.fdopen(backup_fd, "wb") as old:
                    old.write(previous)
                    old.flush()
                    os.fsync(old.fileno())
            except BaseException:
                backup.unlink(missing_ok=True)
                raise
        elif _digest(backup.read_bytes()) != revision:
            raise PermissionError("agent_backup_conflict")
        # Do not follow a different reparse target between preview and commit.
        fd, tmp = tempfile.mkstemp(prefix=".singularity-agent-", suffix=".pending", dir=path.parent)
        try:
            os.chmod(tmp, 0o600)
            with os.fdopen(fd, "wb") as stream:
                stream.write(payload)
                stream.flush()
                os.fsync(stream.fileno())
            if path.is_symlink() or _digest(_read(path)) != revision:
                raise PermissionError("agent_changed_while_saving")
            os.replace(tmp, path)
            if _digest(_read(path)) != _digest(payload):
                raise PermissionError("agent_save_readback_failed")
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)
    return {"saved": True, "revision": _digest(payload),
            "runtimeReloadVerified": False,
            "note": "Definition saved. Verify the next Claude Code delegation."}


def save_agent(request: dict) -> dict:
    _native()
    if request.get("confirm") is not True:
        raise ValueError("explicit_confirmation_required")
    name = request.get("name")
    content = request.get("content")
    revision = request.get("revision")
    if not isinstance(content, str) or not isinstance(revision, str):
        raise ValueError("content_and_revision_required")
    _frontmatter(content, name)
    return _commit(name, content.encode("utf-8"), revision)


def restore_agent(request: dict) -> dict:
    """Restore the definition kept before the editor's current revision.

    The backup must still be a complete, hash-matching, valid agent definition for
    this owned name; the write then goes through _commit, so restoring is itself
    reversible, refuses a stale editor revision, and never touches another agent.
    """
    _native()
    if request.get("confirm") is not True:
        raise ValueError("explicit_confirmation_required")
    name = request.get("name")
    revision = request.get("revision")
    backup_id = request.get("backup")
    if not isinstance(revision, str) or not isinstance(backup_id, str):
        raise ValueError("content_and_revision_required")
    if not re.fullmatch(r"[0-9a-f]{64}", revision):
        raise ValueError("valid_revision_required")
    if not re.fullmatch(r"[0-9a-f]{16}", backup_id):
        raise ValueError("valid_backup_required")
    path = _safe(name)
    backup = path.with_name("." + name + "." + backup_id + ".bak")
    if backup.is_symlink() or not backup.is_file():
        raise FileNotFoundError("agent_backup_unavailable")
    data = backup.read_bytes()
    if not 0 < len(data) <= _MAX_BYTES:
        raise ValueError("agent_backup_invalid")
    if _digest(data)[:16] != backup_id:
        raise PermissionError("agent_backup_hash_mismatch")
    try:
        content = data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ValueError("agent_backup_invalid") from exc
    _frontmatter(content, name)
    result = _commit(name, data, revision)
    return {**result, "restored": True, "restoredFrom": backup_id,
            "runtimeReloadVerified": False,
            "note": "Definition restored. Verify the next Claude Code delegation."}


def _required_entry(spec: dict, servers: list) -> dict:
    """Exact-name presence only; a lookalike wrapper proves nothing either way."""
    registered = {}
    for server in servers:
        registered.setdefault(str(server["name"]).lower(), server["name"])
    exact = sorted(registered[alias] for alias in spec["aliases"] if alias in registered)
    wrappers = sorted({server["name"] for server in servers
                       if str(server["name"]).lower() not in spec["aliases"]
                       and any(alias in str(server["name"]).lower() for alias in spec["aliases"])})
    if exact:
        status, reason = "configured", None
    elif not spec["mcpServer"]:
        status, reason = "not_verified", "connector_registration_not_inspected"
    elif wrappers:
        status, reason = "not_verified", "unrecognised_wrapper_name"
    else:
        status, reason = "missing", "no_matching_registration"
    entry = {"requirement": spec["requirement"], "status": status,
             "servers": exact[:3], "pluginAlternative": spec["pluginAlternative"],
             "reason": reason}
    if wrappers:
        entry["unknownWrappers"] = wrappers[:3]
    return entry


def mcp_inventory() -> dict:
    """Configured registration names only. Never return commands, env or tokens."""
    _native()
    paths = [("user", Path.home() / ".claude.json")]
    if os.environ.get("SINGULARITY_CLAUDE_PROJECT"):
        paths.append(("project", Path(os.environ["SINGULARITY_CLAUDE_PROJECT"]) / ".mcp.json"))
    servers = []
    for scope, path in paths:
        if not path.is_file() or path.is_symlink() or path.stat().st_size > 2_000_000:
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            mapping = data.get("mcpServers", {})
            if not isinstance(mapping, dict):
                continue
            for name in sorted(mapping):
                if isinstance(name, str):
                    servers.append({"name": name[:100], "scope": scope,
                                    "configured": True, "connected": None})
        except (OSError, ValueError, UnicodeDecodeError):
            continue
    required = {key: _required_entry(spec, servers)
                for key, spec in _REQUIRED_INTEGRATIONS.items()}
    return {"servers": servers, "required": required,
            "requiredMissing": [key for key, value in required.items() if value["status"] == "missing"],
            "requiredNotVerified": [key for key, value in required.items() if value["status"] == "not_verified"],
            "verification": "configuration_only_no_live_tool_calls",
            "liveHealthClaimed": False}


def policy_inventory() -> dict:
    """Expose hook and rule registrations, not their code, arguments or secrets.

    Configured is not the same as an executed and verified hook. There is no
    single canonical rules file for arbitrary Windows Claude Code installs.
    """
    _native()
    home = Path.home()
    scopes = [("user", home / ".claude")]
    project = os.environ.get("SINGULARITY_CLAUDE_PROJECT", "")
    if project:
        root = Path(project)
        if root.is_absolute() and root.is_dir() and not root.is_symlink():
            scopes.append(("project", root / ".claude"))
    hooks = []
    rules = []
    for scope, directory in scopes:
        settings = directory / "settings.json"
        if settings.is_file() and not settings.is_symlink() and settings.stat().st_size <= 2_000_000:
            try:
                data = json.loads(settings.read_text(encoding="utf-8"))
                events = data.get("hooks", {})
                if isinstance(events, dict):
                    for event, handlers in sorted(events.items()):
                        if not isinstance(event, str) or not re.fullmatch(r"[A-Za-z][A-Za-z0-9]{0,49}", event):
                            continue
                        # A group can contain many handlers. Counts are groups,
                        # since the inventory must not infer actual execution.
                        if isinstance(handlers, list):
                            hooks.append({"scope": scope, "event": event, "groups": len(handlers)})
            except (OSError, ValueError, UnicodeDecodeError, TypeError):
                pass
        rule_dir = directory / "rules"
        if rule_dir.is_dir() and not rule_dir.is_symlink():
            for file in sorted(rule_dir.glob("*.md"))[:150]:
                if file.is_file() and not file.is_symlink():
                    rules.append({"scope": scope, "name": file.name[:130]})
    return {"hooks": hooks, "rules": rules,
            "verification": "registration_only_not_execution",
            "canonical": "no_single_windows_rules_authority_assumed"}
