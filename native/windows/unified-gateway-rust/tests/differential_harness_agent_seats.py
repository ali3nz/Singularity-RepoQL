#!/usr/bin/env python3
"""500 numerical agent-seat state scenarios. Optional compiled Rust parity."""
import argparse
import json
from pathlib import Path
import random
import subprocess
import sys
ROOT=Path(__file__).resolve().parents[4]
sys.path.insert(0,str(ROOT/'dashboard'))
from agent_seat_projection import _reference, SCHEMA

def cases():
    yield (0,[])
    yield (1,[dict(agent=0,kind=4,model=False,provider=False,
                   stage=True,status=True,ts=True)])
    rng=random.Random(4939)
    for _ in range(498):
        count=rng.randrange(1,20)
        events=[dict(agent=rng.randrange(count),kind=rng.randrange(5),
                     model=bool(rng.randrange(2)),provider=bool(rng.randrange(2)),
                     stage=bool(rng.randrange(2)),status=bool(rng.randrange(2)),
                     ts=bool(rng.randrange(2))) for _ in range(rng.randrange(0,150))]
        yield count,events

def main():
    p=argparse.ArgumentParser();p.add_argument('--rust-cli',type=Path)
    a=p.parse_args()
    if a.rust_cli and not a.rust_cli.is_file():p.error('compiled binary unavailable')
    for i,(n,events) in enumerate(cases(),1):
        expected=_reference(events)
        assert all(v['agent_index']<n for v in expected)
        if a.rust_cli:
            req=dict(schema=SCHEMA,agent_count=n,events=events)
            run=subprocess.run([str(a.rust_cli)],input=json.dumps(req),capture_output=True,
                               text=True,shell=False,timeout=15)
            if run.returncode or json.loads(run.stdout)!=expected:
                raise AssertionError(f'Agent seat compiled parity failed case {i}')
    assert i==500
    print(('AGENT_SEATS_COMPILED_PARITY' if a.rust_cli else 'AGENT_SEATS_REFERENCE_ONLY')+': 500 cases')
if __name__=='__main__':main()
