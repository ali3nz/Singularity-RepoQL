#!/usr/bin/env python3
"""Offline HTTP differential of the existing JS MemoryCore client vs Rust.

With --rust-cli, executes the compiled native read-only client against the exact
same temporary loopback fixture. Without it, verifies the JS reference only.
No live Tencent service, provider secrets, or installed memory files are touched.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[4]
ORACLE = Path(__file__).with_name('memorycore-oracle.mjs')

class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0))
        if length > 128 * 1024 or self.headers.get('x-tdai-user-key') != 'fixture-reader-key' or self.headers.get('x-tdai-service-id') != 'default':
            self.send_response(403)
            self.end_headers()
            return
        try:
            body = json.loads(self.rfile.read(length))
        except (ValueError, UnicodeError):
            self.send_response(400)
            self.end_headers()
            return
        mode = self.server.scenario
        path = self.path
        if path.startswith('/v3/'):
            if self.headers.get('Authorization') != 'Bearer fixture-gateway-key':
                raise AssertionError('v3 gateway credential absent')
            code, result = 200, {'code': 0, 'data': {'messages': [
                {'role': 'assistant', 'task_id': 't1', 'content': 'verified previous answer'}
            ]}}
            if path.endswith('/count'):
                result = {'code': 0, 'data': {'count': 3}}
            if mode == 'v3_app_failure':
                result = {'code': 451, 'message': 'not permitted'}
            encoded = json.dumps(result, ensure_ascii=False).encode('utf8')
            self.send_response(code)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)
            return
        if mode == 'asset_403' and path.endswith('team-assets'):
            code, result = 403, {'code': 403}
        elif mode == 'bad_assets' and path.endswith('team-assets'):
            code, result = 200, {'code': 0, 'data': {'items': {}}}
        elif mode == 'core_assets' and path.endswith('team-assets'):
            code, result = 200, {'code': 401, 'data': {'items': []}}
        elif path.endswith('team-assets'):
            code, result = 200, {'code': 0, 'data': {'items': [
                {'id': 'block-general', 'title': 'Memory of general'},
                {'id': 'block-auditor', 'title': 'Memory of auditor'},
            ]}}
        elif path.endswith('/search'):
            if body.get('block_id') != 'block-auditor' and body.get('block_id') != 'block-general':
                raise AssertionError('invalid block ID supplied')
            if mode == 'bad_search':
                code, result = 200, {'code': 0, 'data': {'items': {}}}
            elif mode == 'core_search':
                code, result = 200, {'code': 73}
            elif mode == 'search_404':
                code, result = 404, {'code': 404}
            else:
                code, result = 200, {'code': 0, 'data': {'items': [
                    {'id': 'r1', 'score': 0.9, 'title': 'Reference', 'body': 'abc😀z',
                     'tags': ['tag'], 'refs': ['https://example.invalid'], 'created_at': '2026-11-12'},
                    {'id': 'r2', 'score': 0, 'title': 'Second', 'body': 'next'},
                ]}}
        elif path.endswith('/skill/list'):
            if mode == 'core_skills':
                code, result = 200, {'code': 5}
            else:
                code, result = 200, {'code': 0, 'data': {'items': [
                    {'name': 'alpha', 'skill_id': 'skill-1', 'version': 2,
                     'is_head': True, 'status': 'active', 'description': 'Task notes',
                     'team_id': 'team-fixture', 'owner_agent_id': 'agt-fixture',
                     'updated_at_ms': 1234, 'metadata': {'kind': 'reference'}},
                ]}}
        else:
            code, result = 404, {'code': 404}
        data = json.dumps(result, ensure_ascii=False).encode('utf8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)
    def log_message(self, *_args):
        pass

CASES = [
    ('normal-assets', 'normal', 'resolveBlocks', {}),
    ('invalid-assets-schema', 'bad_assets', 'resolveBlocks', {}),
    ('upstream-app-failure', 'core_assets', 'resolveBlocks', {}),
    ('unauthorized-assets', 'asset_403', 'resolveBlocks', {}),
    ('bounded-unicode-search', 'normal', 'search', {'agent': 'auditor', 'query': 'match', 'layer': 'L1'}),
    ('layer-0-search', 'normal', 'search', {'agent': 'general', 'query': 'match', 'layer': 'L0', 'limit': 1}),
    ('strict-agent-identity', 'normal', 'search', {'agent': 'absent', 'query': 'match', 'layer': 'L1'}),
    ('empty-query', 'normal', 'search', {'agent': 'auditor', 'query': '  '}),
    ('search-schema-failure', 'bad_search', 'search', {'agent': 'auditor', 'query': 'match'}),
    ('search-core-failure', 'core_search', 'search', {'agent': 'auditor', 'query': 'match'}),
    ('search-404', 'search_404', 'search', {'agent': 'auditor', 'query': 'match'}),
    ('skill-list', 'normal', 'skillList', {'topN': 6, 'status': 'active'}),
    ('skill-core-failure', 'core_skills', 'skillList', {'topN': 6}),
    ('windows-v3-conversation-search', 'normal', 'v3Read', {'path':'/v3/conversation/search', 'body': {'team_id':'team-fixture','user_id':'user-fixture','agent_id':'agt-fixture','query':'verified','limit':4}}),
    ('windows-v3-atomic-search', 'normal', 'v3Read', {'path':'/v3/atomic/search', 'body': {'team_id':'team-fixture','user_id':'user-fixture','agent_id':'agt-fixture','query':'facts','limit':4}}),
    ('windows-v3-conversation-query', 'normal', 'v3Read', {'path':'/v3/conversation/query', 'body': {'team_id':'team-fixture','user_id':'user-fixture','agent_id':'agt-fixture','session_id':'session-fixture','task_id':'task-fixture'}}),
    ('windows-v3-application-denial', 'v3_app_failure', 'v3Read', {'path':'/v3/conversation/query', 'body': {'team_id':'team-fixture','user_id':'user-fixture','agent_id':'agt-fixture','session_id':'session-fixture'}}),
    ('windows-v3-conversation-count', 'normal', 'v3Read', {'path':'/v3/conversation/count', 'body': {'team_id':'team-fixture','user_id':'user-fixture','agent_id':'agt-fixture'}}),
    ('windows-v3-atomic-count', 'normal', 'v3Read', {'path':'/v3/atomic/count', 'body': {'team_id':'team-fixture','user_id':'user-fixture','agent_id':'agt-fixture'}}),
]

def run(argv, payload, env):
    child = subprocess.run(argv, input=json.dumps(payload, ensure_ascii=False), text=True,
                           capture_output=True, env=env, timeout=20, cwd=ROOT)
    if child.returncode != 0:
        raise AssertionError(f'executable failed: {argv[0]} rc={child.returncode}')
    try:
        return json.loads(child.stdout)
    except json.JSONDecodeError as exc:
        raise AssertionError(f'non-JSON result from {argv[0]}') from exc

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--rust-cli', type=Path)
    args = parser.parse_args()
    if args.rust_cli and not args.rust_cli.is_file():
        parser.error('compiled Rust executable missing')
    with tempfile.TemporaryDirectory(prefix='singularity-reader-diff-') as tmp:
        key = Path(tmp, 'reader.key')
        key.write_text('older-reader-key\nfixture-reader-key\n', encoding='utf8')
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        server.scenario = 'normal'
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            config = Path(tmp, 'memory.json')
            config.write_text(json.dumps({'hostBaseUrl':f'http://127.0.0.1:{server.server_port}',
                            'authPrefix':'Bearer ', 'gatewayKey':'fixture-gateway-key',
                            'userKey':'fixture-reader-key', 'serviceId':'default'}),encoding='utf8')
            env = {**os.environ,
                   'MEMORYCORE_HUB_URL': f'http://127.0.0.1:{server.server_port}',
                   'SINGULARITY_MEMORY_CONFIG': str(config),
                   'MEMORYCORE_V3_CONFIG_FILE': str(config),
                   'MEMORYCORE_KEY_FILE': str(key),
                   'MEMORYCORE_SERVICE_ID': 'default',
                   'MEMORYCORE_TEAM_ID': 'team-fixture',
                   'MEMORYCORE_SKILL_TEAM': 'team-fixture',
                   'MEMORYCORE_SKILL_AGENT': 'agt-fixture',
                   'MEMORYCORE_BUDGET_BYTES': '7',
                   'MEMORYCORE_TIMEOUT_MS': '6000'}
            env.pop('SINGULARITY_RUST_MEMORYCORE_READER_BIN', None)
            for k in ('GHOST_MC_SERVICE_KEY','GHOST_MC_USER_KEY','GHOST_MC_URL','GHOST_MC_SERVICE_ID'):
                env.pop(k,None)
            for label, scenario, op, extra in CASES:
                server.scenario = scenario
                request = {'operation': op, 'team': 'team-fixture',
                           'skillTeam': 'team-fixture', 'skillAgent': 'agt-fixture', **extra}
                reference = run(['node', str(ORACLE)], request, env)
                if not isinstance(reference, dict) or (op != 'v3Read' and not isinstance(reference.get('ok'), bool)):
                    raise AssertionError(f'invalid JS reference shape: {label}')
                if label == 'bounded-unicode-search':
                    assert reference['bytesUsed'] <= 7
                    assert reference['results'][0]['body'] == 'abc😀'
                    assert reference['results'][0]['truncated'] is True
                if args.rust_cli:
                    native = run([str(args.rust_cli)], request, env)
                    if op == 'v3Read' and native.get('ok') is True:
                        native = native.get('payload')
                    if native != reference:
                        raise AssertionError(f'RUST_DIFFERENTIAL_FAILED {label}: expected {reference!r}; received {native!r}')
            print(f'{"NATIVE_RUST_PARITY_PASSED" if args.rust_cli else "REFERENCE_ONLY_PASSED"}: {len(CASES)} read-only MemoryCore scenarios')
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=3)

if __name__ == '__main__':
    main()
