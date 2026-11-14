#!/usr/bin/env python3
"""MemoryCore documentation chunk and write-envelope reference differential.

Reference-only runs prove Python fixtures, NOT native Rust parity. An explicit
--rust-cli requires real compiled Rust responses for every case.
"""
from __future__ import annotations
import argparse
import importlib.util
import json
import os
from pathlib import Path
import random
import subprocess
import sys


def reference_module(root: Path):
    os.environ.pop('SINGULARITY_DOC_RUST_BIN', None)
    sys.path.insert(0, str(root / 'scripts'))
    spec = importlib.util.spec_from_file_location('doc_index_reference', root / 'scripts/memory-doc-ingest.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def fixtures(module):
    rng = random.Random(190019)
    result = []
    elements = ['# Main\n', '\n## Topic\n', '```rust\n# code\n```\n',
                '🙂', '🧠', 'é', 'alpha ', 'C:\\path\\note.md', '\r\n', '\u2028',
                'plain line\n', 'a'*500, 'g'*6900, 'X'*14500, '\n', '\n### detail\n']
    for i in range(320):
        if i in (0,1,2,3):
            texts = ['', 'hello\n', '🧠'*18000, '\r\n']
            content = texts[i]
        else:
            content = ''.join(elements[rng.randrange(len(elements))] for _ in range(i%24+1))
        try:
            chunks = module._chunk_markdown_reference(content)
        except module.Blocked:
            continue
        assert len(chunks) <= 64
        assert all(len(piece) <= 7000 for piece in chunks)
        result.append(('doc-index-chunks', {'text':content}, {'ok':True,'chunks':chunks}))

    for i in range(280):
        chunks = [] if i%13==0 else [elements[rng.randrange(len(elements))] for _ in range(i%7+1)]
        chunks = [c for c in chunks if len(c)<=7000]
        rel = ['docs/guide.md','docs/notes é.md','safe/🧠.md','basic.md'][i%4]
        title = ['Guide','Résumé','🧠 Knowledge','Safe steps'][i%4]
        root_id = module.sha(f'root{i%17}')[:8]
        doc_id = module.sha(f'{root_id}::{rel}')[:8]
        rev = module.sha(f'content:{i}')[:8]
        ts = '2026-11-12T15:00:00Z'
        team, user = 'singularity-docs', 'shared'
        request = {'chunks':chunks,'rel':rel,'title':title,'rootId':root_id,
                   'docId':doc_id,'rev':rev,'timestamp':ts,'team':team,'user':user}
        tasks = module._chunk_tasks_reference(chunks, rel,title,root_id,doc_id,rev,ts,team,user)
        result.append(('doc-index-plan',request,{'ok':True,'tasks':tasks}))
    for i in range(240):
        entries=[]
        for j in range(i % 31):
            valid=(j+i)%9 != 0
            root=f'{j%7:08x}'
            rel=f'docs/{(j+i)%13}.md'
            rev=f'{j%4:08x}'
            entries.append({'index':j,'validMarker':valid,'superseded':(j+i)%17==0,
                            'hasEntry':(j+i)%5!=0,'rootAllowed':(j+i)%7!=0,
                            'activeRevMatches':(j+i)%4!=0,'verifiedActive':(j+i)%6!=0,
                            'rootId':root,'rel':rel,'rev':rev})
        stale=i%3==0
        roots_restricted=i%4==0
        limit=(i%18)+1
        expected=module._select_retrieval_indices_reference(entries,limit,stale,roots_restricted)
        request={'candidates':module._native_retrieval_facts(entries),'limit':limit,'includeStale':stale,
                 'rootsRestricted':roots_restricted}
        result.append(('doc-index-select',request,{'ok':True,'indices':expected}))
    for i in range(384):
        pinned = bool(i % 2)
        rows = [[bool(rng.getrandbits(1)), pinned and bool(rng.getrandbits(1))]
                for _ in range(i % 49)]
        eligible = [j for j, (match, same_root) in enumerate(rows)
                    if match and (not pinned or same_root)]
        expected = eligible[0] if eligible and (pinned or len(eligible) == 1) else None
        assert module._locate_entry_index_reference(rows, pinned) == expected
        result.append(('doc-index-locate', {'candidates': rows, 'rootPinned': pinned},
                       {'ok': True, 'index': expected}))
    # Invalid request tail must not be hidden by an earlier valid match.
    result.append(('doc-index-locate', {'candidates': [[True, True], [False, 1]], 'rootPinned': True},
                   {'ok': False, 'code': 'DOC_INDEX_INVALID_INPUT'}))
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--repo', type=Path, required=True)
    parser.add_argument('--rust-cli', type=Path)
    opts = parser.parse_args()
    if opts.rust_cli and not opts.rust_cli.is_file():
        parser.error('compiled Rust CLI not found')
    cases = fixtures(reference_module(opts.repo.resolve()))
    assert len(cases) >= 500
    for n,(command,request,expected) in enumerate(cases):
        encoded = json.dumps(request,ensure_ascii=False)
        if any(s in encoded for s in ('gatewayKey','Authorization','memory.json','PRIVATE_KEY_VALUE')):
            raise AssertionError(f'sensitive fixture value crossed native boundary at case {n}')
        if opts.rust_cli is None:
            continue
        process = subprocess.run([str(opts.rust_cli), command], input=encoded.encode('utf-8'),
                                 capture_output=True,timeout=10,check=False)
        try:
            actual = json.loads(process.stdout)
        except (ValueError,UnicodeError):
            raise AssertionError(f'Rust document ingestion response is not JSON: case {n}') from None
        if process.returncode != (0 if expected['ok'] else 2) or actual != expected:
            raise AssertionError(f'Rust documentation differential mismatch: case {n}: '
                                 f'command={command}; exit={process.returncode}; '
                                 f'expected={repr(expected)[:120]} actual={repr(actual)[:120]}')
    print('DOC_INDEX_REFERENCE_CASES_OK',len(cases))
    print('NATIVE_RUST_DIFFERENTIAL_PASS' if opts.rust_cli else 'NATIVE_RUST_DIFFERENTIAL_NOT_RUN')


if __name__=='__main__': main()
