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
import re
import secrets
import shutil
import socket
import stat
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

INTEGRATIONS = ("kanzo", "office", "repoql", "tencent", "openmausbot", "openmausbot_mcp",
                "claude_code")

CONNECTED = "connected"
NEEDS_ATTENTION = "needs-attention"
UNAVAILABLE = "not-available"


REPOQL_PLUGIN = "repoql@repoql-plugins"


class NeedsUserAction(RuntimeError):
    """Ensure cannot finish without a step only the user can perform.

    Repair records this as action `needs_user_action` (never `failed`, never a
    fabricated success). The message must never contain a credential value.
    """


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
    requires_credential: bool = True


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
                if adapter.requires_credential:
                    cred_path, cred_created = self.ensure_credential(name)
                    if cred_created:
                        ctx.created.append(cred_path)
                detail = adapter.ensure(ctx.created)
                after, _ = adapter.detect()
                results.append(self._finish(name, "applied", before, after, True, detail, started))
            except NeedsUserAction as exc:
                for path in reversed(ctx.created):
                    try:
                        path.unlink()
                    except OSError:
                        pass
                try:
                    after, _ = adapter.detect()
                except Exception:
                    after = NEEDS_ATTENTION
                results.append(self._finish(name, "needs_user_action", before, after, False,
                                            str(exc), started))
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


# -- OpenMausBot desktop MCP pairing (openmausbot_mcp) -----------------------
# Separate from the headless `openmausbot` lane above. The paired MCP session
# token is a bearer secret: it is only ever validated here, never returned,
# logged, placed in argv, or written to a receipt.

OMB_MCP_TOKEN_MAX_BYTES = 4096
OMB_MCP_TOKEN_PATTERN = re.compile(r"omb_sess_[A-Za-z0-9_-]{12,2048}")
OMB_DESKTOP_DEFAULT_PORT = 8799
_FILE_ATTRIBUTE_REPARSE_POINT = 0x400


def omb_mcp_token_path(env: dict) -> Path | None:
    local = _localappdata(env)
    return (local / "Singularity" / "OpenMausBot" / "mcp-session.token") if local else None


def omb_desktop_paths(env: dict) -> tuple[Path, Path] | None:
    local = _localappdata(env)
    if not local:
        return None
    base = local / "Programs" / "OpenMausBot"
    return base / "OpenMausBot.exe", base / "resources" / "server"


def omb_desktop_installed(env: dict) -> bool:
    paths = omb_desktop_paths(env)
    return bool(paths and paths[0].is_file() and paths[1].is_dir())


def inspect_omb_mcp_token(path: Path) -> tuple[str, str]:
    """Read-only validation of the paired session token file.

    Returns (state, detail). The detail never includes any part of the token.
    """
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        return NEEDS_ATTENTION, "no OpenMausBot MCP session token saved yet"
    except OSError:
        return NEEDS_ATTENTION, "OpenMausBot MCP token could not be inspected"
    if (stat.S_ISLNK(info.st_mode)
            or getattr(info, "st_file_attributes", 0) & _FILE_ATTRIBUTE_REPARSE_POINT):
        return NEEDS_ATTENTION, "OpenMausBot MCP token path is a link; refused"
    if not stat.S_ISREG(info.st_mode):
        return NEEDS_ATTENTION, "OpenMausBot MCP token path is not a regular file"
    if info.st_size > OMB_MCP_TOKEN_MAX_BYTES:
        return NEEDS_ATTENTION, "OpenMausBot MCP token file is oversized; refused"
    try:
        with open(path, "rb") as handle:
            raw = handle.read(OMB_MCP_TOKEN_MAX_BYTES + 1)
    except OSError:
        return NEEDS_ATTENTION, "OpenMausBot MCP token could not be read"
    if len(raw) > OMB_MCP_TOKEN_MAX_BYTES:
        return NEEDS_ATTENTION, "OpenMausBot MCP token file is oversized; refused"
    try:
        value = raw.decode("ascii").strip()
    except UnicodeDecodeError:
        value = ""
    if not OMB_MCP_TOKEN_PATTERN.fullmatch(value):
        return NEEDS_ATTENTION, "OpenMausBot MCP token has an unexpected format; pair again"
    return CONNECTED, "OpenMausBot MCP session token present and well-formed"


def restrict_to_current_user(paths, env: dict, run=subprocess.run) -> None:
    """Remove inherited ACEs and grant only the current Windows account via icacls.

    Uses an argument list (no shell) and the System32 icacls binary. The token
    value is never an argument; only file/directory paths are.
    """
    user = env.get("USERNAME")
    if not user:
        raise RuntimeError("current Windows account is not resolvable")
    domain = env.get("USERDOMAIN")
    account = f"{domain}\\{user}" if domain else user
    system_root = env.get("SystemRoot") or r"C:\Windows"
    icacls = str(Path(system_root) / "System32" / "icacls.exe")
    for target in paths:
        is_dir = Path(target).is_dir()
        grant = f"{account}:(OI)(CI)(F)" if is_dir else f"{account}:(F)"
        result = run([icacls, str(target), "/inheritance:r", "/grant:r", grant],
                     capture_output=True, text=True, timeout=30, check=False,
                     creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        if result.returncode != 0:
            raise RuntimeError("icacls could not restrict an OpenMausBot token location")


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

    def omb_port(module) -> int:
        raw = env.get("SINGULARITY_WINDOWS_OMB_PORT") or env.get("SINGULARITY_OMB_PORT")
        try:
            port = int(raw) if raw else int(module.DEFAULT_PORT)
        except (TypeError, ValueError):
            raise RuntimeError("OMB port is not an integer") from None
        if not 1024 <= port <= 65534:
            raise RuntimeError("OMB port is outside the local service range")
        return port

    def kanzo_detect():
        binary = _first_file([env.get("SINGULARITY_KANZO_EXE"), _which("kanzo", search_path),
                              _which("kanzo.exe", search_path)])
        if binary:
            return CONNECTED, f"kanzo binary {binary.name} present"
        return NEEDS_ATTENTION, "kanzo binary not found"

    def kanzo_ensure(created: list[Path]):
        """Stage the vendor board binary into the RC root and leave it serving."""
        module = _rc_services()
        data = module.layout(module.defaults(env))
        report = module.ensure_kanzo(data)
        return f"Kanzo board serving on 127.0.0.1:{report.get('port')}"

    def office_detect():
        module = _rc_services()
        data = module.layout(module.defaults(env))
        if _port_open("127.0.0.1", int(data["office_port"])):
            return CONNECTED, f"Office loopback 127.0.0.1:{data['office_port']} reachable"
        return NEEDS_ATTENTION, f"no Office listener on 127.0.0.1:{data['office_port']}"

    def office_ensure(created: list[Path]):
        """Start Office with RC-owned keys; the capability URL is never logged."""
        module = _rc_services()
        data = module.layout(module.defaults(env))
        module.ensure_office(data)
        return f"Office started on 127.0.0.1:{data['office_port']}"

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
        default_port = "18126" if env.get("SINGULARITY_WINDOWS_NATIVE") == "1" else "8125"
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
                                capture_output=True, text=True, timeout=600,
                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
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
            port = omb_port(module)
        except RuntimeError as exc:
            return UNAVAILABLE, str(exc)
        result, detail = module.detect(state, node, port)
        if result != CONNECTED or os.name != "nt":
            return result, detail
        try:
            verified = run_maintainer_helper(root, node, "--verify-bot")
        except (OSError, subprocess.SubprocessError, ValueError, RuntimeError):
            return NEEDS_ATTENTION, "OpenMausBot is running but its initial bot could not be verified"
        if verified.get("ambiguous") is True:
            return NEEDS_ATTENTION, "multiple default OpenMausBot bots need manual review"
        if verified.get("present") is not True:
            return NEEDS_ATTENTION, "the initial OpenMausBot bot is missing"
        if (verified.get("botRegistrationVerified") is not True
                or verified.get("botConfigVerified") is not True
                or verified.get("botOnlyBoundaryVerified") is not True
                or verified.get("otherBotsPreserved") is not True):
            return NEEDS_ATTENTION, "the initial OpenMausBot bot configuration needs manual review"
        return CONNECTED, detail + "; initial bot verified"

    def run_maintainer_helper(root: Path, node: str, *options: str) -> dict:
        script = Path(__file__).resolve().parent.parent / "openmausbot" / "provision_maintainer.mjs"
        source = Path(__file__).resolve().parents[3]
        result = subprocess.run([node, str(script), *options, "--source", str(source),
                                 "--rc-root", str(root)],
                                capture_output=True, text=True, timeout=180,
                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        try:
            payload = json.loads(result.stdout)
        except (json.JSONDecodeError, TypeError):
            code = ""
            for line in (result.stderr or "").splitlines():
                if line.startswith("OMB_MAINTAINER_PROVISION_REFUSED: "):
                    candidate = line.rsplit(" ", 1)[-1]
                    if candidate.isascii() and candidate.replace("_", "").isalnum():
                        code = candidate
                    break
            raise RuntimeError("OpenMausBot initial bot helper returned no report"
                               + (f" ({code})" if code else ""))
        if not isinstance(payload, dict):
            raise RuntimeError("OpenMausBot initial bot helper returned an invalid report")
        if result.returncode != 0:
            error = payload.get("error")
            if not isinstance(error, str) or not error.isascii() or not error.replace("_", "").isalnum():
                error = "HELPER_FAILED"
            raise RuntimeError("OpenMausBot initial bot helper failed (" + error + ")")
        return payload

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
        port = omb_port(module)
        if os.name == "nt":
            result = module.start_via_task(root, state, node, port=port)
        else:
            result = module.start(root, state, node, port=port)
        detail = "headless OpenMausBot " + ("started" if result.get("started") else "already running")
        if os.name == "nt":
            bot = run_maintainer_helper(root, node, "--apply", "--bot-only")
            required = {
                "botRegistrationVerified": True,
                "botConfigVerified": True,
                "otherBotsPreserved": True,
                "botOnlyBoundaryVerified": True,
                "scheduleRequested": False,
                "scheduleCreated": False,
                "scheduleVerified": False,
                "chatReportVerified": False,
                "liveRulesLoadedVerified": False,
                "reloadRequired": False,
            }
            if any(bot.get(field) is not value for field, value in required.items()):
                raise RuntimeError("OpenMausBot initial bot configuration or bot-only boundary was not verified")
            detail += "; initial bot " + ("reused" if bot.get("botReused") is True else "created")
        return detail

    def omb_mcp_detect():
        token = omb_mcp_token_path(env)
        if token is None:
            return UNAVAILABLE, "LOCALAPPDATA is not set; OpenMausBot MCP location unknown"
        if not omb_desktop_installed(env):
            return UNAVAILABLE, "OpenMausBot desktop is not installed for this Windows user"
        return inspect_omb_mcp_token(token)

    def omb_mcp_ensure(created: list[Path]):
        """Never fakes pairing: the one-time code is the user's step.

        No supported non-interactive pairing source or verified `connect` CLI
        contract exists on this machine, so this reports what the user must do.
        """
        if omb_mcp_token_path(env) is None:
            raise NeedsUserAction("LOCALAPPDATA is not set; OpenMausBot MCP location unknown")
        if not omb_desktop_installed(env):
            raise NeedsUserAction("install OpenMausBot for this Windows user, then repair")
        raw_port = env.get("SINGULARITY_OMB_DESKTOP_PORT")
        try:
            port = int(raw_port) if raw_port else OMB_DESKTOP_DEFAULT_PORT
        except ValueError:
            raise NeedsUserAction("OpenMausBot desktop port is not an integer") from None
        if not 1024 <= port <= 65534:
            raise NeedsUserAction("OpenMausBot desktop port is outside the local service range")
        if not _port_open("127.0.0.1", port):
            raise NeedsUserAction(f"OpenMausBot is installed but its local API is not answering "
                                  f"on 127.0.0.1:{port}; start OpenMausBot and sign in, then repair")
        raise NeedsUserAction("one-time pairing needs a code from OpenMausBot Settings > Phone; "
                              "no verified non-interactive pairing source is available. Pair once "
                              "with the OpenMausBot connect command, saving the session to the "
                              "token path, then repair")

    def claude_detect():
        home = env.get("USERPROFILE") or str(Path.home())
        binary = _first_file([env.get("SINGULARITY_CLAUDE_EXE"),
                              Path(home) / ".local" / "bin" / "claude.exe",
                              _which("claude", search_path), _which("claude.exe", search_path)])
        if not binary:
            return NEEDS_ATTENTION, "claude CLI not installed"
        if not repoql_plugin_enabled():
            return NEEDS_ATTENTION, (f"claude CLI {binary.name} present but plugin "
                                     f"{REPOQL_PLUGIN} is not installed (repair installs it)")
        return CONNECTED, f"claude CLI {binary.name} present, {REPOQL_PLUGIN} installed (login is the owner's step)"

    def repoql_plugin_enabled() -> bool:
        home = env.get("USERPROFILE") or str(Path.home())
        try:
            data = json.loads((Path(home) / ".claude" / "plugins" / "installed_plugins.json")
                              .read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return False
        plugins = data.get("plugins") if isinstance(data, dict) else None
        return isinstance(plugins, dict) and bool(plugins.get(REPOQL_PLUGIN))

    def claude_ensure(created: list[Path]):
        home = env.get("USERPROFILE") or str(Path.home())
        binary = _first_file([env.get("SINGULARITY_CLAUDE_EXE"),
                              Path(home) / ".local" / "bin" / "claude.exe",
                              _which("claude", search_path), _which("claude.exe", search_path)])
        if not binary:
            raise RuntimeError("install via https://claude.ai/install.ps1, then re-run repair")
        if repoql_plugin_enabled():
            return "plugin already installed"
        result = subprocess.run([str(binary), "plugin", "install", REPOQL_PLUGIN],
                                capture_output=True, text=True, timeout=180,
                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        if result.returncode != 0:
            raise RuntimeError(f"claude plugin install {REPOQL_PLUGIN} failed: "
                               + (result.stderr or result.stdout).strip()[:200])
        return f"installed {REPOQL_PLUGIN}"

    return {
        "kanzo": Adapter(kanzo_detect, kanzo_ensure),
        "office": Adapter(office_detect, office_ensure),
        "repoql": Adapter(repoql_detect, repoql_ensure),
        "tencent": Adapter(tencent_detect, tencent_ensure),
        "openmausbot": Adapter(openmausbot_detect, openmausbot_ensure, requires_credential=False),
        "openmausbot_mcp": Adapter(omb_mcp_detect, omb_mcp_ensure, requires_credential=False),
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
