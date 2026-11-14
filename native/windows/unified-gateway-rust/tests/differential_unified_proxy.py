"""Compiled Rust transport parity through the real authenticated dashboard."""
import argparse
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
from unittest.mock import patch

from differential_dashboard_listener import dashboard, request

import unified_bridge as bridge


@contextmanager
def upstream():
    class Target(BaseHTTPRequestHandler):
        requests = []
        response = 'ok'

        def do_GET(self):
            self.handle_verb()

        def do_POST(self):
            self.handle_verb()

        def handle_verb(self):
            n = int(self.headers.get('Content-Length', '0'))
            body = self.rfile.read(n) if n else b''
            self.requests.append((self.command, self.path, self.headers.get('Authorization'), body))
            if self.response == 'redirect':
                self.send_response(302)
                self.send_header('Location', '/do-not-follow')
                payload = b'{}'
            elif self.response == 'unauthorized':
                self.send_response(401)
                payload = b'{"error":"must_not_reflect_fixture"}'
            else:
                self.send_response(200)
                payload = b'{' if self.response == 'invalid' else (
                    b'x' * (8 * 1024 * 1024 + 1) if self.response == 'oversize'
                    else b'{"available":true,"ok":true}')
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *args):
            pass

    with ThreadingHTTPServer(('127.0.0.1', 0), Target) as server:
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            yield Target, server.server_port
        finally:
            server.shutdown()
            worker.join(timeout=5)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--rust-cli', required=True, type=Path)
    binary = parser.parse_args().rust_cli.resolve(strict=True)
    with tempfile.TemporaryDirectory() as td, upstream() as (target, upstream_port):
        root = Path(td).resolve()
        secret = root/'gateway.token'
        secret.write_text('synthetic-unified-key\n')
        # Only this temporary Python upstream has synthetic ownership.
        # Real Windows identity checks run separately; refusal below stays live.
        with dashboard(root/'dashboard') as (server, _), \
                patch.object(bridge, 'BASE', f'http://127.0.0.1:{upstream_port}'), \
                patch.object(bridge, 'SECRET_FILE', secret), \
                patch.object(bridge, '_native_gateway_owner', return_value=True):
            port = server.server_address[1]
            account = server.RequestHandlerClass.app.local_account
            cookie = {'Cookie': 'srq_session=' + account.issue_session()}
            csrf = {**cookie, 'Origin': f'http://127.0.0.1:{port}',
                    'X-Requested-With': 'repoql-dashboard', 'Content-Type': 'application/json'}
            def read(path, headers=cookie):
                status, headers, data = request(port, path, headers=headers)
                return status, {k:v for k,v in headers.items() if k != 'date'}, json.loads(data)

            def collect(selected):
                env = {'SINGULARITY_UNIFIED_PROXY_RUST_BINARY': str(binary) if selected else ''}
                with patch.dict(os.environ, env):
                    target.requests.clear()
                    bridge._graph_cache_clear()
                    result = [read('/api/unified/health', {}),
                              read('/api/unified/openrouter?filter=%E9%8D%B5+%2F%3F%23'),
                              read('/api/unified/tencent/catalog'), read('/api/unified/usage'),
                              read('/api/unified/graph')]
                    assert result[0][0] == 401
                    assert all(row[0] == 200 for row in result[1:])
                    status, _, _ = request(port, '/api/unified/tencent/invoke', 'POST', cookie, b'{}')
                    assert status == 403
                    status, headers, data = request(port, '/api/unified/tencent/invoke', 'POST', csrf,
                                                    b'{"name":"synthetic","args":[1]}')
                    assert status == 200
                    result.append((status, {k:v for k,v in headers.items() if k != 'date'}, json.loads(data)))
                    for behavior, expected in [('redirect','unified_upstream_redirect_refused'),
                                               ('unauthorized','unified_http_401'),
                                               ('invalid','unified_invalid_response'),
                                               ('oversize','unified_response_too_large')]:
                        target.response = behavior
                        value = read('/api/unified/health')
                        assert value[2] == {'available':False,'error':expected}, value
                        result.append(value)
                    target.response = 'ok'
                    assert len(target.requests) == 9
                    assert all(row[2] == 'Bearer synthetic-unified-key' for row in target.requests)
                    return result, target.requests.copy()
            assert collect(False) == collect(True)
            with patch.dict(os.environ, {'SINGULARITY_UNIFIED_PROXY_RUST_BINARY': str(binary)}), \
                    patch.object(bridge, '_native_gateway_owner', return_value=False):
                assert read('/api/unified/health')[2]['error'] == 'windows_local_unified_gateway_unverified'
            with patch.dict(os.environ, {'SINGULARITY_UNIFIED_PROXY_RUST_BINARY': str(root/'missing.exe')}):
                assert read('/api/unified/health')[2]['error'] == 'unified_native_transport_unavailable'
            count = len(target.requests)
            with patch.dict(os.environ, {'SINGULARITY_UNIFIED_PROXY_RUST_BINARY': str(binary)}):
                secret.write_text('multiline\nfixture\n')
                assert read('/api/unified/health')[2]['error'] == 'unified_gateway_not_configured'
                secret.write_text('synthetic-unified-key\n')
            frame = {'host':'127.0.0.1','port':upstream_port,'route':'health','token_file':str(secret),
                     'query':'','body':None}
            for change in ({'host':'192.0.2.10'}, {'query':'x=#fragment'}, {'route':'foreign'},
                           {'body':'{}'}, {'headers':{'Authorization':'foreign'}},
                           {'token_file':str(root/'absent.token')}):
                p = subprocess.run([str(binary)],input=json.dumps({**frame,**change}),text=True,
                                   capture_output=True,timeout=4,check=True)
                assert json.loads(p.stdout)['available'] is False
            assert len(target.requests) == count
    print('UNIFIED_PROXY_COMPILED: six fixed routes; HTTP auth/origin, query/body, redirect, status, oversize and no-fallback parity')


if __name__ == '__main__':
    main()
