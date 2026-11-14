"""Optional privacy-preserving Rust graph projection for stored see-also edges.

The authenticated dashboard resolves and filters capsule links in Python.
The native process sees positional node identifiers only, never names, URIs,
invariants, paths, or link text. Python checks every native output for parity.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess

SCHEMA = 'singularity-dashboard-graph/v1'
MAX_PAIRS = 20_000
MAX_NODES = 40_000
MAX_BYTES = 512 * 1024
MAX_OUTPUT_BYTES = 16 * 1024


def _reference(node_count, pairs):
    seen = set()
    nodes = []
    edges = []
    for left, right in pairs:
        for index in (left, right):
            if index not in seen:
                seen.add(index)
                nodes.append(index)
        edges.append([left, right])
        if len(seen) >= 120:
            break
    return {'node_indices': nodes[:120], 'edge_indices': edges[:200],
            'truncated': len(seen) >= 120}


def project_graph(node_count, pairs, *, rust_bin=None, runner=subprocess.run):
    binary = os.environ.get('SINGULARITY_GRAPH_PROJECTION_RUST_BINARY', '') if rust_bin is None else rust_bin
    if not binary:
        return _reference(node_count, pairs)
    if type(node_count) is not int or not 0 <= node_count <= MAX_NODES or len(pairs) > MAX_PAIRS:
        raise RuntimeError('graph_native_input_too_large')
    if any(type(pair) not in (list, tuple) or len(pair) != 2
           or any(type(i) is not int or i < 0 or i >= node_count for i in pair)
           for pair in pairs):
        raise RuntimeError('graph_native_invalid_pair')
    path = Path(binary)
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        raise RuntimeError('graph_native_binary_invalid')
    parent = path.parent
    while parent != parent.parent:
        if parent.is_symlink():
            raise RuntimeError('graph_native_binary_invalid')
        parent = parent.parent
    request = json.dumps({'schema':SCHEMA, 'node_count':node_count,
                          'pairs':pairs}, separators=(',', ':'))
    if len(request.encode('utf-8')) > MAX_BYTES:
        raise RuntimeError('graph_native_input_too_large')
    expected = _reference(node_count, pairs)
    env = {k:v for k,v in os.environ.items()
           if k.upper() in {'PATH','SYSTEMROOT','WINDIR','TEMP','TMP','HOME'}}
    try:
        result = runner([str(path)], input=request, text=True,capture_output=True,
                        check=False,shell=False,timeout=8,env=env)
        if result.returncode or len(result.stdout.encode('utf-8')) > MAX_OUTPUT_BYTES:
            raise RuntimeError('graph_native_execution_failed')
        actual = json.loads(result.stdout)
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        raise RuntimeError('graph_native_execution_failed') from exc
    if actual != expected:
        raise RuntimeError('graph_native_parity_mismatch')
    return actual
