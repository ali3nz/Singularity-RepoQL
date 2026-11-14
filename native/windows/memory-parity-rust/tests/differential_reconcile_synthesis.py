#!/usr/bin/env python3
"""Run reference selectors; optionally compare compiled Rust memory CLI.

No service calls, no persistent records, no task authorization. A reference
PASS alone NEVER establishes Rust equivalence.
"""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
import random
import subprocess

p = argparse.ArgumentParser()
p.add_argument('--repo', type=Path, required=True)
p.add_argument('--rust-cli', type=Path)
a = p.parse_args()
root = a.repo.resolve()
rng = random.Random(91422)

cases = []
for i in range(160):
    pool = [
        {'role': r, 'content': c, 'timestamp': t}
        for r in ['assistant', 'user', 'system']
        for c in ['', 'memory facts', 'é', 'line 1\nline 2', 'repeat']
        for t in ['2026-11-11', '2026-11-12']
    ]
    messages = [rng.choice(pool).copy() for _ in range(i % 13)]
    rows = [rng.choice(pool).copy() for _ in range(i % 11)]
    if i % 4 == 0 and rows:
        rows[0]['recorded_at'] = rows[0]['timestamp']
        rows[0]['timestamp'] = 'ignored-timestamp'
    cases.append({'command': 'reconcile-missing', 'rows': rows, 'messages': messages})

kinds = ['current_preferences', 'active_projects', 'open_decisions', 'known_conflicts',
         'operator_constraints', 'recent_supersessions', 'unfinished_work', 'unknown', '', None]
for i in range(160):
    n = i % 36
    sources = [('claim-' + str((j * 11 + i) % 31)) for j in range(n)]
    if i % 7 == 0 and sources:
        sources[-1] = sources[0]
    if i % 11 == 0:
        sources = [42, None, False, ['a', None, 'b']]
    cases.append({'command': 'synthesis-validate', 'spec': {
        'type': kinds[i % len(kinds)],
        'summary': ('  fact ' + ('é' if i % 9 == 0 else 'x') * (i % 16)) + '  ',
        'sourceClaimIds': sources,
    }})

script = r'''
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
delete process.env.SINGULARITY_RUST_MEMORY_POLICY_BIN;
const root=process.argv[1];
const rec=await import(pathToFileURL(resolve(root,'scripts/memory-reconcile-core.mjs')));
const synth=await import(pathToFileURL(resolve(root,'harness/kit/lib/memory-synthesis.mjs')));
const rows=JSON.parse(fs.readFileSync(0,'utf8'));
console.log(JSON.stringify(rows.map(({command,...payload})=>{
  if(command==='reconcile-missing') return {ok:true,missingIndexes:rec.missingReconciliationIndexes(payload.rows,payload.messages),totalMessages:payload.messages.length};
  if(command==='synthesis-validate') return {ok:true,value:synth.validateSynthesisSpec(payload.spec)};
  throw new Error('unknown test command');
})));
'''

def execute(cmd, payload):
    env = dict(os.environ)
    env.pop('SINGULARITY_RUST_MEMORY_POLICY_BIN', None)
    proc = subprocess.run(cmd, input=json.dumps(payload,ensure_ascii=False), text=True,
        encoding='utf-8', capture_output=True, timeout=30, env=env, check=False)
    if proc.returncode:
        raise AssertionError(('EXECUTION_FAILED',proc.returncode,proc.stderr[:400]))
    return json.loads(proc.stdout)

expected = execute(['node','--input-type=module','-e',script,str(root)], cases)
assert isinstance(expected,list) and len(expected)==len(cases)
if a.rust_cli:
    rust = str(a.rust_cli.resolve(strict=True))
    for idx,(case,want) in enumerate(zip(cases,expected)):
        actual=execute([rust,case['command']], {k:v for k,v in case.items() if k != 'command'})
        if actual != want:
            raise AssertionError(('RUST_REFERENCE_MISMATCH',idx,case,want,actual))
print(json.dumps({'suite':'reconciliation-and-synthesis','referenceCases':len(cases),
    'reference':'PASS','compiledRustParity':'PASS' if a.rust_cli else 'NOT_RUN_NO_BINARY',
    'memoryWrites':'NONE','releaseReady':False}))
