"""Source-only differential gate. Run after Rust and legacy builders independently run.

Input paths must be prebuilt ZIPs. This script never extracts or writes source.
Checks member inventory, payload bytes and the semantic fields of each manifest.
"""
import argparse
import hashlib
import json
import zipfile


def compare(old, new):
    with zipfile.ZipFile(old) as o, zipfile.ZipFile(new) as n:
        names_o = set(o.namelist())
        names_n = set(n.namelist())
        assert names_o == names_n, f"different member inventory: {sorted(names_o ^ names_n)[:15]}"
        excluded = {"NATIVE_WINDOWS_SOURCE_MANIFEST.json"}
        for member in sorted(names_o - excluded):
            assert hashlib.sha256(o.read(member)).digest() == hashlib.sha256(n.read(member)).digest(), f"member content differs: {member}"
        a = json.loads(o.read("NATIVE_WINDOWS_SOURCE_MANIFEST.json"))
        b = json.loads(n.read("NATIVE_WINDOWS_SOURCE_MANIFEST.json"))
        assert a == b, "semantic manifest differs"
        return {"ok": True, "members": len(names_o), "variant": a["variant"]}


def main():
    p = argparse.ArgumentParser()
    p.add_argument("legacy")
    p.add_argument("rust")
    args = p.parse_args()
    print(json.dumps(compare(args.legacy, args.rust)))

if __name__ == "__main__":
    main()
