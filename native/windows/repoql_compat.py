#!/usr/bin/env python3
"""Fail-closed native RepoQL 1.7.18 connector-contract preflight.

This checks an externally installed binary and both bundled connector
manifests. It does not package, install, or import a connector.
"""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

REQUIRED_VERSION = "1.7.18"
REQUIRED_CONNECTOR_CONTRACT = "fetch-render"
REQUIRED_CALLS = ("parse", "fetch", "render")
MANIFESTS = {
    "connectors/kanzo/manifest.yaml": "kanzo",
    "connectors/memorycore/manifest.yaml": "memorycore",
}
ROOT = Path(__file__).resolve().parents[2]
VERSION_LINE = re.compile(r"(?i)\b(?:repoql|rql)\b[^\r\n]{0,64}?\bv?(\d+\.\d+\.\d+)")
TOP_LEVEL = re.compile(r"^([A-Za-z][A-Za-z0-9]*):(?:[ \t]*(.*))?$")
ALLOWED_TOP_LEVEL = {
    "scheme", "title", "summary", "calls", "recordsVersion", "uri", "partitioned",
    "embedding", "network", "secrets", "functions", "events", "settings", "source",
    "inference", "fetchIntervalSeconds", "fullFetchIntervalSeconds", "retentionDays",
    "maxValueBytes", "memoryMiB", "workspaceMiB",
}


def parse_version(text: str) -> str | None:
    """Accept a bare CLI version or one unambiguous RepoQL banner."""
    output = str(text).strip()
    bare = re.fullmatch(r"v?(\d+\.\d+\.\d+)", output, re.IGNORECASE)
    if bare:
        return bare.group(1)
    if any(re.fullmatch(r"v?\d+\.\d+\.\d+", line.strip(), re.IGNORECASE)
           for line in output.splitlines()):
        return None
    versions = {match.group(1) for match in VERSION_LINE.finditer(output)}
    return next(iter(versions)) if len(versions) == 1 else None


def _scalar(value: str) -> str:
    value = value.split("#", 1)[0].strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        return value[1:-1]
    return value


def manifest_contract(path: Path, expected_scheme: str | None = None) -> tuple[dict | None, list[str]]:
    """Read the top-level contract fields and reject stale or ambiguous manifests.

    RepoQL's own parser remains authoritative for full YAML validity; native
    connector test/pack commands run that parser before release. This gate
    independently fails closed on duplicate/unknown top-level fields, an ABI
    key from the retired manifest shape, and an incomplete fetch/render set.
    """
    errors: list[str] = []
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return None, ["manifest is missing or unreadable"]

    fields: dict[str, str] = {}
    for number, line in enumerate(text.splitlines(), start=1):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if re.match(r"^abi\s*:", stripped, re.IGNORECASE):
            errors.append(f"line {number}: obsolete ABI field is not part of the 1.7.18 connector contract")
            continue
        if line[:1].isspace():
            continue
        match = TOP_LEVEL.fullmatch(line)
        if match is None:
            errors.append(f"line {number}: malformed top-level manifest entry")
            continue
        key, value = match.groups()
        if key in fields:
            errors.append(f"line {number}: duplicate top-level field {key}")
            continue
        if key not in ALLOWED_TOP_LEVEL:
            errors.append(f"line {number}: unknown top-level field {key}")
            continue
        fields[key] = (value or "").strip()

    required = ("scheme", "title", "summary", "calls", "recordsVersion", "fetchIntervalSeconds", "fullFetchIntervalSeconds")
    for key in required:
        if key not in fields or not _scalar(fields.get(key, "")):
            errors.append(f"required top-level field {key} is missing or empty")

    scheme = _scalar(fields.get("scheme", ""))
    if expected_scheme and scheme != expected_scheme:
        errors.append(f"scheme must be {expected_scheme}")

    calls: tuple[str, ...] = ()
    calls_text = fields.get("calls", "")
    match = re.fullmatch(r"\[\s*([^\[\]]*)\s*\]\s*(?:#.*)?", calls_text)
    if match is None:
        errors.append("calls must be one inline list of parse, fetch, render")
    else:
        calls = tuple(_scalar(item.strip()) for item in match.group(1).split(",") if item.strip())
        if calls != REQUIRED_CALLS:
            errors.append("calls must be exactly [parse, fetch, render]")

    numbers: dict[str, int] = {}
    for key in ("recordsVersion", "fetchIntervalSeconds", "fullFetchIntervalSeconds"):
        if key not in fields:
            continue
        try:
            raw = _scalar(fields[key])
            if not re.fullmatch(r"\d+", raw):
                raise ValueError
            numbers[key] = int(raw)
        except ValueError:
            errors.append(f"{key} must be a positive integer")
    if "recordsVersion" in numbers and numbers["recordsVersion"] < 1:
        errors.append("recordsVersion must be positive")
    fetch = numbers.get("fetchIntervalSeconds")
    full = numbers.get("fullFetchIntervalSeconds")
    if fetch is not None and not 60 <= fetch <= 86_400:
        errors.append("fetchIntervalSeconds is outside the supported range")
    if full is not None and not 60 <= full <= 2_592_000:
        errors.append("fullFetchIntervalSeconds is outside the supported range")
    if fetch is not None and full is not None and full != fetch:
        errors.append("fullFetchIntervalSeconds must equal fetchIntervalSeconds for these full-list connectors")
    if "maxValueBytes" in fields:
        try:
            max_value = int(_scalar(fields["maxValueBytes"]))
            if not 16_384 <= max_value <= 131_072:
                raise ValueError
        except ValueError:
            errors.append("maxValueBytes is outside the supported range")

    if errors:
        return None, errors
    return {
        "scheme": scheme,
        "calls": list(calls),
        "records_version": numbers["recordsVersion"],
        "fetch_interval_seconds": fetch,
        "full_fetch_interval_seconds": full,
        "obsolete_abi_present": False,
    }, []


def preflight(*, binary: str | None = None, root: Path = ROOT, runner=subprocess.run,
              system: str | None = None, rust_binary: Path | None = None) -> dict:
    system = system or sys.platform
    windows = system == "win32"
    chosen = binary or os.environ.get("SINGULARITY_RQL_EXE") or shutil.which("rql.exe" if windows else "rql")
    report = {
        "ok": False,
        "required_version": REQUIRED_VERSION,
        "required_connector_contract": REQUIRED_CONNECTOR_CONTRACT,
        "binary": str(chosen) if chosen else None,
        "actual_version": None,
        "manifests": {},
        "errors": [],
        "native_windows": windows,
    }
    for rel, expected_scheme in MANIFESTS.items():
        contract, errors = manifest_contract(root / rel, expected_scheme)
        report["manifests"][rel] = contract
        for error in errors:
            report["errors"].append(f"{rel}: {error}")
    if not chosen:
        report["errors"].append("no rql executable found; provide SINGULARITY_RQL_EXE pointing to native RepoQL 1.7.18")
        return report
    if windows and Path(chosen).suffix.lower() != ".exe":
        report["errors"].append("Windows requires a native rql.exe, not a WSL/Linux shell script")
        return report
    try:
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if windows else 0
        completed = runner([chosen, "--version"], capture_output=True, text=True,
                           timeout=10, check=False, creationflags=flags)
    except (OSError, subprocess.TimeoutExpired, ValueError) as error:
        report["errors"].append(f"unable to execute RepoQL version check: {type(error).__name__}")
        return report
    if completed.returncode != 0:
        report["errors"].append("RepoQL version check failed; no connectors were installed")
        return report
    actual = parse_version(completed.stdout)
    report["actual_version"] = actual
    if actual != REQUIRED_VERSION:
        report["errors"].append(f"unsupported RepoQL version {actual or 'unknown'}: pinned to {REQUIRED_VERSION}; connector installation BLOCKED")
    # Optional native Rust check is an additional mandatory verdict, not a
    # substitute for this live source and installed-binary verification.
    # The Rust binary bundles reviewed connector manifests at compile time;
    # Python also checks the current project source to catch drift.
    if rust_binary is not None and not report["errors"]:
        native = Path(rust_binary)
        if not windows or not native.is_absolute() or not native.is_file() or native.is_symlink():
            report["errors"].append("native Rust RepoQL preflight binary is unverified")
        else:
            try:
                native_result = subprocess.run(
                    [str(native), "repoql-preflight", "--rql", str(chosen)],
                    capture_output=True, text=True, timeout=14, check=False,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                )
                native_json = json.loads(native_result.stdout)
                expected_true = ("ok", "kanzo_contract_compatible",
                                 "memorycore_contract_compatible", "native_binary",
                                 "connector_installation_allowed")
                passed = (native_result.returncode == 0 and isinstance(native_json, dict)
                          and all(native_json.get(key) is True for key in expected_true)
                          and native_json.get("required_version") == REQUIRED_VERSION
                          and native_json.get("actual_version") == actual
                          and native_json.get("required_connector_contract") == REQUIRED_CONNECTOR_CONTRACT)
            except (OSError, subprocess.TimeoutExpired, ValueError, UnicodeError):
                passed = False
            if not passed:
                report["errors"].append("native Rust RepoQL preflight failed; connector installation blocked")
    report["ok"] = not report["errors"]
    return report


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Read-only native RepoQL 1.7.18 connector preflight")
    parser.add_argument("--rql", default=None, help="Path to externally installed rql.exe")
    parser.add_argument("--rust-binary", type=Path, help="opt-in compiled native desktop bridge RepoQL preflight")
    args = parser.parse_args(argv)
    result = preflight(binary=args.rql, rust_binary=args.rust_binary)
    print(json.dumps(result, indent=2))
    return 0 if result["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
