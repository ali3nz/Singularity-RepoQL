#!/usr/bin/env python3
"""Independent 500-case Python oracle; --rust-cli requires real compiled parity."""
import argparse
import json
from pathlib import Path
import random
import subprocess
import sys
ROOT=Path(__file__).resolve().parents[4]
sys.path.insert(0,str(ROOT/'dashboard'))
from repository_projection import project_repositories,SCHEMA


def scenarios():
    yield [],[],[]
    yield [dict(state=None,available=True,file_count=1,indexed_count=0)],[0],[0]
    rng=random.Random(4737)
    for _ in range(498):
        n=rng.randrange(1,40)
        rows=[dict(state=rng.choice([None,'served','pending','error']),
                   available=rng.choice([True,False]),
                   file_count=rng.choice([None,0,1,25,500]),
                   indexed_count=rng.choice([None,0,1,25,500])) for _ in range(n)]
        failed=[rng.randrange(n) for _ in range(rng.randrange(0,50))]
        excluded=[rng.randrange(n) for _ in range(rng.randrange(0,50))]
        yield rows,failed,excluded


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--rust-cli',type=Path)
    args=parser.parse_args()
    if args.rust_cli and not args.rust_cli.is_file(): parser.error('compiled binary not found')
    for count,(rows,failed,excluded) in enumerate(scenarios(),1):
        expected=project_repositories(rows,failed,excluded,rust_bin='')
        assert len(expected)==len(rows)
        if args.rust_cli:
            req={'schema':SCHEMA,'rows':[{'override':r['state'] not in (None,'served'),
                                          'available':r['available'], 'file_count':r['file_count'],
                                          'indexed_count':r['indexed_count']} for r in rows],
                 'failed_indices':failed,'exclusion_indices':excluded}
            p=subprocess.run([str(args.rust_cli)],input=json.dumps(req),capture_output=True,
                             text=True,timeout=15,shell=False)
            if p.returncode or json.loads(p.stdout)!=expected:
                raise AssertionError(f'Rust mismatch at case {count}')
    assert count==500
    print(('REPOSITORY_SUMMARY_COMPILED_PARITY' if args.rust_cli else 'REPOSITORY_SUMMARY_REFERENCE_ONLY') + ': 500 cases')

if __name__=='__main__':main()
