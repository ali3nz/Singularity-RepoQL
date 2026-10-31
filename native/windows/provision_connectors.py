#!/usr/bin/env python3
"""Build, inspect and provision the two bundled RepoQL connectors.

The repository ships connector source and a pinned package recipe, never a
built ``.nupkg``.  ``build`` runs the real 1.7.18 connector test and pack
commands for both connectors, verifies the result against
``connectors/packages.lock.json``, and writes only the packages to a build
root.  ``install`` uses the supported local consent page with no envelope
flags: the operator approves the loopback host for Kanzo and chooses the
MemoryCore data folder there.  ``status`` is read-only with respect to the
connector registry and reports installed, missing and awaiting-consent states.

This helper does not create a connector, grant a host or folder on the
operator's behalf, import a source, or call the dashboard.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import zipfile
from datetime import datetime, timezone
from typing import Any, Callable
from xml.etree import ElementTree

ROOT = Path(__file__).resolve().parents[2]
LOCK_PATH = ROOT / "connectors" / "packages.lock.json"
REQUIRED_RQL = "1.7.18"
LOCK_SCHEMA = "singularity-connector-packages/v1"
REPORT_SCHEMA = "singularity-connectors/v1"
PACKAGE_DIR = "packages"
WORKSPACE_DIR = "workspace"
INSTALL_TIMEOUT_SECONDS = 660

_SCHEME = re.compile(r"^[a-z0-9][a-z0-9+.-]{0,63}$")
_PACKAGE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$")
_VERSION = re.compile(r"^\d+\.\d+\.\d+$")


class ProvisionError(RuntimeError):
    """A fail-closed connector provisioning error with a safe public code."""

    def __init__(self, code: str, detail: str = ""):
        super().__init__(code)
        self.code = code
        self.detail = _safe_detail(detail)


def _safe_detail(value: Any, limit: int = 320) -> str:
    text = " ".join(str(value).replace("\x00", "").split())
    return text[:limit]


def _now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _decode_output(stream) -> str:
    stream.seek(0)
    return stream.read().decode("utf-8", errors="replace")


def _kill_process_tree(process: subprocess.Popen) -> None:
    """Kill a timed-out command and every child that inherited its handles."""
    if os.name == "nt":
        try:
            subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                           timeout=15, check=False)
        except (OSError, subprocess.SubprocessError):
            pass
    else:
        try:
            os.killpg(os.getpgid(process.pid), signal.SIGKILL)
        except (OSError, ProcessLookupError):
            pass
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        try:
            process.kill()
        except OSError:
            pass
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass


def _run(cmd: list[Any], *, cwd: Path, timeout: int = 180,
         runner: Callable[..., subprocess.CompletedProcess] | None = None,
         env: dict[str, str] | None = None):
    argv = [str(part) for part in cmd]
    merged = os.environ.copy()
    if env is not None:
        merged.update(env)
    if runner is not None:
        return runner(argv, cwd=str(cwd), capture_output=True, text=True, encoding="utf-8",
                      errors="replace", timeout=timeout, check=False, env=merged)
    # File-backed output is deliberate: a RepoQL command can leave a host or
    # MCP child holding inherited pipe handles after the CLI itself exits.
    # capture_output would wait on those pipes forever even after the timeout.
    with tempfile.TemporaryFile() as stdout_file, tempfile.TemporaryFile() as stderr_file:
        kwargs = dict(cwd=str(cwd), stdin=subprocess.DEVNULL, stdout=stdout_file,
                      stderr=stderr_file, env=merged)
        if os.name == "nt":
            kwargs["creationflags"] = (getattr(subprocess, "CREATE_NO_WINDOW", 0)
                                       | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0))
        else:
            kwargs["start_new_session"] = True
        process = subprocess.Popen(argv, **kwargs)
        try:
            process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            _kill_process_tree(process)
            raise
        return subprocess.CompletedProcess(argv, process.returncode,
                                           _decode_output(stdout_file),
                                           _decode_output(stderr_file))


def _json_output(text: str) -> dict:
    cleaned = (text or "").lstrip("\ufeff").strip()
    try:
        payload = json.loads(cleaned)
    except json.JSONDecodeError:
        start, end = cleaned.find("{"), cleaned.rfind("}")
        if start < 0 or end <= start:
            raise
        payload = json.loads(cleaned[start:end + 1])
    if not isinstance(payload, dict):
        raise ValueError("expected a JSON object")
    return payload


def _under(root: Path, value: str, code: str) -> Path:
    if not isinstance(value, str) or not value.strip():
        raise ProvisionError(code)
    candidate = (root / value).resolve()
    root = root.resolve()
    try:
        candidate.relative_to(root)
    except ValueError:
        raise ProvisionError(code, "path escapes the product root")
    if candidate == root:
        raise ProvisionError(code, "path must name a file or directory below the product root")
    return candidate


def validate_lock(data: Any, root: Path = ROOT) -> dict:
    """Validate the committed connector package lock, returning it unchanged."""
    if not isinstance(data, dict) or data.get("schema") != LOCK_SCHEMA:
        raise ProvisionError("CONNECTOR_LOCK_INVALID", "schema")
    if data.get("repoqlVersion") != REQUIRED_RQL:
        raise ProvisionError("CONNECTOR_LOCK_INVALID", "RepoQL version must be " + REQUIRED_RQL)
    if data.get("connectorAbi") != 1:
        raise ProvisionError("CONNECTOR_LOCK_INVALID", "connector ABI must be 1")
    authors = data.get("authors")
    if not isinstance(authors, str) or not authors.strip():
        raise ProvisionError("CONNECTOR_LOCK_INVALID", "authors")
    packages = data.get("packages")
    if not isinstance(packages, list) or len(packages) != 2:
        raise ProvisionError("CONNECTOR_LOCK_INVALID", "exactly two packages are required")
    schemes: set[str] = set()
    ids: set[str] = set()
    for spec in packages:
        if not isinstance(spec, dict):
            raise ProvisionError("CONNECTOR_LOCK_INVALID", "package row")
        scheme = spec.get("scheme")
        package_id = spec.get("id")
        version = spec.get("version")
        if not isinstance(scheme, str) or not _SCHEME.fullmatch(scheme) or scheme in schemes:
            raise ProvisionError("CONNECTOR_LOCK_INVALID", "scheme")
        if not isinstance(package_id, str) or not _PACKAGE_ID.fullmatch(package_id) or package_id in ids:
            raise ProvisionError("CONNECTOR_LOCK_INVALID", "package id")
        if not isinstance(version, str) or not _VERSION.fullmatch(version):
            raise ProvisionError("CONNECTOR_LOCK_INVALID", "version")
        expected_name = f"{package_id}.{version}.nupkg"
        if spec.get("package") != expected_name:
            raise ProvisionError("CONNECTOR_LOCK_INVALID", "package filename")
        for key in ("source", "suite"):
            _under(root, spec.get(key), "CONNECTOR_LOCK_INVALID")
        source = _under(root, spec.get("source"), "CONNECTOR_LOCK_INVALID")
        suite = _under(root, spec.get("suite"), "CONNECTOR_LOCK_INVALID")
        if not (source / "connector.ts").is_file() or not (source / "manifest.yaml").is_file():
            raise ProvisionError("CONNECTOR_SOURCE_MISSING", source.name)
        if not suite.is_file():
            raise ProvisionError("CONNECTOR_SOURCE_MISSING", suite.name)
        for key in ("sha256", "bytes"):
            if key not in spec:
                raise ProvisionError("CONNECTOR_LOCK_INVALID", key)
        if not isinstance(spec["sha256"], str) or not re.fullmatch(r"[0-9a-f]{64}", spec["sha256"]):
            raise ProvisionError("CONNECTOR_LOCK_INVALID", "sha256")
        if not isinstance(spec["bytes"], int) or spec["bytes"] <= 0:
            raise ProvisionError("CONNECTOR_LOCK_INVALID", "bytes")
        schemes.add(scheme)
        ids.add(package_id)
    if schemes != {"kanzo", "memorycore"}:
        raise ProvisionError("CONNECTOR_LOCK_INVALID", "the lock must name kanzo and memorycore once each")
    return data


def load_lock(path: Path = LOCK_PATH, root: Path = ROOT) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise ProvisionError("CONNECTOR_LOCK_MISSING", type(exc).__name__)
    except json.JSONDecodeError:
        raise ProvisionError("CONNECTOR_LOCK_INVALID", "JSON")
    return validate_lock(data, root)


def _package_spec(lock: dict, scheme: str) -> dict:
    return next(spec for spec in lock["packages"] if spec["scheme"] == scheme)


def package_path(build_root: Path, spec: dict) -> Path:
    return build_root / PACKAGE_DIR / spec["package"]


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def package_state(build_root: Path, spec: dict) -> dict:
    path = package_path(build_root, spec)
    if not path.is_file():
        return {"state": "missing", "path": str(path), "sha256": "", "bytes": 0}
    size = path.stat().st_size
    digest = _sha256(path)
    if size != spec["bytes"] or digest != spec["sha256"]:
        return {"state": "hash_mismatch", "path": str(path), "sha256": digest, "bytes": size}
    return {"state": "built", "path": str(path), "sha256": digest, "bytes": size}


def _zip_entries(path: Path) -> dict[str, bytes]:
    try:
        with zipfile.ZipFile(path) as archive:
            names = archive.namelist()
            if len(names) != len(set(names)):
                raise ProvisionError("CONNECTOR_PACKAGE_CONTENT_INVALID", "duplicate zip entry")
            return {name: archive.read(name) for name in names}
    except (OSError, zipfile.BadZipFile, RuntimeError):
        raise ProvisionError("CONNECTOR_PACKAGE_CONTENT_INVALID", "not a readable package")


def _nuspec(entries: dict[str, bytes], spec: dict) -> None:
    candidates = [name for name in entries if name.endswith(".nuspec")]
    if len(candidates) != 1:
        raise ProvisionError("CONNECTOR_PACKAGE_CONTENT_INVALID", "nuspec")
    try:
        document = ElementTree.fromstring(entries[candidates[0]])
    except ElementTree.ParseError:
        raise ProvisionError("CONNECTOR_PACKAGE_CONTENT_INVALID", "nuspec XML")
    values: dict[str, str] = {}
    package_type = ""
    for element in document.iter():
        name = element.tag.rsplit("}", 1)[-1]
        if name in {"id", "version", "authors"} and name not in values:
            values[name] = (element.text or "").strip()
        if name == "packageType":
            package_type = (element.attrib.get("name") or "").strip()
    if values.get("id") != spec["id"] or values.get("version") != spec["version"]:
        raise ProvisionError("CONNECTOR_PACKAGE_CONTENT_INVALID", "package id or version")
    if values.get("authors") != "Singularity":
        raise ProvisionError("CONNECTOR_PACKAGE_CONTENT_INVALID", "package authors")
    if package_type != "RepoQLConnector":
        raise ProvisionError("CONNECTOR_PACKAGE_CONTENT_INVALID", "package type")


def inspect_package(path: Path, spec: dict, root: Path = ROOT) -> dict:
    """Verify the pinned bytes and the source-derived contents of one package."""
    if not path.is_file():
        raise ProvisionError("CONNECTOR_PACKAGE_MISSING", path.name)
    size = path.stat().st_size
    digest = _sha256(path)
    if size != spec["bytes"] or digest != spec["sha256"]:
        raise ProvisionError("CONNECTOR_PACKAGE_HASH_DRIFT",
                             f"{path.name}: expected {spec['sha256']} ({spec['bytes']} bytes), got {digest} ({size} bytes)")
    entries = _zip_entries(path)
    source = _under(root, spec["source"], "CONNECTOR_SOURCE_MISSING")
    for relative in ("manifest.yaml", "README.md"):
        packaged = entries.get(f"connector/{relative}")
        if packaged is None or packaged != (source / relative).read_bytes():
            raise ProvisionError("CONNECTOR_PACKAGE_CONTENT_INVALID", relative)
    for directory in ("help", "sql"):
        for file in sorted((source / directory).rglob("*")) if (source / directory).is_dir() else []:
            if not file.is_file():
                continue
            relative = file.relative_to(source).as_posix()
            packaged = entries.get(f"connector/{relative}")
            if packaged is None or packaged != file.read_bytes():
                raise ProvisionError("CONNECTOR_PACKAGE_CONTENT_INVALID", relative)
    wasm = entries.get("connector/connector.wasm")
    if not wasm or len(wasm) < 1024 or not wasm.startswith(b"\x00asm"):
        raise ProvisionError("CONNECTOR_PACKAGE_CONTENT_INVALID", "compiled module")
    if any(name.endswith(".ts") for name in entries):
        raise ProvisionError("CONNECTOR_PACKAGE_CONTENT_INVALID", "TypeScript source in package")
    _nuspec(entries, spec)
    return {"sha256": digest, "bytes": size, "entries": len(entries), "wasmBytes": len(wasm)}


def reused_packages(lock: dict, build_root: Path, root: Path = ROOT) -> list[dict] | None:
    """Verify pinned packages already supplied as release artifacts, if all exist."""
    paths = [(spec, package_path(build_root, spec)) for spec in lock["packages"]]
    if not all(path.is_file() for _, path in paths):
        return None
    packages = []
    for spec, path in paths:
        info = inspect_package(path, spec, root)
        packages.append({
            "scheme": spec["scheme"], "id": spec["id"], "version": spec["version"],
            "package": path.name, "path": str(path), "sha256": info["sha256"],
            "bytes": info["bytes"], "entries": info["entries"], "wasmBytes": info["wasmBytes"],
            "reused": True,
            "sourceTest": {"state": "pinned-release-artifact",
                           "generations": spec.get("sourceTestGenerations", 0), "reused": True},
            "packageTest": {"state": "pinned-release-artifact",
                            "generations": spec.get("packageTestGenerations", 0), "reused": True},
        })
    return packages


def _connector_test(rql: Path, module: Path, spec: dict, root: Path,
                    runner: Callable[..., subprocess.CompletedProcess] | None = None,
                    cwd: Path | None = None, env: dict[str, str] | None = None) -> dict:
    completed = _run([rql, "connector", "test", module, "--fixtures", root / spec["suite"], "--json"],
                     cwd=cwd or root, timeout=600, runner=runner, env=env)
    if completed.returncode != 0:
        raise ProvisionError("CONNECTOR_TEST_FAILED", f"{spec['scheme']} rc={completed.returncode}")
    try:
        report = _json_output(completed.stdout)
    except (ValueError, json.JSONDecodeError):
        raise ProvisionError("CONNECTOR_TEST_FAILED", f"{spec['scheme']} did not return JSON")
    generations = report.get("generations")
    if (report.get("scheme") != spec["scheme"] or report.get("passed") is not True
            or report.get("notRun") != 0 or report.get("refusal") is not None
            or not isinstance(generations, list) or not generations):
        raise ProvisionError("CONNECTOR_TEST_FAILED", f"{spec['scheme']} fixture contract")
    return {"scheme": spec["scheme"], "passed": True, "generations": len(generations)}


def _pack(rql: Path, spec: dict, output: Path, root: Path,
          runner: Callable[..., subprocess.CompletedProcess] | None = None,
          cwd: Path | None = None, env: dict[str, str] | None = None) -> Path:
    output.mkdir(parents=True, exist_ok=True)
    completed = _run([rql, "connector", "pack", root / spec["source"] / "connector.ts",
                      "--id", spec["id"], "--version", spec["version"], "--authors", "Singularity",
                      "--out", output], cwd=cwd or root, timeout=600, runner=runner, env=env)
    if completed.returncode != 0:
        raise ProvisionError("CONNECTOR_PACK_FAILED", f"{spec['scheme']} rc={completed.returncode}")
    produced = output / spec["package"]
    if not produced.is_file():
        raise ProvisionError("CONNECTOR_PACK_FAILED", f"{spec['scheme']} produced no package")
    return produced


def _write_receipt(build_root: Path, lock: dict, rql_version: str, packages: list[dict]) -> Path:
    receipt = {
        "schema": "singularity-connector-build-receipt/v1",
        "generatedAtUtc": _now(),
        "repoqlVersion": rql_version,
        "connectorAbi": lock["connectorAbi"],
        "packages": packages,
        "reusedPinnedPackages": all(bool(item.get("reused")) for item in packages),
        "buildRoot": str(build_root),
        "releaseReady": False,
    }
    path = build_root / "connector-build-receipt.json"
    path.write_text(json.dumps(receipt, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return path


def build_connectors(rql: Path, lock: dict, build_root: Path, *, root: Path = ROOT,
                     runner: Callable[..., subprocess.CompletedProcess] | None = None) -> dict:
    """Run the real source and package tests and pack both pinned connectors."""
    rql = rql.resolve()
    root = root.resolve()
    build_root = build_root.resolve()
    try:
        build_root.relative_to(root)
    except ValueError:
        pass
    else:
        raise ProvisionError("CONNECTOR_BUILD_ROOT_INSIDE_SOURCE")
    build_root.mkdir(parents=True, exist_ok=True)
    (build_root / PACKAGE_DIR).mkdir(parents=True, exist_ok=True)
    preflight = None
    try:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from repoql_compat import preflight as repoql_preflight
        preflight = repoql_preflight(binary=str(rql), root=root, system="win32",
                                    runner=runner or subprocess.run)
    except (ImportError, OSError, subprocess.TimeoutExpired, ValueError) as exc:
        raise ProvisionError("CONNECTOR_PREFLIGHT_FAILED", type(exc).__name__)
    if not preflight or not preflight.get("ok"):
        raise ProvisionError("CONNECTOR_PREFLIGHT_FAILED",
                             "; ".join(preflight.get("errors", []) if preflight else ["preflight"]))
    packaged = reused_packages(lock, build_root, root)
    if packaged is not None:
        receipt = _write_receipt(build_root, lock, str(preflight.get("actual_version") or ""), packaged)
        return {"packages": packaged, "receipt": str(receipt), "rqlVersion": preflight.get("actual_version"),
                "reused": True}
    shot = tempfile.mkdtemp(prefix=".build-", dir=str(build_root))
    workspace = ensure_workspace(build_root)
    # Best effort: ask RepoQL not to load the operator's global agent MCP
    # servers. RepoQL 1.7.18 can still start installed bridge servers; a source
    # build waits for host readiness, so release artifacts avoid that path.
    scratch_env = {"REPOQL_MCP_INCLUDE_GLOBALS": "false"}
    packages: list[dict] = []
    try:
        for spec in lock["packages"]:
            source_test = _connector_test(rql, _under(root, spec["source"], "CONNECTOR_SOURCE_MISSING") / "connector.ts",
                                           spec, root, runner, cwd=workspace, env=scratch_env)
            produced = _pack(rql, spec, Path(shot), root, runner, cwd=workspace, env=scratch_env)
            package_test = _connector_test(rql, produced, spec, root, runner, cwd=workspace, env=scratch_env)
            try:
                info = inspect_package(produced, spec, root)
            except ProvisionError as exc:
                if exc.code == "CONNECTOR_PACKAGE_HASH_DRIFT":
                    rejected = build_root / "rejected" / f"{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}-{spec['package']}"
                    rejected.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(produced, rejected)
                    raise ProvisionError(exc.code, str(rejected))
                raise
            final = package_path(build_root, spec)
            final.parent.mkdir(parents=True, exist_ok=True)
            os.replace(produced, final)
            packages.append({
                "scheme": spec["scheme"], "id": spec["id"], "version": spec["version"],
                "package": final.name, "path": str(final), "sha256": info["sha256"],
                "bytes": info["bytes"], "entries": info["entries"], "wasmBytes": info["wasmBytes"],
                "sourceTest": source_test, "packageTest": package_test,
            })
    finally:
        stop_workspace_host(rql, workspace, runner=runner)
        shutil.rmtree(shot, ignore_errors=True)
    receipt = _write_receipt(build_root, lock, str(preflight.get("actual_version") or ""), packages)
    return {"packages": packages, "receipt": str(receipt), "rqlVersion": preflight.get("actual_version")}


def ensure_workspace(build_root: Path) -> Path:
    workspace = build_root / WORKSPACE_DIR
    marker = workspace / ".repoql"
    marker.mkdir(parents=True, exist_ok=True)
    # RepoQL treats a .repoql directory as a workspace marker only when it is
    # the initialized shape (a cache directory and the gitignore), not an empty
    # look-alike. Creating both keeps connector status/install from walking up to
    # the user's profile workspace.
    (marker / "cache").mkdir(parents=True, exist_ok=True)
    ignore = marker / ".gitignore"
    if not ignore.exists():
        ignore.write_text("*\n", encoding="utf-8")
    # This scratch workspace exists only to run RepoQL connector commands, so
    # it must not pull in the operator's global agent MCP servers.
    config = marker / "config.json"
    if not config.exists():
        config.write_text(json.dumps({"mcp": {"include_globals": False}}, indent=2) + "\n",
                          encoding="utf-8")
    return workspace


def read_inventory(rql: Path, workspace: Path,
                   runner: Callable[..., subprocess.CompletedProcess] | None = None) -> dict:
    try:
        completed = _run([rql, "connector", "status", "--json"], cwd=workspace,
                         timeout=45, runner=runner)
    except subprocess.TimeoutExpired:
        raise ProvisionError("CONNECTOR_INVENTORY_UNAVAILABLE", "timeout")
    if completed.returncode != 0:
        raise ProvisionError("CONNECTOR_INVENTORY_UNAVAILABLE", f"rc={completed.returncode}")
    try:
        payload = _json_output(completed.stdout)
    except (ValueError, json.JSONDecodeError):
        raise ProvisionError("CONNECTOR_INVENTORY_UNAVAILABLE", "not JSON")
    rows = payload.get("connectors")
    if not isinstance(rows, list):
        raise ProvisionError("CONNECTOR_INVENTORY_UNAVAILABLE", "connectors")
    inventory: dict[str, dict] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        scheme = row.get("scheme")
        if isinstance(scheme, str) and _SCHEME.fullmatch(scheme.lower()) and scheme.lower() not in inventory:
            inventory[scheme.lower()] = {
                "state": str(row.get("state") or "unknown").lower(),
                "version": str(row.get("version") or ""),
                "title": str(row.get("title") or ""),
            }
    return inventory


def connector_rows(lock: dict, build_root: Path, inventory: dict) -> list[dict]:
    rows = []
    for spec in lock["packages"]:
        installed = inventory.get(spec["scheme"])
        package = package_state(build_root, spec)
        if installed and installed["state"] == "installed" and installed["version"] == spec["version"]:
            state, action = "installed", "none"
        elif installed and installed["state"] == "installed":
            state, action = "installed_version_mismatch", "update"
        elif package["state"] != "built":
            state, action = f"package_{package['state']}", "build"
        else:
            state, action = "missing", "install"
        rows.append({
            "scheme": spec["scheme"], "title": spec["title"], "id": spec["id"],
            "version": spec["version"], "package": package["path"], "packageState": package["state"],
            "sha256": package["sha256"], "bytes": package["bytes"],
            "installed": bool(installed and installed["state"] == "installed"),
            "installedVersion": installed["version"] if installed else "",
            "registryState": installed["state"] if installed else "missing",
            "state": state, "nextAction": action,
        })
    return rows


def install_command(rql: Path, package: Path) -> list[str]:
    """The one supported consent invocation: no envelope grant flags."""
    return [str(rql), "connector", "install", str(package)]


def _looks_declined(text: str) -> bool:
    lowered = (text or "").lower()
    return any(word in lowered for word in ("declin", "denied", "cancel", "refus", "not approved", "rejected"))


def install_connectors(rql: Path, lock: dict, build_root: Path, *, root: Path = ROOT,
                       runner: Callable[..., subprocess.CompletedProcess] | None = None,
                       install_timeout: int = INSTALL_TIMEOUT_SECONDS,
                       builder: Callable[..., dict] | None = None,
                       inventory_reader: Callable[..., dict] | None = None) -> dict:
    """Build when needed, then run one consent-gated install per missing connector."""
    rql = rql.resolve()
    root = root.resolve()
    build_root = build_root.resolve()
    build_root.mkdir(parents=True, exist_ok=True)
    workspace = ensure_workspace(build_root)
    inventory_reader = inventory_reader or read_inventory
    inventory = inventory_reader(rql, workspace, runner=runner)
    rows = connector_rows(lock, build_root, inventory)
    missing = [row for row in rows if row["state"] != "installed"]
    build = None
    if missing:
        builder = builder or build_connectors
        build = builder(rql, lock, build_root, root=root, runner=runner)
        by_scheme = {item["scheme"]: item for item in build.get("packages", [])}
        for row in rows:
            if row["state"] != "installed":
                item = by_scheme.get(row["scheme"])
                if not item:
                    raise ProvisionError("CONNECTOR_PACKAGE_MISSING", row["scheme"])
                row["package"] = item["path"]
                row["sha256"] = item["sha256"]
                row["bytes"] = item["bytes"]
                row["packageState"] = "built"
                row["state"] = "missing"
                row["nextAction"] = "install"
    blocked = False
    for row in rows:
        if row["state"] == "installed":
            continue
        if blocked:
            row["state"] = "not_attempted"
            row["nextAction"] = "install"
            continue
        command = install_command(rql, Path(row["package"]))
        completed = None
        try:
            completed = _run(command, cwd=workspace, timeout=install_timeout, runner=runner)
        except subprocess.TimeoutExpired:
            row["state"] = "waiting_for_consent"
            row["nextAction"] = "approve_install"
            row["detail"] = "approval window timed out"
            blocked = True
            continue
        after = inventory_reader(rql, workspace, runner=runner)
        installed = after.get(row["scheme"])
        if installed and installed["state"] == "installed" and installed["version"] == row["version"]:
            row["state"] = "installed"
            row["nextAction"] = "none"
            row["installed"] = True
            row["installedVersion"] = installed["version"]
            row["registryState"] = installed["state"]
        elif completed.returncode != 0 and _looks_declined((completed.stdout or "") + "\n" + (completed.stderr or "")):
            row["state"] = "declined"
            row["nextAction"] = "rerun_install"
            row["detail"] = "operator declined the consent page"
            blocked = True
        elif completed.returncode != 0:
            row["state"] = "failed"
            row["nextAction"] = "rerun_install"
            row["detail"] = f"install rc={completed.returncode}"
            blocked = True
        else:
            row["state"] = "waiting_for_consent"
            row["nextAction"] = "approve_install"
            row["detail"] = "install returned without a registered connector"
            blocked = True
    all_installed = all(row["state"] == "installed" for row in rows)
    return {
        "packages": rows,
        "build": build,
        "allInstalled": all_installed,
        "awaitingConsent": any(row["state"] == "waiting_for_consent" for row in rows),
        "installCommands": [install_command(rql, Path(row["package"])) for row in rows if row["state"] != "installed"],
    }


def stop_workspace_host(rql: Path, workspace: Path,
                        runner: Callable[..., subprocess.CompletedProcess] | None = None) -> bool:
    """Best-effort stop for the scratch host started by connector status/install."""
    try:
        completed = _run([rql, "host", "stop"], cwd=workspace, timeout=30, runner=runner)
    except (OSError, subprocess.SubprocessError):
        return False
    return completed.returncode == 0


def report(action: str, lock: dict, build_root: Path, rows: list[dict], **extra: Any) -> dict:
    data = {
        "schema": REPORT_SCHEMA,
        "action": action,
        "generatedAtUtc": _now(),
        "repoqlVersion": lock["repoqlVersion"],
        "connectorAbi": lock["connectorAbi"],
        "buildRoot": str(build_root),
        "connectors": rows,
        "allInstalled": all(row["state"] == "installed" for row in rows),
        "awaitingConsent": any(row["state"] == "waiting_for_consent" for row in rows),
        "releaseReady": False,
    }
    data.update(extra)
    return data


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build and provision the bundled RepoQL connectors")
    parser.add_argument("--action", required=True, choices=("status", "build", "install"))
    parser.add_argument("--rql-exe", required=True, type=Path)
    parser.add_argument("--build-root", type=Path)
    parser.add_argument("--install-timeout", type=int, default=INSTALL_TIMEOUT_SECONDS)
    args = parser.parse_args(argv)
    if os.name != "nt":
        print(json.dumps({"schema": REPORT_SCHEMA, "action": args.action, "ok": False,
                          "error": "NATIVE_WINDOWS_REQUIRED"}, indent=2))
        return 2
    if not args.rql_exe.is_absolute() or not args.rql_exe.is_file():
        print(json.dumps({"schema": REPORT_SCHEMA, "action": args.action, "ok": False,
                          "error": "CONNECTOR_RQL_NOT_FOUND"}, indent=2))
        return 2
    build_root = (args.build_root or (Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "Singularity" / "connectors")).resolve()
    workspace = None
    try:
        lock = load_lock()
        if args.action in {"status", "install"}:
            workspace = ensure_workspace(build_root)
        if args.action == "status":
            inventory = read_inventory(args.rql_exe.resolve(), workspace)
            data = report("status", lock, build_root, connector_rows(lock, build_root, inventory))
            data["ok"] = True
            print(json.dumps(data, indent=2, ensure_ascii=False))
            return 0
        if args.action == "build":
            build = build_connectors(args.rql_exe, lock, build_root)
            # A build report must not depend on the host inventory; use the
            # package state alone so a release-artifact verification stays
            # offline and deterministic.
            rows = connector_rows(lock, build_root, {})
            data = report("build", lock, build_root, rows, packageBuild=build)
            data["ok"] = True
            print(json.dumps(data, indent=2, ensure_ascii=False))
            return 0
        install = install_connectors(args.rql_exe, lock, build_root, install_timeout=max(60, args.install_timeout))
        data = report("install", lock, build_root, install["packages"])
        data["packageBuild"] = install.get("build")
        data["installCommands"] = [{"scheme": row["scheme"], "command": command}
                                   for row, command in zip([r for r in install["packages"] if r["state"] != "installed"],
                                                           install.get("installCommands", []))]
        data["ok"] = install["allInstalled"]
        print(json.dumps(data, indent=2, ensure_ascii=False))
        return 0 if install["allInstalled"] else 1
    except ProvisionError as exc:
        print(json.dumps({"schema": REPORT_SCHEMA, "action": args.action, "ok": False,
                          "error": exc.code, "detail": exc.detail}, indent=2, ensure_ascii=False))
        return 2
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as exc:
        print(json.dumps({"schema": REPORT_SCHEMA, "action": args.action, "ok": False,
                          "error": "CONNECTOR_PROVISION_FAILED", "detail": type(exc).__name__},
                         indent=2, ensure_ascii=False))
        return 2
    finally:
        if workspace is not None:
            stop_workspace_host(args.rql_exe.resolve(), workspace)


if __name__ == "__main__":
    raise SystemExit(main())
