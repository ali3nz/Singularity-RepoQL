#!/usr/bin/env python3
"""Conservative Linux-runtime candidate inventory for shipped Windows source.

Findings are *source references*, not executable traces. A matching line may be
inside a platform-gated branch or fixture; this tool never certifies parity.
Only file paths, categories and line numbers are returned, never source text,
which may contain credentials. The installer must still fail closed on native
services that have not passed Windows acceptance.
"""
from __future__ import annotations
import argparse
import json
import re
import zipfile
from pathlib import Path

PATTERNS = {
    'linux_proc': re.compile(r'/proc/(?:\w+|\$|\{)'),
    'systemd': re.compile(r'\bsystemctl\b|\bjournalctl\b|\bsystemd\b', re.I),
    'container_runtime': re.compile(r'\b(?:docker|podman|docker-compose)\b', re.I),
    'linux_shell': re.compile(r'\b(?:bash|setsid|nohup|sudo|apt-get)\b', re.I),
    'remote_fleet': re.compile(r'\b(?:ssh|scp|rsync)\b', re.I),
    'unix_socket': re.compile(r'\bUnix(?:Listener|Stream)\b|AF_UNIX', re.I),
}
EXTENSIONS = ('.js', '.mjs', '.cjs', '.py', '.rs', '.ts', '.tsx')


def audit(archive: Path, *, max_occurrences=30):
    result = {'schema':'singularity-native-source-linux-candidates/v1',
              'archive':archive.name, 'finding_is_execution_proof':False,
              'feature_parity_verified':False, 'native_release_ready':False,
              'categories':{}, 'total_candidates':0}
    by_kind={name:[] for name in PATTERNS}
    with zipfile.ZipFile(archive) as z:
        for path in z.namelist():
            if not path.endswith(EXTENSIONS) or path.startswith(('docs/', '.github/')):
                continue
            # No source body is ever copied into the report.
            content=z.read(path).decode('utf-8', 'replace')
            for line_number, line in enumerate(content.splitlines(), 1):
                short=line.lstrip()
                if not short or short.startswith(('#','//','*','/*')):
                    continue
                for kind, pattern in PATTERNS.items():
                    if pattern.search(line):
                        by_kind[kind].append({'path':path,'line':line_number})
    for kind, items in by_kind.items():
        result['categories'][kind]={
            'count':len(items),
            'sample':items[:max_occurrences],
            'truncated':len(items)>max_occurrences}
        result['total_candidates']+=len(items)
    result['note']='Candidates can be dead code, test fixtures or Windows-guarded paths; require runtime process traces and feature receipts before release.'
    return result


def main():
    p=argparse.ArgumentParser();p.add_argument('archive',type=Path);p.add_argument('--output',type=Path)
    args=p.parse_args()
    text=json.dumps(audit(args.archive),indent=2)+'\n'
    if args.output:args.output.write_text(text,encoding='utf-8')
    else:print(text)
    return 0

if __name__=='__main__':raise SystemExit(main())
