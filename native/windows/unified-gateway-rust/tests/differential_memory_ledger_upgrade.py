#!/usr/bin/env python3
"""700 deterministic offline upgrade cases, with optional compiled Rust parity.

Without --rust-cli these are Python reference checks only, not Rust tests.
"""
import argparse
import json
from pathlib import Path
import random
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "native" / "windows"))
from memory_ledger_upgrade_audit import SCHEMA, project_reference

FIELDS = ("root_authorized", "source_exists", "active", "hash_equal",
          "indexed", "verified", "chunks_complete", "newer_unresolved")


def cases():
    good = dict.fromkeys(FIELDS, True)
    good["newer_unresolved"] = False
    yield []
    yield [good]
    yield [{**good, "hash_equal": False}]
    yield [{**good, "newer_unresolved": True}]
    rng = random.Random(20261143)
    for _ in range(696):
        rows = []
        for _ in range(rng.randrange(0, 60)):
            rows.append({k: bool(rng.getrandbits(1)) for k in FIELDS})
        yield rows


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--rust-cli", type=Path)
    args = parser.parse_args()
    if args.rust_cli and not args.rust_cli.is_file():
        parser.error("compiled native Rust CLI not found")
    n = 0
    for rows in cases():
        expected = project_reference(rows)
        assert expected["checked"] == len(rows)
        assert expected["ready"] == (bool(rows) and not expected["failures"])
        for failure in expected["failures"]:
            assert 0 <= failure["index"] < len(rows)
        if args.rust_cli:
            request = {"schema": SCHEMA, "documents": rows}
            p = subprocess.run([str(args.rust_cli)], input=json.dumps(request),
                               capture_output=True, text=True, timeout=15, shell=False)
            if p.returncode != (0 if expected["ready"] else 2):
                raise AssertionError(f"wrong native exit code on case {n}")
            if json.loads(p.stdout) != expected:
                raise AssertionError(f"native projection mismatch on case {n}")
        n += 1
    assert n == 700
    if args.rust_cli:
        bad = [
            {"schema": SCHEMA, "documents": [{**dict.fromkeys(FIELDS, True), "path": "SECRET"}]},
            {"schema": SCHEMA, "documents": [{k: 1 for k in FIELDS}]},
            {"schema": SCHEMA, "documents": "bad"},
            {"schema": "wrong-schema", "documents": []},
        ]
        for request in bad:
            p = subprocess.run([str(args.rust_cli)], input=json.dumps(request),
                               capture_output=True, text=True, timeout=15, shell=False)
            assert p.returncode not in (0, 2)
            assert "SECRET" not in p.stdout + p.stderr
    label = "COMPILED_PARITY" if args.rust_cli else "REFERENCE_ONLY"
    print(f"MEMORY_LEDGER_UPGRADE_{label}: {n} cases")


if __name__ == "__main__":
    main()
