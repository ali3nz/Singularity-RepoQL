#!/usr/bin/env python3
"""Read-only release gate for committed Rust dependency resolution.

Does not download crates, generate Cargo.lock, compile or verify publisher trust.
It separates an acceptance build (possibly using floating dependencies) from a
release-eligible source revision with explicit reviewable dependency locks.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import sys
import tomllib

ROOT = Path(__file__).resolve().parents[2]
CRATES = (
    ('native/desktop-bridge', 'singularity-desktop-bridge'),
    ('native/windows/rust-supervisor', 'singularity-windows-supervisor'),
    ('native/windows/unified-gateway-rust', 'unified-repoql-control'),
)
_SHA = re.compile(r'^[a-f0-9]{64}$')


def inspect(root: Path) -> dict:
    rows=[]
    for rel, name in CRATES:
        crate = root / rel
        cargo = crate / 'Cargo.toml'
        lock = crate / 'Cargo.lock'
        record = {'crate': rel, 'manifestPresent': cargo.is_file(),
                  'lockfilePresent': lock.is_file(), 'lockfileValid': False}
        if not cargo.is_file() or not lock.is_file() or cargo.is_symlink() or lock.is_symlink():
            rows.append(record)
            continue
        try:
            manifest = tomllib.loads(cargo.read_text(encoding='utf-8'))
            obj = tomllib.loads(lock.read_text(encoding='utf-8'))
        except (OSError, UnicodeError, tomllib.TOMLDecodeError):
            rows.append(record)
            continue
        packages = obj.get('package')
        if (manifest.get('package', {}).get('name') != name or
                obj.get('version') not in (3, 4) or not isinstance(packages, list) or not packages):
            rows.append(record)
            continue
        root_package = [p for p in packages if isinstance(p, dict) and p.get('name') == name
                        and p.get('version') == manifest['package'].get('version')]
        valid = len(root_package) == 1
        identities=set()
        registry_count=0
        for p in packages:
            if not isinstance(p, dict):
                valid=False
                break
            ident=(p.get('name'),p.get('version'),p.get('source',''))
            if not all(isinstance(v,str) and v for v in ident[:2]) or ident in identities:
                valid=False
                break
            identities.add(ident)
            source=p.get('source')
            if source is not None:
                if not isinstance(source,str) or not source.startswith('registry+') or not _SHA.fullmatch(str(p.get('checksum',''))):
                    valid=False
                    break
                registry_count+=1
        # Missing registry entries for these dependency-bearing crates means
        # the dependency resolution was not captured properly.
        if not registry_count:
            valid=False
        record.update({'lockfileValid':valid, 'resolvedPackages':len(packages),
                       'registryPackagesWithChecksums':registry_count,
                       'sha256':hashlib.sha256(lock.read_bytes()).hexdigest()})
        rows.append(record)
    return {'schema':'singularity-rust-lock-release-gate/v1','checks':rows,
            'readyForRustDependencyReview':all(x['lockfileValid'] for x in rows),
            'nativeWindowsBuildVerified':False,'publisherProvenanceVerified':False,
            'releaseReady':False}


def main(argv=None):
    p=argparse.ArgumentParser()
    p.add_argument('--source-root',type=Path,default=ROOT)
    p.add_argument('--output',type=Path)
    args=p.parse_args(argv)
    result=inspect(args.source_root)
    data=json.dumps(result,indent=2)+'\n'
    if args.output:args.output.write_text(data,encoding='utf-8')
    else:print(data,end='')
    return 0 if result['readyForRustDependencyReview'] else 2


if __name__=='__main__':sys.exit(main())
