"""Headless OpenMausBot for the Windows RC (fleet#893 W1, Section G2a).

The RC runs OpenMausBot as a **Singularity-owned headless server**, not the
desktop app:

    openmausbot serve --no-pair --data-dir <private> --port <rc port>

`--no-pair` is the vendor's documented headless mode: on loopback a local
caller is the owner, so no pairing code, no phone, no session token is needed
(`docs/headless-cli.md`). The official MCP server is the same package's
``openmausbot mcp`` command, which speaks the vendor's own tool surface
(`list_bots`, ``send_bot_message``, ``wait_for_conversation``, ...). This
module never reimplements those tools and never invents a token.

Everything it writes lives under the caller-supplied RC root/state dir:
``<root>/stage/omb`` (verified payload) and ``<state>/omb`` (data dir +
ownership manifest). A tarball is verified against the registry integrity
before extraction and refused if it contains absolute paths, ``..`` or
symlinks. A listener owned by another process is reported, never killed.

Node >= 24 is required by the package (`engines.node`); the RC ships it.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import queue
import shutil
import signal
import subprocess
import sys
import tarfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

DEFAULT_PORT = 18211
PORT_SPAN = 2  # server port + the vendor's webhook receiver on port+1
PAYLOAD_RELATIVE = ("stage", "omb")
MARKER = "dist-server/openmausbot.js"
CLI = "cli.js"
MAX_TARBALL = 512 * 1024 * 1024
MAX_FILES = 20_000
MAX_INSTANCE_BYTES = 8192

CONNECTED = "connected"
NEEDS_ATTENTION = "needs-attention"
UNAVAILABLE = "not-available"


class HeadlessError(RuntimeError):
    """A refusal with a stable, reportable reason code."""

    def __init__(self, code: str, detail: str = ""):
        super().__init__(f"{code}: {detail}" if detail else code)
        self.code = code
        self.detail = detail


# -- paths and manifests ------------------------------------------------------

def payload_dir(root: str | Path) -> Path:
    return Path(root).joinpath(*PAYLOAD_RELATIVE)


def data_dir(state_dir: str | Path) -> Path:
    return Path(state_dir) / "omb"


_SID: str | None = None


def current_sid() -> str | None:
    """The logged-in user's SID, so ACLs never depend on a localized name."""
    global _SID
    if _SID is not None:
        return _SID or None
    if os.name != "nt":
        _SID = ""
        return None
    try:
        out = subprocess.run(["whoami", "/user", "/fo", "csv", "/nh"],
                             capture_output=True, text=True, timeout=20)
        fields = [f.strip().strip('"') for f in (out.stdout or "").strip().split(",")]
        candidate = fields[-1] if fields else ""
        _SID = candidate if candidate.upper().startswith("S-1-5-21") else ""
    except (OSError, subprocess.SubprocessError):
        _SID = ""
    return _SID or None


def secure(path: Path, directory: bool = True) -> None:
    """Give the logged-in user full control, explicitly.

    A provisioner started from an elevated MSI/ssh session inherits an ACL of
    SYSTEM + Administrators + OWNER RIGHTS only. The headless server then runs
    under the user's normal (non-elevated) token and sees an empty directory:
    that exact failure is why this grant exists.
    """
    if os.name != "nt":
        return
    sid = current_sid()
    if not sid:
        return
    rights = "(OI)(CI)F" if directory else "F"
    subprocess.run(["icacls", str(path), "/grant", f"*{sid}:{rights}"],
                   capture_output=True, timeout=60)


def _private(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    if os.name == "nt":
        secure(path, directory=True)
    else:
        try:
            os.chmod(path, 0o700)
        except OSError:
            pass
    return path


def _write_json(path: Path, payload: dict) -> None:
    _private(path.parent)
    tmp = path.with_name(path.name + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_BINARY", 0), 0o600)
    try:
        os.write(fd, json.dumps(payload, indent=2, sort_keys=True).encode())
        os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(tmp, path)
    secure(path, directory=False)


def read_instance(state_dir: str | Path) -> dict | None:
    path = data_dir(state_dir) / "instance.json"
    try:
        if path.is_symlink() or not path.is_file():
            return None
        if path.stat().st_size > MAX_INSTANCE_BYTES:
            return None
        doc = json.loads(path.read_text(encoding="utf8"))
    except (OSError, ValueError):
        return None
    return doc if isinstance(doc, dict) else None


def write_instance(state_dir: str | Path, payload: dict) -> Path:
    path = data_dir(state_dir) / "instance.json"
    _write_json(path, payload)
    return path


def read_lease(state_dir: str | Path) -> dict | None:
    """The server's own lease: authoritative pid, whoever started it.

    Someone else can start our data dir (the logon task, an operator running
    the generated .cmd); the manifest a direct `start()` wrote then goes stale.
    The vendor lease is the tie-breaker that keeps status honest.
    """
    path = data_dir(state_dir) / "openmausbot-server.lease"
    try:
        if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_INSTANCE_BYTES:
            return None
        doc = json.loads(path.read_text(encoding="utf8"))
    except (OSError, ValueError):
        return None
    if not isinstance(doc, dict) or not isinstance(doc.get("pid"), int):
        return None
    return doc


def owned_pids(state_dir: str | Path) -> set[int]:
    pids = set()
    for doc in (read_instance(state_dir), read_lease(state_dir)):
        if doc and isinstance(doc.get("pid"), int):
            pids.add(int(doc["pid"]))
    return pids


# -- payload verification -----------------------------------------------------

def digest_bytes(data: bytes) -> dict:
    return {
        "sha256": hashlib.sha256(data).hexdigest(),
        "sha512": hashlib.sha512(data).hexdigest(),
        "sha512_b64": base64.b64encode(hashlib.sha512(data).digest()).decode(),
        "bytes": len(data),
    }


def _read_hashed(path: Path) -> dict:
    digest256 = hashlib.sha256()
    digest512 = hashlib.sha512()
    size = 0
    with open(path, "rb") as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            size += len(chunk)
            if size > MAX_TARBALL:
                raise HeadlessError("OMB_PAYLOAD_TOO_LARGE", f">{MAX_TARBALL} bytes")
            digest256.update(chunk)
            digest512.update(chunk)
    digest = digest512
    return {
        "sha256": digest256.hexdigest(),
        "sha512": digest.hexdigest(),
        "sha512_b64": base64.b64encode(digest.digest()).decode(),
        "bytes": size,
    }


def verify_source(tarball: str | Path, *, integrity: str | None = None,
                  sha512: str | None = None, sha256: str | None = None) -> dict:
    """Verify a payload before it is unpacked.

    `integrity` is the registry form `sha512-<base64>`; the hex forms are
    accepted too so an operator can pin either. At least one pin is required:
    an unverified 18 MB payload is never extracted.
    """
    path = Path(tarball)
    if path.is_symlink() or not path.is_file():
        raise HeadlessError("OMB_PAYLOAD_MISSING", str(path))
    if not (integrity or sha512 or sha256):
        raise HeadlessError("OMB_PAYLOAD_UNPINNED", "no integrity/sha512/sha256 pin")
    computed = _read_hashed(path)
    if integrity:
        algorithm, _, expected = integrity.partition("-")
        if algorithm != "sha512" or not expected:
            raise HeadlessError("OMB_INTEGRITY_UNSUPPORTED", algorithm)
        if computed["sha512_b64"] != expected.strip():
            raise HeadlessError("OMB_INTEGRITY_MISMATCH", "sha512(base64)")
    if sha512 and computed["sha512"] != sha512.strip().lower():
        raise HeadlessError("OMB_INTEGRITY_MISMATCH", "sha512")
    if sha256 and computed["sha256"] != sha256.strip().lower():
        raise HeadlessError("OMB_INTEGRITY_MISMATCH", "sha256")
    return computed


def _safe_members(archive: tarfile.TarFile) -> list[tarfile.TarInfo]:
    members = archive.getmembers()
    if len(members) > MAX_FILES:
        raise HeadlessError("OMB_PAYLOAD_TOO_MANY_FILES", str(len(members)))
    safe = []
    for member in members:
        name = member.name.replace("\\", "/")
        if member.issym() or member.islnk() or member.isdev():
            raise HeadlessError("OMB_PAYLOAD_UNSAFE_MEMBER", name)
        if name.startswith("/") or ".." in name.split("/"):
            raise HeadlessError("OMB_PAYLOAD_UNSAFE_PATH", name)
        if ":" in name.split("/")[0]:
            raise HeadlessError("OMB_PAYLOAD_UNSAFE_PATH", name)
        safe.append(member)
    return safe


def extract_payload(tarball: str | Path, destination: str | Path) -> dict:
    """Unpack a verified npm tarball into `destination` (atomic swap)."""
    dest = Path(destination)
    staging = dest.with_name(dest.name + ".new")
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir(parents=True, mode=0o700)
    try:
        options: dict = {"set_attrs": False}
        if sys.version_info >= (3, 12):
            options["filter"] = "data"  # the members were already vetted above
        with tarfile.open(tarball, "r:gz") as archive:
            members = _safe_members(archive)
            for member in members:
                archive.extract(member, staging, **options)
        root = staging
        entries = [p for p in staging.iterdir()]
        if len(entries) == 1 and entries[0].is_dir():
            root = entries[0]  # npm tarballs carry a single "package/" top level
        if not (root / MARKER).is_file() or not (root / CLI).is_file():
            raise HeadlessError("OMB_PAYLOAD_INCOMPLETE", f"missing {MARKER} or {CLI}")
        if dest.exists():
            shutil.rmtree(dest)
        os.replace(root, dest)
        if root is not staging and staging.exists():
            shutil.rmtree(staging, ignore_errors=True)
        secure(dest, directory=True)
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    return {"path": str(dest), "files": len(list(dest.rglob("*")))}


def payload_ready(root: str | Path) -> bool:
    base = payload_dir(root)
    return (base / MARKER).is_file() and (base / CLI).is_file() and not base.is_symlink()


# -- node ---------------------------------------------------------------------

def _node_version(node: str) -> tuple[int, ...] | None:
    try:
        out = subprocess.run([node, "-v"], capture_output=True, text=True, timeout=20)
    except (OSError, subprocess.SubprocessError):
        return None
    text = (out.stdout or "").strip().lstrip("v")
    parts = []
    for piece in text.split("."):
        if not piece.isdigit():
            return None
        parts.append(int(piece))
    return tuple(parts) or None


def node_ready(node: str) -> tuple[bool, str]:
    version = _node_version(node)
    if version is None:
        return False, f"node unavailable: {node}"
    if version < (24,):
        return False, "node " + ".".join(map(str, version)) + " is below the package's engines.node >=24"
    return True, "node " + ".".join(map(str, version))


# -- health -------------------------------------------------------------------

def health(port: int, timeout: float = 2.0, host: str = "127.0.0.1") -> dict | None:
    url = f"http://{host}:{int(port)}/api/health"
    try:
        with urllib.request.urlopen(url, timeout=timeout) as reply:
            if reply.status != 200:
                return None
            body = reply.read(65536)
        doc = json.loads(body)
    except (OSError, ValueError, urllib.error.URLError):
        return None
    if not isinstance(doc, dict) or doc.get("app") != "openmausbot":
        return None
    if not isinstance(doc.get("pid"), int):
        return None
    return doc


def port_free(port: int) -> bool:
    import socket
    for candidate in range(port, port + PORT_SPAN):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            try:
                sock.bind(("127.0.0.1", candidate))
            except OSError:
                return False
    return True


# -- lifecycle ----------------------------------------------------------------

def detect(state_dir: str | Path, node: str, port: int = DEFAULT_PORT) -> tuple[str, str]:
    instance = read_instance(state_dir)
    payload = Path(instance["payload"]) if instance and instance.get("payload") else None
    if payload is None:
        payload = payload_dir(Path(state_dir).parent)
    if not ((payload / MARKER).is_file() and (payload / CLI).is_file()):
        return NEEDS_ATTENTION, "OpenMausBot headless payload not staged"
    live = health(port)
    if live is None and instance and instance.get("port") != port:
        live = health(int(instance["port"]))
    if live is not None:
        pids = owned_pids(state_dir)
        if pids and live.get("pid") not in pids:
            return NEEDS_ATTENTION, "port " + str(port) + " answered by another process"
        return CONNECTED, "headless server pid " + str(live["pid"]) + " on 127.0.0.1:" + str(port)
    ready, detail = node_ready(node)
    if not ready:
        return NEEDS_ATTENTION, detail
    return NEEDS_ATTENTION, "headless server not answering on 127.0.0.1:" + str(port)


def start(root: str | Path, state_dir: str | Path, node: str, *, port: int = DEFAULT_PORT,
          timeout: float = 40.0) -> dict:
    base = payload_dir(root)
    if not payload_ready(root):
        raise HeadlessError("OMB_PAYLOAD_MISSING", str(base))
    live = health(port)
    if live is not None:
        if live["pid"] in owned_pids(state_dir):
            return {"started": False, "pid": live["pid"], "port": port}
        raise HeadlessError("OMB_PORT_FOREIGN", f"127.0.0.1:{port} belongs to pid {live['pid']}")
    if not port_free(port):
        raise HeadlessError("OMB_PORT_BUSY", str(port))
    ready, detail = node_ready(node)
    if not ready:
        raise HeadlessError("OMB_NODE_UNSUPPORTED", detail)
    data = _private(data_dir(state_dir))
    logs = _private(Path(state_dir) / "logs")
    log_path = logs / "omb-headless.log"
    env = {k: v for k, v in os.environ.items()
           if k not in {"OPENMAUSBOT_URL", "OPENMAUSBOT_TOKEN", "OMB_PORT", "ELECTRON_RUN_AS_NODE"}}
    env.update({"OMB_PORT": str(port), "NO_COLOR": "1"})
    command = [node, str(base / CLI), "serve", "--no-pair", "--data-dir", str(data),
               "--port", str(port), "--label", "Singularity RC"]
    # On Windows the child must leave the caller's job object, or it dies with
    # the shell that started it (an ssh session, the MSI, Start-Here).
    creation = 0
    if os.name == "nt":
        creation = 0x00000008 | 0x00000200 | 0x01000000
    with open(log_path, "ab") as log:
        try:
            proc = subprocess.Popen(command, cwd=str(base), env=env, stdin=subprocess.DEVNULL,
                                    stdout=log, stderr=log, creationflags=creation,
                                    start_new_session=(os.name != "nt"), shell=False)
        except OSError:
            if creation == 0:
                raise
            creation &= ~0x01000000  # job forbids breakaway: keep the group only
            proc = subprocess.Popen(command, cwd=str(base), env=env, stdin=subprocess.DEVNULL,
                                    stdout=log, stderr=log, creationflags=creation,
                                    start_new_session=False, shell=False)
    deadline = time.time() + timeout
    while time.time() < deadline:
        if proc.poll() is not None:
            raise HeadlessError("OMB_START_FAILED", _tail(log_path))
        live = health(port, timeout=1.0)
        if live is not None:
            write_instance(state_dir, {
                "pid": live["pid"], "port": port, "webhook_port": port + 1,
                "payload": str(base), "data_dir": str(data), "log": str(log_path),
                "started_at": time.time(), "launcher_pid": proc.pid,
                "mode": "headless-no-pair",
            })
            return {"started": True, "pid": live["pid"], "port": port, "log": str(log_path)}
        time.sleep(0.5)
    raise HeadlessError("OMB_START_TIMEOUT", _tail(log_path))


def _tail(path: Path, limit: int = 800) -> str:
    try:
        text = path.read_text(encoding="utf8", errors="replace")
    except OSError:
        return "no log"
    return text[-limit:].strip()


def stop(state_dir: str | Path, *, timeout: float = 20.0) -> dict:
    instance = read_instance(state_dir)
    lease = read_lease(state_dir)
    if not instance and not lease:
        return {"stopped": False, "reason": "no instance manifest"}
    port = int((instance or {}).get("port") or DEFAULT_PORT)
    live = health(port)
    if live is None:
        if os.name == "nt" and task_state():
            end = stop_task()
            return {"stopped": False, "reason": "not running", "task": end}
        return {"stopped": False, "reason": "not running",
                "pid": (instance or lease or {}).get("pid")}
    if live["pid"] not in owned_pids(state_dir):
        return {"stopped": False, "reason": "pid mismatch; foreign listener left alone",
                "pid": (instance or lease or {}).get("pid"), "observed": live.get("pid")}
    ended = stop_task() if os.name == "nt" and task_state() else None
    _terminate(live["pid"])
    deadline = time.time() + timeout
    while time.time() < deadline:
        if health(port, timeout=0.5) is None:
            return {"stopped": True, "pid": live["pid"], "task": ended}
        time.sleep(0.4)
    return {"stopped": False, "reason": "still answering after stop", "pid": live["pid"]}


def _terminate(pid: int) -> None:
    """End our server, then insist.

    A console process has no window to close, so `taskkill` without /F is a
    no-op for it; the forced pass is what actually ends it. This never targets
    a pid we have not just matched against the lease/manifest.
    """
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(pid), "/T"], capture_output=True, timeout=30)
        for _ in range(8):
            if not _pid_alive(pid):
                return
            time.sleep(0.25)
        subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"],
                       capture_output=True, timeout=30)
        return
    try:
        os.kill(pid, signal.SIGTERM)
    except OSError:
        pass
    for _ in range(12):
        if not _pid_alive(pid):
            return
        time.sleep(0.25)
    try:
        os.kill(pid, signal.SIGKILL)
    except OSError:
        pass


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if os.name == "nt":
        out = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/NH"],
                             capture_output=True, text=True, timeout=30)
        return str(pid) in (out.stdout or "")
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


# -- official MCP -------------------------------------------------------------

class McpClient:
    """Minimal MCP stdio client for the package's own `mcp` command."""

    def __init__(self, node: str, payload: Path, port: int, *, timeout: float = 30.0):
        self.node = node
        self.payload = Path(payload)
        self.port = int(port)
        self.timeout = timeout
        self.proc: subprocess.Popen | None = None
        self._next_id = 0
        self._lines: "queue.Queue[dict]" = queue.Queue()
        self._reader: threading.Thread | None = None

    def __enter__(self) -> "McpClient":
        env = {k: v for k, v in os.environ.items()
               if k not in {"OPENMAUSBOT_URL", "OPENMAUSBOT_TOKEN", "ELECTRON_RUN_AS_NODE"}}
        env.update({"OMB_PORT": str(self.port), "NO_COLOR": "1"})
        self.proc = subprocess.Popen([self.node, str(self.payload / CLI), "mcp"],
                                     cwd=str(self.payload), env=env, text=True, bufsize=1,
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE, shell=False)
        # A reader thread keeps this portable: select() on a pipe is not
        # implemented on Windows, and a blocking readline() could hang.
        self._reader = threading.Thread(target=self._pump, name="omb-mcp-reader", daemon=True)
        self._reader.start()
        reply = self._rpc("initialize", {
            "protocolVersion": "2024-11-05", "capabilities": {},
            "clientInfo": {"name": "singularity-rc", "version": "1"},
        })
        if "result" not in reply:
            raise HeadlessError("OMB_MCP_INIT_FAILED", json.dumps(reply)[:200])
        self._send({"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}})
        return self

    def __exit__(self, *exc) -> None:
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.proc.kill()

    def _send(self, message: dict) -> None:
        assert self.proc and self.proc.stdin
        self.proc.stdin.write(json.dumps(message) + "\n")
        self.proc.stdin.flush()

    def _pump(self) -> None:
        assert self.proc and self.proc.stdout
        for line in self.proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                message = json.loads(line)
            except ValueError:
                continue
            self._lines.put(message)
        self._lines.put({})

    def _read(self) -> dict:
        try:
            message = self._lines.get(timeout=self.timeout)
        except queue.Empty:
            raise HeadlessError("OMB_MCP_TIMEOUT") from None
        if not message:
            raise HeadlessError("OMB_MCP_CLOSED")
        return message

    def _rpc(self, method: str, params: dict, *, timeout: float | None = None) -> dict:
        self._next_id += 1
        self._send({"jsonrpc": "2.0", "id": self._next_id, "method": method, "params": params})
        saved, self.timeout = self.timeout, timeout or self.timeout
        try:
            while True:
                reply = self._read()
                if reply.get("id") == self._next_id:
                    return reply
        finally:
            self.timeout = saved

    def tools(self) -> list[str]:
        reply = self._rpc("tools/list", {})
        return [tool.get("name") for tool in (reply.get("result") or {}).get("tools", [])]

    def call(self, tool: str, arguments: dict | None = None) -> dict:
        reply = self._rpc("tools/call", {"name": tool, "arguments": arguments or {}})
        if "error" in reply:
            raise HeadlessError("OMB_MCP_ERROR", json.dumps(reply["error"])[:300])
        result = reply.get("result") or {}
        if result.get("isError"):
            raise HeadlessError("OMB_MCP_TOOL_ERROR", json.dumps(result)[:300])
        if isinstance(result.get("structuredContent"), dict):
            return result["structuredContent"]
        for item in result.get("content") or []:
            if item.get("type") == "text":
                try:
                    return json.loads(item.get("text") or "")
                except ValueError:
                    return {"text": item.get("text")}
        return result


def _instance_payload(state_dir: str | Path) -> Path:
    instance = read_instance(state_dir) or {}
    recorded = instance.get("payload")
    if isinstance(recorded, str) and recorded:
        return Path(recorded)
    return payload_dir(Path(state_dir).parent)


def list_bots(state_dir: str | Path, node: str, *, port: int | None = None,
              timeout: float = 30.0) -> dict:
    instance = read_instance(state_dir) or {}
    chosen = int(port or instance.get("port") or DEFAULT_PORT)
    with McpClient(node, _instance_payload(state_dir), chosen, timeout=timeout) as client:
        return {"tools": client.tools(), "bots": client.call("list_bots")}


def send_probe(state_dir: str | Path, node: str, text: str, *, port: int | None = None,
               timeout: float = 120.0) -> dict:
    """One safe message + one bounded wait, reporting the precise blocker.

    Spends a single model turn when the workspace has a usable engine, which is
    the task's accepted cost. With no engine credential the vendor refuses and
    the exact status/reason is returned instead of a claim of success.
    """
    instance = read_instance(state_dir) or {}
    chosen = int(port or instance.get("port") or DEFAULT_PORT)
    out = {"sent": False, "settled": False, "text": text}
    with McpClient(node, _instance_payload(state_dir), chosen, timeout=timeout) as client:
        bots = client.call("list_bots")
        listed = bots.get("bots") or []
        if not listed:
            raise HeadlessError("OMB_NO_BOT", "the workspace lists no bot to message")
        bot = next((b for b in listed if b.get("chiefOfStaff")), listed[0])
        out["bot"] = {"id": bot.get("id"), "name": bot.get("name")}
        try:
            sent = client.call("send_bot_message", {
                "bot_id": bot.get("id"), "text": text,
                "send_id": "rc-probe-" + hashlib.sha256(text.encode()).hexdigest()[:24],
            })
        except HeadlessError as exc:
            out.update({"blocked": "send_refused", "reason": exc.detail or exc.code})
            return out
        out["sent"] = True
        out["receipt"] = sent
        task = sent.get("taskId") or sent.get("task_id")
        try:
            waited = client.call("wait_for_conversation", {
                "target_type": "bot", "target_id": bot.get("id"),
                "task_id": task, "timeout_seconds": int(min(timeout, 300)),
            })
        except HeadlessError as exc:
            out.update({"blocked": "wait_refused", "reason": exc.detail or exc.code})
            return out
        out["wait"] = waited
        out["settled"] = waited.get("status") in {"settled", "needs-user", "failed", "stalled"}
        out["state"] = waited.get("state")
        return out


# -- per-user logon task (Windows) --------------------------------------------

TASK_NAME = "Fleet893-RC-OpenMausBot"


def task_script(root: str | Path, state_dir: str | Path, node: str, port: int = DEFAULT_PORT) -> Path:
    """Write the RC-owned launcher the logon task runs.

    A file rather than a quoted `/TR` string: one owner, removable by uninstall,
    no shell metacharacters, and the command survives a task re-registration.
    """
    base = payload_dir(root)
    if not payload_ready(root):
        raise HeadlessError("OMB_PAYLOAD_MISSING", str(base))
    path = _private(data_dir(state_dir)) / "omb-headless.cmd"
    logs = _private(Path(state_dir) / "logs")
    log = logs / "omb-headless.log"
    body = (
        "@echo off\r\n"
        "rem Singularity RC headless OpenMausBot (generated; removed by uninstall)\r\n"
        f'if not exist "{node}" echo MISSING_NODE>> "{log}"\r\n'
        f'if not exist "{base / CLI}" echo MISSING_CLI>> "{log}"\r\n'
        f'"{node}" "{base / CLI}" serve --no-pair --data-dir "{data_dir(state_dir)}"'
        f' --port {int(port)} --label "Singularity RC"'
        f' >> "{log}" 2>&1\r\n'
    )
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_BINARY", 0), 0o600)
    try:
        os.write(fd, body.encode())
        os.fsync(fd)
    finally:
        os.close(fd)
    secure(path, directory=False)
    return path


def _require_windows() -> None:
    if os.name != "nt":
        raise HeadlessError("OMB_WINDOWS_ONLY", "the logon task is Windows-only")


def register_task(root: str | Path, state_dir: str | Path, node: str, *, port: int = DEFAULT_PORT,
                  name: str = TASK_NAME) -> dict:
    """Idempotent per-user logon task; no admin, no service, no elevation."""
    _require_windows()
    script = task_script(root, state_dir, node, port)
    result = subprocess.run(
        ["schtasks", "/Create", "/TN", name, "/SC", "ONLOGON",
         "/TR", f'"{script}"', "/RL", "LIMITED", "/F"],
        capture_output=True, text=True, timeout=60,
    )
    if result.returncode != 0:
        raise HeadlessError("OMB_TASK_REGISTER_FAILED",
                            (result.stderr or result.stdout).strip()[:300])
    return {"task": name, "script": str(script), "port": int(port)}


def run_task(name: str = TASK_NAME) -> dict:
    _require_windows()
    result = subprocess.run(["schtasks", "/Run", "/TN", name],
                            capture_output=True, text=True, timeout=60)
    if result.returncode != 0:
        raise HeadlessError("OMB_TASK_RUN_FAILED", (result.stderr or result.stdout).strip()[:300])
    return {"task": name, "started": True}


def stop_task(name: str = TASK_NAME) -> dict:
    _require_windows()
    result = subprocess.run(["schtasks", "/End", "/TN", name],
                            capture_output=True, text=True, timeout=60)
    return {"task": name, "ended": result.returncode == 0,
            "detail": (result.stderr or "").strip()[:200]}


def remove_task(name: str = TASK_NAME) -> dict:
    _require_windows()
    result = subprocess.run(["schtasks", "/Delete", "/TN", name, "/F"],
                            capture_output=True, text=True, timeout=60)
    return {"task": name, "deleted": result.returncode == 0}


def start_via_task(root: str | Path, state_dir: str | Path, node: str, *, port: int = DEFAULT_PORT,
                   name: str = TASK_NAME, timeout: float = 60.0) -> dict:
    """Register the logon task, start it now and wait for a healthy listener.

    This is the Windows product path: a child of the installer/Start-Here dies
    with the shell that started it, a scheduled task does not.
    """
    _require_windows()
    live = health(port)
    if live is not None:
        if live["pid"] not in owned_pids(state_dir):
            raise HeadlessError("OMB_PORT_FOREIGN", f"127.0.0.1:{port} belongs to pid {live['pid']}")
        return {"started": False, "pid": live["pid"], "port": port, "mode": "already-running"}
    if not port_free(port):
        raise HeadlessError("OMB_PORT_BUSY", str(port))
    register_task(root, state_dir, node, port=port, name=name)
    run_task(name)
    deadline = time.time() + timeout
    while time.time() < deadline:
        live = health(port, timeout=1.0)
        if live is not None:
            write_instance(state_dir, {
                "pid": live["pid"], "port": port, "webhook_port": port + 1,
                "payload": str(payload_dir(root)), "data_dir": str(data_dir(state_dir)),
                "log": str(Path(state_dir) / "logs" / "omb-headless.log"),
                "started_at": time.time(), "mode": "headless-no-pair-task", "task": name,
            })
            return {"started": True, "pid": live["pid"], "port": port, "task": name}
        time.sleep(0.75)
    raise HeadlessError("OMB_START_TIMEOUT", _tail(Path(state_dir) / "logs" / "omb-headless.log"))


def task_state(name: str = TASK_NAME) -> str | None:
    if os.name != "nt":
        return None
    result = subprocess.run(["schtasks", "/Query", "/TN", name, "/FO", "LIST"],
                            capture_output=True, text=True, timeout=60)
    if result.returncode != 0:
        return None
    for line in result.stdout.splitlines():
        if line.lower().startswith("status"):
            return line.split(":", 1)[-1].strip()
    return "unknown"


def rollback(root: str | Path, state_dir: str | Path) -> dict:
    stopped = stop(state_dir)
    task = remove_task() if os.name == "nt" else {"deleted": False}
    removed = []
    for path in (payload_dir(root), data_dir(state_dir)):
        if path.exists() and not path.is_symlink():
            shutil.rmtree(path)
            removed.append(str(path))
    return {"stopped": stopped, "task": task, "removed": removed}


# -- CLI (used by the provisioner and by operators) ---------------------------

def _main(argv: list[str]) -> int:
    import argparse
    parser = argparse.ArgumentParser(description="headless OpenMausBot for the RC")
    parser.add_argument("action", choices=("status", "install", "start", "stop", "bots",
                                           "send", "rollback", "task-install",
                                           "task-run", "task-stop", "task-start"))
    parser.add_argument("--root")
    parser.add_argument("--state-dir")
    parser.add_argument("--node", default="node")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--tarball")
    parser.add_argument("--integrity")
    parser.add_argument("--sha512")
    parser.add_argument("--text", default="Singularity RC integration probe")
    args = parser.parse_args(argv)
    if args.action not in {"task-run", "task-stop"} and not (args.root and args.state_dir):
        parser.error("--root and --state-dir are required for this action")
    root = Path(args.root or ".")
    state = Path(args.state_dir or ".")
    try:
        if args.action == "status":
            state_name, detail = detect(state, args.node, args.port)
            print(json.dumps({"state": state_name, "detail": detail}, indent=2))
            return 0
        if args.action == "install":
            if not args.tarball:
                raise HeadlessError("OMB_PAYLOAD_MISSING", "--tarball required")
            digest = verify_source(args.tarball, integrity=args.integrity, sha512=args.sha512)
            extracted = extract_payload(args.tarball, payload_dir(root))
            print(json.dumps({"verified": digest, "extracted": extracted}, indent=2))
            return 0
        if args.action == "start":
            print(json.dumps(start(root, state, args.node, port=args.port), indent=2))
            return 0
        if args.action == "stop":
            print(json.dumps(stop(state), indent=2))
            return 0
        if args.action == "bots":
            result = list_bots(state, args.node, port=args.port)
            print(json.dumps({"tools": result["tools"],
                              "bot_count": len(result["bots"].get("bots") or []),
                              "bots": [{"id": b.get("id"), "name": b.get("name")}
                                       for b in result["bots"].get("bots") or []]}, indent=2))
            return 0
        if args.action == "send":
            print(json.dumps(send_probe(state, args.node, args.text, port=args.port), indent=2))
            return 0
        if args.action == "task-install":
            print(json.dumps(register_task(root, state, args.node, port=args.port), indent=2))
            return 0
        if args.action == "task-start":
            print(json.dumps(start_via_task(root, state, args.node, port=args.port), indent=2))
            return 0
        if args.action == "task-run":
            print(json.dumps(run_task(), indent=2))
            return 0
        if args.action == "task-stop":
            # `schtasks /End` ends the wrapper, not necessarily the node child;
            # stop() ends both and verifies the listener is gone.
            print(json.dumps(stop(state), indent=2))
            return 0
        print(json.dumps(rollback(root, state), indent=2))
        return 0
    except HeadlessError as exc:
        print(json.dumps({"error": exc.code, "detail": exc.detail}, indent=2))
        return 2


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
