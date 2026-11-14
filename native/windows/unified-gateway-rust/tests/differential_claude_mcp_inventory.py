#!/usr/bin/env python3
"""Independent deterministic registration label fixtures; Rust executable optional."""
import argparse
import json
from pathlib import Path
import random
import subprocess

SPECS=[('repoql','official_plugin_or_mcp','repoql',True,True),
       ('kanzo','project_mcp','kanzo',False,True),
       ('memorycore','repoql_memorycore_connector',None,False,False),
       ('openmausbot','local_paired_mcp','openmausbot',False,True)]


def oracle(names):
    registered={}
    for n in names:registered.setdefault(n.lower(),n)
    required={};missing=[];notverified=[]
    for key,requirement,alias,plugin,mcp in SPECS:
        exact=[registered[alias]] if alias in registered else []
        wrappers=sorted(set(n for n in names if alias is not None and n.lower()!=alias
                            and alias in n.lower()))[:3]
        if exact: status,reason='configured',None
        elif not mcp:status,reason='not_verified','connector_registration_not_inspected'
        elif wrappers:status,reason='not_verified','unrecognised_wrapper_name'
        else:status,reason='missing','no_matching_registration'
        entry={'requirement':requirement,'status':status,'servers':exact,
               'pluginAlternative':plugin,'reason':reason}
        if wrappers:entry['unknownWrappers']=wrappers
        required[key]=entry
        if status=='missing':missing.append(key)
        if status=='not_verified':notverified.append(key)
    return {'required':required,'requiredMissing':missing,
            'requiredNotVerified':notverified,
            'verification':'configuration_only_no_live_tool_calls','liveHealthClaimed':False}


def cases():
    yield []
    yield ['repoql','kanzo','openmausbot']
    yield ['not-repoql','repoql-test','fake-kanzo','combo-openmausbot']
    yield ['RepoQL','repoql','repoQL','kanzo']
    rng=random.Random(35237)
    choices=['repoql','kanzo','openmausbot','memorycore','repoql-test','kanzo-test',
             'not-memorycore','openmausbot-proxy','combo-tools','RepoQL', 'KANZO',
             'XrepoqlY','random','rql','repoql-plus','TEST', '']
    for _ in range(496):
        yield [rng.choice(choices) for _ in range(rng.randrange(0,70))]


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--rust-cli',type=Path)
    args=parser.parse_args();binary=args.rust_cli.resolve() if args.rust_cli else None
    if binary and not binary.is_file():parser.error('compiled Rust CLI missing')
    count=0
    for names in cases():
        expected=oracle(names)
        request={'schema':'singularity-claude-mcp-inventory/v1','names':names}
        if binary:
            proc=subprocess.run([str(binary)],input=json.dumps(request),text=True,
                                encoding='utf-8',capture_output=True,shell=False,timeout=15)
            if proc.returncode or json.loads(proc.stdout)!=expected:
                raise AssertionError(f'compiled Claude MCP inventory mismatch case={count}')
        count+=1
    assert count==500
    if binary:
        base={'schema':'singularity-claude-mcp-inventory/v1','names':['repoql']}
        for invalid in (dict(base,token='PRIVATE'),dict(base,names=['a\nprivate']),
                        dict(base,names=[{'env':'PRIVATE'}]),dict(base,names=['repoql']*1025)):
            proc=subprocess.run([str(binary)],input=json.dumps(invalid),text=True,
                                capture_output=True,shell=False,timeout=15)
            if proc.returncode==0 or 'PRIVATE' in proc.stdout+proc.stderr:
                raise AssertionError('Rust Claude inventory accepted private or malformed input')
        print(f'CLAUDE_MCP_INVENTORY_COMPILED_PARITY_PASSED: {count} cases')
    else:
        print(f'CLAUDE_MCP_INVENTORY_REFERENCE_ONLY_PASSED: {count} cases (Rust executable NOT_RUN)')


if __name__=='__main__':main()
