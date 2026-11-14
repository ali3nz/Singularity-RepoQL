#!/usr/bin/env python3
"""Deterministic RepoQL query usage attribution; compiled Rust opt-in required for parity."""
import argparse
import json
from pathlib import Path
import random
import subprocess

NOW=1793253600.0
WINDOWS=(('1d',86400.0),('7d',604800.0),('30d',2592000.0))


def fixtures():
    yield 0,[]
    yield 2,[[NOW,[0,1]]]
    yield 1,[[NOW+10,[0]],[NOW-86400,[0]],[NOW-2592000,[0]]]
    rng=random.Random(32011)
    for _ in range(420):
        count=rng.randrange(0,10)
        rows=[]
        for i in range(rng.randrange(0,140)):
            ts=NOW+rng.choice([0,10,300,-1,-86000,-86400,-604800,-2592000,-2600000,-4000000])
            roots=rng.sample(list(range(count)),rng.randrange(0,min(5,count)+1))
            rows.append([ts,sorted(roots)])
        yield count,rows


def reference(count,events):
    calls={k:0 for k,_ in WINDOWS};unmatched={k:0 for k,_ in WINDOWS}
    by_repo=[{k:0 for k,_ in WINDOWS} for _ in range(count)]
    for ts,targets in events:
        for key,seconds in WINDOWS:
            if NOW-seconds<=ts<=NOW:
                calls[key]+=1
                if not targets: unmatched[key]+=1
                for root in targets:by_repo[root][key]+=1
    return {'calls':calls,'unattributed':unmatched,'repositories':by_repo,
            'accepted_events':len(events),'earliest':min((x[0] for x in events),default=None),
            'latest':max((x[0] for x in events),default=None)}


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--rust-cli',type=Path)
    args=parser.parse_args();bin=args.rust_cli.resolve() if args.rust_cli else None
    if bin and not bin.is_file():parser.error('compiled Rust binary missing')
    count=0
    for n,events in fixtures():
        expected=reference(n,events)
        request={'now':NOW,'root_count':n,'events':events}
        assert not any(isinstance(k,str) and '/' in k for k in request)
        if bin:
            got=subprocess.run([str(bin)],input=json.dumps(request),text=True,
                               encoding='utf-8',capture_output=True,shell=False,timeout=15)
            if got.returncode!=0 or json.loads(got.stdout)!=expected:
                raise AssertionError(f'compiled RepoQL query usage differential mismatch at {count}')
        count+=1
    if bin:
        for invalid in ({'now':NOW,'root_count':1,'events':[[NOW,[10]]]},
                        {'now':NOW,'root_count':1,'events':[[NOW,[0,0]]]},
                        {'now':NOW,'root_count':0,'events':[],'repository_path':'PRIVATE'}):
            got=subprocess.run([str(bin)],input=json.dumps(invalid),text=True,encoding='utf-8',
                               capture_output=True,shell=False,timeout=15)
            if got.returncode==0 or 'PRIVATE' in got.stderr+got.stdout:
                raise AssertionError('Rust accepted private or forged RepoQL usage input')
        print(f'REPOQL_QUERY_USAGE_COMPILED_PARITY_PASSED: {count} cases')
    else:
        print(f'REPOQL_QUERY_USAGE_REFERENCE_ONLY_PASSED: {count} cases (Rust executable NOT_RUN)')


if __name__=='__main__':main()
