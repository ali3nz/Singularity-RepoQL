#!/usr/bin/env python3
"""Independent Python oracle for Windows Rust upgrade and acceptance projections.

With --rust-cli, every sanitized decision is compared to the compiled binary.
Without it, only the original Python path executes. No installed state is read.
"""
from __future__ import annotations

import argparse
import hashlib
import itertools
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

p=argparse.ArgumentParser()
p.add_argument('--repo',type=Path,required=True)
p.add_argument('--rust-cli',type=Path)
args=p.parse_args()
repo=args.repo.resolve()
sys.path.insert(0,str(repo/'native/windows'))
os.environ.pop('SINGULARITY_RUST_RELEASE_EVIDENCE_BIN',None)
from plan_option2_upgrade import upgrade_plan, RECEIPTS
from claude_complete_acceptance_matrix import matrix, GATES, RECEIPT_SCHEMA

count=0

def compare(command,facts,reference):
    global count
    count+=1
    if not args.rust_cli:
        return
    process=subprocess.run([str(args.rust_cli.resolve()),command],
        input=json.dumps(facts,separators=(',',':')),capture_output=True,text=True,
        encoding='utf-8',check=False,timeout=15)
    if process.returncode!=0:
        raise AssertionError((command,'Rust command rejected a valid source decision',process.returncode,process.stderr[:180]))
    try: actual=json.loads(process.stdout)
    except ValueError as exc:
        raise AssertionError((command,'invalid Rust JSON')) from exc
    if actual!=reference:
        raise AssertionError((command,'Rust output mismatched authoritative Python',facts,actual,reference))

with tempfile.TemporaryDirectory(prefix='singularity-rust-upgrade-') as temporary:
    base=Path(temporary)
    for ix,bits in enumerate(itertools.product((False,True),repeat=len(RECEIPTS))):
        status=dict(zip(RECEIPTS,bits))
        root=base/f'case-{ix}'
        stage=root/'stage';home=root/'home';workspace=root/'workspace'
        for d in (stage,home,workspace):d.mkdir(parents=True)
        for key,(relative,schema) in RECEIPTS.items():
            if not status[key]:continue
            parent=workspace if key=='kanzo' else home if key in ('claude','parent') else stage
            file=parent/relative
            file.parent.mkdir(parents=True,exist_ok=True)
            file.write_text(json.dumps({'schema':schema or 'fixture'}),encoding='utf-8')
        for task in ('ABSENT','UNKNOWN','REGISTERED'):
            for dashboard in ('ABSENT','UNKNOWN','REGISTERED'):
                expected=upgrade_plan(stage,home,workspace,task,dashboard)
                assert expected['receipt_presence']==status
                assert not expected['release_ready']
                compare('upgrade-plan-stdin',{'receipts':status,'taskState':task,
                    'dashboardTaskState':dashboard},expected)

    evidence=base/'evidence';evidence.mkdir()
    compare('acceptance-matrix-stdin',{'gateResults':matrix()['gate_results']},matrix())
    for case in range(1,1+len(GATES)*3):
        for f in evidence.iterdir():f.unlink()
        for i,gate in enumerate(GATES):
            if i >= case% (len(GATES)+1):continue
            body=b'REDACTED SYNTHETIC WINDOWS TEST EVIDENCE\n'
            name=f'{gate}.log'
            (evidence/name).write_bytes(body)
            record={
                'schema':RECEIPT_SCHEMA,'gate':gate,
                'result':'PASS' if (i+case)%5 else 'FAIL',
                'source_commit':('b' if (i+case)%7 else 'c')*40,
                'evidence_name':name,'evidence_sha256':hashlib.sha256(body).hexdigest()
            }
            (evidence/f'{gate}.json').write_text(json.dumps(record),encoding='utf-8')
        expected=matrix(evidence)
        assert expected['release_ready'] is False
        compare('acceptance-matrix-stdin',{'gateResults':expected['gate_results']},expected)

print(f'RELEASE_UPGRADE_ACCEPTANCE_REFERENCE_PASS cases={count} rust_compiled={bool(args.rust_cli)}')
