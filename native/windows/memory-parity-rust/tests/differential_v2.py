#!/usr/bin/env python3
"""Cross-language reference fixture suite for Rust migration wave two.

Reference-only by default; pass --rust-cli after a native build to assert byte/
JSON identical outputs. All filesystem snapshots live under a temporary directory.
Nothing writes to installed services or production memory.
"""
import argparse
import json
import subprocess
import tempfile
from pathlib import Path

NODE = r'''
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [root, mode] = process.argv.slice(1);
const input = JSON.parse(fs.readFileSync(0,'utf8'));
const load = async (f) => import(pathToFileURL(path.join(root, 'harness/kit/lib', f)).href);
let result;
if (mode === 'candidate-policy') {
  const m = await load('memory-candidate-v2.mjs');
  const c = input.candidate;
  result = { ok:true, hasAnchoredProvenance:m.hasAnchoredProvenance(c),
    isDerivedProvenance:m.isDerivedProvenance(c),
    hasIndependentProvenance:m.hasIndependentProvenance(c, {excludeUri:input.excludeUri ?? null}),
    precedenceRank:m.precedenceRank(c) };
} else if (mode === 'payload-budget') {
  const m = await load('payload-budget.mjs');
  result = m.budgetPayload(input.files, {totalCap:input.totalCap, perFileCap:input.perFileCap});
} else if (mode === 'split-bytes') {
  const m = await load('payload-budget.mjs');
  result = {ok:true, parts:m.splitIntoByteParts(input.text, input.cap)};
} else if (mode === 'memory-impact') {
  const m = await load('memory-impact.mjs');
  const fields = { changedFiles:input.changedFiles, subsystemHint:input.subsystemHint,
    minScore:input.minScore, knowledgeFiles:input.knowledgeFiles.map(r=>r.file) };
  result = {ok:true, ...m.computeMemoryImpact(fields)};
} else if (mode === 'lineage-graph') {
  const m = await load('memory-lineage.mjs');
  result = input.mode === 'ancestors'
    ? m.getAncestors(input.recordId, input.lineageDir, {maxDepth:input.maxDepth})
    : m.getDescendants(input.recordId, input.lineageDir, {maxDepth:input.maxDepth});
} else if (mode === 'lineage-filter') {
  const m = await load('memory-lineage.mjs');
  const v = m.excludeInvalidFromCurrentRetrieval(input.recordNames, input.lineageDir);
  result = {ok:true, kept:v.kept, excluded:v.excluded, historical:false};
} else throw new Error(mode);
process.stdout.write(JSON.stringify(result));
'''

def invoke(cmd, payload):
    p = subprocess.run(cmd, input=json.dumps(payload), text=True, capture_output=True, timeout=15)
    if p.returncode:
        raise RuntimeError(f'{cmd[0]} returned {p.returncode}: {p.stderr[:500]}')
    return json.loads(p.stdout)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--repo', type=Path, required=True)
    parser.add_argument('--rust-cli', type=Path)
    ns = parser.parse_args()
    root = ns.repo.resolve()
    cases = [
        ('candidate-policy', {'candidate':{'provenance':[{'kind':'derived','uri':'concept:///a'}]}}),
        ('candidate-policy', {'candidate':{'provenance':[{'kind':'live-evidence','uri':'file:///a'}, {'kind':'derived','uri':'concept:///a'}]}}),
        ('candidate-policy', {'candidate':{'provenance':[{'kind':'live-evidence','uri':'concept:///self'}]}, 'excludeUri':'concept:///self'}),
        ('candidate-policy', {'candidate':{'provenance':[{'kind':'operator-decision','runId':'run123'}, {'kind':'conversation','uri':'file:///b'}]}}),
        ('candidate-policy', {'candidate':{'provenance':[{'error':'bad','uri':'x'}]}}),
        ('candidate-policy', {'candidate':{}}),
        ('payload-budget', {'files':[{'name':'a','content':'hello'},{'name':'b','content':'🌺'}]}),
        ('payload-budget', {'files':[{'name':'a','content':'🌺🌺🌺'},{'name':'b','content':'hello'}], 'totalCap':10,'perFileCap':8}),
        ('payload-budget', {'files':[{'name':'a','content':'ééé'},{'name':'b','content':'🎉'}], 'totalCap':7,'perFileCap':9}),
        ('payload-budget', {'files':[]}),
        ('split-bytes', {'text':'hello\nworld\n', 'cap':5}),
        ('split-bytes', {'text':'a\né\n🌺\nmore', 'cap':4}),
        ('split-bytes', {'text':'🌺🌺🌺\nx', 'cap':4}),
        ('split-bytes', {'text':'αβγδεζηθ', 'cap':6}),
        ('split-bytes', {'text':'', 'cap':5}),
    ]
    with tempfile.TemporaryDirectory() as d:
        d = Path(d)
        filter_dir = d / 'lineage-filter'
        graph_dir = d / 'lineage-graph'
        filter_dir.mkdir()
        graph_dir.mkdir()
        recs = [
            ('alpha', 'known'), ('beta', 'invalid'), ('gamma', 'stale'), ('delta', 'legacy_unknown')
        ]
        for name, state in recs:
            (filter_dir / (name+'.json')).write_text(json.dumps({'recordId':name, 'lineageState':state}))
        cases.append(('lineage-filter', {'recordNames':[x[0] for x in recs]+['missing'],
                                         'lineageDir':str(filter_dir),
                                         'states':dict(recs)}))
        graph = [
          ('Alpha', {'recordId':'Alpha', 'derivedFrom':['Root']}),
          ('Beta', {'recordId':'Beta', 'sourceClaimIds':['Root']}),
          ('Gamma', {'recordId':'Gamma', 'derivedFrom':['Alpha','Beta']}),
        ]
        for name, obj in graph:
            (graph_dir/(name+'.json')).write_text(json.dumps(obj))
        snapshot = [obj for _, obj in graph]
        cases += [
            ('lineage-graph', {'recordId':'Root', 'mode':'descendants', 'sidecars':snapshot, 'lineageDir':str(graph_dir)}),
            ('lineage-graph', {'recordId':'Gamma', 'mode':'ancestors', 'sidecars':snapshot, 'lineageDir':str(graph_dir)}),
            ('lineage-graph', {'recordId':'None', 'mode':'descendants', 'sidecars':snapshot, 'lineageDir':str(graph_dir)}),
        ]
        knowledge = []
        for idx, text in enumerate(['harness context retrieval', 'unrelated note', 'context pack', 'harness retrieval context pack']):
            f = d / f'memory{idx}.md'
            f.write_text(text)
            knowledge.append({'file':str(f),'content':text})
        cases += [
            ('memory-impact', {'changedFiles':['harness/kit/lib/context-pack.mjs'],
                               'subsystemHint':'context retrieval','knowledgeFiles':knowledge}),
            ('memory-impact', {'changedFiles':[], 'knowledgeFiles':knowledge}),
            ('memory-impact', {'changedFiles':['harness/kit/lib/context-pack.mjs'],
                               'subsystemHint':'context retrieval','knowledgeFiles':knowledge,
                               'minScore':3}),
        ]
        counts = {}
        for mode, data in cases:
            ref = invoke(['node','--input-type=module','-e',NODE,str(root),mode],data)
            assert isinstance(ref, dict) and 'ok' in ref, (mode, ref)
            if mode == 'lineage-filter':
                assert ref['ok'] is True
                assert ref['kept'] == ['alpha', 'delta', 'missing'], ref
                assert ref['excluded'] == [{'name':'beta', 'state':'invalid'},
                                           {'name':'gamma', 'state':'stale'}], ref
                assert ref['historical'] is False
            if ns.rust_cli:
                result = invoke([str(ns.rust_cli.resolve()),mode],data)
                if ref != result:
                    raise AssertionError(f'{mode} does not match source contract:\nREFERENCE {ref}\nRUST {result}')
            counts[mode] = counts.get(mode,0)+1
        print(json.dumps({'ok':True,'referenceCases':sum(counts.values()),'breakdown':counts,
                          'rustCompared':bool(ns.rust_cli),
                          'requiresNativeCompilation':not bool(ns.rust_cli)},indent=2))

if __name__ == '__main__': main()
