#!/usr/bin/env python3
"""Reference and optional real Rust differential for the conflict gate.

Does not promote, change, or read any persisted memory. Without --rust-cli
this measures only existing JS behavior, never Rust parity.
"""
import argparse
import json
import os
import subprocess
from pathlib import Path

p = argparse.ArgumentParser()
p.add_argument('--repo', type=Path, required=True)
p.add_argument('--rust-cli', type=Path)
a = p.parse_args()
root = a.repo.resolve()
script = r'''
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
delete process.env.SINGULARITY_RUST_MEMORY_POLICY_BIN;
const mod=await import(pathToFileURL(resolve(process.argv[1], 'harness/kit/lib/concept-conflict-gate.mjs')));
const inputs=JSON.parse(fs.readFileSync(0,'utf8'));
console.log(JSON.stringify(inputs.map(({command,...v}) => {
  if(command==='contradiction-signal')return {ok:true,signal:mod.contradictionSignal(v.claimA,v.claimB)};
  if(command==='numeric-divergence')return {ok:true,signal:mod.numericDivergenceSignal(v.claimA,v.claimB)};
  if(command==='extract-invariant')return {ok:true,value:mod.extractInvariant(v.body)};
  if(command==='parse-capsule')return {ok:true,value:mod.parseCapsule(v.body)};
  throw new Error('unknown fixture command');
})));
'''

cases = []
seeds = [
 ('policy required value', 'policy forbidden value'),
 ('feature enabled by default', 'feature disabled by default'),
 ('provider must run', 'provider must not run'),
 ('service is allowed on port 443','service is rejected on port 443'),
 ('label primary', 'label retired'),
 ('keep all records', 'keep all records'),
 ('the issue is resolved', 'issue remains open'),
 ('feature is true','feature is false'),
 ('policy required value', 'different policy forbidden value'),
 ('never do this', 'always do this'),
 ('error rate 1.5','error rate 2.0'),
 ('réglage actif', 'réglage non actif'),
 ('⚙️ State 25\nmore', '⚙️ State 50\nmore'),
 ('', 'unknown'),
]
for first, second in seeds:
    for command in ('contradiction-signal', 'numeric-divergence'):
        cases.append({'command':command,'claimA':first,'claimB':second})
        cases.append({'command':command,'claimA':second,'claimB':first})
for noun in ['window','lease','memory TTL','retry','batch','worker','slot','bridge','prefix','queue']:
    for before, after in [(1,2),(14,30),(30,30),(3,50),(100,101),(0,10)]:
        for command in ('contradiction-signal','numeric-divergence'):
            cases.append({'command':command, 'claimA':f'{noun} is {before} days', 'claimB':f'{noun} is {after} days'})
for status in ['required','forbidden','optional','retired','active','primary','enabled','disabled','allowed','rejected']:
    for alt in ['never','always','must','is not','is','supported','deprecated']:
        cases.append({'command':'contradiction-signal','claimA':f'service {status} now','claimB':f'service {alt} now'})
frontmatters = [None, '', '# Note', '---\ncategory: rule\n---\n# Heading',
 '---\ndescription: "Hello"\nrelevance: high\nverification: EXTERNAL\nttl: 14\n---\n# A title',
 '---\nverified:\ndate: 2026-01-01\nttl: 0\n---\n# Another title',
 '---\nverified:\n  date: 2026-01-01\nttl: bad\n---\n# Another',
 '---\ncategory: knowledge\nttl: -5\n---\n# Lesson',
 '---\ncategory: rule\r\n---\n# Windows',
 'junk\n---\ncategory: rule\n---\n# Later',
 '---\ncategory: rule\nrelevance: global\n---\n# Title\n**Invariant**\nfoo\n**Example**\nbar']
for body in frontmatters:
    cases.append({'command':'parse-capsule','body':body})
for body in [None, '', 'no invariant', '**Invariant**\nKeep facts exact',
     '**Invariant**  \nMust be scoped\n**Example**\nText',
     '**Invariant**\n\nEvidence first\n\n**Rationale**\nMore',
     'prefix **Invariant**\nClaim A\n**Notes**\nTail',
     '**Invariant**\nA\n**Not really a header**\nB']:
    cases.append({'command':'extract-invariant','body':body})

def invoke(cmd, data, *, many=False):
    env = os.environ.copy()
    env.pop('SINGULARITY_RUST_MEMORY_POLICY_BIN', None)
    proc = subprocess.run(cmd, input=json.dumps(data, ensure_ascii=False),
        capture_output=True, text=True, timeout=20, env=env, check=False)
    if proc.returncode:
        raise AssertionError(('reference/cli failure', cmd, proc.returncode, proc.stderr[:500], proc.stdout[:500]))
    result = json.loads(proc.stdout)
    if many and len(result) != len(data): raise AssertionError('reference cardinality')
    return result

reference = invoke(['node','--input-type=module','-e',script,str(root)],cases,many=True)
if a.rust_cli:
    binary = a.rust_cli.resolve(strict=True)
    for index, (case, desired) in enumerate(zip(cases, reference)):
        actual = invoke([str(binary),case['command']],{k:v for k,v in case.items() if k!='command'})
        if actual != desired:
            raise AssertionError(('RUST_DIFFERENTIAL_MISMATCH',index,case,desired,actual))
print(json.dumps({'suite':'memory-conflict-signals','referenceCases':len(cases),
    'reference':'PASS','rustDifferential':'PASS' if a.rust_cli else 'NOT_RUN_NO_BINARY',
    'memoryMutation':'NONE','releaseReady':False}))
