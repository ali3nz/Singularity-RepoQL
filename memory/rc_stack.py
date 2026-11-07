"""RC-owned native memory stack: start, health, scoped probe, teardown.

The Windows memory stack is three vendor components (gateway, core, panel) run
by `scripts/native-memory-supervisor.mjs`. This module is the repeatable
provisioning path for a *fresh* RC location:

  * the supervisor's generated config, bearer token, data and logs all live
    under `root` (RC-owned); the vendor build directories are inputs only and
    are never written;
  * nothing here reads a production stack config, production port or an
    existing instance's credential -- `build_config` takes explicit ports and
    refuses a root that is not absolute;
  * `probe` writes one scoped conversation, recalls it, deletes it and proves
    the recall is empty afterwards, so a test leaves no record behind.
"""
from __future__ import annotations

import json
import os
import subprocess
import urllib.error
import urllib.request
from pathlib import Path

SCHEMA = "native-memory-supervisor/v1"
DEFAULT_CORE_PORT = 18221
DEFAULT_PANEL_PORT = 18226


class StackError(RuntimeError):
    pass


def build_config(root, *, node, core_dir, panel_dir, core_port=DEFAULT_CORE_PORT,
                 panel_port=DEFAULT_PANEL_PORT, core_command=None):
    """RC-owned stack config: state, logs and secrets under `root` only."""
    root = Path(root)
    if not root.is_absolute():
        raise StackError("root must be an absolute RC-owned path")
    if core_port == panel_port:
        raise StackError("core and panel need distinct ports")
    for port in (core_port, panel_port):
        if not 1 <= int(port) <= 65535:
            raise StackError("port out of range")
    core_dir, panel_dir, node = Path(core_dir), Path(panel_dir), Path(node)
    for path in (core_dir, panel_dir):
        if not path.is_absolute() or not path.is_dir():
            raise StackError(f"vendor build input is missing: {path}")
    if not node.is_file():
        raise StackError(f"node runtime is missing: {node}")
    return {
        "schema": SCHEMA,
        "root": str(root),
        "stateDir": str(root / "state"),
        "logsDir": str(root / "logs"),
        "node": str(node),
        "components": {
            "core": {
                "kind": "core", "host": "127.0.0.1", "port": int(core_port),
                "cwd": str(core_dir),
                "command": core_command or ["--import", "tsx", "src/gateway/server.ts"],
                "healthPath": "/health", "readyTimeoutMs": 180000, "env": {},
            },
            "panel": {
                "kind": "panel", "host": "127.0.0.1", "port": int(panel_port),
                "cwd": str(panel_dir), "command": ["dist/index.js"],
                "healthPath": "/", "readyTimeoutMs": 120000, "env": {},
            },
        },
        "order": ["core", "panel"],
    }


def write_config(config, path):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
    return path


def _run(node, supervisor, verb, config_path, timeout=600):
    result = subprocess.run(
        [str(node), str(supervisor), verb, "--config", str(config_path), "--json"],
        capture_output=True, text=True, timeout=timeout, check=False,
    )
    payload = (result.stdout or "").strip()
    try:
        parsed = json.loads(payload) if payload else None
    except json.JSONDecodeError:
        parsed = None
    return result.returncode, parsed, (result.stderr or "").strip()


def _runner(run):
    """Explicit None means "use the default runner"; it is not callable."""
    return _run if run is None else run


def start(node, supervisor, config_path, *, run=_run):
    run = _runner(run)
    code, payload, err = run(node, supervisor, "start", config_path)
    if code != 0:
        raise StackError(f"stack start failed: {(err or json.dumps(payload))[:300]}")
    return payload or {}


def status(node, supervisor, config_path, *, run=_run):
    run = _runner(run)
    code, payload, err = run(node, supervisor, "status", config_path)
    if code != 0:
        raise StackError(f"stack status failed: {(err or json.dumps(payload))[:300]}")
    return payload or {}


def stop(node, supervisor, config_path, *, run=_run):
    run = _runner(run)
    code, payload, err = run(node, supervisor, "stop", config_path)
    if code != 0:
        raise StackError(f"stack stop failed: {(err or json.dumps(payload))[:300]}")
    return payload or {}


def healthy(state):
    processes = (state or {}).get("processes") or []
    return (state or {}).get("code") == "RUNNING" and bool(processes) and all(
        row.get("health") == "ok" and row.get("ownership") == "verified" for row in processes)


def read_token(config):
    path = Path(config["stateDir"]) / "secrets" / "core-bearer"
    try:
        token = path.read_text(encoding="utf-8").strip()
    except OSError as exc:
        raise StackError(f"bearer token is unavailable: {exc}") from None
    if not token:
        raise StackError("bearer token file is empty")
    return token, path


def _post(url, body, token, *, opener=None, timeout=30):
    opener = opener or urllib.request.urlopen
    data = json.dumps(body).encode()
    request = urllib.request.Request(url, data=data, method="POST", headers={
        "Content-Type": "application/json",
        "Authorization": f"Bearer {token}",
        "x-tdai-service-id": "default",
    })
    try:
        with opener(request, timeout=timeout) as response:
            return json.loads(response.read().decode())
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")[:300]
        raise StackError(f"HTTP {exc.code} from {url}: {detail}") from None


def probe(base_url, token, *, session_id, text, scope_user="rc-probe-user",
          scope_agent="rc-probe-agent", opener=None):
    """Write, recall, delete and prove empty. Raises if any step disagrees."""
    base = base_url.rstrip("/")
    common = {"user_id": scope_user, "agent_id": scope_agent}
    added = _post(f"{base}/v2/conversation/add", dict(
        common, session_id=session_id,
        messages=[{"role": "user", "content": text},
                  {"role": "assistant", "content": "ack " + text}],
    ), token, opener=opener)
    accepted = (added.get("data") or {}).get("accepted_ids") or []
    if added.get("code") != 0 or len(accepted) != 2:
        raise StackError(f"scoped write rejected: {added.get('code')} {added.get('message')}")

    search_body = dict(common, query=text, limit=5)
    recalled = _post(f"{base}/v2/conversation/search", search_body, token, opener=opener)
    messages = (recalled.get("data") or {}).get("messages") or []
    if recalled.get("code") != 0 or not messages:
        raise StackError("scoped recall returned nothing")
    if not any(text in str(row.get("content", "")) for row in messages):
        raise StackError("scoped recall did not contain the written text")

    deleted = _post(f"{base}/v2/conversation/delete", dict(
        common, session_ids=[session_id],
        message_ids=[str(row["id"]) for row in messages if row.get("id")],
    ), token, opener=opener)
    if deleted.get("code") != 0:
        raise StackError(f"scoped delete rejected: {deleted.get('message')}")

    after = _post(f"{base}/v2/conversation/search", search_body, token, opener=opener)
    left = [row for row in ((after.get("data") or {}).get("messages") or [])
            if text in str(row.get("content", ""))]
    if after.get("code") != 0 or left:
        raise StackError(f"test record survived deletion: {len(left)} hit(s)")
    return {
        "accepted": len(accepted),
        "recalled": len(messages),
        "deleted": ((deleted.get("data") or {}).get("deleted_count")),
        "remaining": len(left),
    }


def cleanup(state_dir):
    """Remove only the RC-owned state subtree (data, secrets, generated files)."""
    state_dir = Path(state_dir)
    if not state_dir.is_absolute() or state_dir.name != "state":
        raise StackError("refusing to remove a directory that is not an RC state dir")
    if not state_dir.exists():
        return False
    for child in sorted(state_dir.iterdir(), key=lambda p: p.name, reverse=True):
        if child.is_dir() and not child.is_symlink():
            for nested in sorted(child.rglob("*"), key=lambda p: len(p.parts), reverse=True):
                nested.unlink() if nested.is_file() or nested.is_symlink() else nested.rmdir()
            child.rmdir()
        else:
            child.unlink()
    state_dir.rmdir()
    return True


def node_defaults(env=None):
    """The RC's own runtime/build inputs; never a production state directory."""
    env = dict(os.environ if env is None else env)
    local = Path(env["LOCALAPPDATA"]) if env.get("LOCALAPPDATA") else None
    if not local:
        raise StackError("LOCALAPPDATA is required on Windows")
    return {
        "root": local / "Singularity" / "Fleet893P2" / "memory",
        "node": local / "Singularity" / "Runtime" / "node" / "node.exe",
        "core_dir": local / "Singularity" / "runtime" / "build" / "MemoryCore",
        "panel_dir": local / "Singularity" / "runtime" / "build" / "MemoryPanel",
    }
