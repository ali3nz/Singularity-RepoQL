#!/usr/bin/env python3
"""Hermetic GUI receipt model parity with optional compiled Windows Rust binary."""
import argparse
import json
import random
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / 'dashboard'))
from native_gui_usage import _public_native_payload, _project_python

PROFILE = {'gui': 'claude-desktop-code'}


def fixtures():
    base = [None, False, 12, [], {}, {'available': False},
            {'available': True, 'recent': [], 'sources': []},
            {'available': True, 'recent': [None, [], False, {}, {'source': 'claude-desktop-code'}]},
            {'available': True, 'sources': [{'id': 'claude-desktop-code', 'events': True}]},
            {'available': True, 'recent': [{'source':'claude-desktop-code','input_tokens':True, 'output_tokens':-1}]},
            {'available': True, 'recent': [{'source': 'freebuff', 'token': 'PRIVATE'},
                                          {'source':'claude-desktop-code','model':'éclair 🧠','input_tokens':7}]},
            {'available': True, 'recent': [{'source':'claude-desktop-code','input_tokens':11}] * 55},
            {'available': True, 'collected_at': '2026-11-13T01:00:00Z'}]
    yield from base
    rng = random.Random(28055)
    gui = 'claude-desktop-code'
    for _ in range(400):
        payload = {'available': rng.choice([True, False, 'False', None]),
                   'provider': {'token': 'PRIVATE'}, 'quota': 1000000, 'freebuff':'PRIVATE',
                   'collected_at': rng.choice([None, '', '2026-11-13T01:00:00Z', 'X' * 55])}
        payload['sources'] = [{
            'id': rng.choice([gui,'freebuff','openchamber-desktop-subscription',None]),
            'status': rng.choice(['ok','partial','unavailable','failed',None,True]),
            'events': rng.choice([0, 4, True, -1, None, 1.5, 2**64]),
            'latest_at': rng.choice([None,'2026-11-13T01:00:00Z','X'*45]),
            'credential': 'PRIVATE'} for _ in range(rng.randrange(1, 12))]
        payload['recent'] = [{
            'source': rng.choice([gui, 'freebuff', 'openchamber-desktop-subscription', None]),
            'timestamp': rng.choice(['2026-11-13T01:00:00Z',None,'X'*50]),
            'model': rng.choice(['sonnet','éclair 🧠',None,'X'*130]),
            'input_tokens': rng.choice([0, 42, 1000000000000000, 1000000000000001, False, None, -20, 4.5]),
            'output_tokens': rng.choice([2, True, None, 3.3, -3]),
            'apiKey': 'PRIVATE'} for _ in range(rng.randrange(0, 21))]
        yield payload


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--rust-cli',type=Path)
    args=parser.parse_args()
    binary=args.rust_cli.resolve() if args.rust_cli else None
    if binary and not binary.is_file(): parser.error('native executable missing')
    count=0
    for payload in fixtures():
        expected=_project_python(payload,profile=PROFILE)
        public=_public_native_payload(payload)
        if _project_python(public,profile=PROFILE)!=expected:
            raise AssertionError(f'allowlist changed Python GUI projection at case {count}')
        if binary:
            req=json.dumps({'payload':public,'gui':PROFILE['gui']},ensure_ascii=False)
            proc=subprocess.run([str(binary)],input=req,text=True,encoding='utf-8',capture_output=True,timeout=10,shell=False)
            if proc.returncode!=0 or json.loads(proc.stdout)!=expected:
                raise AssertionError(f'compiled GUI Rust mismatch at case {count}: exit={proc.returncode}')
            if 'PRIVATE' in proc.stdout:
                raise AssertionError('private upstream GUI metadata escaped into native result')
        count+=1
    if binary:
        proc=subprocess.run([str(binary)],input=json.dumps({'gui':PROFILE['gui'],'payload':{},'secret':'PRIVATE'}),
                            capture_output=True,text=True,encoding='utf-8',timeout=10)
        if proc.returncode==0 or 'PRIVATE' in proc.stdout+proc.stderr:
            raise AssertionError('invalid native GUI request fields not rejected')
        print(f'NATIVE_GUI_USAGE_COMPILED_PARITY_PASSED: {count} cases')
    else:
        print(f'NATIVE_GUI_USAGE_REFERENCE_ONLY_PASSED: {count} cases (Rust executable NOT_RUN)')


if __name__=='__main__':main()
