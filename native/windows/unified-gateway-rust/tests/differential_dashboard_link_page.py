#!/usr/bin/env python3
"""Independent deterministic 500-case oracle; optional real compiled Rust parity."""
import argparse
import json
from pathlib import Path
import random
import subprocess
import sys

ROOT=Path(__file__).resolve().parents[4]
sys.path.insert(0,str(ROOT/'dashboard'))
from link_page_projection import page_links, SCHEMA


def scenarios():
    yield [],1,10
    yield [True,False,True],1,2
    rng=random.Random(1142)
    for _ in range(498):
        count=rng.randrange(0,150)
        yield [rng.choice([False,False,True]) for _ in range(count)], rng.randrange(1,10), rng.randrange(1,41)


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--rust-cli',type=Path)
    args=parser.parse_args()
    if args.rust_cli and not args.rust_cli.is_file(): parser.error('compiled Rust binary not found')
    for count,(bits,page,size) in enumerate(scenarios(),1):
        rows=[{'source_name':'Name','target_name':'Match' if flag else 'Other',
               'source_category':'rule','target_category':'wisdom'} for flag in bits]
        expected=page_links(rows,page,size,query='match',rust_bin='')
        matched_indices=[i for i,flag in enumerate(bits) if flag]
        assert expected['total']==len(matched_indices)
        assert expected['rows']==[rows[i] for i in matched_indices[(page-1)*size:page*size]]
        if args.rust_cli:
            payload={'schema':SCHEMA,'matches':bits,'page':page,'page_size':size}
            process=subprocess.run([str(args.rust_cli)],input=json.dumps(payload),text=True,
                                   capture_output=True,timeout=15,shell=False)
            if process.returncode or json.loads(process.stdout)!={'total':len(matched_indices),
                    'indices':matched_indices[(page-1)*size:page*size]}:
                raise AssertionError(f'compiled Rust link paging mismatch at case {count}')
    assert count==500
    print(('DASHBOARD_LINK_PAGE_COMPILED_PARITY' if args.rust_cli else 'DASHBOARD_LINK_PAGE_REFERENCE_ONLY') + ': 500 cases')

if __name__=='__main__': main()
