"""Idempotent Windows-local integration provisioner (fleet#893 W2/Z2).

Design constraints:
  * per-integration independence: one failure never blocks the others;
  * idempotent: an already-connected integration is never re-provisioned;
  * private credentials: generated with `secrets`, written 0600, never logged,
    never returned in a receipt;
  * durable receipts: one JSON per attempt, plus latest.json, fsync'd;
  * rollback: files created during a failed attempt are removed again.

The default adapters probe real Windows/Linux hosts. Tests inject fakes.
"""
from __future__ import annotations

import argparse
import json
import os
import secrets
import shutil
import socket
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

INTEGRATIONS = ("kanzo", "repoql", "tencent", "openmausbot", "claude_code")

CONNECTED = "connected"
NEEDS_ATTENTION = "needs-attention"
UNAVAILABLE = "not-available"


def _private_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    if os.name != "nt":
        os.chmod(path, 0o700)
    return path


def _port_open(host: str, port: int, timeout: float = 0.4) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


@dataclass
class Adapter:
    """One integration's detect/ensure pair.

    `detect` returns (state, detail) where state is CONNECTED / NEEDS_ATTENTION /
    UNAVAILABLE. `ensure` performs the provisioning and returns a detail string.
    `cleanup` is called with the list of paths created before a failure.
    """

    detect: Callable[[], tuple[str, str]]
    ensure: Callable[[list[Path]], str] | None = None


@dataclass
class Context:
    state_dir: Path
    created: list[Path] = field(default_factory=list)


class Provisioner:
    def __init__(self, state_dir: str | Path, adapters: dict[str, Adapter] | None = None,
                 clock: Callable[[], float] = time.time):
        self.state_dir = _private_dir(Path(state_dir))
        self.credentials_dir = _private_dir(self.state_dir / "credentials")
        self.receipts_dir = _private_dir(self.state_dir / "receipts")
        self.adapters = adapters if adapters is not None else build_adapters()
        self.clock = clock

    # -- credentials -------------------------------------------------------
    def credential_path(self, integration: str) -> Path:
        return self.credentials_dir / f"{integration}.token"

    def ensure_credential(self, integration: str) -> tuple[Path, bool]:
        path = self.credential_path(integration)
        if path.exists() and path.stat().st_size >= 32:
            return path, False
        value = secrets.token_urlsafe(32)
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            # A concurrent repair created the credential first: reuse it rather
            # than failing the integration or overwriting another attempt's key.
            if path.stat().st_size >= 32:
                return path, False
            raise
        try:
            os.write(fd, value.encode())
            os.fsync(fd)
        finally:
            os.close(fd)
        if os.name != "nt":
            os.chmod(path, 0o600)
        return path, True

    # -- status / repair ---------------------------------------------------
    def status(self) -> list[dict]:
        rows = []
        for name in INTEGRATIONS:
            adapter = self.adapters.get(name)
            if adapter is None:
                rows.append({"integration": name, "state": UNAVAILABLE, "detail": "no adapter"})
                continue
            try:
                state, detail = adapter.detect()
            except Exception as exc:  # detection must never abort the panel
                state, detail = UNAVAILABLE, f"detect failed: {type(exc).__name__}"
            rows.append({"integration": name, "state": state, "detail": detail})
        return rows

    def repair(self, only: list[str] | None = None) -> dict:
        targets = [n for n in INTEGRATIONS if (only is None or n in only)]
        results = []
        for name in targets:
            adapter = self.adapters.get(name)
            started = self.clock()
            if adapter is None:
                results.append(self._finish(name, "skipped", UNAVAILABLE, UNAVAILABLE,
                                            False, "no adapter", started))
                continue
            ctx = Context(state_dir=self.state_dir)
            before = NEEDS_ATTENTION
            try:
                state, _ = adapter.detect()
                before = state
                if adapter.ensure is None:
                    # Detection-only integration: report the state it actually has,
                    # never a fabricated needs-attention just because no automated
                    # repair exists yet.
                    results.append(self._finish(name, "skipped", state, state, False,
                                                "detect-only integration; no automated repair",
                                                started))
                    continue
                if state == CONNECTED:
                    results.append(self._finish(name, "noop", state, state, False,
                                                "already connected", started))
                    continue
                cred_path, cred_created = self.ensure_credential(name)
                if cred_created:
                    ctx.created.append(cred_path)
                detail = adapter.ensure(ctx.created)
                after, _ = adapter.detect()
                results.append(self._finish(name, "applied", before, after, True, detail, started))
            except Exception as exc:
                for path in reversed(ctx.created):
                    try:
                        path.unlink()
                    except OSError:
                        pass
                results.append(self._finish(name, "failed", before, NEEDS_ATTENTION, False,
                                            f"{type(exc).__name__}: {exc}", started))
        summary = {
            "generated_at": self.clock(),
            "changed": sum(1 for r in results if r["changed"]),
            "failed": sum(1 for r in results if r["action"] == "failed"),
            "results": results,
        }
        self._write_json(self.receipts_dir / "latest.json", summary)
        return summary

    def _finish(self, name, action, before, after, changed, detail, started) -> dict:
        receipt = {
            "integration": name, "action": action, "state_before": before,
            "state_after": after, "changed": changed, "detail": detail,
            "started_at": started, "finished_at": self.clock(),
            "credential": str(self.credential_path(name)) if self.credential_path(name).exists() else None,
        }
        stamp = time.strftime("%Y%m%dT%H%M%S", time.gmtime(receipt["finished_at"]))
        self._write_json(self.receipts_dir / f"{stamp}-{name}.json", receipt)
        return receipt

    @staticmethod
    def _write_json(path: Path, payload: dict) -> None:
        tmp = path.with_suffix(path.suffix + ".tmp")
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2, sort_keys=True)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)


# -- default Windows/Linux adapters -------------------------------------------

def _which(name: str, path: str | None = None) -> str | None:
    """PATH lookup relative to the adapter's env, not a hidden global."""
    return shutil.which(name, path=path if path is not None else os.environ.get("PATH"))


def _localappdata(env: dict) -> Path | None:
    raw = env.get("LOCALAPPDATA")
    return Path(raw) if raw else None


def _first_file(candidates) -> Path | None:
    for candidate in candidates:
        if not candidate:
            continue
        path = Path(candidate)
        try:
            if path.is_file() and not path.is_symlink():
                return path
        except OSError:
            continue
    return None


def _sibling_module(name: str):
    """Import a sibling lane module (openmausbot/headless.py) from the tree."""
    import importlib
    here = Path(__file__).resolve().parent
    directory = here.parent / name
    if str(directory) not in sys.path:
        sys.path.insert(0, str(directory))
    return importlib.import_module("headless" if name == "openmausbot" else name)


def _rc_services():
    """The RC's own zero-touch backend bootstrap (native/windows/rc_services.py)."""
    import importlib
    directory = Path(__file__).resolve().parent.parent
    if str(directory) not in sys.path:
        sys.path.insert(0, str(directory))
    return importlib.import_module("rc_services")


def build_adapters(env: dict | None = None) -> dict[str, Adapter]:
    """Real Windows/Linux probes, path-overridable for tests and the RC.

    Every default is either an RC-owned location or the vendor's per-user
    install; nothing here reaches the network or a fleet endpoint.
    """
    env = dict(os.environ if env is None else env)
    search_path = env.get("PATH")
    local = _localappdata(env)
    root_default = (local / "Singularity" / "Fleet861RC") if local else None

    def omb_root() -> Path | None:
        raw = env.get("SINGULARITY_OMB_ROOT")
        return Path(raw) if raw else root_default

    def omb_state() -> Path | None:
        raw = env.get("SINGULARITY_OMB_STATE")
        if raw:
            return Path(raw)
        base = omb_root()
        return (base / "state") if base else None

    def omb_node() -> str | None:
        raw = env.get("SINGULARITY_OMB_NODE")
        if raw:
            return raw
        if local:
            candidate = local / "Singularity" / "Runtime" / "node" / "node.exe"
            if candidate.is_file():
                return str(candidate)
        return shutil.which("node")

    def kanzo_detect():
        binary = _first_file([env.get("SINGULARITY_KANZO_EXE"), _which("kanzo", search_path),
                              _which("kanzo.exe", search_path)])
        if binary:
            return CONNECTED, f"kanzo binary {binary.name} present"
        return NEEDS_ATTENTION, "kanzo binary not found"

    def kanzo_ensure(created: list[Path]):
        raise RuntimeError("kanzo install is not automated in this build; place kanzo.exe on PATH")

    def repoql_detect():
        binary = _first_file([env.get("SINGULARITY_RQL_EXE"), _which("rql", search_path),
                              _which("rql.exe", search_path)])
        if binary:
            return CONNECTED, f"rql binary {binary.name} present"
        return NEEDS_ATTENTION, "rql binary not found"

    def repoql_ensure(created: list[Path]):
        """Create the RC workspace and leave a verified local host serving it."""
        module = _rc_services()
        data = module.layout(module.defaults(env))
        report = module.ensure_repoql(data)
        return ("RepoQL host " + str(report.get("verdict") or "ready")
                + " on the RC-owned workspace")

    def tencent_detect():
        # Native RC installs run MemoryPanel on their own loopback port; the
        # Linux/docker dashboard default stays 8125 when no native marker is set.
        default_port = "18226" if env.get("SINGULARITY_WINDOWS_NATIVE") == "1" else "8125"
        try:
            port = int(env.get("SINGULARITY_TENCENT_PANEL_PORT") or default_port)
        except ValueError:
            return UNAVAILABLE, "panel port is not an integer"
        if _port_open("127.0.0.1", port):
            return CONNECTED, f"MemoryPanel loopback 127.0.0.1:{port} reachable"
        return NEEDS_ATTENTION, f"no MemoryPanel listener on 127.0.0.1:{port}"

    def tencent_ensure(created: list[Path]):
        supervisor = env.get("SINGULARITY_MEMORY_SUPERVISOR")
        config = env.get("SINGULARITY_MEMORY_STACK_CONFIG")
        if not supervisor or not config:
            # No pre-staged config: build the RC-owned one from the machine's
            # vendor build dirs, start it and provision the owner identity.
            module = _rc_services()
            data = module.layout(module.defaults(env))
            module.ensure_memory(data)
            identity = module.ensure_identity(data)
            return ("memory stack started on RC ports "
                    + f"{data['core_port']}/{data['panel_port']}; owner identity "
                    + str(identity.get("action")))
        node = omb_node()
        if not node:
            raise RuntimeError("no Node runtime for the memory supervisor")
        result = subprocess.run([node, supervisor, "start", "--config", config, "--json"],
                                capture_output=True, text=True, timeout=600)
        if result.returncode != 0:
            raise RuntimeError("memory supervisor start failed: "
                               + (result.stderr or result.stdout).strip()[:200])
        return "native memory stack started"

    def openmausbot_detect():
        module = _sibling_module("openmausbot")
        root, state, node = omb_root(), omb_state(), omb_node()
        if not root or not state or not node:
            return UNAVAILABLE, "RC root/state/node is not resolvable"
        try:
            port = int(env.get("SINGULARITY_OMB_PORT", str(module.DEFAULT_PORT)))
        except ValueError:
            return UNAVAILABLE, "OMB port is not an integer"
        return module.detect(state, node, port)

    def openmausbot_ensure(created: list[Path]):
        module = _sibling_module("openmausbot")
        root, state, node = omb_root(), omb_state(), omb_node()
        if not root or not state or not node:
            raise RuntimeError("RC root/state/node is not resolvable")
        tarball = env.get("SINGULARITY_OMB_TARBALL")
        integrity = env.get("SINGULARITY_OMB_INTEGRITY")
        if not module.payload_ready(root):
            if not tarball:
                raise RuntimeError("OpenMausBot payload is not staged and no tarball is configured")
            module.verify_source(tarball, integrity=integrity)
            module.extract_payload(tarball, module.payload_dir(root))
        port = int(env.get("SINGULARITY_OMB_PORT", str(module.DEFAULT_PORT)))
        if os.name == "nt":
            result = module.start_via_task(root, state, node, port=port)
        else:
            result = module.start(root, state, node, port=port)
        return "headless OpenMausBot " + ("started" if result.get("started") else "already running")

    def claude_detect():
        home = env.get("USERPROFILE") or str(Path.home())
        binary = _first_file([env.get("SINGULARITY_CLAUDE_EXE"),
                              Path(home) / ".local" / "bin" / "claude.exe",
                              _which("claude", search_path), _which("claude.exe", search_path)])
        if binary:
            return CONNECTED, f"claude CLI {binary.name} present (login is the owner's step)"
        return NEEDS_ATTENTION, "claude CLI not installed"

    def claude_ensure(created: list[Path]):
        raise RuntimeError("install via https://claude.ai/install.ps1, then re-run repair")

    return {
        "kanzo": Adapter(kanzo_detect, kanzo_ensure),
        "repoql": Adapter(repoql_detect, repoql_ensure),
        "tencent": Adapter(tencent_detect, tencent_ensure),
        "openmausbot": Adapter(openmausbot_detect, openmausbot_ensure),
        "claude_code": Adapter(claude_detect, claude_ensure),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Singularity integration provisioner")
    parser.add_argument("action", choices=("status", "repair"))
    parser.add_argument("--state-dir", required=True)
    parser.add_argument("--only", action="append", choices=INTEGRATIONS)
    args = parser.parse_args(argv)

    provisioner = Provisioner(args.state_dir)
    if args.action == "status":
        print(json.dumps({"rows": provisioner.status()}, indent=2))
        return 0
    summary = provisioner.repair(args.only)
    print(json.dumps(summary, indent=2))
    return 0 if summary["failed"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
