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
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
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
            if adapter is None or adapter.ensure is None:
                results.append(self._finish(name, "skipped", NEEDS_ATTENTION, NEEDS_ATTENTION,
                                            False, "no adapter", started))
                continue
            ctx = Context(state_dir=self.state_dir)
            before = NEEDS_ATTENTION
            try:
                state, _ = adapter.detect()
                before = state
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

def _which(name: str) -> str | None:
    return shutil.which(name)


def build_adapters() -> dict[str, Adapter]:
    def kanzo_detect():
        if _which("kanzo") or _which("kanzo.exe"):
            return CONNECTED, "kanzo binary on PATH"
        return NEEDS_ATTENTION, "kanzo binary not found"

    def kanzo_ensure(created: list[Path]):
        raise RuntimeError("kanzo install is not automated in this build; place kanzo.exe on PATH")

    def repoql_detect():
        if _which("rql") or _which("rql.exe"):
            return CONNECTED, "rql binary on PATH"
        return NEEDS_ATTENTION, "rql binary not found"

    def repoql_ensure(created: list[Path]):
        raise RuntimeError("rql provisioning requires the staged release; see INSTALLATION")

    def tencent_detect():
        return (CONNECTED, "loopback 8125 reachable") if _port_open("127.0.0.1", 8125) else (
            NEEDS_ATTENTION, "no MemoryCore listener on 127.0.0.1:8125")

    def openmausbot_detect():
        return (CONNECTED, "loopback 8799 reachable") if _port_open("127.0.0.1", 8799) else (
            NEEDS_ATTENTION, "no OpenMausBot listener on 127.0.0.1:8799")

    def claude_detect():
        if _which("claude") or _which("claude.exe"):
            return CONNECTED, "claude CLI on PATH"
        return NEEDS_ATTENTION, "claude CLI not installed"

    def claude_ensure(created: list[Path]):
        raise RuntimeError("install via https://claude.ai/install.ps1, then re-run repair")

    return {
        "kanzo": Adapter(kanzo_detect, kanzo_ensure),
        "repoql": Adapter(repoql_detect, repoql_ensure),
        "tencent": Adapter(tencent_detect, None),
        "openmausbot": Adapter(openmausbot_detect, None),
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
