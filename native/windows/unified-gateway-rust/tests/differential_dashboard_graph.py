#!/usr/bin/env python3
"""600-case deterministic graph oracle; --rust-cli checks compiled Rust."""
import argparse
import json
from pathlib import Path
import random
import subprocess
import sys
ROOT=Path(__file__).resolve().parents[4]
sys.path.insert(0,str(ROOT/'dashboard'))
from graph_projection import project_graph,SCHEMA

def scenarios():
    yield (0,[])
    yield (2,[[0,1]]*300)
    yield (201,[[i,i+1] for i in range(200)])
    rng=random.Random(4838)
    for _ in range(597):
        n=rng.randrange(1,250)
        count=rng.randrange(0,400)
        yield (n,[[rng.randrange(n),rng.randrange(n)] for _ in range(count)])

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--rust-cli',type=Path)
    args=parser.parse_args()
    if args.rust_cli and not args.rust_cli.is_file():parser.error('compiled binary unavailable')
    for count,(nodes,pairs) in enumerate(scenarios(),1):
        expected=project_graph(nodes,pairs,rust_bin='')
        assert len(expected['node_indices'])<=120
        assert len(expected['edge_indices'])<=200
        if args.rust_cli:
            r=subprocess.run([str(args.rust_cli)],input=json.dumps({'schema':SCHEMA,
                'node_count':nodes,'pairs':pairs}),text=True,capture_output=True,
                timeout=15,shell=False)
            if r.returncode or json.loads(r.stdout)!=expected:
                raise AssertionError(f'compiled Rust graph parity mismatch at case {count}')
    assert count==600
    print(('DASHBOARD_GRAPH_COMPILED_PARITY' if args.rust_cli else 'DASHBOARD_GRAPH_REFERENCE_ONLY')+': 600 cases')
if __name__=='__main__':main()
