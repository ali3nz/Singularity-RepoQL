#!/usr/bin/env python3
"""Deterministic differential checks against the actual Windows Python sources.

Without --rust-cli, validates reference fixtures only and reports Rust NOT_RUN.
With --rust-cli, compares returned JSON and CLI exit policy for all cases.
Does not read or modify installed Windows services.
"""
from __future__ import annotations
import argparse
import copy
from datetime import datetime,timezone,timedelta
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import zipfile

p=argparse.ArgumentParser()
p.add_argument('--repo',type=Path,required=True)
p.add_argument('--rust-cli',type=Path)
a=p.parse_args()
ROOT=a.repo.resolve()
sys.path.insert(0,str(ROOT))
sys.path.insert(0,str(ROOT/'native/windows'))
from compare_production_parity import SCHEMA,mandatory,compare
from trace_linux_assumptions import audit
from check_rust_lock_provenance import inspect,CRATES
from verify_option2_connectors import evaluate
NOW=datetime(2026,10,29,1,tzinfo=timezone.utc)
count=0

def run(command,options,expected,expected_ok):
    global count
    count+=1
    if not a.rust_cli:return
    binary=a.rust_cli.resolve()
    proc=subprocess.run([str(binary),command,*options],capture_output=True,text=True,timeout=20,check=False)
    try:actual=json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise AssertionError((command,'invalid Rust JSON',proc.returncode,proc.stderr[:160])) from exc
    if actual!=expected:
        raise AssertionError((command,'JSON mismatch',expected,actual))
    if (proc.returncode==0)!=expected_ok:
        raise AssertionError((command,'unexpected return code',proc.returncode,expected_ok))

def make_receipt(runtime,option):
    return {'schema':SCHEMA,'product':'Singularity RepoQL','runtime':runtime,
        'repoql_version':'1.7.18' if runtime=='native-windows-no-wsl' else '1.7.15',
        'connector_abi':1,'variant':option,
        'checks':{name:{'result':'PASS','evidence_id':'verified-receipt-fixture',
            'observed_at':NOW.isoformat()} for name in mandatory(option)}}

with tempfile.TemporaryDirectory(prefix='singularity-rust-evidence-') as temp:
    d=Path(temp)
    # Known authoritative comparison outcomes, including all options and edge gates.
    cases=[]
    for option in (1,2,3,4):
        cases.append((f'option-{option}-full',make_receipt('production-linux-docker',option),make_receipt('native-windows-no-wsl',option)))
    for issue in ('missing','stale','future','synthetic','no_evidence','version','runtime','product','abi','bad_option','bool_option','bad_schema'):
        x=make_receipt('production-linux-docker',2)
        y=make_receipt('native-windows-no-wsl',2)
        entry=y['checks']['new_session_recall']
        if issue=='missing':del y['checks']['new_session_recall']
        elif issue=='stale':entry['observed_at']=(NOW-timedelta(days=8)).isoformat()
        elif issue=='future':entry['observed_at']=(NOW+timedelta(minutes=6)).isoformat()
        elif issue=='synthetic':entry['synthetic']=True
        elif issue=='no_evidence':entry['evidence_id']=' '
        elif issue=='version':y['repoql_version']='1.7.15'
        elif issue=='runtime':y['runtime']='wsl'
        elif issue=='product':x['product']='Different product'
        elif issue=='abi':y['connector_abi']=2
        elif issue=='bad_option':y['variant']='2'
        elif issue=='bool_option':y['variant']=True
        elif issue=='bad_schema':x['schema']='wrong'
        cases.append((issue,x,y))
    for label,x,y in cases:
        expected=compare(x,y,now=NOW)
        xp=d/'production.json';yp=d/'windows.json'
        xp.write_text(json.dumps(x));yp.write_text(json.dumps(y))
        run('parity',['--production',str(xp),'--windows',str(yp),'--now',NOW.isoformat()],expected,expected['ready'])
    # Inert comment, candidate source, source from docs, and repeated pattern.
    for index,sources in enumerate((
        {'harness/main.mjs':'// docker comment\nspawnSync("docker", ["--password=DO_NOT_PRINT_ME"]);\nconst x="/proc/loadavg";\n',
         'docs/README.md':'sudo docker'},
        {'native/windows/tool.py':'# sudo comment\nimport subprocess\nsubprocess.run(["bash", "-c", "ssh host"]);\n',
         '.github/workflow.ts':'docker'},
        {'app/mod.rs':'let a="UnixListener";\nlet b="AF_UNIX";\nlet c="systemctl";\nlet d="journalctl";\nlet e="podman";\n'})):
        z=d/f'source-{index}.zip'
        with zipfile.ZipFile(z,'w') as archive:
            for name,body in sources.items():archive.writestr(name,body)
        expected=audit(z,max_occurrences=2)
        assert 'DO_NOT_PRINT_ME' not in str(expected)
        run('linux-candidates',[str(z),'--max-occurrences','2'],expected,True)
    # Lockfile structural acceptance matches original release gate exactly.
    for kind in ('missing','valid','bad-checksum','duplicate'):
        root=d/f'lock-{kind}'
        for rel,name in CRATES:
            crate=root/rel;crate.mkdir(parents=True,exist_ok=True)
            (crate/'Cargo.toml').write_text(f'[package]\nname="{name}"\nversion="0.1.0"\n')
            if kind!='missing':
                dependency='''[[package]]\nname="sample-dependency"\nversion="1.0.0"\nsource="registry+https://github.com/rust-lang/crates.io-index"\nchecksum="'''+('INVALID' if kind=='bad-checksum' else 'a'*64)+'''"\n'''
                (crate/'Cargo.lock').write_text('version=4\n[[package]]\nname="'+name+'"\nversion="0.1.0"\n'+dependency+(dependency if kind=='duplicate' else ''))
        expected=inspect(root)
        run('rust-lock',['--source-root',str(root)],expected,expected['readyForRustDependencyReview'])
    for inventory in (
        {'available':False},
        {'available':True,'truncated':True,'connectors':[]},
        {'available':True,'truncated':False,'connectors':[{'id':'kanzo','active':True,'status':'ready'},{'id':'memorycore','active':True,'status':'ready'}]},
        {'available':True,'truncated':False,'connectors':[{'id':'kanzo','active':True},{'id':'kanzo','active':True},{'id':'memorycore','active':True}]},
        {'available':True,'truncated':False,'connectors':[{'id':'kanzo','active':True},{'id':'memorycore','active':False}]},
    ):
        inv=d/'inventory.json';inv.write_text(json.dumps(inventory))
        expected=evaluate(inventory)
        run('connector-evaluate',['--inventory',str(inv)],expected,expected['bothConnectorsActive'])

# Native-only stdin transport must never require writing a connector inventory
# to a temporary plaintext file. Compare the exact same Python policy result.
for inventory in (
    {'available': False},
    {'available': True, 'truncated': False, 'connectors': [
        {'id':'kanzo','active':True,'status':'ready'},
        {'id':'memorycore','active':True,'status':'ready'}]},
):
    count += 1
    if a.rust_cli:
        expected = evaluate(inventory)
        proc = subprocess.run([str(a.rust_cli.resolve()), 'connector-evaluate-stdin'],
                              input=json.dumps(inventory), capture_output=True,
                              text=True, timeout=20, check=False)
        try: actual = json.loads(proc.stdout)
        except json.JSONDecodeError as exc: raise AssertionError('invalid native stdin response') from exc
        if actual != expected or (proc.returncode == 0) != expected['bothConnectorsActive']:
            raise AssertionError(('connector-evaluate-stdin', expected, actual, proc.returncode))

print(json.dumps({'reference_cases':count,'reference': 'PASS',
    'rust_differential': 'PASS' if a.rust_cli else 'NOT_RUN_NO_BINARY',
    'live_windows_runtime':'NOT_RUN','release_eligible':False},indent=2))
