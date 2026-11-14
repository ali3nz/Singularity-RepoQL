#!/usr/bin/env python3
"""Claude hook Rust capture preparation differential. Reference-only without --rust-cli.

No real memory, credentials or live transcript are read. Test inputs are synthetic
and never printed on a disagreement, which could otherwise expose secret-shaped data.
"""
import argparse
import json
import subprocess
from pathlib import Path


def make_cases():
    secrets = [
        '', 'nothing sensitive', 'api_key=notsecret', 'token: abcdefghijklmnop',
        'token=somevaluewithlength', 'secret: value-with_underscores1234',
        'password="12345678"', 'PaSsWoRd = abcdefghijkl', 'API-KEY = ABCDEFGHIJ',
        'sk-abcdef12345678', 'sk-1abcdefghi', 'sk-short',
        'ghp_abcdefghijk', 'gho_AAAAAAAAAAA', 'github_pat_longalphabet0123456789',
        'AKIAABCDEFGHIJKL', 'AKIAABCDEFGHIJKL_MORE',
        'prefix sk-abc123456789 suffix', '⛄️token=abc123456789',
        'ümlaut sk-abc123456789', 'token=abc123456789\nsecret = testsecret123',
        'token="abcdefgh" and token=12345678',
        'API_KEY: aaaa1234; OTHER=foo',
        'token: ___----_++', 'literal backslash\\token=abcdefghi',
        'password = zzzzzzzz/abc? trailing',
        'token: sk-abc123456789',
        'ghp_abcdefghijklmnop\nsk-abcdefghijk',
        'skip AKIAABCDEFGHIJK', 'AKIAABCDEFGHIJKL',
        'éabc token=abc123456789',
    ]
    cases = [{'command': 'hook-redact', 'text': x} for x in secrets]
    # Deterministic generated cases widen the token punctuation and boundary coverage.
    alphabet = 'abcXYZ09_.-+=/🙂é'
    for i in range(144):
        value = ''.join(alphabet[(i * 17 + j * 7 + i * j) % len(alphabet)] for j in range(8 + i % 23))
        prefix = ('token', 'secret', 'password', 'api_key', 'api-key', 'apikey')[i % 6]
        sep = (':', ' = ', ':\t', '=')[i % 4]
        cases.append({'command': 'hook-redact', 'text': f'item{i} {prefix}{sep}{value} end'})
    for i in range(112):
        session = f'session/{i}🌐' if i % 3 else f'session\\{i}'
        cases.append({
            'command': 'hook-capture-id',
            'parts': [session, f'singularity-agent-{i % 7}', f'lesson {i} with é, 🙃 and escaped \\ symbols'],
            'sessionKey': session,
        })
    cases += [
        {'command': 'hook-capture-id', 'parts': ['', '', ''], 'sessionKey': ''},
        {'command': 'hook-capture-id', 'parts': ['"', '\\', '\n'], 'sessionKey': '\n'},
        {'command': 'hook-capture-id', 'parts': ['a', 'b', 'a/b'], 'sessionKey': 'slash'},
    ]
    return cases


NODE_ORACLE = r'''
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
delete process.env.SINGULARITY_RUST_MEMORY_POLICY_BIN;
const hook = await import(pathToFileURL(resolve(process.argv[1], 'adapters/claude-code/memory-hook.mjs')));
const requests=JSON.parse(fs.readFileSync(0,'utf8'));
const digest=(text, n)=>createHash('sha256').update(text).digest('hex').slice(0,n);
const output=requests.map(req => {
  if (req.command === 'hook-redact') return {ok:true,text:hook.redactSecrets(req.text)};
  if (req.command === 'hook-capture-id') return {ok:true,
    taskId:'cc-'+digest(JSON.stringify(req.parts),16), sessionHash8:digest(req.sessionKey,8)};
  throw new Error('unknown reference fixture command');
});
process.stdout.write(JSON.stringify(output));
'''


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--repo', required=True, type=Path)
    parser.add_argument('--rust-cli', type=Path)
    args=parser.parse_args()
    root=args.repo.resolve()
    cases=make_cases()
    raw=json.dumps(cases,ensure_ascii=False).encode('utf-8')
    result=subprocess.run(['node','--input-type=module','--eval',NODE_ORACLE,str(root)],input=raw,
        stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=30,check=True)
    expected=json.loads(result.stdout)
    assert len(expected)==len(cases)
    assert all(entry.get('ok') is True for entry in expected)
    if args.rust_cli:
        rust_cli=args.rust_cli.resolve()
        if not rust_cli.is_file():
            raise SystemExit('Compiled Rust hook CLI not found')
        for index,(case,reference) in enumerate(zip(cases,expected)):
            command=case['command']
            payload={k:v for k,v in case.items() if k!='command'}
            proc=subprocess.run([str(rust_cli),command],input=json.dumps(payload,ensure_ascii=False).encode('utf8'),
                stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=5)
            try: actual=json.loads(proc.stdout)
            except (ValueError,UnicodeDecodeError):
                raise AssertionError(f'Rust hook case {index} {command} invalid JSON output') from None
            if proc.returncode!=0 or actual!=reference:
                raise AssertionError(f'Rust hook case {index} {command} differs from reference')
        print(f'COMPILED_RUST_HOOK_PARITY_PASS {len(cases)}')
    else:
        print(f'JS_HOOK_REFERENCE_ONLY_PASS {len(cases)}; Rust NOT_RUN')


if __name__=='__main__':
    main()
