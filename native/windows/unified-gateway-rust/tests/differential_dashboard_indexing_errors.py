#!/usr/bin/env python3
"""500 independent indexing error reference cases, optional compiled Rust parity."""
import argparse
import json
from pathlib import Path
import random
import subprocess
import sys

ROOT=Path(__file__).resolve().parents[4]
sys.path.insert(0,str(ROOT/'dashboard'))
from indexing_error_projection import SCHEMA, project_indexing_errors


def cases():
    yield [],1,3
    yield [{'timestamp':None,'message':'secret','uri':'private'}],2,1
    rng=random.Random(45261)
    stamps=[None,'','2026-01-02','2026-01-02T11:11:11Z','2026-01-03','99',0,42]
    for _ in range(498):
        size=rng.randrange(0,110)
        records=[{'timestamp':rng.choice(stamps),'message':f'secret item {i}',
                  'uri':f'local://private/{i}'} for i in range(size)]
        yield records,rng.randrange(1,9),rng.randrange(1,30)


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--rust-cli',type=Path)
    args=parser.parse_args()
    if args.rust_cli and not args.rust_cli.is_file(): parser.error('compiled binary missing')
    for case,(items,page,size) in enumerate(cases(),1):
        reference=project_indexing_errors(items,page,size,rust_bin='')
        ordering=sorted(range(len(items)),key=lambda i:str(items[i].get('timestamp') or ''),reverse=True)
        selected=ordering[(page-1)*size:page*size]
        assert reference=={'total':len(items),'rows':[items[index] for index in selected]}
        if args.rust_cli:
            stamps=[str(item.get('timestamp') or '') for item in items]
            ranks={stamp:i for i,stamp in enumerate(sorted(set(stamps)))}
            proc=subprocess.run([str(args.rust_cli)],input=json.dumps({'schema':SCHEMA,
                         'ranks':[ranks[stamp] for stamp in stamps],
                         'page':page,'page_size':size}),capture_output=True,text=True,timeout=15,shell=False)
            if proc.returncode or json.loads(proc.stdout)!={'total':len(items),'indices':selected}:
                raise AssertionError(f'compiled Rust indexing error mismatch at case {case}')
    assert case==500
    print(('DASHBOARD_INDEXING_ERRORS_COMPILED_PARITY' if args.rust_cli
           else 'DASHBOARD_INDEXING_ERRORS_REFERENCE_ONLY')+': 500 cases')

if __name__=='__main__': main()
