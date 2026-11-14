#!/usr/bin/env python3
"""Independent OpenMausBot catalogue/bot inventory Python and compiled Rust parity."""
import argparse
import json
from pathlib import Path
import random
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT/'dashboard'))
from native_openmausbot import (_project_models_python,_project_overview_python,
                                _public_models,_public_bots)


def fixtures():
    rng=random.Random(31011)
    yield 'models', {'instances':[]}
    yield 'models', {'instances':[{'instanceId':'a','displayName':'Alpha','snapshot':{'state':'available'},
                                  'models':{'options':[{'id':'m','label':'Model'}]}}]}
    yield 'bots', {'bots':[]}
    yield 'bots', {'bots':[{'id':'bot_A','name':'Alpha','busy':True,'token':'PRIVATE_VALUE'}]}
    for i in range(360):
        if i % 2 == 0:
            instances=[]
            for n in range(rng.randrange(0,15)):
                options=[]
                for j in range(rng.randrange(0,8)):
                    options.append({'id':f'model_{n}_{j}','label':f'label {j}',
                                    'session_secret':'PRIVATE_VALUE'})
                instances.append({'instanceId':f'instance_{n}',
                                  'displayName':rng.choice(['Alpha','beta','Gamma','omega'])+str(n),
                                  'snapshot':{'state':rng.choice(['available','offline','unknown'])},
                                  'models':{'options':options}, 'credentials':'PRIVATE_VALUE'})
            yield 'models',{'instances':instances}
        else:
            bots=[]
            for n in range(rng.randrange(0,22)):
                bots.append({'id':f'bot_{n}','name':rng.choice(['Alpha','beta','Gamma','omega'])+str(n),
                             'busy':rng.choice([True,False,0,1]),'chiefOfStaff':rng.choice([True,False]),
                             'threadId':f'thread_{n}',
                             'modelSelection':{'instanceId':'provider','model':f'model_{n}'},
                             'secret':'PRIVATE_VALUE'})
            yield 'bots',{'bots':bots}


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--rust-cli',type=Path)
    args=parser.parse_args();binary=args.rust_cli.resolve() if args.rust_cli else None
    if binary and not binary.is_file():parser.error('Rust binary missing')
    count=0
    for mode,data in fixtures():
        if mode=='models':
            expected=_project_models_python(data); payload=_public_models(data)
        else:
            expected=_project_overview_python(data); payload=_public_bots(data)
        assert 'PRIVATE_VALUE' not in json.dumps(payload)
        request={'mode':mode,'payload':payload}
        if binary:
            result=subprocess.run([str(binary)],input=json.dumps(request),text=True,encoding='utf-8',
                                  capture_output=True,shell=False,timeout=10)
            if result.returncode!=0 or json.loads(result.stdout)!=expected:
                raise AssertionError(f'compiled OpenMaus inventory mismatch: {mode} case {count}')
        count+=1
    if binary:
        for injected in (
            {'mode':'models','payload':{'instances':[],'token':'PRIVATE'}},
            {'mode':'bots','payload':{'total':1,'truncated':False,'bots':[{'id':'bad/id'}]}},
            {'mode':'forged','payload':{}},
        ):
            result=subprocess.run([str(binary)],input=json.dumps(injected),text=True,
                                  capture_output=True,timeout=10,shell=False)
            if result.returncode==0 or 'PRIVATE' in result.stdout+result.stderr:
                raise AssertionError('Rust accepted private or forged inventory')
        print(f'OPENMAUS_INVENTORY_COMPILED_PARITY_PASSED: {count} cases')
    else:
        print(f'OPENMAUS_INVENTORY_REFERENCE_ONLY_PASSED: {count} cases (Rust executable NOT_RUN)')


if __name__=='__main__':main()
