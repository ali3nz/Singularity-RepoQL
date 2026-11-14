#!/usr/bin/env python3
"""Deterministic model billing reference; compiled Rust parity is a separate gate.

The Rust binary receives only whitelisted usage metadata, never prompts or
private runtime identifiers. Reference mode does not claim native acceptance.
"""
import argparse
import json
import os
from pathlib import Path
import random
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / 'dashboard'))
from harness_telemetry import model_usage_metrics


def cases():
    samples = [
        {'engine':'openai-sol','model':'chatgpt/review','inputTokens':4500,'outputTokens':2000,'costUsd':500.0},
        {'engine':'openai-sol','model':'chatgpt/review','usageScope':'sender','sendInputTokens':90.8,'sendOutputTokens':16.2,'sendCostUsd':0.015},
        {'engine':'opencode-go','model':'deepseek/flash','inputTokens':15,'outputTokens':7,'costUsd':0.12},
        {'engine':'freebuff','model':'','inputTokens':0,'outputTokens':0},
        {'engine':'chatgpt','model':'llm','usageScope':'transport','sendInputTokens':0,'sendOutputTokens':0,'sendCostUsd':0.0},
        {'engine':'chatgpt-sol','model':'','usageScope':'transport','sendInputTokens':True,'sendOutputTokens':False},
        {'engine':'openai-sol','model':'','usageScope':'unknown','sendCostUsd':1.0},
        {'engine':'claude','model':'model/noop','inputTokens':0,'costUsd':None},
        {'engine':'openai', 'model':'','costUsd':-2.3, 'outputTokens':None},
    ]
    rng = random.Random(47311)
    engines = ['openai-sol','chatgpt','chatgpt-sol','opencode-go','claude','freebuff','OTHER','']
    models = ['chatgpt/think','model/noop','claude/opus','', 'MiMo/Flash', 'plain']
    scopes = ['sender','transport','outbound_request','receiver','',None]
    for _ in range(600):
        row = {'engine':rng.choice(engines),'model':rng.choice(models), 'usageScope':rng.choice(scopes)}
        for key in ['inputTokens','outputTokens','sendInputTokens','sendOutputTokens']:
            row[key] = rng.choice([None,0,42,1.9,1000.1, 1e16, -2, True, False])
        for key in ['costUsd','sendCostUsd']:
            row[key]=rng.choice([None,0,0.001,12.3,1e9,1e9-1, -3, True])
        samples.append(row)
    return samples


def check_native(binary, rows, expected):
    for start in range(0,len(rows),128):
        batch = rows[start:start+128]
        # Input projection is constructed by the Python boundary itself. Its
        # response is checked byte-for-byte semantically against the reference.
        import harness_telemetry as h
        def runner(argv, **kwargs):
            return subprocess.run([str(binary)], input=kwargs['input'], text=True,
                capture_output=True,timeout=30, env=kwargs['env'])
        actual = h.model_usage_metrics(batch, rust_bin=binary, runner=runner)
        if actual != expected[start:start+128]:
            raise AssertionError(f'compiled Rust mismatch in batch {start//128}')
    # The native command must independently refuse any unexpected field.
    bad = {'schema':'singularity-model-usage/v1', 'rows':[{'model':'x','prompt':'private'}]}
    result=subprocess.run([str(binary)],input=json.dumps(bad),capture_output=True,text=True,timeout=30)
    payload=json.loads(result.stdout)
    if result.returncode != 0 or payload != {'ok':False,'code':'UNEXPECTED_FIELD'}:
        raise AssertionError('native binary accepted a private field')


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--rust-cli',type=Path)
    args=parser.parse_args()
    rows=cases()
    # This is the Python reference, not Rust execution.
    reference = [model_usage_metrics(rows[i:i+128], rust_bin='')
                 for i in range(0,len(rows),128)]
    expected=[v for batch in reference for v in batch]
    if args.rust_cli:
        if not args.rust_cli.is_file():
            parser.error('compiled Rust binary missing')
        check_native(args.rust_cli.resolve(),rows,expected)
        print(f'NATIVE_TELEMETRY_PARITY_PASSED: {len(rows)} cases plus private-field rejection')
    else:
        print(f'TELEMETRY_REFERENCE_ONLY_PASSED: {len(rows)} cases (Rust executable NOT_RUN)')


if __name__=='__main__': main()
