#!/usr/bin/env python3
"""Independent harness usage count reference; compiled Rust optionally required."""
import argparse
import json
from pathlib import Path
import random
import subprocess


def cases():
    yield [], 0
    yield [[2,1,1,0]], 2
    yield [[0,0,0,0],[7,7,1,3]], 1
    rng = random.Random(34121)
    for _ in range(597):
        rows = []
        for _ in range(rng.randrange(0,101)):
            n = rng.randrange(0,2000)
            rows.append([n,rng.randrange(n+1),rng.randrange(n+1),rng.randrange(n+1)])
        yield rows, rng.randrange(0,10000)


def expected(rows, completed):
    return {'calls_without_input_tokens': sum(n-inn for n,inn,_,_ in rows),
            'calls_without_output_tokens': sum(n-out for n,_,out,_ in rows),
            'paid_calls': sum(paid for _,_,_,paid in rows),
            'completed_tasks':completed}


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--rust-cli',type=Path)
    args=parser.parse_args();binary=args.rust_cli.resolve() if args.rust_cli else None
    if binary and not binary.is_file(): parser.error('compiled Rust executable missing')
    total=0
    for rows, completed in cases():
        oracle=expected(rows,completed)
        req={'schema':'singularity-harness-usage-counts/v1','rows':rows,'completed':completed}
        if binary:
            got=subprocess.run([str(binary)],input=json.dumps(req),text=True,
                               encoding='utf-8',capture_output=True,shell=False,timeout=15)
            if got.returncode or json.loads(got.stdout)!=oracle:
                raise AssertionError(f'usage counters compiled Rust parity failed on case {total}')
        total+=1
    assert total==600
    if binary:
        base={'schema':'singularity-harness-usage-counts/v1','rows':[[1,1,1,1]],'completed':0}
        for invalid in (dict(base, prompt='PRIVATE'),dict(base,rows=[[1,2,0,0]]),
                        dict(base,rows=[[1,True,0,0]]),dict(base,rows=[[1,1,1,'PRIVATE']]),
                        dict(base,completed=-1)):
            got=subprocess.run([str(binary)],input=json.dumps(invalid),text=True,
                               capture_output=True,timeout=15,shell=False)
            if got.returncode==0 or 'PRIVATE' in got.stdout+got.stderr:
                raise AssertionError('usage Rust failed to reject private or invalid counts')
        print(f'HARNESS_USAGE_COMPILED_PARITY_PASSED: {total} cases')
    else:
        print(f'HARNESS_USAGE_REFERENCE_ONLY_PASSED: {total} cases (Rust executable NOT_RUN)')


if __name__=='__main__':main()
