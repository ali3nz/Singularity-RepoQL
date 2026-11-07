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

Everything is idempotent and stays inside RC-owned roots. Nothing here reads a
production config, connects to dockerhost, or falls back to a stub: a backend
that cannot start is reported as a failure with its exact reason.

Two backends are deliberately *not* started here because the candidate does not
ship them: the local Kanzo board (`kanzo.exe`, a third-party install) and
Claude Office (a third-party service with its own login). `status` reports them
as unavailable rather than pretending they work.
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
FORBIDDEN_PORTS = frozenset({18100, 18101, 18126, 18128})
MARKER_GITIGNORE = "cache/\n"
METADATA_DB = ("state", "data", "core", "metadata", "tdai_metadata_default", "metadata.db")
SOURCE = Path(__file__).resolve().parent.parent


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
    except ValueError:
        raise ServiceError("RC service ports must be integers") from None
    for port in (core_port, panel_port):
        if not 1 <= port <= 65535:
            raise ServiceError("RC service port out of range")
        if port in FORBIDDEN_PORTS:
            raise ServiceError(f"port {port} belongs to the production stack")
    if core_port == panel_port:
        raise ServiceError("core and panel need distinct ports")
    return {
        "root": root,
        "workspace": root / "workspace",
        "memory_root": root / "memory",
        "source": root / "source" if (root / "source").is_dir() else SOURCE,
        "node": node,
        "rql": rql,
        "supervisor": None,
        "core_dir": vendor / "runtime" / "build" / "MemoryCore",
        "panel_dir": vendor / "runtime" / "build" / "MemoryPanel",
        "core_port": core_port,
        "panel_port": panel_port,
        "dashboard_port": int(env.get("SINGULARITY_RC_DASHBOARD_PORT", DEFAULT_DASHBOARD_PORT)),
    }


def layout(d):
    """Resolve the supervisor script and the owner-key path for this root."""
    source = Path(d["source"])
    resolved = dict(d)
    resolved["supervisor"] = Path(d.get("supervisor") or source / "scripts" / "native-memory-supervisor.mjs")
    resolved["admin_key"] = Path(d["memory_root"]) / "state" / "secrets" / "admin-user-key"
    resolved["metadata_db"] = Path(d["memory_root"]).joinpath(*METADATA_DB)
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


def ensure_repoql(d, *, run=None, sleep=time.sleep, attempts=30, delay=2.0):
    """Marker + import + a running host, verified by `host status`."""
    if not Path(d["rql"]).is_file():
        raise ServiceError(f"rql is not installed at {d['rql']}")
    workspace_marker(d["workspace"])
    status = repoql_status(d, run=run)
    if not status.get("running"):
        import_source(d, run=run)
        for _ in range(attempts):
            status = repoql_status(d, run=run)
            if status.get("running"):
                break
            sleep(delay)
    if not status.get("running"):
        reason = status.get("error") or status.get("verdict") or "unknown"
        raise ServiceError(f"RepoQL host did not start: {reason}")
    files = ((status.get("workspace") or {}).get("files")
             or status.get("files") or status.get("filesIndexed"))
    return {"ok": True, "workspace": str(status.get("workspace", {}).get("root") if isinstance(status.get("workspace"), dict) else d["workspace"]),
            "verdict": status.get("verdict"), "files": files,
            "pid": (status.get("host") or {}).get("pid")}


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
        raise ServiceError(f"memory stack is not healthy: {state.get('code')} {' '.join(rows)}".strip())
    return {"ok": True, "code": state.get("code"),
            "processes": [{k: row.get(k) for k in ("name", "health", "ownership", "port")}
                          for row in state.get("processes", [])],
            "core_port": d["core_port"], "panel_port": d["panel_port"]}


def ensure_identity(d, *, run=None, sleep=time.sleep, attempts=60, delay=2.0):
    """Provision the RC owner identity once the metadata store exists."""
    if Path(d["admin_key"]).is_file():
        return {"ok": True, "action": "reused", "admin_key_present": True}
    script = Path(d["source"]) / "native" / "windows" / "provision_memory_identity.mjs"
    if not script.is_file():
        raise ServiceError(f"identity provisioner is missing: {script}")
    for _ in range(attempts):
        if Path(d["metadata_db"]).is_file():
            break
        sleep(delay)
    if not Path(d["metadata_db"]).is_file():
        raise ServiceError(f"memory metadata store never appeared: {d['metadata_db']}")
    process = _run([d["node"], script, "--memory-root", d["memory_root"], "--json"], timeout=180, run=run)
    receipt = _json_tail(process) or {}
    if process.returncode != 0 or not receipt.get("provisioned"):
        detail = (process.stderr or process.stdout or "no output").strip().splitlines()
        raise ServiceError("memory identity provisioning failed: " + " ".join(detail[-2:])[:300])
    return {"ok": True, "action": "provisioned", "admin_key_present": Path(d["admin_key"]).is_file(),
            "team_id": receipt.get("team_id"), "conflicts": len(receipt.get("conflicts") or [])}


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
        "SINGULARITY_OFFICE_HEALTH_PORT": "8001",
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
    result["kanzo_board"] = {"ok": _port_open("127.0.0.1", 4242),
                             "detail": "third-party local Kanzo board is not installed by this candidate"}
    result["office"] = {"ok": _port_open("127.0.0.1", 8001),
                        "detail": "Claude Office is a third-party service with its own login"}
    return result


def start(d, *, run=None, spawn=None):
    """Bring up every backend the candidate can own; independent per service."""
    d = layout(d)
    report = {"root": str(d["root"]), "services": {}}
    for name, step in (("repoql", lambda: ensure_repoql(d, run=run)),
                       ("memory", lambda: ensure_memory(d, run=run, spawn=spawn)),
                       ("memory_identity", lambda: ensure_identity(d, run=run))):
        try:
            report["services"][name] = {"ok": True, **(step() or {})}
        except Exception as exc:
            report["services"][name] = {"ok": False, "error": str(exc)[:400]}
    report["ok"] = all(row.get("ok") for row in report["services"].values())
    return report


def stop(d, *, run=None):
    """Stop the RC-owned stack and host without touching any other install."""
    d = layout(d)
    report = {}
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
