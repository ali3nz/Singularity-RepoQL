#!/usr/bin/env python3
"""Read-only answerability oracle and optional compiled Rust differential.

This suite does not query RepoQL, MemoryCore, Kanzo or an LLM. The absence
of --rust-cli is explicitly reported as NOT_RUN, not a Rust parity pass.
"""
import argparse
import json
import os
import subprocess
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--repo', required=True, type=Path)
parser.add_argument('--rust-cli', type=Path)
args = parser.parse_args()
root = args.repo.resolve()

channels = [
    'error-signature-exact', 'exact-identifier', 'procedure-runbook',
    'skill-approved', 'repoql-concept', 'repoql-code-symbol',
    'docs-current', 'episode-historical', 'tencent-l0-keyword',
    'tencent-l1-semantic', 'policy-insight', 'temporal-fact',
    'entity-relationship', 'custom-unknown',
]
intents = ['exact', 'how-to', 'what-happened', 'why-recurring', 'where-am-i', 'temporal', 'unknown']
claims = ['The service is active', '  The service is active', 'the\tservice\nis active',
          'cache 25 expires', 'Another claim', '', 'révision prête']
cases = []
for n in range(210):
    mode = ['answerability-packet', 'answerability-expanded', 'answerability-conflicts'][n % 3]
    width = n % 5
    rows = []
    for j in range(width):
        row = {
            'id': f'{n}-{j}', 'channel': channels[(n + j * 7) % len(channels)],
            'claimText': claims[(n // 3 + j) % len(claims)],
            'validity': ['CURRENT', 'STALE', 'invalid', 'CURRENT'][((n // 5) + j) % 4],
        }
        if (n + j) % 4 == 0: row['exact'] = True
        if j % 3 == 0: row['origin'] = 'repoql'
        if n % 11 == 0: row.pop('validity', None)
        rows.append(row)
    if n % 10 in (0, 1) and len(rows) >= 2:
        rows[1]['claimText'] = rows[0]['claimText']
        rows[0]['validity'] = 'CURRENT'
        rows[1]['validity'] = 'STALE'
    fused = {'ok': n % 29 != 0, 'candidates': rows}
    if n % 29 == 0: fused['code'] = 'GATE_DENIED'
    case = {'command': mode, 'plan': {'intent': intents[n % len(intents)]}, 'fused': fused}
    if mode == 'answerability-conflicts': case = {'command': mode, 'candidates': rows}
    cases.append(case)

script = r'''
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
delete process.env.SINGULARITY_RUST_MEMORY_POLICY_BIN;
const source = await import(pathToFileURL(resolve(process.argv[1], 'harness/kit/lib/memory-orchestra/answerability.mjs')));
const inputs = JSON.parse(fs.readFileSync(0, 'utf8'));
console.log(JSON.stringify(inputs.map(c => {
  let value;
  if (c.command === 'answerability-packet') value = source.judgePacket(c);
  else if (c.command === 'answerability-expanded') value = source.judgeExpandedCancellation(c.plan,c.fused);
  else value = source.detectConflicts(c.candidates);
  return {ok:true,value};
})));
'''

def run(cmd, payload):
    env = os.environ.copy()
    env.pop('SINGULARITY_RUST_MEMORY_POLICY_BIN', None)
    result = subprocess.run(cmd, input=json.dumps(payload, ensure_ascii=False), text=True,
                            capture_output=True, timeout=20, check=False, env=env)
    if result.returncode != 0:
        raise AssertionError((cmd[0], 'EXIT_NONZERO', result.returncode, result.stderr[:300]))
    return json.loads(result.stdout)

reference = run(['node', '--input-type=module', '-e', script, str(root)], cases)
assert len(reference) == len(cases)
for i, item in enumerate(reference):
    assert item.get('ok') is True and 'value' in item, ('INVALID_REFERENCE', i, item)

if args.rust_cli:
    binary = args.rust_cli.resolve(strict=True)
    for i, (case, expected) in enumerate(zip(cases, reference)):
        command = case['command']
        actual = run([str(binary), command], {k:v for k,v in case.items() if k != 'command'})
        if actual != expected:
            raise AssertionError(('RUST_ANSWERABILITY_DIFFERENTIAL', i, case, expected, actual))
print(json.dumps({'suite': 'memory-answerability', 'referenceCases': len(cases),
    'reference': 'PASS', 'rustDifferential': 'PASS' if args.rust_cli else 'NOT_RUN_NO_BINARY',
    'memoryMutations': 0, 'releaseReady': False}))
