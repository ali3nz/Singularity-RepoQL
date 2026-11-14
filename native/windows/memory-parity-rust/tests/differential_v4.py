#!/usr/bin/env python3
"""Candidate lifecycle and TTL reference/Rust differential, without live writes.

No --rust-cli means reference verification only. Native policy parity is NOT_RUN.
"""
import argparse
import copy
import json
import os
from pathlib import Path
import subprocess

ap=argparse.ArgumentParser()
ap.add_argument('--repo',type=Path,required=True)
ap.add_argument('--rust-cli',type=Path)
a=ap.parse_args()
root=a.repo.resolve()
fixed='2026-11-12T00:00:00.000Z'
NODE=r'''
import fs from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const file=pathToFileURL(resolve(process.argv[1],'harness/kit/lib/memory-candidate-v2.mjs')).href;
const { validateLifecycleTransition, isTtlDue } = await import(file);
const realDate=Date;
globalThis.Date = class extends realDate {
  constructor(...args) { super(...(args.length?args:['2026-11-12T00:00:00.000Z'])); }
  static now(){ return realDate.parse('2026-11-12T00:00:00.000Z'); }
};
const v=JSON.parse(fs.readFileSync(0,'utf8'));
let result;
if (v.command==='candidate-transition') {
  try { const candidate=validateLifecycleTransition(v.candidate,v.toState,{verification:v.verification??null});
    result={ok:true,accepted:true,candidate}; }
  catch(e) {result={ok:true,accepted:false,reason:e.message};}
} else { const t=isTtlDue(v.candidate,{now:new Date(v.now)});result={ok:true,...t}; }
console.log(JSON.stringify(result));
'''


def call(argv,data,reference=False):
    env=os.environ.copy()
    if reference:env.pop('SINGULARITY_RUST_MEMORY_POLICY_BIN',None)
    p=subprocess.run(argv,input=json.dumps(data),capture_output=True,text=True,timeout=15,env=env,check=False)
    if p.returncode!=0:
        raise AssertionError(('nonzero command',argv,p.returncode,p.stderr[:100]))
    try:return json.loads(p.stdout)
    except ValueError as exc:raise AssertionError(('non-JSON result',argv,p.stdout[:100])) from exc


anchored={'provenance':[{'kind':'live-evidence','uri':'file:///snapshot.mjs'}],'id':'MC20001',
          'claim':'a testable invariant','contentDigest':'abcdef0123','caseId':'case-1'}
no_anchor={'provenance':[],'id':'MC20002','claim':'unverified text'}
entries=[]
for from_state in ('OBSERVATION','CANDIDATE','VERIFIED','EXPIRED','SUPERSEDED'):
    for to in ('CANDIDATE','VERIFIED','EXPIRED','SUPERSEDED','INVALIDATED','UNKNOWN'):
        for proof in (False,True):
            cand=copy.deepcopy(anchored if proof else no_anchor)
            cand['maturityState']=from_state
            entries.append({'command':'candidate-transition','candidate':cand,
                            'toState':to,'verification':'reviewed test receipt' if proof else None,
                            'closedAt':fixed})
for maturity in ('OBSERVATION','CANDIDATE','VERIFIED'):
    for time in (None,'2026-11-01T00:00:00Z','2026-11-10T00:00:00Z',
                 '2026-11-15T00:00:00Z','bad-date','2026-11-01'):
        for ttl in (None,1,3,'3'):
            cand={'maturityState':maturity,'ttlDays':ttl}
            if time is not None: cand['verifiedAt']=time
            entries.append({'command':'candidate-ttl','candidate':cand,'now':fixed})

for i,data in enumerate(entries):
    ref=call(['node','--input-type=module','-e',NODE,str(root)],data,reference=True)
    if a.rust_cli:
        rust=call([str(a.rust_cli.resolve()),data['command']],data)
        if ref!=rust:
            raise AssertionError((i,'mismatch',data,ref,rust))
print(json.dumps({'referenceCases':len(entries),'reference':'PASS',
    'rustDifferential':'PASS' if a.rust_cli else 'NOT_RUN_NO_BINARY',
    'liveMemoryBackend':'NOT_RUN','releaseReady':False}))
