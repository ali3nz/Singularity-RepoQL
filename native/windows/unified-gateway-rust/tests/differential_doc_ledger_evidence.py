#!/usr/bin/env python3
"""600 documentation evidence cases, optional compiled Windows Rust differential.

Reference-only runs must never be described as compiled Rust parity.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import random
import subprocess
import sys

ROOT=Path(__file__).resolve().parents[4]
sys.path.insert(0,str(ROOT/'scripts'))
spec=importlib.util.spec_from_file_location('doc_ingest_reference',ROOT/'scripts'/'memory-doc-ingest.py')
ref=importlib.util.module_from_spec(spec)
spec.loader.exec_module(ref)
SCHEMA='singularity-doc-ledger-evidence/v1'


def cases():
    yield dict(schema=SCHEMA, active=False, hash_equal=False, indexed=False,
               verified=False, chunks_complete=False, revisions=[])
    yield dict(schema=SCHEMA, active=True, hash_equal=True, indexed=True,
               verified=True, chunks_complete=True, revisions=[])
    yield dict(schema=SCHEMA, active=True, hash_equal=False, indexed=True,
               verified=True, chunks_complete=True, revisions=[])
    rng=random.Random(402026)
    for _ in range(597):
        yield dict(schema=SCHEMA,
                   active=bool(rng.randrange(2)),hash_equal=bool(rng.randrange(2)),
                   indexed=bool(rng.randrange(2)),verified=bool(rng.randrange(2)),
                   chunks_complete=bool(rng.randrange(2)),
                   revisions=[dict(active=bool(rng.randrange(4)==0),
                                   unresolved=bool(rng.randrange(2)),
                                   newer=bool(rng.randrange(2)))
                              for _ in range(rng.randrange(0, 130))])


def main():
    p=argparse.ArgumentParser();p.add_argument('--rust-cli',type=Path);a=p.parse_args()
    if a.rust_cli and not a.rust_cli.is_file():p.error('compiled Rust CLI unavailable')
    count=0
    for request in cases():
        expected=ref._ledger_evidence_reference(request)
        actual_indices=[i for i, rev in enumerate(request['revisions'])
                        if not rev['active'] and rev['unresolved'] and rev['newer']]
        assert actual_indices==expected['newer_unresolved_indices']
        if a.rust_cli:
            proc=subprocess.run([str(a.rust_cli)],input=json.dumps(request),
                                capture_output=True,text=True,timeout=15,shell=False)
            if proc.returncode or json.loads(proc.stdout)!=expected:
                raise AssertionError(f'Rust document ledger evidence mismatch case {count}')
        count+=1
    assert count==600
    if a.rust_cli:
        valid=next(cases())
        for extra in ({**valid,'root':'private'}, {**valid,'active':1},
                      {**valid,'revisions':[{'active':False,'unresolved':False,'newer':False,'secret':'private'}]},
                      {**valid,'revisions':[{'active':False,'unresolved':False,'newer':False}]*257}):
            p=subprocess.run([str(a.rust_cli)],input=json.dumps(extra),capture_output=True,
                             text=True,timeout=15,shell=False)
            if p.returncode==0 or 'private' in (p.stdout+p.stderr):
                raise AssertionError('Rust document ledger evidence rejection failed')
    print(f'DOC_LEDGER_EVIDENCE_{"COMPILED_PARITY" if a.rust_cli else "REFERENCE_ONLY"}: {count} cases')

if __name__=='__main__':main()
