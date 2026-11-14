#!/usr/bin/env python3
"""Closeout documentation impact classifier Rust/JS parity.

Reference-only without --rust-cli. This tool cannot approve a release.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('--repo', type=Path, required=True)
parser.add_argument('--rust-cli', type=Path)
a = parser.parse_args()
repo = a.repo.resolve()

paths = ['orchestrate.mjs','config.json','lib/engine-router.mjs','lib/case-state.mjs',
'lib/case-store.mjs','lib/approval-artifact.mjs','lib/policy-identity.mjs',
'lib/payload-budget.mjs','lib/repoql-client.mjs','lib/concept-capture.mjs',
'.repoql/concepts/knowledge/Example.md','lib/plan-cache.mjs','openai-sol-bridge.sh',
'lib/sol-humanize.mjs','lib/nanny.mjs','lib/start-guard.mjs','lib/debrief.mjs',
'prompts/plan.txt','other/a.mjs','bootstrapper/source.zip','LIB/nanny.mjs',
'work/ai-orchestration/config.json','work/ai-orchestration/other/b.mjs','',
'documentation/ai-orchestration.md']
inputs = [[], paths, list(reversed(paths))]
for i in range(len(paths)):
    inputs.append(paths[:i+1])
    inputs.append([{'path':p,'status':'modify'} for p in paths[i:i+2]])
    inputs.append([paths[i], paths[i], paths[i]])
script = r'''
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
delete process.env.SINGULARITY_RUST_EVIDENCE_POLICY_BIN;
const {classifyDocImpact,renderDocImpactReport}=await import(pathToFileURL(resolve(process.argv[1], 'harness/kit/lib/doc-impact.mjs')));
const cases=JSON.parse(fs.readFileSync(0,'utf8'));
console.log(JSON.stringify(cases.map(changedFiles=>{
 const classification=classifyDocImpact(changedFiles);
 return {classification,report:renderDocImpactReport(classification)};
})));
'''

def invoke(argv, body):
    env=os.environ.copy()
    env.pop('SINGULARITY_RUST_EVIDENCE_POLICY_BIN',None)
    p=subprocess.run(argv,input=json.dumps(body,ensure_ascii=False),
       capture_output=True,text=True,env=env,timeout=20,check=False)
    if p.returncode:raise AssertionError(('CLI_FAILED',argv,p.stderr[:250],p.stdout[:250]))
    return json.loads(p.stdout)

reference=invoke(['node','--input-type=module','-e',script,str(repo)],inputs)
if a.rust_cli:
    binary=str(a.rust_cli.resolve(strict=True))
    for index,(inp,ref) in enumerate(zip(inputs,reference)):
        actual=invoke([binary,'doc-impact-stdin'],{'changedFiles':inp})
        if actual!=ref['classification']:
            raise AssertionError(('DOC_IMPACT_RUST_MISMATCH',index,inp,ref['classification'],actual))
        report=invoke([binary,'doc-render-stdin'],{'classification':actual})
        if report!={'report':ref['report']}:
            raise AssertionError(('DOC_REPORT_RUST_MISMATCH',index,inp,ref['report'],report))
print(json.dumps({'suite':'doc-impact','referenceCases':len(inputs),
'reference':'PASS','rustDifferential':'PASS' if a.rust_cli else 'NOT_RUN_NO_BINARY',
'noLiveChanges':True,'releaseReady':False}))
