#!/usr/bin/env python3
"""Deterministic SOURCE REVIEW archives for one full Claude Code Windows profile.

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
    windows_retired_source,
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
    if variant != 2 or str(variant) not in policy["variants"]:
        raise ValueError("only Claude Code Full is supported")
    parts = component_files()
    if parts["unclassified"]:
        raise ValueError("unclassified source cannot enter release source archive: " + ", ".join(parts["unclassified"][:8]))
    office_enabled = True
    features = policy["variants"][str(variant)]["features"]
    required_features = ("office", "repoql_dashboard", "tencent_connector", "kanzo", "openmausbot", "memory", "repoql_mcp")
    if any(features.get(key) is not True for key in required_features) or features.get('ghost') is not False:
        raise ValueError("Full Claude Code feature policy incomplete")
    selected = set(parts["core"] + parts["dashboard"] + (parts["office"] if office_enabled else [])) - {"SHA256SUMS"}
    paths = sorted(name for name in selected
                   if not linux_deployment_asset(name)
                   and not windows_variant_excludes(name, variant))
    if any(windows_retired_source(name) for name in paths):
        raise ValueError("Retired source leaked into native Windows archive")
    if not paths:
        raise ValueError("empty source set")
    required_paths = ("native/windows/openmausbot/", "connectors/kanzo/", "connectors/memorycore/", "dashboard/", "office/", "adapters/claude-code/")
    for prefix in required_paths:
        if not any(name.startswith(prefix) for name in paths):
            raise ValueError("Full Claude Code component missing: " + prefix)
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
        # Release-specific SHA256SUMS lists only the full supported Windows source.
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



def build_with_rust(binary: Path, output_dir: Path, variant: int | None = None):
    """Opt-in native builder, independently checked by the existing scanner.

    This is never selected implicitly by the installer or a host environment.
    No previously published output is overwritten. Use only AFTER compiled
    Rust parity has been independently established on the target machine.
    """
    if not binary.is_absolute() or not binary.is_file():
        raise ValueError('Rust packager binary must be an existing absolute file')
    if output_dir.exists() and any(output_dir.iterdir()):
        raise ValueError('Rust output directory must be empty (no overwrite)')
    output_dir.mkdir(parents=True, exist_ok=True)
    argv = [str(binary), 'build', str(ROOT), str(output_dir)]
    if variant is not None:
        argv.append(str(variant))
    process = subprocess.run(argv, capture_output=True, text=True, timeout=180, check=False)
    if process.returncode:
        raise ValueError(f'Rust packager failed rc={process.returncode}: {process.stderr[:200]}')
    try:
        result = json.loads(process.stdout)
    except json.JSONDecodeError as exc:
        raise ValueError('Rust packager returned invalid JSON') from exc
    expected = [2]
    outputs = result.get('outputs') if isinstance(result, dict) else None
    if not isinstance(result, dict) or result.get('release_status') != 'NOT_READY' or not isinstance(outputs, list) or len(outputs) != len(expected):
        raise ValueError('Rust packager returned an unexpected release manifest')
    from scan_source_archive import scan
    seen = set()
    for row in outputs:
        if not isinstance(row, dict) or type(row.get('variant')) is not int or row['variant'] not in expected:
            raise ValueError('Rust packager returned an unexpected variant')
        v = row['variant']
        if v in seen:
            raise ValueError('Rust packager returned a duplicate variant')
        seen.add(v)
        name = f'singularity-native-windows-option{v}-SOURCE-ONLY.zip'
        if row.get('name') != name:
            raise ValueError('Rust packager returned an unexpected archive name')
        zip_path = output_dir / name
        if not zip_path.is_file() or zip_path.is_symlink():
            raise ValueError('Rust source archive missing or is a symlink')
        raw = zip_path.read_bytes()
        if row.get('bytes') != len(raw) or row.get('sha256') != hashlib.sha256(raw).hexdigest():
            raise ValueError('Rust source archive digest or size mismatch')
        receipt = scan(zip_path)
        if not receipt['ok']:
            raise ValueError('Rust source archive failed original release scanner: ' + ', '.join(receipt['issues']))
    if seen != set(expected):
        raise ValueError('Rust packager omitted a requested variant')
    return result


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--output-dir',required=True,type=Path)
    parser.add_argument('--variant',type=int,choices=[2],help='legacy receipt identity, always 2')
    parser.add_argument('--rust-binary', type=Path,
                        help='explicit opt-in compiled Rust source packager; still scanned and not a Windows installer')
    args=parser.parse_args()
    if args.rust_binary is not None:
        result = build_with_rust(args.rust_binary, args.output_dir, args.variant)
        print(json.dumps(result, indent=2))
        return
    outputs=[build(2,args.output_dir/'singularity-native-windows-option2-SOURCE-ONLY.zip')]
    print(json.dumps({'release_status':'NOT_READY','outputs':outputs},indent=2))

if __name__=='__main__':
    try:
        main()
    except unittest.SkipTest as exc:
        # Same condition as the tests, but a CLI must fail with a message, not a traceback.
        sys.exit('build_source_variants: ' + str(exc))
