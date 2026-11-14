#!/usr/bin/env python3
"""Pure Windows memory acceptance differential, with optional compiled Rust CLI.

No real profile identities, sources, secrets, service connections or writes.
Run without --rust-cli to check the JavaScript reference fixtures only.
"""
import argparse
import json
import subprocess
from pathlib import Path

ROLES = ['board', 'code-reviewer', 'explore', 'general', 'thinker']


def base_map(seed=0):
    return {role: {'team_id': 'team', 'user_id': 'test', 'agent_id': role + str(seed)} for role in ROLES}


def cases():
    result = []
    for i in range(125):
        mapping = base_map(i)
        parent = {'team_id': 'team', 'user_id': 'test', 'agent_id': 'parent' + str(i)}
        if i % 17 == 0:
            mapping['board'] = mapping['thinker'].copy()
        elif i % 17 == 1:
            mapping['explore']['agent_id'] = 'Ghost'
        elif i % 17 == 2:
            del mapping['code-reviewer']
        elif i % 17 == 3:
            mapping['general']['user_id'] = ' x'
        elif i % 17 == 4:
            mapping['thinker']['extra'] = 'bad'
        elif i % 17 == 5:
            mapping['board'] = 0
        elif i % 17 == 6:
            mapping['board']['team_id'] = 'ghost-companion'
        elif i % 17 == 7:
            mapping['board'] = parent.copy()
        elif i % 17 == 8:
            mapping['general']['user_id'] = '\ufeffhidden'
        elif i % 17 == 9:
            mapping['general']['agent_id'] = '❄' * 64
        elif i % 17 == 10:
            mapping['general']['agent_id'] = '❄' * 65
        elif i % 17 == 11:
            parent = 'invalid'
        elif i % 17 == 12:
            parent = None
        elif i % 17 == 13:
            mapping['general']['team_id'] = 'À Very Unicode Team'
        elif i % 17 == 14:
            mapping['board']['agent_id'] = 'x' * 129
        elif i % 17 == 15:
            mapping['board'] = []
        else:
            mapping['board']['agent_id'] = 'board-' + '☃' * 20
        result.append({'command': 'delegated-identity', 'map': mapping, 'parent': parent,
                       'delegatedRoles': ROLES, 'mainRolesExcluded': 4})
    result += [{'command':'delegated-identity','map':None,'parent':None,'delegatedRoles':ROLES,'mainRolesExcluded':4}]
    issue_groups = [[], ['TENCENT_LEDGER_STALE_OR_UNVERIFIED'],
                    ['REPOQL_INDEX_QUERY_FAILED'], ['SOURCE_CHANGED_DURING_READBACK'],
                    ['DOCUMENT_READBACK_FAILED'], ['TENCENT_X', 'REPOQL_Y'],
                    ['REPOQL_Y', 'SOURCE_CHANGED_DURING_READBACK', 'TENCENT_X'],
                    ['other'], ['TENCENT_'], ['REPOQL_']]
    for i in range(150):
        issues = list(issue_groups[i % len(issue_groups)])
        if i % 4 == 1:
            issues.append('REFERENCE_' + str(i))
        if i % 5 == 2:
            issues.append('TENCENT_LIVE_SEARCH_FAILED')
        if i % 7 == 3:
            issues.append('REPOQL_READ_FAILED')
        result.append({'command':'doc-reconcile-action','issues': issues})
    path_cases = ['', '/', '/docs/a.md', 'docs/../x.md', 'docs/./x.md',
                  'docs//x.md', 'docs/', '.', '..', 'a b.md', 'é/雪.md',
                  'file?query=1.md', 'docs/hash#name.md', 'docs/café + tea.md',
                  'one\\two.md', "quotes/'apostrophe'.md", 'emoji/🙂.md']
    alphabet = 'abcXYZ0123-_.!~*\'()+[]{}é☃'
    for i in range(145):
        seg = ''.join(alphabet[(i * 19 + j * 7 + j * i) % len(alphabet)] for j in range(2 + i % 23))
        path_cases.append((('docs/' + seg + '.md') if i % 3 else (seg + '/child ' + str(i) + '.md')))
    result.extend({'command':'repoql-doc-uri','relative':path} for path in path_cases)
    return result


NODE_ORACLE = r'''
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
delete process.env.SINGULARITY_RUST_MEMORY_POLICY_BIN;
const root=process.argv[1];
const profile=await import(pathToFileURL(path.join(root,'native/windows/claude_complete_memory_profiles.mjs')));
const reconcile=await import(pathToFileURL(path.join(root,'native/windows/claude_complete_doc_reconciliation.mjs')));
const parity=await import(pathToFileURL(path.join(root,'native/windows/claude_complete_doc_parity.mjs')));
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'singularity-win-native-diff-'));
const marker='DOCPARITY-TEST-ABCD123456';
fs.writeFileSync(path.join(dir,'test.md'),`# Fixture\n\n${marker}\n\nSufficient stable test content for the readback.\n`);
const manifest={schema:reconcile.SCHEMA,documents:[{file:'test.md',marker}]};
const requests=JSON.parse(fs.readFileSync(0,'utf8'));
const output=[];
try {
  for(const req of requests) {
    try {
      if(req.command==='delegated-identity') {
        output.push({ok:true,value:profile.validateDelegatedMap(req.map,req.parent)});
      } else if(req.command==='doc-reconcile-action') {
        const receipt=await reconcile.reconcileDocuments({root:dir,manifest,
          parityCheck:async()=>({issues:req.issues,exactTestRevisionVerified:false})});
        output.push({ok:true,action:receipt.documents[0].operatorNextAction});
      } else if(req.command==='repoql-doc-uri') {
        output.push({ok:true,uri:parity.repoqlDocumentUri({relative:req.relative})});
      } else {throw new Error('BAD_COMMAND')}
    } catch (e) {output.push({ok:false,code:String(e.message).slice(0,128)})}
  }
} finally {fs.rmSync(dir,{recursive:true,force:true});}
process.stdout.write(JSON.stringify(output));
'''


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--repo',required=True,type=Path)
    parser.add_argument('--rust-cli',type=Path)
    args=parser.parse_args()
    test_cases=cases()
    raw=json.dumps(test_cases,ensure_ascii=False).encode('utf-8')
    process=subprocess.run(['node','--input-type=module','--eval',NODE_ORACLE,str(args.repo.resolve())],
                           input=raw,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=40,check=True)
    expected=json.loads(process.stdout)
    if len(expected)!=len(test_cases):
        raise AssertionError('JavaScript reference count mismatch')
    if args.rust_cli:
        binary=args.rust_cli.resolve()
        if not binary.is_file():
            raise SystemExit('Compiled Rust binary unavailable')
        for i, (request, reference) in enumerate(zip(test_cases,expected)):
            command=request['command']
            data={k:v for k,v in request.items() if k!='command'}
            actual=subprocess.run([str(binary),command],
                                  input=json.dumps(data,ensure_ascii=False).encode('utf-8'),
                                  stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=5)
            try:
                parsed=json.loads(actual.stdout)
            except (UnicodeDecodeError,ValueError):
                raise AssertionError(f'Invalid native JSON for case {i}') from None
            # No raw identities printed on failure.
            if parsed!=reference or ((actual.returncode == 0) != bool(reference['ok'])):
                raise AssertionError(f'Native Windows acceptance divergence in case {i}, command {command}')
    print(f'WINDOWS_ACCEPTANCE_REFERENCE_CASES_OK {len(test_cases)}')
    print('NATIVE_RUST_DIFFERENTIAL_PASS' if args.rust_cli else 'NATIVE_RUST_DIFFERENTIAL_NOT_RUN')


if __name__=='__main__':
    main()
