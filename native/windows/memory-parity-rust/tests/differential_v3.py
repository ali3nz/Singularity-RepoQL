#!/usr/bin/env python3
"""Read-only source-vs-compiled-Rust policy comparison.

No live authority or service mutation. The JS reference is always run with the
Rust switch disabled, so equality cannot be faked by routing both sides to the
same Rust binary. --rust-cli is required for an actual Rust acceptance verdict.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile

NODE = r'''
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const [root,cmd] = process.argv.slice(1);
const arg = JSON.parse(fs.readFileSync(0,'utf8'));
const load = async rel => import(pathToFileURL(path.join(root,rel)).href);
let out;
if(cmd==='rank') {
  const m = await load('harness/kit/lib/repoql-client.mjs');
  out = {ok:true,results:m.liveSourceOrder(arg.results,arg.query)};
} else if(cmd==='temporal') {
  const m = await load('harness/kit/lib/memory-temporal.mjs');
  const opt={capsuleBody:arg.capsuleBody??null,temporal:arg.temporal??null};
  const verdict=arg.mode==='current' ? m.currentTruth({...opt,now:new Date(arg.now)})
    : arg.mode==='historical' ? m.historicalTruth({...opt,asOf:arg.asOf})
    : m.beliefTruth({...opt,asOf:arg.asOf});
  out={ok:true,verdict};
} else if(cmd==='tombstone-claim' || cmd==='tombstone-check') {
  const m = await load('harness/kit/lib/memory-tombstone.mjs');
  const result=cmd==='tombstone-claim' ? m.claimIsRejected(arg) : m.evaluateTombstones(arg);
  out={ok:true,blocked:result.blocked,matchedIndex:result.blocked?arg.tombstones.indexOf(result.tombstone):null};
} else if(cmd==='payload-budget') {
  const m=await load('harness/kit/lib/payload-budget.mjs');
  out=m.budgetPayload(arg.files,{totalCap:arg.totalCap??24000,perFileCap:arg.perFileCap??8000});
} else if(cmd==='split-bytes') {
  const m=await load('harness/kit/lib/payload-budget.mjs');
  out={ok:true,parts:m.splitIntoByteParts(arg.text,arg.cap)};
} else if(cmd==='task-links') {
  const m=await load('memory/portable/task-recovery.mjs');
  out={ok:true,units:m.linkedCaptureUnits(arg.ledger,arg.taskId,arg.agent)};
} else if(cmd==='lineage-filter') {
  const m=await load('harness/kit/lib/memory-lineage.mjs');
  const v=m.excludeInvalidFromCurrentRetrieval(arg.recordNames,arg.lineageDir);
  out={ok:true,kept:v.kept,excluded:v.excluded,historical:false};
} else if(cmd==='candidate-policy') {
  const m=await load('harness/kit/lib/memory-candidate-v2.mjs');
  const c=arg.candidate;
  out={ok:true,hasAnchoredProvenance:m.hasAnchoredProvenance(c),isDerivedProvenance:m.isDerivedProvenance(c),
   hasIndependentProvenance:m.hasIndependentProvenance(c,{excludeUri:arg.excludeUri??null}),precedenceRank:m.precedenceRank(c)};
} else if(cmd==='memory-impact-files') {
  const m=await load('harness/kit/lib/memory-impact.mjs');
  out={ok:true,...m.computeMemoryImpact({changedFiles:arg.changedFiles,subsystemHint:arg.subsystemHint,
   minScore:arg.minScore,knowledgeFiles:arg.files})};
} else throw Error('Unknown differential command: '+cmd);
process.stdout.write(JSON.stringify(out));
'''


def invoke(argv, payload, *, clear_rust=False):
    env = os.environ.copy()
    if clear_rust:
        env.pop('SINGULARITY_RUST_MEMORY_POLICY_BIN', None)
    p = subprocess.run(argv, input=json.dumps(payload), text=True, capture_output=True,
                       timeout=30, env=env)
    if p.returncode:
        raise AssertionError(f'command {argv[0]} failed rc={p.returncode}: {p.stderr[:500]}')
    return json.loads(p.stdout)


def cases(tmp):
    root = Path(tmp)
    tombs = [
        {'name': 'OldValue', 'subject': 'Renewal', 'field': 'period', 'status': 'active',
         'rejectedClaim': '30 days', 'scope': 'concept:///knowledge/**'},
        {'name': 'Retired', 'subject': 'Renewal', 'status': 'retired',
         'rejectedClaim': '14 days'},
        {'name': 'Elsewhere', 'status': 'active', 'rejectedClaim': '7 days',
         'scope': 'concept:///else/**'},
    ]
    originals = [
        ('rank', {'query':'src/config.mjs','results':[
            {'uri':'local:///src/config.mjs.bak','score':.9},
            {'uri':'local:///src/config.mjs','score':.3},
            {'uri':'local:///src/config.js','score':.8}]}),
        ('rank', {'query':'unknown','results':[]}),
        ('rank', {'query':'test','results':[
            {'uri':'local:///a/a.md','score':.1},
            {'uri':'local:///b/a.md.bak','score':.8}]}),
        ('temporal', {'mode':'current','now':'2026-11-12T00:00:00Z','capsuleBody':'---\ncategory: rule\n---\nlegacy'}),
        ('temporal', {'mode':'current','now':'2026-11-12T00:00:00Z','capsuleBody':'---\nvalidFrom: 2027-01-01T00:00:00Z\n---\nfuture'}),
        ('temporal', {'mode':'current','now':'2026-11-12T00:00:00Z','temporal':{'validFrom':'2026-01-01T00:00:00Z','validTo':'2027-01-01T00:00:00Z'}}),
        ('temporal', {'mode':'historical','asOf':'2026-06-12T00:00:00Z','temporal':{'validFrom':'2026-01-01T00:00:00Z','validTo':'2027-01-01T00:00:00Z'}}),
        ('temporal', {'mode':'historical','asOf':'2026-06-12T00:00:00Z','temporal':{'recordedAt':'2026-01-01T00:00:00Z'}}),
        ('temporal', {'mode':'belief','asOf':'2026-06-12T00:00:00Z','temporal':{'recordedAt':'2026-01-01T00:00:00Z'}}),
        ('temporal', {'mode':'belief','asOf':'2026-06-12T00:00:00Z','temporal':{'recordedAt':'2027-01-01T00:00:00Z'}}),
        ('tombstone-claim', {'claim':'30 days','scope':'concept:///knowledge/Renewal.md','tombstones':tombs}),
        ('tombstone-claim', {'claim':'14 days','scope':'concept:///knowledge/Renewal.md','tombstones':tombs}),
        ('tombstone-claim', {'claim':'7 days','scope':'concept:///knowledge/Renewal.md','tombstones':tombs}),
        ('tombstone-check', {'subject':'Renewal','field':'period','claim':'30 days',
                             'scope':'concept:///knowledge/Renewal.md','tombstones':tombs}),
        ('tombstone-check', {'subject':'Renewal','field':'period','claim':'14 days',
                             'scope':'concept:///knowledge/Renewal.md','tombstones':tombs}),
        ('payload-budget', {'files':[{'name':'alpha','content':'éé'},{'name':'beta','content':'🎉'}],
                            'totalCap':5,'perFileCap':6}),
        ('payload-budget', {'files':[{'name':'alpha','content':'abc'},{'name':'beta','content':'de'}],
                            'totalCap':100,'perFileCap':100}),
        ('payload-budget', {'files':[]}),
        ('split-bytes', {'text':'hello\nworld\n', 'cap':5}),
        ('split-bytes', {'text':'é🎉é\nhello', 'cap':6}),
        ('split-bytes', {'text':'', 'cap':8}),
        ('candidate-policy', {'candidate':{'provenance':[{'kind':'derived','uri':'concept:///a'}]}}),
        ('candidate-policy', {'candidate':{'provenance':[{'kind':'live-evidence','uri':'file:///a'}]}}),
        ('candidate-policy', {'candidate':{'provenance':[{'kind':'live-evidence','uri':'concept:///self'}]}, 'excludeUri':'concept:///self'}),
        ('candidate-policy', {'candidate':{'provenance':[{'kind':'operator-decision','runId':'run-1'}]}}),
        ('candidate-policy', {'candidate':{'provenance':[{'kind':'live-evidence','uri':'file:///a','error':'malformed'}]}}),
        ('task-links', {'ledger':{'units':{'oc:s1:1-2':{
            'status':'reconciled','task_id_source':'binding','task_id':'task-abcdef1234',
            'agent':'alpha','session_id':'s1','first_seq':1,'last_seq':2,'at':'2026-11-12T00:00:00Z'}}},
                        'taskId':'task-abcdef1234','agent':'alpha'}),
        ('task-links', {'ledger':{'units':{}}, 'taskId':'kanzo:123','agent':'alpha'}),
    ]
    lineage = root/'lineage'
    lineage.mkdir()
    records=[('alpha','known'),('beta','stale'),('gamma','invalid'),('delta','legacy_unknown')]
    for name,state in records:
        (lineage/f'{name}.json').write_text(json.dumps({'recordId':name,'lineageState':state}))
    originals.append(('lineage-filter', {'recordNames':[n for n,_ in records]+['missing'],
                                         'lineageDir':str(lineage), 'states':dict(records)}))
    docs=root/'docs'
    docs.mkdir()
    paths=[]
    for i,text in enumerate(['context-pack harness', 'harness context retrieval', 'unrelated note',
                             'harness context pack retrieval code']):
        file=docs/f'memory{i}.md'
        file.write_text(text)
        paths.append(str(file))
    originals += [
        ('memory-impact-files', {'changedFiles':['harness/kit/lib/context-pack.mjs'],
                                 'subsystemHint':'context retrieval','files':paths}),
        ('memory-impact-files', {'changedFiles':[], 'files':paths}),
    ]
    return originals


def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('--repo',type=Path,required=True)
    ap.add_argument('--rust-cli',type=Path)
    args=ap.parse_args()
    root=args.repo.resolve()
    totals={}
    with tempfile.TemporaryDirectory(prefix='singularity-wave5-parity-') as temp:
        for command,payload in cases(temp):
            ref=invoke(['node','--input-type=module','-e',NODE,str(root),command],payload,clear_rust=True)
            if args.rust_cli:
                rust_payload=dict(payload)
                rust_payload.pop('lineageDir',None)
                if command=='memory-impact-files':
                    # Rust disk-reader command takes the same explicit list.
                    pass
                actual=invoke([str(args.rust_cli.resolve()),command],rust_payload)
                if actual!=ref:
                    raise AssertionError(f'{command}: DIFFERENTIAL MISMATCH\nJS {ref!r}\nRUST {actual!r}')
            totals[command]=totals.get(command,0)+1
    if args.rust_cli:
        # The native memory-impact reader must fail CLOSED if a trusted
        # knowledge source disappears. A fabricated empty content would make
        # an actually stale concept invisible to REVIEW.
        missing = Path(tempfile.gettempdir()) / 'singularity-memory-impact-file-does-not-exist.md'
        result = subprocess.run(
            [str(args.rust_cli.resolve()), 'memory-impact-files'],
            input=json.dumps({'files':[str(missing)], 'changedFiles':['memory']}),
            text=True, capture_output=True, timeout=10)
        assert result.returncode != 0, 'native reader must reject missing file'
        assert json.loads(result.stdout).get('code') == 'KNOWLEDGE_FILE_UNREADABLE', result.stdout
    print(json.dumps({'ok':True,'referenceCases':sum(totals.values()),'byCommand':totals,
                      'rustCompared':bool(args.rust_cli),'nativeWindowsRuntimeTested':False},indent=2))

if __name__=='__main__':
    main()
