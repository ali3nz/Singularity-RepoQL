#!/usr/bin/env python3
"""Deterministic 500-case Claude agent parsed metadata reference; optional Rust."""
import argparse
import json
from pathlib import Path
import random
import subprocess
import sys

ROOT=Path(__file__).resolve().parents[4]
sys.path.insert(0,str(ROOT/'dashboard'))
from claude_agents_control import _frontmatter

NAME='singularity-code-reviewer'


def cases():
    yield {'name':NAME,'description':'Read code','model':'sonnet','effort':'high',
           'tools':'Read, Glob','permissionMode':'plan'}
    yield {'name':NAME,'description':'Review','model':'','effort':'',
           'tools':'Read','permissionMode':''}
    rng=random.Random(36437)
    for i in range(498):
        yield {'name':NAME,'description':f'Review evidence case {i}',
               'model':rng.choice(['sonnet','opus','haiku','inherit','model:custom','my-model.v2','']),
               'effort':rng.choice(['','low','medium','high','max']),
               'tools':rng.choice(['Read','Read, Grep, Glob','Read, Glob','Grep,Search','Bashing','Written']),
               'permissionMode':rng.choice(['','default','plan','acceptEdits','dontAsk'])}


def main():
    p=argparse.ArgumentParser();p.add_argument('--rust-cli',type=Path)
    a=p.parse_args();binary=a.rust_cli.resolve() if a.rust_cli else None
    if binary and not binary.is_file():p.error('Rust executable unavailable')
    total=0
    for metadata in cases():
        fm='---\n'+''.join(f'{key}: {value}\n' for key,value in metadata.items())+'---\n\nPRIVATE_INSTRUCTIONS\n'
        expected=_frontmatter(fm,NAME)
        assert expected==metadata
        if binary:
            request={'schema':'singularity-claude-agent-fields/v1',
                     'owner_name':NAME,'metadata':expected}
            got=subprocess.run([str(binary)],input=json.dumps(request),text=True,
                               capture_output=True,shell=False,timeout=15)
            if got.returncode or json.loads(got.stdout)!={'metadata':expected}:
                raise AssertionError(f'compiled agent metadata parity failed at case {total}')
        total+=1
    assert total==500
    if binary:
        valid={'name':NAME,'description':'Read','model':'sonnet','effort':'high',
               'tools':'Read','permissionMode':'plan'}
        request={'schema':'singularity-claude-agent-fields/v1',
                 'owner_name':NAME,'metadata':valid}
        for invalid in (dict(request,api_key='PRIVATE'),
                        dict(request,metadata=dict(valid,permissionMode='bypassPermissions')),
                        dict(request,metadata=dict(valid,tools='Read, Bash')),
                        dict(request,metadata=dict(valid,model='x;PRIVATE'))):
            got=subprocess.run([str(binary)],input=json.dumps(invalid),text=True,
                               capture_output=True,shell=False,timeout=15)
            if got.returncode==0 or 'PRIVATE' in got.stdout+got.stderr:
                raise AssertionError('compiled Rust agent fields security boundary broken')
        print(f'CLAUDE_AGENT_FIELDS_COMPILED_PARITY_PASSED: {total} cases')
    else:
        print(f'CLAUDE_AGENT_FIELDS_REFERENCE_ONLY_PASSED: {total} cases (Rust executable NOT_RUN)')


if __name__=='__main__':main()
