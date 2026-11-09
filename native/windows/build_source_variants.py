#!/usr/bin/env python3
"""Deterministic SOURCE REVIEW archives for four native Windows variants.

Not a Windows installer: no binaries, credentials, services or GUI changes.
The same authoritative Node component classifier used by the legacy product
selects files. Rust bridge builds are a separate Windows CI acceptance gate.
"""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[2]
ZIP_DATE = (2026, 1, 1, 0, 0, 0)

from windows_source_policy import (
    linux_deployment_asset,
    windows_ghost_source,
    windows_office_source,
    windows_variant_excludes,
)


def _node_executable():
    """Return the Node executable, or skip cleanly when the toolchain is absent.

    The source archives are built, not read from a checked-in artifact, so a
    machine without Node cannot run the source-variant tests at all. Skipping
    (instead of failing with FileNotFoundError) keeps full discovery honest on
    such a machine while leaving behaviour unchanged wherever node exists.
    """
    node = shutil.which("node")
    if node:
        return node
    raise unittest.SkipTest(
        "release source artifacts cannot be built: Node.js is not on PATH "
        "('node' not found); install Node.js or run this test where node is available"
    )


def component_files():
    js = """import {walkShippedFiles,partitionBundleFiles} from './scripts/bundle-classification.mjs';
      console.log(JSON.stringify(partitionBundleFiles(walkShippedFiles(process.cwd()))));"""
    out = subprocess.run([_node_executable(), "--input-type=module", "--eval", js], cwd=ROOT,
                         capture_output=True, text=True, check=True, timeout=30)
    return json.loads(out.stdout)


def build(variant: int, output: Path):
    policy = json.loads((ROOT/"native/windows/variants.json").read_text(encoding="utf-8"))
    if str(variant) not in policy["variants"]:
        raise ValueError("variant must be 1 through 4")
    parts = component_files()
    if parts["unclassified"]:
        raise ValueError("unclassified source cannot enter release source archive: " + ", ".join(parts["unclassified"][:8]))
    office_enabled = variant in (2, 4)
    features = policy["variants"][str(variant)]["features"]
    if features.get("ghost") is not False:
        raise ValueError("Ghost must be disabled in every native Windows source variant")
    if features.get("office") is not office_enabled:
        raise ValueError("Office must be enabled only in options 2 and 4")
    selected = set(parts["core"] + parts["dashboard"] + (parts["office"] if office_enabled else [])) - {"SHA256SUMS"}
    paths = sorted(name for name in selected
                   if not linux_deployment_asset(name)
                   and not windows_variant_excludes(name, variant))
    if any(windows_ghost_source(name) for name in paths):
        raise ValueError("Ghost source leaked into native Windows archive")
    if not paths:
        raise ValueError("empty source set")
    if not office_enabled:
        assert not any(windows_office_source(name) for name in paths)
    output.parent.mkdir(parents=True,exist_ok=True)
    receipts = []
    with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=7) as dest:
        for name in paths:
            file=ROOT/name
            if file.is_symlink():
                raise ValueError('source symlink refused: '+name)
            data=file.read_bytes()
            receipts.append({'path':name,'sha256':hashlib.sha256(data).hexdigest(),'bytes':len(data)})
            info=zipfile.ZipInfo(name, ZIP_DATE)
            info.compress_type=zipfile.ZIP_DEFLATED
            info.external_attr=(0o644<<16)
            dest.writestr(info,data,compress_type=zipfile.ZIP_DEFLATED,compresslevel=7)
        # Release-specific SHA256SUMS cannot list excluded Ghost/Office files.
        checksums=''.join(f"{x['sha256']}  {x['path']}\n" for x in receipts)
        scoped_sha=zipfile.ZipInfo('SHA256SUMS',ZIP_DATE)
        scoped_sha.compress_type=zipfile.ZIP_DEFLATED
        dest.writestr(scoped_sha,checksums)
        receipts.append({'path':'SHA256SUMS','sha256':hashlib.sha256(checksums.encode()).hexdigest(),'bytes':len(checksums.encode())})
        manifest={
            'schema':1,'product':'Singularity RepoQL native Windows SOURCE review',
            'variant':variant,'gui':policy['variants'][str(variant)]['gui'],
            'features':policy['variants'][str(variant)]['features'],
            'rustOfficeFeature':office_enabled,
            'rustGhostFeature':False,
            'repoql':policy['repoql'],
            'release_status':'SOURCE_ONLY_UNCOMPILED_NOT_INSTALLER',
            'no_wsl_required_for_intended_runtime':'UNVERIFIED_NATIVE_ACCEPTANCE_REQUIRED',
            'production_feature_parity':'UNVERIFIED',
            'linux_deployment_assets_excluded':True,
            'acceptance':'NOT_RUN_ON_NATIVE_WINDOWS',
            'files':receipts,
        }
        info=zipfile.ZipInfo('NATIVE_WINDOWS_SOURCE_MANIFEST.json', ZIP_DATE)
        info.compress_type=zipfile.ZIP_DEFLATED
        dest.writestr(info,json.dumps(manifest,indent=2)+'\n')
    from scan_source_archive import scan
    result = scan(output)
    if not result['ok']:
        raise ValueError('source archive release scanner rejected build: ' + ', '.join(result['issues']))
    return {'variant':variant,'name':output.name,'bytes':output.stat().st_size,'file_count':len(paths),
            'sha256':hashlib.sha256(output.read_bytes()).hexdigest()}


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--output-dir',required=True,type=Path)
    parser.add_argument('--variant',type=int,choices=[1,2,3,4],help='one variant; default all four')
    args=parser.parse_args()
    outputs=[build(i,args.output_dir/f'singularity-native-windows-option{i}-SOURCE-ONLY.zip') for i in ([args.variant] if args.variant else [1,2,3,4])]
    print(json.dumps({'release_status':'NOT_READY','outputs':outputs},indent=2))

if __name__=='__main__':
    try:
        main()
    except unittest.SkipTest as exc:
        # Same condition as the tests, but a CLI must fail with a message, not a traceback.
        sys.exit('build_source_variants: ' + str(exc))
