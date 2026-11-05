#!/usr/bin/env python3
"""Write lifecycle-part.json: the first N generations of lifecycle.json, for reading a mid-suite workspace."""
import json, pathlib, sys

root = pathlib.Path(__file__).resolve().parent.parent
suite = json.loads((root / "lifecycle.json").read_text())
n = int(sys.argv[1]) if len(sys.argv) > 1 else 2
suite["generations"] = suite["generations"][:n]
out = root / f"lifecycle-part-{n}.json"
out.write_text(json.dumps(suite, indent=2, ensure_ascii=False) + "\n")
print("wrote", out.name)
