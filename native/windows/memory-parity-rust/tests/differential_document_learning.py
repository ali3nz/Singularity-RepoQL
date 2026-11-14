#!/usr/bin/env python3
"""Golden tests for document policy and self-learning identity.

The source-only run checks the authoritative JavaScript results. Passing
--rust-cli additionally compares the compiled binary per case; it never
substitutes a Python reimplementation for executable Rust acceptance.
"""
import argparse
import json
import subprocess
import sys
from pathlib import Path

NODE_ORACLE = r'''
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const root=process.argv[1];
delete process.env.SINGULARITY_RUST_MEMORY_POLICY_BIN;
const doc=await import(pathToFileURL(path.join(root,'scripts/doc-policy.mjs')));
const lesson=await import(pathToFileURL(path.join(root,'scripts/selflearn-candidates.mjs')));
const inputs=JSON.parse(fs.readFileSync(0,'utf8'));
const outputs=[];
for(const input of inputs){
  try {
    if(input.command==='doc-policy-classify') {
      const {material,skipped}=doc.classifyFiles(input.files);
      outputs.push({ok:true,material,skipped,docsOnly:doc.isDocsOnlyChange(input.files)});
    } else if(input.command==='doc-root-entries') {
      outputs.push({ok:true,roots:doc.parseDocRootEntries(input.raw,input.platform)});
    } else if(input.command==='selflearn-candidate-id') {
      outputs.push({ok:true,id:lesson.candidateId(input.session,input.files)});
    } else if(input.command==='selflearn-validate-lesson') {
      outputs.push({ok:true,value:lesson.validateLesson(input.raw,{allowedRefs:input.allowedRefs})});
    } else { throw new Error('unknown case'); }
  } catch(error){ outputs.push({ok:false,code:String(error.message).slice(0,128)}); }
}
process.stdout.write(JSON.stringify(outputs));
'''

NAME_PARTS = [
    'src/main.rs', 'docs/note.md', 'README.md', 'assets/logo.svg',
    'data/selflearn/pending/01.rs', 'data/doc-policy/report.log',
    'data/doc-index/revision.rs', 'data/acceptance/a.py', 'data/opencode/config.rs',
    'data/attach-backups/old.py', 'data/agent-backups/old.md',
    'src/generated/foo.rs', '.repoql/concepts/x.py',
    'vendor/lib/config.toml', 'node_modules/foo.js', 'build/app.exe',
    'scripts/a.js', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
    'MANIFEST.json', 'SHA256SUMS', 'a.md', 'a.mdx', 'a.txt', 'a.lock',
    'a.min.js', 'x-backup.py', 'x.tmp', 'x.bak-old', 'log~',
    'αβ.py', 'docs/🙂.md', 'docs/雪.md', 'DOCS/NOTE.MD',
    'a.bak', '/some/path/hidden/.git/config', 'data\\selflearn\\foo.md',
    'C:\\work\\node_modules\\index.js', 'C:\\a\\b.min.js',
    'test.d.ts', 'src/.config', 'foo', '', 'a/b/c.', '///',
]

def cases():
    result=[]
    native_platform='win32' if sys.platform.startswith('win') else 'linux'
    for i in range(310):
        names=[NAME_PARTS[(i*13+j*7+j*j) % len(NAME_PARTS)] for j in range(i % 11)]
        if i % 17 == 3: names += [names[0]] if names else ['src/a.py']
        result.append({'command':'doc-policy-classify','platform':native_platform, 'files':names})
    root_samples=[
        ('win32',' C:\\workspace ; D:\\docs ;'),('linux','/home/a:/mnt/data'),
        ('win32','A:B; C:D'),('linux','A:B; C:D'),('win32',' ; ; '),
        ('darwin','/a:/b::'),('win32','\\\\server\\share;C:\\work'),
    ]
    for i in range(125):
        platform,raw=root_samples[i%len(root_samples)]
        result.append({'command':'doc-root-entries','raw':raw+(';' if i%3==2 else ''),
                       'platform':platform})
    files=['src/main.py','README.md','🧠/brain.md','🌟/star.md','\ue000/mid.md',
           '雪/雪.md','docs/[alpha].md','DOCS/NOTE.MD','C:\\source\\a.rs',
           'path/space x.md','docs/🙂/δ.md','a\\b\\c.md','', 'a.rs']
    sessions=['', 'run1', 'RÜN', '🧠', 'a\nb', 'colon:session', '  ', '日',
              '🙂 and \ue000', 'résumé']
    for i in range(245):
        selected=[files[(i*5+j*7+j*j)%len(files)] for j in range(i%9)]
        if i%5==0: selected += selected[:2]
        result.append({'command':'selflearn-candidate-id',
                       'session':sessions[i%len(sessions)],'files':selected})
    base={'schema':'selflearn.lesson.v1','title':'  MatchEvidence  ',
          'lesson':'  Verified evidence is required before promotion.  ',
          'category':'bugfix','generalizable':True,'confidence':'medium',
          'needsVerification':False,'evidenceRefs':['src/test.rs'],'duplicateOf':None}
    for i in range(270):
        raw=base.copy()
        allowed=['src/test.rs','docs/notes.md']
        case=i%22
        if case==0:raw=None
        elif case==1:raw={'schema':'selflearn.lesson.v1','noLesson':True}
        elif case==2:raw={'schema':'selflearn.lesson.v1','noLesson':True,'extra':1}
        elif case==3:raw['schema']='invalid'
        elif case==4:raw['unknown']='extra'
        elif case==5:raw.update({'other':'x','unknown':'y'})
        elif case==6:raw['title']='  '
        elif case==7:raw['title']='🧠'*41
        elif case==8:raw['title']='x'*80
        elif case==9:raw['lesson']='🌟'*301
        elif case==10:raw['lesson']=' '
        elif case==11:raw['category']='invalid'
        elif case==12:raw['generalizable']='true'
        elif case==13:raw['confidence']='guess'
        elif case==14:raw['needsVerification']=None
        elif case==15:raw['evidenceRefs']=[]
        elif case==16:raw['evidenceRefs']=['missing.rs']
        elif case==17:raw['evidenceRefs']=['src/test.rs','src/test.rs','docs/notes.md']
        elif case==18:raw['evidenceRefs']=[55]
        elif case==19:raw['duplicateOf']=''
        elif case==20:raw['duplicateOf']=99
        else:raw['title']='  Ω Unicode title   '
        row={'command':'selflearn-validate-lesson','raw':raw,'allowedRefs':allowed,
             'rawKeys':list(raw) if isinstance(raw,dict) else []}
        result.append(row)
    return result


def run():
    parser=argparse.ArgumentParser()
    parser.add_argument('--repo',required=True,type=Path)
    parser.add_argument('--rust-cli',type=Path)
    args=parser.parse_args()
    repo=args.repo.resolve()
    rows=cases()
    process=subprocess.run(['node','--input-type=module','--eval',NODE_ORACLE,str(repo)],
                           input=json.dumps(rows,ensure_ascii=False).encode(),
                           stdout=subprocess.PIPE,stderr=subprocess.PIPE,check=True,timeout=35)
    reference=json.loads(process.stdout)
    assert len(reference)==len(rows)
    assert all(v.get('ok') for v in reference), 'JS reference unexpectedly rejected a fixture'
    if args.rust_cli:
        binary=args.rust_cli.resolve()
        if not binary.is_file():raise SystemExit('Rust executable not found; native parity NOT_RUN')
        for index,(row,want) in enumerate(zip(rows,reference)):
            payload={k:v for k,v in row.items() if k!='command'}
            result=subprocess.run([str(binary),row['command']],
              input=json.dumps(payload,ensure_ascii=False).encode(),stdout=subprocess.PIPE,
              stderr=subprocess.PIPE,timeout=5)
            try:got=json.loads(result.stdout)
            except (ValueError,UnicodeDecodeError) as e:
                raise AssertionError(f'Invalid Rust JSON at case {index}') from e
            if result.returncode!=0 or got!=want:
                raise AssertionError(f'Document learning native parity mismatch at case {index}, {row["command"]}')
    print('DOCUMENT_LEARNING_REFERENCE_CASES_OK',len(rows))
    print('NATIVE_RUST_DIFFERENTIAL_PASS' if args.rust_cli else 'NATIVE_RUST_DIFFERENTIAL_NOT_RUN')

if __name__=='__main__':run()
