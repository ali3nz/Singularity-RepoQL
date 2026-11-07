"""Zero-touch local service startup for the installed release candidate (fleet#893).

The dashboard proxies fixed loopback backends (RepoQL host, MemoryPanel,
Kanzo board, Claude Office). A release candidate that leaves those backends
unstarted is not usable, and asking the owner to start them by hand is not
acceptance. This module starts what the candidate can own:

  * **RepoQL** - an RC-owned workspace with the marker layout `rql init`
    writes, the installed source imported into it, and the local `rql` host
    that serves it. The host is launched by `rql` itself (implicit start), so
    its lifecycle stays with RepoQL.
  * **MemoryCore + MemoryPanel** - the vendor memory supervisor started from
    an RC-owned config on RC ports, with state, logs and secrets under the RC
    root, then the owner identity in that RC metadata store.

  * **Kanzo board** - the real local `kanzo.exe` board staged into the RC root
    and started with an RC-owned `--home` and an RC port. The production board
    (`C:\\Users\\Ben\\kanzo`, port 4242) is never opened, written or bound.
  * **Claude Office** - the locally installed Claude Office distribution started
    from an RC-owned service config, state, log directory and port. The RC owns
    its API/ingest keys and DB; the installed distribution is read only.

Everything is idempotent and stays inside RC-owned roots. Nothing here reads a
production config, connects to dockerhost, or falls back to a stub: a backend
that cannot start is reported as a failure with its exact reason.
"""
from __future__ import annotations

import argparse
import json
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

DEFAULT_CORE_PORT = 18221
DEFAULT_PANEL_PORT = 18226
DEFAULT_DASHBOARD_PORT = 18200
DEFAULT_KANZO_PORT = 18202
DEFAULT_OFFICE_PORT = 18203
FORBIDDEN_PORTS = frozenset({18100, 18101, 18126, 18128})
MARKER_GITIGNORE = "cache/\n"
METADATA_DB = ("state", "data", "core", "metadata", "tdai_metadata_default", "metadata.db")
# <product>/native/windows/rc_services.py -> <product>
SOURCE = Path(__file__).resolve().parents[2]


class ServiceError(RuntimeError):
    """A backend could not be brought up; the message names the exact cause."""


# --------------------------------------------------------------------- layout


def _local_appdata(env):
    raw = env.get("LOCALAPPDATA")
    if not raw and os.name == "nt":
        raise ServiceError("LOCALAPPDATA is required on Windows")
    return Path(raw) if raw else Path.home() / ".local" / "share"


def defaults(env=None):
    """RC-owned roots plus the machine's existing vendor installs."""
    env = dict(os.environ if env is None else env)
    local = _local_appdata(env)
    root = Path(env.get("SINGULARITY_RC_ROOT") or local / "Singularity" / "Fleet861RC")
    vendor = local / "Singularity"
    rql = Path(env.get("SINGULARITY_RQL_BIN") or local / "rql" / "rql.exe")
    node = Path(env.get("SINGULARITY_RC_NODE") or vendor / "Runtime" / "node" / "node.exe")
    try:
        core_port = int(env.get("SINGULARITY_RC_CORE_PORT", DEFAULT_CORE_PORT))
        panel_port = int(env.get("SINGULARITY_RC_PANEL_PORT", DEFAULT_PANEL_PORT))
        kanzo_port = int(env.get("SINGULARITY_RC_KANZO_PORT", DEFAULT_KANZO_PORT))
        office_port = int(env.get("SINGULARITY_RC_OFFICE_PORT", DEFAULT_OFFICE_PORT))
        dashboard_port = int(env.get("SINGULARITY_RC_DASHBOARD_PORT", DEFAULT_DASHBOARD_PORT))
    except ValueError:
        raise ServiceError("RC service ports must be integers") from None
    ports = (core_port, panel_port, kanzo_port, office_port, dashboard_port)
    for port in ports:
        if not 1 <= port <= 65535:
            raise ServiceError("RC service port out of range")
        if port in FORBIDDEN_PORTS:
            raise ServiceError(f"port {port} belongs to the production stack")
    if len(set(ports)) != len(ports):
        raise ServiceError("RC services need distinct ports")
    kanzo = Path(env.get("SINGULARITY_RC_KANZO_EXE") or root / "bin" / "kanzo.exe")
    vendor_kanzo = vendor / "Runtime" / "kanzo" / "kanzo.exe"
    office_root = Path(env.get("SINGULARITY_RC_OFFICE_INSTALL") or vendor / "WindowsNative" / "office")
    return {
        "root": root,
        "workspace": root / "workspace",
        "memory_root": root / "memory",
        "source": _source_root(root, env),
        "node": node,
        "rql": rql,
        "supervisor": None,
        "core_dir": vendor / "runtime" / "build" / "MemoryCore",
        "panel_dir": vendor / "runtime" / "build" / "MemoryPanel",
        "core_port": core_port,
        "panel_port": panel_port,
        "kanzo_port": kanzo_port,
        "office_port": office_port,
        "dashboard_port": dashboard_port,
        "kanzo": kanzo,
        "vendor_kanzo": vendor_kanzo,
        "office_install": office_root,
        "office_python": _office_python(office_root),
    }


def _source_root(root, env):
    """The product source the RC runs: installed tree, or an explicit RC copy.

    A directory merely being named `source` is not proof of a product tree; an
    earlier partial start can leave an empty one behind, and running from it
    turns every backend into a missing-script failure. A staged RC copy counts
    only when it actually carries the product entry points.
    """
    staged = Path(env.get("SINGULARITY_RC_SOURCE") or root / "source")
    if (staged / "native" / "windows" / "rc_services.py").is_file() and (
            staged / "memory" / "rc_stack.py").is_file():
        return staged
    return SOURCE


def _office_python(office_root):
    scripts = Path(office_root) / "venv" / "Scripts"
    for name in ("pythonw.exe", "python.exe"):
        if (scripts / name).is_file():
            return scripts / name
    return scripts / "python.exe"


def layout(d):
    """Resolve every script, key file and RC-owned subtree for this root."""
    source = Path(d["source"])
    root = Path(d["root"])
    resolved = dict(d)
    resolved["supervisor"] = Path(d.get("supervisor") or source / "scripts" / "native-memory-supervisor.mjs")
    resolved["admin_key"] = Path(d["memory_root"]) / "state" / "secrets" / "admin-user-key"
    resolved["metadata_db"] = Path(d["memory_root"]).joinpath(*METADATA_DB)
    resolved["kanzo_home"] = root / "kanzo"
    resolved["office_root"] = root / "office"
    resolved["office_service_dir"] = root / "office" / "service"
    resolved["office_state"] = root / "office" / "state"
    resolved["office_logs"] = root / "office" / "logs"
    resolved["office_config"] = root / "office" / "service" / "service.json"
    resolved["office_launcher"] = root / "office" / "service" / "rc_office_service.py"
    resolved["office_panel_key"] = root / "state" / "office-panel-key"
    resolved["service_state"] = root / "state" / "rc-services.json"
    return resolved


# ------------------------------------------------------------------- plumbing


def _run(cmd, *, cwd=None, timeout=180, run=None):
    if run is not None:
        return run(cmd, cwd=cwd, timeout=timeout)
    return subprocess.run([str(part) for part in cmd], cwd=str(cwd) if cwd else None,
                          capture_output=True, text=True, timeout=timeout, check=False)


def _json_tail(process):
    """Last JSON object on stdout; RepoQL prints human lines before it."""
    for line in reversed((process.stdout or "").strip().splitlines()):
        line = line.strip()
        if line.startswith("{"):
            try:
                return json.loads(line)
            except json.JSONDecodeError:
                continue
    try:
        return json.loads((process.stdout or "").strip())
    except json.JSONDecodeError:
        return None


def _port_open(host, port, timeout=0.5):
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def _panel_ready(base):
    try:
        with urllib.request.urlopen(base + "/", timeout=5) as response:
            return response.status == 200
    except (urllib.error.URLError, OSError):
        return False


def _spawn_detached(cmd, *, cwd=None, log_path=None, spawn=None):
    """Start a long-lived supervisor that survives the launching console."""
    if spawn is not None:
        return spawn(cmd, cwd=cwd, log_path=log_path)
    log = None
    if log_path is not None:
        Path(log_path).parent.mkdir(parents=True, exist_ok=True)
        log = open(log_path, "ab")
    flags = 0
    if os.name == "nt":
        flags = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
    try:
        process = subprocess.Popen([str(part) for part in cmd], cwd=str(cwd) if cwd else None,
                                   stdin=subprocess.DEVNULL,
                                   stdout=log or subprocess.DEVNULL,
                                   stderr=subprocess.STDOUT if log else subprocess.DEVNULL,
                                   creationflags=flags, close_fds=True)
        return process.pid
    finally:
        if log is not None:
            log.close()


# --------------------------------------------------------------------- RepoQL


def workspace_marker(workspace):
    """Create the `.repoql` layout `rql init` writes, idempotently.

    `rql init` refuses to designate a directory when an ancestor already carries
    a marker, and the user's home does (RepoQL keeps its own `~/.repoql` there),
    so the RC writes the same layout itself instead of inheriting the home
    workspace.
    """
    workspace = Path(workspace)
    marker = workspace / ".repoql"
    marker.mkdir(parents=True, exist_ok=True)
    ignore = marker / ".gitignore"
    if not ignore.is_file() or ignore.read_text(encoding="utf-8") != MARKER_GITIGNORE:
        ignore.write_text(MARKER_GITIGNORE, encoding="utf-8")
    (marker / "cache").mkdir(exist_ok=True)
    return marker


def repoql_status(d, *, run=None):
    process = _run([d["rql"], "host", "status", "--json"], cwd=d["workspace"], timeout=60, run=run)
    return _json_tail(process) or {"running": False, "error": "no status output"}


def import_source(d, *, run=None):
    """Import the installed source. Re-importing sweeps the same import again."""
    source = Path(d["source"]).resolve().as_posix()
    process = _run([d["rql"], "import", "local:///" + source.lstrip("/"), "--analysis", "links"],
                   cwd=d["workspace"], timeout=300, run=run)
    if process.returncode != 0:
        raise ServiceError("RepoQL import failed: " + ((process.stderr or process.stdout or "").strip()[:300]))
    return _json_tail(process) or {"returncode": process.returncode}


def host_running(status):
    """`host status` reports readiness, not a `running` boolean.

    The live host is identified by its PID plus the readiness flags; treating
    only a literal `running: true` as up made every start re-import a healthy
    workspace and then report a timeout on a host that was already serving.
    """
    status = status or {}
    return bool(status.get("running") or status.get("ready") or status.get("queryable")
                or (status.get("host") or {}).get("pid"))


def clear_stale_host_socket(workspace):
    """Drop the socket a terminated host left behind.

    `host status` reporting no host means nothing owns this workspace, but the
    socket file survives a hard termination and the next `rql serve` fails to
    bind it (`Access is denied`). Only the RC-owned socket is removed here.
    """
    socket_path = Path(workspace) / ".repoql" / "cache" / "repoql.sock"
    try:
        if socket_path.exists():
            socket_path.unlink()
            return True
    except OSError:
        pass
    return False


def workspace_graph(workspace):
    """The on-disk graph `rql import` built; importing again is not a start step."""
    return Path(workspace) / ".repoql" / "cache" / "index.duckdb"


def ensure_repoql(d, *, run=None, spawn=None, sleep=time.sleep, attempts=60, delay=2.0):
    """A running `rql` host over the RC workspace, with the source imported once.

    `host status` never starts anything (it answers `no host`), so the host is
    started here as `rql serve` exactly as the installed product does. A
    workspace that already holds an index is served as-is; only a workspace
    without one is imported, and the import runs against the live host.
    """
    if not Path(d["rql"]).is_file():
        raise ServiceError(f"rql is not installed at {d['rql']}")
    workspace_marker(d["workspace"])
    status = repoql_status(d, run=run)
    pid = None
    if not host_running(status):
        clear_stale_host_socket(d["workspace"])
        pid = _spawn_detached([d["rql"], "serve", "--path", str(d["workspace"])],
                              cwd=d["workspace"],
                              log_path=Path(d["root"]) / "logs" / "repoql-host.log", spawn=spawn)
        for _ in range(attempts):
            status = repoql_status(d, run=run)
            if host_running(status):
                break
            sleep(delay)
    if not host_running(status):
        reason = status.get("error") or status.get("verdict") or "unknown"
        raise ServiceError(f"RepoQL host did not start: {reason}")
    imported = None
    if not workspace_graph(d["workspace"]).is_file():
        imported = import_source(d, run=run)
    files = (status.get("totalFiles") or (status.get("workspace") or {}).get("files")
             or status.get("files") or status.get("filesIndexed"))
    return {"ok": True, "workspace": str(status.get("workspace", {}).get("root") if isinstance(status.get("workspace"), dict) else d["workspace"]),
            "verdict": status.get("verdict") or ("ready" if status.get("ready") else None),
            "files": files, "pid": (status.get("host") or {}).get("pid"),
            "host_started": pid is not None, "imported": imported is not None}


# --------------------------------------------------------------------- memory


def _rc_stack(d):
    path = str(Path(d["source"]) / "memory")
    if path not in sys.path:
        sys.path.insert(0, path)
    import rc_stack  # noqa: PLC0415 - shipped beside the installed source

    return rc_stack


def memory_config(d):
    """The RC-owned supervisor config: RC state, RC ports, vendor inputs only."""
    rc_stack = _rc_stack(d)
    config = rc_stack.build_config(d["memory_root"], node=d["node"], core_dir=d["core_dir"],
                                   panel_dir=d["panel_dir"], core_port=d["core_port"],
                                   panel_port=d["panel_port"])
    path = rc_stack.write_config(config, Path(d["memory_root"]) / "stack.json")
    return config, path


def memory_status(d, *, run=None):
    rc_stack = _rc_stack(d)
    config_path = Path(d["memory_root"]) / "stack.json"
    if not config_path.is_file():
        return {"code": "ABSENT", "processes": []}
    try:
        result = rc_stack.status(d["node"], d["supervisor"], config_path, run=run)
    except Exception as exc:  # a dead supervisor is a status, not a crash
        return {"code": "UNAVAILABLE", "error": type(exc).__name__, "processes": []}
    result["healthy"] = rc_stack.healthy(result)
    return result


def ensure_memory(d, *, run=None, spawn=None, sleep=time.sleep, attempts=90, delay=2.0):
    """Start the vendor memory stack on RC ports and verify it is healthy."""
    for key in ("node", "supervisor", "core_dir", "panel_dir"):
        if not Path(d[key]).exists():
            raise ServiceError(f"{key} is missing: {d[key]}")
    config, config_path = memory_config(d)
    state = memory_status(d, run=run)
    if not state.get("healthy"):
        # A manifest left by a hard task termination makes the supervisor refuse
        # a fresh start; stop reconciles the recorded PIDs and clears it.
        try:
            stack = _rc_stack(d)
            stack.stop(d["node"], d["supervisor"], config_path, run=run)
        except Exception:  # no runnable stack is not a stop failure for startup
            pass
        pid = _spawn_detached([d["node"], d["supervisor"], "start", "--config", str(config_path), "--json"],
                              cwd=Path(d["memory_root"]), log_path=Path(d["memory_root"]) / "logs" / "start.log",
                              spawn=spawn)
        for _ in range(attempts):
            state = memory_status(d, run=run)
            if state.get("healthy"):
                break
            sleep(delay)
        state["launcher_pid"] = pid
    if not state.get("healthy"):
        rows = [f"{row.get('name')}={row.get('health')}/{row.get('ownership')}" for row in state.get("processes", [])]
        log = Path(d["memory_root"]) / "logs" / "start.log"
        detail = ""
        if log.is_file():
            detail = " · " + " ".join(log.read_text(encoding="utf-8", errors="replace").strip().splitlines()[-2:])[:300]
        raise ServiceError(f"memory stack is not healthy: {state.get('code')} {' '.join(rows)}{detail}".strip())
    return {"ok": True, "code": state.get("code"),
            "processes": [{k: row.get(k) for k in ("name", "health", "ownership", "port")}
                          for row in state.get("processes", [])],
            "core_port": d["core_port"], "panel_port": d["panel_port"]}


def ensure_identity(d, *, run=None, sleep=time.sleep, attempts=3, delay=3.0):
    """Provision the RC owner identity once the metadata store exists."""
    key_file = Path(d["admin_key"])
    # A key without its metadata store belongs to state that no longer exists.
    # Keeping it would make init-admin skip the only admin it could create, so
    # the stale RC-owned key is dropped and provisioned again from scratch.
    if key_file.is_file() and not Path(d["metadata_db"]).is_file():
        key_file.unlink()
    if key_file.is_file():
        return {"ok": True, "action": "reused", "admin_key_present": True}
    script = Path(d["source"]) / "native" / "windows" / "provision_memory_identity.mjs"
    if not script.is_file():
        raise ServiceError(f"identity provisioner is missing: {script}")
    # A fresh RC store has no metadata database yet: the internal init-admin call
    # the provisioner makes creates it. Waiting for the file first deadlocked
    # every clean install, so the provisioner itself is the readiness step.
    last = None
    for attempt in range(max(1, attempts)):
        process = _run([d["node"], script, "--memory-root", d["memory_root"], "--json"],
                       timeout=180, run=run)
        receipt = _json_tail(process) or {}
        if process.returncode == 0 and receipt.get("provisioned"):
            return {"ok": True, "action": "provisioned",
                    "admin_key_present": Path(d["admin_key"]).is_file(),
                    "team_id": receipt.get("team_id"),
                    "agents": (receipt.get("identity_map") or {}).get("agents"),
                    "conflicts": len(receipt.get("conflicts") or [])}
        last = process
        if attempt + 1 < max(1, attempts):
            sleep(delay)
    detail = (last.stderr or last.stdout or "no output").strip().splitlines()
    raise ServiceError("memory identity provisioning failed: " + " ".join(detail[-2:])[:300])


# --------------------------------------------------------------------- Kanzo


def _http_json(port, path, timeout=5):
    with urllib.request.urlopen(f"http://127.0.0.1:{int(port)}{path}", timeout=timeout) as response:
        raw = response.read(1024 * 1024 + 1)
        if response.status != 200 or len(raw) > 1024 * 1024:
            raise ServiceError(f"unexpected reply from 127.0.0.1:{port}{path}")
        return json.loads(raw)


def _kanzo_ping(port):
    """The board's own readiness contract: 200 plus the literal body `kanzo`."""
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{int(port)}/api/ping", timeout=3) as response:
            return response.status == 200 and response.read(64).strip() == b"kanzo"
    except (urllib.error.URLError, OSError, ValueError):
        return False


def _kanzo_board(port):
    board = _http_json(port, "/api/board?project=all")
    tasks = board.get("tasks")
    if not isinstance(tasks, list) or not isinstance(board.get("statuses"), list):
        raise ServiceError("Kanzo /api/board did not return a board")
    return {"tasks": len(tasks), "statuses": len(board["statuses"]),
            "projects": len(board.get("projects") or [])}


def _stage_kanzo(d):
    """Provision the RC's own board binary from the machine's local install."""
    target = Path(d["kanzo"])
    if target.is_file():
        return target
    source = Path(d["vendor_kanzo"])
    if not source.is_file():
        raise ServiceError(f"Kanzo board binary is unavailable: {target} and {source} are missing")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(source.read_bytes())
    return target


def ensure_kanzo(d, *, spawn=None, sleep=time.sleep, attempts=30, delay=1.0, ping=None):
    """An RC-owned, real Kanzo board on an RC port. Never production 4242."""
    binary = _stage_kanzo(d)
    home = Path(d["kanzo_home"])
    home.mkdir(parents=True, exist_ok=True)
    ping = ping or _kanzo_ping
    if not ping(d["kanzo_port"]):
        pid = _spawn_detached([binary, "--home", str(home), "--port", str(d["kanzo_port"]), "--no-open"],
                              cwd=home, log_path=Path(d["root"]) / "logs" / "kanzo.log", spawn=spawn)
        for _ in range(attempts):
            if ping(d["kanzo_port"]):
                break
            sleep(delay)
    if not ping(d["kanzo_port"]):
        raise ServiceError(f"Kanzo board did not answer on 127.0.0.1:{d['kanzo_port']}")
    board = _kanzo_board(d["kanzo_port"])
    _remember_pid(d, "kanzo", locals().get("pid"))
    return {"ok": True, "port": d["kanzo_port"], "home": str(home),
            "binary": str(binary), "pid": locals().get("pid"), **board}


# --------------------------------------------------------------------- Office

OFFICE_LAUNCHER = '''"""RC-owned Claude Office launcher (generated by rc_services.py)."""
import json, os, pathlib, sys
args = sys.argv[1:]
cfg = json.loads(pathlib.Path(args[args.index("--config") + 1]).read_text(encoding="utf-8-sig"))
state = pathlib.Path(cfg["stateDir"])
logs = pathlib.Path(cfg["logDir"])
logs.mkdir(parents=True, exist_ok=True)
handle = open(logs / "backend.log", "a", encoding="utf-8", buffering=1)
sys.stdout = sys.stderr = handle
keys = json.loads((state / "keys.json").read_text(encoding="utf-8-sig"))
os.environ.update(
    CLAUDE_OFFICE_API_KEY=keys["apiKey"],
    CLAUDE_OFFICE_INGEST_KEY=keys["ingestKey"],
    SUMMARY_ENABLED="false",
    SUMMARY_BACKEND="disabled",
    SERVE_STATIC="true",
    DATABASE_URL="sqlite+aiosqlite:///" + (state / "office.db").as_posix(),
)
sys.path.insert(0, str(pathlib.Path(cfg["backendDir"])))
import uvicorn
uvicorn.run("app.main:app", host="127.0.0.1", port=int(cfg["port"]), log_level="info")
'''


def _office_health(port):
    try:
        payload = _http_json(port, "/health", timeout=3)
        return payload.get("status") == "ok"
    except (ServiceError, urllib.error.URLError, OSError, ValueError):
        return False


def office_paths(d):
    """Create the RC-owned Office service, state and log directories."""
    for key in ("office_service_dir", "office_state", "office_logs"):
        Path(d[key]).mkdir(parents=True, exist_ok=True)
    return d


def office_keys(d, *, token_factory=None):
    """Stable RC-owned Office API/ingest keys; reused on every later start."""
    path = Path(d["office_state"]) / "keys.json"
    if path.is_file():
        return json.loads(path.read_text(encoding="utf-8-sig"))
    make = token_factory or (lambda: __import__("secrets").token_urlsafe(32))
    keys = {"apiKey": make(), "ingestKey": make()}
    path.write_text(json.dumps(keys), encoding="utf-8")
    return keys


def office_config(d):
    """The RC-owned service config over the installed, read-only distribution."""
    install = Path(d["office_install"])
    backend = install / "source" / "backend"
    if not backend.is_dir():
        raise ServiceError(f"Claude Office distribution is unavailable: {backend} is missing")
    if not Path(d["office_python"]).is_file():
        raise ServiceError(f"Claude Office venv interpreter is unavailable: {d['office_python']}")
    office_paths(d)
    keys = office_keys(d)
    config = {
        "port": int(d["office_port"]),
        "backendDir": str(backend),
        "stateDir": str(d["office_state"]),
        "logDir": str(d["office_logs"]),
        "serveStatic": True,
    }
    Path(d["office_config"]).write_text(json.dumps(config, indent=2), encoding="utf-8")
    Path(d["office_launcher"]).write_text(OFFICE_LAUNCHER, encoding="utf-8")
    panel_key = Path(d["office_panel_key"])
    panel_key.parent.mkdir(parents=True, exist_ok=True)
    panel_key.write_text(keys["apiKey"], encoding="utf-8")
    return config


def ensure_office(d, *, spawn=None, sleep=time.sleep, attempts=90, delay=1.0, health=None):
    """Start the real local Claude Office service with RC-owned state and port."""
    office_config(d)
    health = health or _office_health
    pid = None
    if not health(d["office_port"]):
        pid = _spawn_detached([d["office_python"], "-B", d["office_launcher"],
                               "--config", d["office_config"]],
                              cwd=Path(d["office_root"]),
                              log_path=Path(d["office_logs"]) / "launch.log", spawn=spawn)
        for _ in range(attempts):
            if health(d["office_port"]):
                break
            sleep(delay)
    if not health(d["office_port"]):
        raise ServiceError(f"Claude Office did not become healthy on 127.0.0.1:{d['office_port']}")
    _remember_pid(d, "office", pid)
    return {"ok": True, "port": d["office_port"], "state": str(d["office_state"]),
            "pid": pid, "health": "ok"}


# --------------------------------------------------------------- service state


def _read_state(d):
    path = Path(d["service_state"])
    if not path.is_file():
        return {}
    return json.loads(path.read_text(encoding="utf-8-sig"))


def _remember_pid(d, name, pid):
    if not pid:
        return
    state = _read_state(d)
    state[name] = int(pid)
    path = Path(d["service_state"])
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(state), encoding="utf-8")


def _stop_pid(pid):
    if not pid:
        return False
    try:
        if os.name == "nt":
            process = subprocess.run(["taskkill", "/PID", str(int(pid)), "/T", "/F"],
                                     capture_output=True, text=True, timeout=60, check=False)
            return process.returncode == 0
        os.kill(int(pid), 15)
        return True
    except (OSError, ValueError, subprocess.SubprocessError):
        return False


# ------------------------------------------------------------ dashboard context


def panel_env(d):
    """Environment the dashboard needs to reach the RC-owned backends."""
    d = layout(d)
    return {
        "SINGULARITY_WINDOWS_NATIVE": "1",
        "SINGULARITY_INSTALL_VARIANT": "2",
        "SINGULARITY_BIND": "127.0.0.1",
        "SINGULARITY_PORT": str(d["dashboard_port"]),
        "SINGULARITY_WORKSPACE": str(d["workspace"]),
        "SINGULARITY_RQL_BIN": str(d["rql"]),
        "SINGULARITY_STATE_DIR": str(Path(d["root"]) / "state"),
        "SINGULARITY_PROVISION_STATE_DIR": str(Path(d["root"]) / "provision"),
        "SINGULARITY_TENCENT_HOST": "127.0.0.1",
        "SINGULARITY_TENCENT_PORT": str(d["panel_port"]),
        "SINGULARITY_TENCENT_OWNER_KEY_FILE": str(d["admin_key"]),
        "TENCENT_PANEL_BASE": f"http://127.0.0.1:{d['panel_port']}",
        "SINGULARITY_OFFICE_HEALTH_HOST": "127.0.0.1",
        "SINGULARITY_OFFICE_HEALTH_PORT": str(d["office_port"]),
        "SINGULARITY_OFFICE_HOST": "127.0.0.1",
        "SINGULARITY_OFFICE_PORT": str(d["office_port"]),
        "SINGULARITY_OFFICE_NATIVE_AUTH_MODE": "key_file",
        "SINGULARITY_OFFICE_PANEL_KEY_FILE": str(d["office_panel_key"]),
        "SINGULARITY_KANZO_HOST": "127.0.0.1",
        "SINGULARITY_KANZO_PORT": str(d["kanzo_port"]),
        "SINGULARITY_MEMORY_SUPERVISOR": str(d["supervisor"]),
        "SINGULARITY_MEMORY_STACK_CONFIG": str(Path(d["memory_root"]) / "stack.json"),
        "PYTHONDONTWRITEBYTECODE": "1",
    }


def backend_status(d, *, run=None):
    """Value-free readiness of every loopback backend the panels use."""
    d = layout(d)
    result = {}
    try:
        status = repoql_status(d, run=run)
        result["repoql"] = {"ok": bool(status.get("running")), "verdict": status.get("verdict"),
                            "error": status.get("error") if not status.get("running") else None}
    except Exception as exc:
        result["repoql"] = {"ok": False, "error": type(exc).__name__}
    state = memory_status(d, run=run)
    result["memory"] = {"ok": bool(state.get("healthy")), "code": state.get("code"),
                        "core_listening": _port_open("127.0.0.1", d["core_port"]),
                        "panel_listening": _port_open("127.0.0.1", d["panel_port"]),
                        "panel_http": _panel_ready(f"http://127.0.0.1:{d['panel_port']}"),
                        "owner_key_present": Path(d["admin_key"]).is_file()}
    ping = _kanzo_ping(d["kanzo_port"])
    kanzo = {"ok": ping, "port": d["kanzo_port"]}
    if ping:
        try:
            kanzo.update(_kanzo_board(d["kanzo_port"]))
        except (ServiceError, urllib.error.URLError, OSError, ValueError) as exc:
            kanzo.update(ok=False, error=type(exc).__name__)
    result["kanzo_board"] = kanzo
    result["office"] = {"ok": _office_health(d["office_port"]), "port": d["office_port"],
                        "panel_key_present": Path(d["office_panel_key"]).is_file()}
    return result


def start(d, *, run=None, spawn=None, log=None):
    """Bring up every backend the candidate can own; independent per service."""
    d = layout(d)
    say = log or (lambda message: print("rc-services: " + message, file=sys.stderr, flush=True))
    report = {"root": str(d["root"]), "services": {}}
    for name, step in (("repoql", lambda: ensure_repoql(d, run=run, spawn=spawn)),
                       ("memory", lambda: ensure_memory(d, run=run, spawn=spawn)),
                       ("memory_identity", lambda: ensure_identity(d, run=run)),
                       ("kanzo", lambda: ensure_kanzo(d, spawn=spawn)),
                       ("office", lambda: ensure_office(d, spawn=spawn))):
        say(f"starting {name}")
        began = time.monotonic()
        try:
            report["services"][name] = {"ok": True, **(step() or {})}
        except Exception as exc:
            report["services"][name] = {"ok": False, "error": str(exc)[:400]}
        report["services"][name]["seconds"] = round(time.monotonic() - began, 1)
        say(f"{name}: {'ok' if report['services'][name]['ok'] else 'FAILED'} "
            f"({report['services'][name]['seconds']}s)")
    report["ok"] = all(row.get("ok") for row in report["services"].values())
    return report


def stop(d, *, run=None):
    """Stop the RC-owned stack and host without touching any other install."""
    d = layout(d)
    report = {}
    state = _read_state(d)
    for name in ("kanzo", "office"):
        stopped = _stop_pid(state.get(name))
        report[name] = {"stopped": stopped, "pid": state.get(name)}
    try:
        rc_stack = _rc_stack(d)
        config_path = Path(d["memory_root"]) / "stack.json"
        if config_path.is_file():
            stopped = rc_stack.stop(d["node"], d["supervisor"], config_path, run=run)
            report["memory"] = {"stopped": True,
                                "all_stopped": all(row.get("stopped") for row in stopped.get("processes", []))}
    except Exception as exc:
        report["memory"] = {"stopped": False, "error": str(exc)[:300]}
    try:
        _run([d["rql"], "host", "stop"], cwd=d["workspace"], timeout=120, run=run)
        report["repoql"] = {"stopped": not repoql_status(d, run=run).get("running")}
    except Exception as exc:
        report["repoql"] = {"stopped": False, "error": str(exc)[:300]}
    return report


def launch(d, argv=()):
    """Set the backend environment, start the services, then serve the dashboard."""
    d = layout(d)
    os.environ.update(panel_env(d))
    report = start(d)
    print(json.dumps(report, indent=2), flush=True)
    if not report["ok"]:
        print("rc-services: a local backend did not start; the dashboard will report it",
              file=sys.stderr, flush=True)
    dashboard = Path(d["source"]) / "dashboard"
    if str(dashboard) not in sys.path:
        sys.path.insert(0, str(dashboard))
    os.chdir(dashboard)
    from server import main  # noqa: PLC0415 - the installed dashboard entry point

    return main(list(argv) or ["serve"])


def main(argv=None):
    parser = argparse.ArgumentParser(description="Start the RC's local backends")
    parser.add_argument("action", choices=("start", "status", "stop", "env", "launch"))
    parser.add_argument("--root", default=None, help="RC root (default: the installed candidate)")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("rest", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    env = dict(os.environ)
    if args.root:
        env["SINGULARITY_RC_ROOT"] = args.root
    d = layout(defaults(env))
    if args.action == "start":
        report = start(d)
        print(json.dumps(report, indent=2))
        return 0 if report["ok"] else 1
    if args.action == "status":
        print(json.dumps(backend_status(d), indent=2))
        return 0
    if args.action == "stop":
        report = stop(d)
        print(json.dumps(report, indent=2))
        return 0
    if args.action == "env":
        print(json.dumps(panel_env(d), indent=2))
        return 0
    return launch(d, args.rest)


if __name__ == "__main__":
    raise SystemExit(main())
