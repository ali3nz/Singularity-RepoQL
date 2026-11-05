#!/usr/bin/env python3
"""Generate the native Windows ``singularity-rust-supervisor/v1`` config.

The installer passes the staged paths; this module produces the exact four
component entries the Rust supervisor accepts (office, dashboard, ghost and
memory). It never writes a credential into the launcher: the memory bearer and
any upstream provider key stay in ACL-protected files owned by their process.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys

SCHEMA = "singularity-rust-supervisor/v1"
REPOQL_VERSION = "1.7.18"
SECRET_KEY_MARKERS = ("TOKEN", "SECRET", "PASSWORD", "API_KEY", "PRIVATE_KEY", "AUTHORIZATION", "CREDENTIAL")
SECRET_ARG_PREFIXES = ("--password=", "--token=", "api_key=", "secret=")


def local_absolute(value: str, label: str) -> Path:
    path = Path(value)
    if not path.is_absolute() or str(path).startswith("\\\\"):
        raise SystemExit(f"{label} must be an absolute local path")
    if "\r" in str(path) or "\n" in str(path):
        raise SystemExit(f"{label} contains a newline")
    return path


def require_file(value: str, label: str) -> Path:
    path = local_absolute(value, label)
    if not path.is_file():
        raise SystemExit(f"{label} does not exist: {path}")
    return path


def require_dir(value: str, label: str) -> Path:
    path = local_absolute(value, label)
    if not path.is_dir():
        raise SystemExit(f"{label} does not exist: {path}")
    return path


def assert_no_secrets(component: dict) -> None:
    for key in component.get("env", {}):
        upper = key.upper()
        if any(marker in upper for marker in SECRET_KEY_MARKERS):
            raise SystemExit(f"{component['id']}: credential environment is refused: {key}")
    for arg in component.get("args", []):
        lower = arg.lower()
        if any(prefix in lower for prefix in SECRET_ARG_PREFIXES):
            raise SystemExit(f"{component['id']}: credential argument is refused")


def component(cid: str, executable: Path, args: list[str], working_dir: Path,
              health: dict | None = None, env: dict[str, str] | None = None) -> dict:
    entry: dict = {
        "id": cid,
        "executable": str(executable),
        "args": args,
        "workingDir": str(working_dir),
    }
    if env:
        entry["env"] = env
    if health:
        entry["health"] = health
    assert_no_secrets(entry)
    return entry


def build(args: argparse.Namespace) -> dict:
    install_root = local_absolute(args.install_root, "--install-root")
    source_root = require_dir(args.source_root, "--source-root")
    bin_dir = require_dir(args.bin_dir, "--bin-dir")
    python = require_file(args.python, "--python")
    repoql = require_file(args.repoql, "--repoql")
    workspace = require_dir(args.workspace, "--workspace")
    dashboard_script = require_file(str(source_root / "native/windows/claude_complete_dashboard_host.py"),
                                    "dashboard host")
    ghost_script = require_file(str(source_root / "native/windows/ghost_scheduler_host.py"), "ghost host")
    bridge = require_file(str(bin_dir / "singularity-desktop-bridge.exe"), "desktop bridge")
    ghost_config = require_file(args.ghost_config, "--ghost-config")
    ghost_client = require_file(args.ghost_client_config, "--ghost-client-config")
    dashboard_state = require_dir(args.dashboard_state, "--dashboard-state")

    components = []
    if not args.skip_office:
        office_source = require_dir(args.office_source, "--office-source")
        office_python = require_file(args.office_python, "--office-python")
        office_backend = require_dir(str(office_source / "backend"), "--office-source/backend")
        components.append(component(
            "office", office_python,
            ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", str(args.office_port)],
            office_backend,
            {"port": args.office_port, "path": "/health", "readyTimeoutMs": 30000}))
    if not args.skip_dashboard:
        components.append(component("dashboard", python,
                  ["-B", str(dashboard_script), "--source-root", str(source_root),
                   "--rql-exe", str(repoql), "--workspace", str(workspace),
                   "--state-dir", str(dashboard_state), "--port", str(args.dashboard_port),
                   "--variant", "2", "--native-bridge-exe", str(bridge),
                   "--ghost-control-config", str(ghost_client)],
                  source_root,
                  {"port": args.dashboard_port, "path": "/.well-known/singularity-health",
                   "readyTimeoutMs": 60000}))
    if not args.skip_ghost:
        components.append(component("ghost", python,
                  ["-B", str(ghost_script), "--config", str(ghost_config)],
                  source_root))

    memory_root = local_absolute(args.memory_root, "--memory-root")
    memory_build_root = local_absolute(args.memory_build_root, "--memory-build-root") if args.memory_build_root else memory_root / "build"
    memory_stack = local_absolute(args.memory_stack_config, "--memory-stack-config") if args.memory_stack_config else memory_root / "stack.json"
    memory_supervisor = local_absolute(args.memory_supervisor, "--memory-supervisor") if args.memory_supervisor else source_root / "scripts/native-memory-supervisor.mjs"
    if (memory_build_root / "MemoryCore").is_dir() and (memory_build_root / "MemoryPanel").is_dir() and memory_stack.is_file() and memory_supervisor.is_file():
        node = require_file(args.node, "--node") if args.node else None
        if node is None:
            raise SystemExit("--node is required when the memory build is present")
        # One long-lived component owns core+panel so the Rust supervisor's
        # Job Object kills the entire memory tree if the task stops or crashes.
        components.append(component(
            "memory", node,
            [str(memory_supervisor), "serve", "--config", str(memory_stack), "--json"],
            source_root,
        ))

    ports = [entry["health"]["port"] for entry in components if entry.get("health")]
    if len(set(ports)) != len(ports):
        raise SystemExit("duplicate component health ports")
    return {
        "schema": SCHEMA,
        "variant": 2,
        "repoqlVersion": REPOQL_VERSION,
        "components": components,
    }


def restrict_windows_acl(path: Path) -> None:
    if os.name != "nt":
        try:
            path.chmod(0o700 if path.is_dir() else 0o600)
        except OSError:
            pass
        return
    whoami = subprocess.run(["whoami", "/user", "/fo", "csv", "/nh"],
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                            text=True, check=False)
    if whoami.returncode != 0:
        raise SystemExit("WINDOWS_SID_UNAVAILABLE")
    owner = whoami.stdout.strip().split(",")[-1].strip().strip('"')
    if not owner.startswith("S-"):
        raise SystemExit("WINDOWS_SID_UNAVAILABLE")
    inherit = "(OI)(CI)F" if path.is_dir() else "F"
    result = subprocess.run(
        ["icacls", str(path), "/inheritance:r", "/grant:r", f"*{owner}:{inherit}", "*S-1-5-18:F"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    if result.returncode != 0:
        raise SystemExit("WINDOWS_ACL_FAILED")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--install-root", required=True)
    parser.add_argument("--source-root", required=True)
    parser.add_argument("--bin-dir", required=True)
    parser.add_argument("--python", required=True)
    parser.add_argument("--repoql", required=True)
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--office-source", default=None)
    parser.add_argument("--office-python", default=None)
    parser.add_argument("--skip-office", action="store_true",
                        help="emit the non-Office stack")
    parser.add_argument("--skip-dashboard", action="store_true",
                        help="omit dashboard (it is a separate scheduled task)")
    parser.add_argument("--skip-ghost", action="store_true",
                        help="omit ghost (it is a separate scheduled task)")
    parser.add_argument("--ghost-config", required=True)
    parser.add_argument("--ghost-client-config", required=True)
    parser.add_argument("--dashboard-state", required=True)
    parser.add_argument("--memory-root", default=None)
    parser.add_argument("--memory-build-root", default=None)
    parser.add_argument("--memory-stack-config", default=None)
    parser.add_argument("--memory-supervisor", default=None)
    parser.add_argument("--node", default=None)
    parser.add_argument("--output", required=True)
    parser.add_argument("--dashboard-port", type=int, default=18100)
    parser.add_argument("--ghost-port", type=int, default=18473)
    parser.add_argument("--office-port", type=int, default=18128)
    parser.add_argument("--memory-port", type=int, default=18421)
    parser.add_argument("--llm-base-url", default="http://127.0.0.1:18431/v1")
    parser.add_argument("--llm-model", default="extraction-failover")
    parser.add_argument("--check", action="store_true", help="validate and print without writing")
    args = parser.parse_args(argv)
    if args.memory_root is None:
        args.memory_root = str(local_absolute(args.install_root, "--install-root") / "memory")
    stack = build(args)
    text = json.dumps(stack, indent=2) + "\n"
    if args.check:
        print(text, end="")
        return 0
    output = local_absolute(args.output, "--output")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(text, encoding="utf-8")
    restrict_windows_acl(output.parent)
    restrict_windows_acl(output)
    print(json.dumps({
        "ok": True,
        "schema": SCHEMA,
        "config": str(output),
        "components": [entry["id"] for entry in stack["components"]],
        "credentialsInConfig": False,
    }, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
