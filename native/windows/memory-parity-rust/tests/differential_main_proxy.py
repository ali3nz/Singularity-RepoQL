#!/usr/bin/env python3
"""Parent-session memory routing: JS reference oracle and optional compiled Rust parity.

No credentials, gateway URLs or settings are given to the Rust process.
Reference-only runs do NOT establish native Rust correctness.
"""
from __future__ import annotations
import argparse
import json
from pathlib import Path
import subprocess
import sys

NODE_CASES = r'''
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
delete process.env.SINGULARITY_RUST_MEMORY_POLICY_BIN;
const mod=await import(pathToFileURL(join(process.argv[1],'adapters/claude-code/main-memory.mjs')));
const BASE='http://127.0.0.1:8096/claude-code/default';
const all=[];
for(let i=0;i<192;i++){
  const env={};
  const endpoint=['', BASE, BASE+'/', 'https://foreign.invalid/provider', 'http://localhost:8096/claude-code/default'][i%5];
  if(i%7!==0 && endpoint) env.ANTHROPIC_BASE_URL=endpoint;
  if(i%3===0) env.ANTHROPIC_API_KEY='SYNTHETIC_EXISTING_KEY';
  if(i%6===0) env.CLAUDE_CODE_USE_BEDROCK='1';
  if(i%7===2) env.ANTHROPIC_BEDROCK_BASE_URL='synthetic';
  if(i%8===0) env.CLAUDE_CODE_USE_VERTEX='1';
  if(i%9===4) env.ANTHROPIC_VERTEX_BASE_URL='synthetic';
  if(i%11===3) env.CLAUDE_CODE_USE_FOUNDRY='1';
  if(i%4===2) env.ANTHROPIC_AUTH_TOKEN='SYNTHETIC_OLD_TOKEN';
  if(i%5===2) env.ANTHROPIC_MODEL='synthetic-model-old';
  const settings={env,extra:{privateValue:'SYNTHETIC_PRIVATE_VALUE'}};
  if(i%13===2) settings.apiKeyHelper='synthetic helper';
  const opts={baseUrl:BASE,token:i%4===0?undefined:'SYNTHETIC_NEW_TOKEN',
    model:i%3===0?'synthetic-model-new':undefined,replaceProvider:i%2===0};
  const facts=mod.mainMemoryPolicyFacts(settings,BASE);
  const state=mod.classifyMainMemoryState(settings,BASE);
  all.push({command:'main-memory-state',payload:{facts},expected:{ok:true,value:state}});
  const reference=mod.ensureMainMemoryIntegration(settings,opts);
  const own=facts.ownsEndpoint;
  const conflicts=mod.detectProviderConflicts(settings,{baseUrl:BASE});
  const refused=!own && conflicts.length>0 && !opts.replaceProvider;
  const plan={facts,replaceProvider:opts.replaceProvider,
    writeUrl:!own && !refused && env.ANTHROPIC_BASE_URL!==BASE,
    writeToken:refused?false:own ? Boolean(opts.token && !env.ANTHROPIC_AUTH_TOKEN):Boolean(opts.token && env.ANTHROPIC_AUTH_TOKEN!==opts.token),
    writeModel:refused?false:own ? Boolean(opts.model && !env.ANTHROPIC_MODEL):Boolean(opts.model && env.ANTHROPIC_MODEL!==opts.model),
  };
  all.push({command:'main-memory-plan',payload:plan,expected:{ok:true,value:{mode:reference.mode,changed:reference.changed,reasons:reference.reasons}}});
  const written={};
  if(i%3===0) written.ANTHROPIC_BASE_URL=env.ANTHROPIC_BASE_URL;
  else if(i%3===1) written.ANTHROPIC_BASE_URL=BASE;
  if(i%4===0) written.ANTHROPIC_AUTH_TOKEN=env.ANTHROPIC_AUTH_TOKEN;
  else if(i%4===1) written.ANTHROPIC_AUTH_TOKEN='SYNTHETIC_NOT_CURRENT';
  if(i%5===0) written.ANTHROPIC_MODEL=env.ANTHROPIC_MODEL;
  else if(i%5===1) written.ANTHROPIC_MODEL='SYNTHETIC_NOT_CURRENT_MODEL';
  const prev={};
  if(i%6===0) prev.ANTHROPIC_BASE_URL='https://synthetic.previous.invalid';
  if(i%6===2) prev.ANTHROPIC_AUTH_TOKEN='SYNTHETIC_PREVIOUS_TOKEN';
  if(i%6===4) prev.ANTHROPIC_MODEL='synthetic-previous-model';
  const receipt={mainMemory:{envWritten:written}};
  const removed=mod.removeMainMemoryIntegration(settings,receipt,prev);
  const keys=['ANTHROPIC_BASE_URL','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_MODEL'].map(key=>({
    key,present:env[key]!==undefined,
    matchesReceipt:written[key]!==undefined && env[key]===written[key],
    restorePrevious:prev[key]!==undefined && prev[key]!==''}));
  const operations=removed.changedKeys.map(key=>({key,action:keys.find(x=>x.key===key).restorePrevious?'restore':'remove'}));
  all.push({command:'main-memory-uninstall',payload:{keys},expected:{ok:true,value:{changedKeys:removed.changedKeys,operations}}});
}
console.log(JSON.stringify(all));
'''


def run(repo: Path, binary: Path | None) -> None:
    ref = subprocess.run(['node', '--input-type=module', '--eval', NODE_CASES, str(repo.resolve())],
                         check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                         timeout=25, text=True)
    cases = json.loads(ref.stdout)
    assert len(cases) == 576
    for i, case in enumerate(cases):
        encoded = json.dumps(case['payload'], ensure_ascii=False)
        # Real settings, URLs, and credential values may not cross the IPC boundary.
        for forbidden in ('SYNTHETIC_', 'foreign.invalid', '127.0.0.1:8096', 'privateValue'):
            if forbidden in encoded:
                raise AssertionError(f'Private input crossed native boundary in case {i}')
        if binary:
            call = subprocess.run([str(binary), case['command']], input=encoded.encode('utf-8'),
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=8)
            try:
                actual = json.loads(call.stdout)
            except (UnicodeDecodeError, ValueError):
                raise AssertionError(f'Invalid native JSON at case {i}') from None
            if call.returncode != 0 or actual != case['expected']:
                # Do not print captured payloads, settings, private URLs or tokens.
                raise AssertionError(f'Rust parent-memory policy divergence case {i}, command {case["command"]}')
    print('MAIN_PROXY_REFERENCE_CASES_OK', len(cases))
    print('NATIVE_RUST_DIFFERENTIAL_PASS' if binary else 'NATIVE_RUST_DIFFERENTIAL_NOT_RUN')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--repo', required=True, type=Path)
    parser.add_argument('--rust-cli', type=Path)
    args = parser.parse_args()
    if args.rust_cli and not args.rust_cli.is_file():
        sys.exit('Compiled native Rust executable not found')
    run(args.repo, args.rust_cli)
