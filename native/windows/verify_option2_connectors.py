#!/usr/bin/env python3
"""Read-only actual installed RepoQL connector check for Claude Code Complete.

Presence of packaged TS/manifest files proves neither registration nor a fresh
sweep. This checks the pinned executable and real connector/import registry.
It never installs/imports, prints local namespaces or echoes subprocess errors.
"""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'dashboard'))
from repoql_bridge import Config, RepoQL
from repoql_connectors import connector_inventory
from native.windows.repoql_compat import preflight
from rust_readonly_bridge import run_checked, RustReadOnlyBridgeError

NEEDED=('kanzo','memorycore')


def evaluate(inventory: dict) -> dict:
    items=inventory.get('connectors',[]) if inventory.get('available') else []
    rows=[]
    for scheme in NEEDED:
        matches=[x for x in items if x.get('id')==scheme]
        rows.append({'scheme':scheme, 'unique':len(matches)==1,
                     'active':len(matches)==1 and matches[0].get('active') is True,
                     'state':matches[0].get('status','unknown') if len(matches)==1 else 'missing_or_ambiguous'})
    complete = inventory.get('truncated') is False
    return {'schema':'singularity-option2-repoql-connectors/v1',
            'registryComplete': complete,
            'inventoryAvailable':inventory.get('available') is True,
            'connectorChecks':rows,
            'bothConnectorsActive':inventory.get('available') is True and complete and all(x['active'] for x in rows),
            'liveMcpCallsVerified':False, 'releaseReady':False}


def main(argv=None):
    ap=argparse.ArgumentParser()
    ap.add_argument('--rql-exe',required=True,type=Path)
    ap.add_argument('--workspace',required=True,type=Path)
    ap.add_argument('--rust-binary',type=Path,help='opt-in Rust inventory assessment; Python still collects live evidence')
    a=ap.parse_args(argv)
    if os.name!='nt' or not a.rql_exe.is_absolute() or not a.workspace.is_dir():
        print(json.dumps({'ok':False,'error':'NATIVE_WINDOWS_WORKSPACE_REQUIRED'}));return 2
    pin=preflight(binary=str(a.rql_exe),root=ROOT,system='win32')
    if not pin['ok']:
        print(json.dumps({'ok':False,'error':'REPOQL_VERSION_OR_CONNECTOR_ABI_REFUSED'}));return 2
    try:
        rql=RepoQL(Config(workspace=a.workspace,rql=a.rql_exe,
                         state_dir=Path(os.environ['LOCALAPPDATA'])/'Singularity'/'Dashboard',
                         bind='127.0.0.1',port=18100))
        inventory=connector_inventory(rql)
    except (OSError,subprocess.TimeoutExpired,ValueError,KeyError):
        inventory={'available':False}
    result=evaluate(inventory)
    if a.rust_binary is not None:
        try:
            result=run_checked(a.rust_binary,['connector-evaluate-stdin'],result,data=inventory)
        except RustReadOnlyBridgeError:
            # Do not leak collector details or silently accept Python fallback.
            print(json.dumps({'ok':False,'error':'RUST_CONNECTOR_EVALUATION_UNVERIFIED'}))
            return 2
    print(json.dumps(result,indent=2))
    return 0 if result['bothConnectorsActive'] else 1


if __name__=='__main__':raise SystemExit(main())
