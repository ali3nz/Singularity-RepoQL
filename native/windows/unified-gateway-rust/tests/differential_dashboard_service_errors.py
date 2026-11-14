#!/usr/bin/env python3
"""500 independent Python service error aggregation scenarios, optional Rust parity."""
import argparse
import json
from pathlib import Path
import random
import re
import subprocess
import sys

ROOT=Path(__file__).resolve().parents[4]
sys.path.insert(0,str(ROOT/'dashboard'))
from service_error_projection import SCHEMA,group_service_errors


def cases():
    yield [],1,10
    yield [{'msg':'Example 12','level':'ERR','ts':'2026-01-01'}],2,1
    randomizer=random.Random(44543)
    for _ in range(498):
        n=randomizer.randrange(0,130)
        records=[]
        for i in range(n):
            records.append({'msg':f'{randomizer.choice(["Failure","Lost peer","Request expired","Missing resource","Timeout"])} {randomizer.randrange(1,15)} code {randomizer.randrange(1,1000)}',
                            'level':randomizer.choice(['WARN','ERR','FTL']),
                            'ts':f'2026-01-{randomizer.randrange(1,20):02d}T{randomizer.randrange(0,24):02d}:00:00Z'})
        yield records,randomizer.randrange(1,8),randomizer.randrange(1,40)


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--rust-cli',type=Path)
    args=parser.parse_args()
    if args.rust_cli and not args.rust_cli.is_file():parser.error('compiled binary not found')
    for count,(records,page,size) in enumerate(cases(),1):
        reference=group_service_errors(records,page,size,rust_bin='')
        # Independently derive an ordered signature ledger and project it to the desired page.
        groups={}
        for i,row in enumerate(records):
            sig=re.sub(r'\d+','#',row['msg'])[:180]
            if sig not in groups:groups[sig]={'message':row['msg'],'count':0,'signature':sig,'first_ts':row['ts'],
                                             'last_ts':row['ts'],'level':row['level'],'kind':'service','component':'repoql-host'}
            g=groups[sig];g.update(first_ts=row['ts'],last_ts=row['ts'],level=row['level']);g['count']+=1
        order=sorted(groups.values(),key=lambda g:g['last_ts'],reverse=True)
        assert reference=={'total':len(order),'rows':order[(page-1)*size:page*size]}
        if args.rust_cli:
            groups_by_signature={}
            for rec in records:
                sig=re.sub(r'\d+','#',rec['msg'])[:180]
                if sig not in groups_by_signature:groups_by_signature[sig]=len(groups_by_signature)
            stamps={timestamp:i for i,timestamp in enumerate(sorted(set(rec['ts'] for rec in records)))}
            events=[{'group':groups_by_signature[re.sub(r'\d+','#',rec['msg'])[:180]],
                     'time_rank':stamps[rec['ts']]} for rec in records]
            ledger={}
            for i,rec in enumerate(records):
                signature=re.sub(r'\d+','#',rec['msg'])[:180]
                idx=groups_by_signature[signature]
                if idx not in ledger:ledger[idx]={'count':0,'last_event':i,'rank':stamps[rec['ts']]}
                ledger[idx]['count']+=1;ledger[idx]['last_event']=i;ledger[idx]['rank']=stamps[rec['ts']]
            expected_order=sorted(ledger.items(),key=lambda row:(-row[1]['rank'],row[0]))
            selected=expected_order[(page-1)*size:page*size]
            expected={'total':len(ledger),'groups':[{'group_index':idx,'count':item['count'],
                                                     'last_event':item['last_event']} for idx,item in selected]}
            proc=subprocess.run([str(args.rust_cli)],input=json.dumps({'schema':SCHEMA,'events':events,
                                  'page':page,'page_size':size}),capture_output=True,text=True,timeout=15,shell=False)
            if proc.returncode or json.loads(proc.stdout)!=expected:
                raise AssertionError(f'compiled Rust service errors mismatch at case {count}')
    assert count==500
    print(('DASHBOARD_SERVICE_ERRORS_COMPILED_PARITY' if args.rust_cli else 'DASHBOARD_SERVICE_ERRORS_REFERENCE_ONLY') + ': 500 cases')

if __name__=='__main__':main()
