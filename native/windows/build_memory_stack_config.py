#!/usr/bin/env python3
"""Generate the variant-2 native Windows Tencent memory stack config.

The config is consumed by ``scripts/native-memory-supervisor.mjs``. It uses
only per-user paths under ``%LOCALAPPDATA%\\Singularity\\WindowsNative\\memory``
and never contains a provider credential: the supervisor creates its own
ACL-protected bearer file and the optional loopback model gateway (port 18431)
owns any upstream credential outside this config.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

SCHEMA = "native-memory-supervisor/v1"
CORE_PORT = 18421
PANEL_PORT = 18126
MODEL_GATEWAY_PORT = 18431
SECRET_KEY_MARKERS = ("TOKEN", "SECRET", "PASSWORD", "API_KEY", "PRIVATE_KEY", "CREDENTIAL")


def local_absolute(value: str, label: str) -> Path:
    path = Path(value)
    if not path.is_absolute() or str(path).startswith("\\\\"):
        raise SystemExit(f"{label} must be an absolute local path")
    return path


def discover_node(explicit: str | None) -> Path:
    if explicit:
        return local_absolute(explicit, "--node")
    found = shutil.which("node")
    if found:
        return Path(found)
    base = Path(os.environ.get("LOCALAPPDATA", "")) / "Singularity" / "runtime"
    candidates = sorted(base.glob("node-*/node.exe")) if base.is_dir() else []
    if candidates:
        return candidates[-1]
    raise SystemExit("--node is required (node.exe was not found on PATH or in the staged runtime)")


def default_npm_cli(node: Path, explicit: str | None, label: str) -> Path:
    if explicit:
        return local_absolute(explicit, label)
    candidate = node.parent / "node_modules" / "npm" / "bin" / "npm-cli.js"
    if not candidate.is_file():
        raise SystemExit(f"{label} is required: {candidate} does not exist")
    return candidate


def assert_no_inline_secrets(value: object, trail: str = "config") -> None:
    if isinstance(value, dict):
        for key, item in value.items():
            upper = str(key).upper()
            if any(marker in upper for marker in SECRET_KEY_MARKERS):
                raise SystemExit(f"inline credential key refused at {trail}.{key}")
            assert_no_inline_secrets(item, f"{trail}.{key}")
    elif isinstance(value, list):
        for index, item in enumerate(value):
            assert_no_inline_secrets(item, f"{trail}[{index}]")


def build(root: Path, node: Path, npm_cli: Path, npm_cli11: Path,
          source_root: Path, build_root: Path, llm_base_url: str,
          llm_model: str, gateway_script_path: Path | None = None) -> dict:
    if not llm_base_url.startswith("http://127.0.0.1:") and not llm_base_url.startswith("http://localhost:"):
        raise SystemExit("--llm-base-url must be a loopback HTTP origin")
    gateway_script = gateway_script_path if gateway_script_path else source_root / "scripts" / "extraction-failover.mjs"
    if not gateway_script.is_file():
        raise SystemExit(f"gateway script is missing: {gateway_script}")
    router_key = root / "state" / "secrets" / "router-access-key"
    if not router_key.is_file():
        raise SystemExit(f"router key is missing: {router_key}")
    stack = {
        "schema": SCHEMA,
        "root": str(root),
        "stateDir": str(root / "state"),
        "logsDir": str(root / "logs"),
        "node": str(node),
        "npmCli": str(npm_cli),
        "npmCli11": str(npm_cli11),
        "sourceRoot": str(source_root),
        "buildRoot": str(build_root),
        "components": {
            "gateway": {
                "kind": "gateway",
                "host": "127.0.0.1",
                "cwd": str(source_root),
                "command": [str(gateway_script)],
                "port": MODEL_GATEWAY_PORT,
                "healthPath": "/health",
                "readyTimeoutMs": 30000,
                "env": {},
            },
            "core": {
                "kind": "core",
                "cwd": str(build_root / "MemoryCore"),
                "command": ["--import", "tsx", "src/gateway/server.ts"],
                "port": CORE_PORT,
                "healthPath": "/health",
                "readyTimeoutMs": 120000,
                "llmKeyFile": str(router_key),
                "env": {
                    "TDAI_LLM_BASE_URL": llm_base_url,
                    "TDAI_LLM_MODEL": llm_model,
                },
                "coreConfig": {
                    "llm": {
                        "baseUrl": llm_base_url,
                        "apiKey": "${TDAI_LLM_API_KEY}",
                        "model": llm_model,
                    },
                    "memory": {
                        "capture": {"enabled": True},
                        "extraction": {"enabled": True, "enableDedup": False, "maxMemoriesPerSession": 4},
                        "pipeline": {
                            "everyNConversations": 1,
                            "enableWarmup": False,
                            "l1IdleTimeoutSeconds": 15,
                            "l2DelayAfterL1Seconds": 3600,
                        },
                    },
                },
            },
            "panel": {
                "kind": "panel",
                "cwd": str(build_root / "MemoryPanel"),
                "command": ["dist/index.js"],
                "port": PANEL_PORT,
                "healthPath": "/",
                "readyTimeoutMs": 60000,
                "env": {},
            },
        },
        "order": ["gateway", "core", "panel"],
    }
    ports = [component["port"] for component in stack["components"].values()]
    if len(set(ports)) != len(ports):
        raise SystemExit("duplicate component ports")
    assert_no_inline_secrets(stack)
    return stack


def build_hook_config(root: Path) -> dict | None:
    """The Claude memory hook needs the core bearer, not the stack manifest.
    Keep that credential in one ACL-protected file and hand callers its path."""
    bearer_path = root / "state" / "secrets" / "core-bearer"
    if not bearer_path.is_file():
        return None
    bearer = bearer_path.read_text(encoding="utf-8").strip()
    if not bearer:
        return None
    return {
        "hostBaseUrl": f"http://127.0.0.1:{CORE_PORT}",
        "gatewayKey": bearer,
        "serviceId": "default",
        "ghostTeamId": "openchamber-agents",
        "ghostUserId": "pilot-operator",
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
    command = ["icacls", str(path), "/inheritance:r", "/grant:r", f"*{owner}:{inherit}", "*S-1-5-18:F"]
    result = subprocess.run(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    if result.returncode != 0:
        raise SystemExit("WINDOWS_ACL_FAILED")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=None,
                        help="per-user memory root (default %%LOCALAPPDATA%%\\Singularity\\WindowsNative\\memory)")
    parser.add_argument("--node", default=None)
    parser.add_argument("--npm-cli", default=None)
    parser.add_argument("--npm-cli11", default=None)
    parser.add_argument("--source-root", default=None)
    parser.add_argument("--build-root", default=None)
    parser.add_argument("--llm-base-url", default=f"http://127.0.0.1:{MODEL_GATEWAY_PORT}/v1")
    parser.add_argument("--llm-model", default="extraction-failover")
    parser.add_argument("--gateway-script", default=None)
    parser.add_argument("--output", default=None)
    parser.add_argument("--check", action="store_true", help="validate and print the config without writing")
    args = parser.parse_args(argv)

    if args.root:
        root = local_absolute(args.root, "--root")
    else:
        local = os.environ.get("LOCALAPPDATA")
        if not local:
            raise SystemExit("LOCALAPPDATA is required when --root is omitted")
        root = Path(local) / "Singularity" / "WindowsNative" / "memory"
    node = discover_node(args.node)
    if not node.is_file():
        raise SystemExit("--node must point to an existing node.exe")
    npm_cli = default_npm_cli(node, args.npm_cli, "--npm-cli")
    npm_cli11 = default_npm_cli(node, args.npm_cli11, "--npm-cli11")
    source_root = local_absolute(args.source_root, "--source-root") if args.source_root else root / "source"
    build_root = local_absolute(args.build_root, "--build-root") if args.build_root else root / "build"
    gateway_script_path = local_absolute(args.gateway_script, "--gateway-script") if args.gateway_script else None
    stack = build(root, node, npm_cli, npm_cli11, source_root, build_root,
                  args.llm_base_url, args.llm_model, gateway_script_path)
    text = json.dumps(stack, indent=2) + "\n"
    if args.check:
        print(text, end="")
        return 0
    for directory in (root, root / "state", root / "logs"):
        directory.mkdir(parents=True, exist_ok=True)
    output = local_absolute(args.output, "--output") if args.output else root / "stack.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(text, encoding="utf-8")
    restrict_windows_acl(root)
    restrict_windows_acl(output)
    hook = build_hook_config(root)
    hook_output = None
    if hook is not None:
        hook_output = root / "memory-hook.json"
        hook_output.write_text(json.dumps(hook, indent=2) + "\n", encoding="utf-8")
        restrict_windows_acl(hook_output)
        hook_output = str(hook_output)
    print(json.dumps({
        "ok": True,
        "schema": SCHEMA,
        "config": str(output),
        "hookConfig": hook_output,
        "root": str(root),
        "ports": {"core": CORE_PORT, "panel": PANEL_PORT, "modelGateway": MODEL_GATEWAY_PORT},
        "credentialsInConfig": False,
    }, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
