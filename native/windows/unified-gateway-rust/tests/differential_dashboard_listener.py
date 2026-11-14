"""Run the compiled listener around an actual dashboard with disposable state."""
import argparse
import base64
import hashlib
import hmac
from contextlib import contextmanager
import http.client
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / 'dashboard'))
from repoql_bridge import Config
from server import build_native_listener, build_server


@contextmanager
def dashboard(root, binary=None, port=0):
    root.mkdir()
    config = Config(workspace=root, rql=root / 'rql', state_dir=root / 'state',
                    bind='127.0.0.1', port=port, allow_peers=('127.0.0.1/32',))
    with patch.dict(os.environ, {'SINGULARITY_LOCAL_ACCOUNT_AUTH': '1',
                                 'SINGULARITY_WINDOWS_NATIVE': '1',
                                 'SINGULARITY_INSTALL_VARIANT': '2',
                                 'SINGULARITY_DASHBOARD_AUTH_MODE': 'password',
                                 'SINGULARITY_DASHBOARD_ROUTE_RUST_BINARY': ''}):
        native = build_native_listener(config, binary) if binary else None
        server = native.server if native else build_server(config)
        worker = threading.Thread(target=native.serve if native else server.serve_forever, daemon=True)
        worker.start()
        try:
            yield server, native
        finally:
            if native:
                native.close()
            else:
                server.shutdown()
            worker.join(timeout=4)
            server.server_close()
            assert not worker.is_alive()


def request(port, path, method='GET', headers=None, payload=None):
    connection = http.client.HTTPConnection('127.0.0.1', port, timeout=6)
    try:
        connection.request(method, path, body=payload, headers=headers or {})
        response = connection.getresponse()
        return response.status, {k.lower(): v for k, v in response.getheaders()}, response.read()
    finally:
        connection.close()


def password_roundtrip(reference, native):
    # Native setup must preserve the existing on-disk v1 credential format.
    account = native.server.RequestHandlerClass.app.local_account
    assert account.native_store is not None
    record = json.loads(account.path.read_text())
    salt = base64.b64decode(record['salt'])
    expected = base64.b64decode(record['hash'])
    assert expected == hashlib.scrypt(b'fixture-passphrase', salt=salt, n=16384, r=8, p=1, dklen=32)
    for password in ('Fictional 鍵 phrase 1234', '🦊' * 256, ''):
        baseline = hashlib.scrypt(password.encode('utf-8'), salt=salt, n=16384, r=8, p=1, dklen=32)
        assert native.password(password, salt) == baseline
        assert native.password(password, salt, baseline) is True
        assert native.password(password, salt, bytes(v ^ 1 for v in baseline)) is False
    with patch('local_account.hashlib.scrypt', side_effect=AssertionError('Python KDF fallback')), \
            patch.object(account, '_record', side_effect=AssertionError('Python file fallback')):
        assert account.login(record['username'], 'fixture-passphrase', '127.0.0.1')
        try:
            account.login(record['username'], 'incorrect fixture passphrase', '127.0.0.1')
        except ValueError as exc:
            assert str(exc) == 'invalid_credentials'
        else:
            raise AssertionError('wrong password accepted')
        ref_record = json.loads(reference.read_text())
        account.path.write_text(json.dumps(ref_record))
        assert account.login(ref_record['username'], 'fixture-passphrase', '127.0.0.1')
    with patch.object(native, '_control_failed', True):
        try:
            account.login(record['username'], 'fixture-passphrase', '127.0.0.1')
        except RuntimeError as exc:
            assert str(exc) == 'DASHBOARD_NATIVE_ACCOUNT_UNAVAILABLE'
        else:
            raise AssertionError('native failure was not refused')


def account_store_contract(native, root):
    from local_account import AccountRefused, LocalAccount
    from concurrent.futures import ThreadPoolExecutor

    state = root / 'account-storage'
    state.mkdir()
    password = 'synthetic 鍵 passphrase'
    def create(number):
        try:
            return native.account('create', state, username=f'owner{number}', password=password,
                                  salt=[number] * 16)
        except AccountRefused as error:
            return error
    with ThreadPoolExecutor(max_workers=2) as pool:
        a, b = list(pool.map(create, (1, 2)))
    assert sum(value is True for value in (a,b)) == 1
    assert [str(value) for value in (a,b) if isinstance(value,AccountRefused)] == ['account_already_configured']
    legacy = LocalAccount(state, mode='password')
    doc = legacy._record()
    assert legacy.login(doc['username'], password, 'fixture')
    assert native.account('verify', state, username=doc['username'], password=password) is True
    assert native.account('verify', state, username='wrong_owner', password=password) is False
    assert native.account('set_mode', state, mode='password', nonce='a' * 32) is True
    assert json.loads(legacy.mode_path.read_bytes()) == {'version':1,'mode':'password'}
    assert native.account('password_mode', state) is True
    assert native.account('set_mode', state, mode='auto-local', nonce='b' * 32) is True
    assert json.loads(legacy.mode_path.read_bytes()) == {'version':1,'mode':'auto-local'}
    assert native.account('password_mode', state) is False
    legacy.path.write_bytes(b' ' * 4097)
    try:
        native.account('verify', state, username=doc['username'], password=password)
        raise AssertionError('oversized account file accepted')
    except AccountRefused as error:
        assert str(error) == 'account_file_invalid'
    legacy.path.unlink()
    if os.name != 'nt':
        foreign = root / 'foreign-account'
        foreign.write_bytes(b'synthetic foreign fixture')
        legacy.path.symlink_to(foreign)
        try:
            native.account('configured', state)
            raise AssertionError('linked account file accepted')
        except AccountRefused as error:
            assert str(error) == 'account_path_reparse_refused'
        assert foreign.read_bytes() == b'synthetic foreign fixture'


def persisted_mode_restart(binary, root):
    state_root = root / 'persisted-account'
    with patch.dict(os.environ, {'SINGULARITY_WINDOWS_NATIVE':'1',
                                 'SINGULARITY_LOCAL_ACCOUNT_AUTH':'1',
                                 'SINGULARITY_INSTALL_VARIANT':'2',
                                 'SINGULARITY_DASHBOARD_AUTH_MODE':''}):
        config = Config(workspace=root, rql=root/'rql', state_dir=state_root,
                        bind='127.0.0.1', port=0, allow_peers=('127.0.0.1/32',))
        first = build_native_listener(config, str(binary))
        try:
            first.server.RequestHandlerClass.app.local_account.set_mode('password')
        finally:
            first.close()
            first.server.server_close()
        second = build_native_listener(config, str(binary))
        try:
            assert second.server.RequestHandlerClass.app.local_account.mode == 'password'
        finally:
            second.close()
            second.server.server_close()


def uncertain_mode_write(native, root):
    state = root / 'account-storage'
    with patch('native_listener.subprocess.run', side_effect=subprocess.TimeoutExpired('fixture', 1)):
        try:
            native.account('set_mode', state, mode='password', nonce='c' * 32)
            raise AssertionError('unknown write was accepted')
        except RuntimeError as error:
            assert str(error) == 'DASHBOARD_NATIVE_ACCOUNT_UNAVAILABLE'
    assert native._control_failed
    try:
        native.session('clear')
        raise AssertionError('session control still available after an unknown mode change')
    except RuntimeError as error:
        assert str(error) == 'DASHBOARD_NATIVE_SESSION_UNAVAILABLE'


def static_contract(server):
    account = server.RequestHandlerClass.app.local_account
    port = server.server_address[1]
    cookie = {'Cookie': 'srq_session=' + account.issue_session()}
    observations = []
    for path in ('/', '/account.html', '/app.css', '/app.js', '/brain_top.webp',
                 '/not-a-real-dashboard-asset', '/assets/../app.css'):
        # The native resolver intentionally falls back instead of normalizing
        # path aliases. Compare standard browser paths byte for byte.
        status, headers, body = request(port, path, headers=cookie)
        assert status == 200 and headers['cache-control'] == 'no-store'
        if path != '/assets/../app.css':
            observations.append((status, headers['content-type'], body))
    for path in ('/', '/account.html', '/app.js', '/not-a-real-dashboard-asset'):
        status, headers, body = request(port, path)
        assert status == (200 if path in ('/', '/account.html') else 401)
        observations.append((status, headers['content-type'], body))
    return observations


def private_static_refusal(native, root):
    assets = root / 'static'
    assets.mkdir()
    (assets / 'index.html').write_bytes(b'<head>fixture</head>')
    (root / 'private.txt').write_bytes(b'private synthetic fixture')
    for path in ('../private.txt', 'missing', 'index.html:stream', 'x/../../private.txt', 'nul'):
        assert native.asset(assets, path) == (True, 'text/html; charset=utf-8', b'<head>fixture</head>')
    if os.name != 'nt':
        (assets / 'link').symlink_to(root / 'private.txt')
        assert native.asset(assets, 'link')[2] == b'<head>fixture</head>'


def observe(server):
    port = server.server_address[1]
    origin = f'http://127.0.0.1:{port}'
    csrf = {'Origin': origin, 'X-Requested-With': 'repoql-dashboard',
            'Content-Type': 'application/json'}
    setup = json.dumps({'username': 'fixture_owner', 'password': 'fixture-passphrase'}).encode()
    before = request(port, '/api/features')
    assert before[0] == 401
    refused = request(port, '/api/account/setup', 'POST', {**csrf, 'Origin': 'http://localhost:1'}, setup)
    assert refused[0] == 403
    accepted = request(port, '/api/account/setup', 'POST', csrf, setup)
    assert accepted[0] == 200
    assert 'HttpOnly; SameSite=Strict;' in accepted[1]['set-cookie']
    cookie = {'Cookie': accepted[1]['set-cookie'].split(';', 1)[0]}
    account = request(port, '/api/account/status', headers=cookie)
    assert account[0] == 200 and json.loads(account[2])['authenticated']
    features = request(port, '/api/features', headers=cookie)
    assert features[0] == 200
    mutation = request(port, '/api/repos/remove', 'POST', cookie, b'{}')
    assert mutation[0] == 403
    static = request(port, '/', headers=cookie)
    assert static[0] == 200
    health = request(port, '/.well-known/singularity-health')
    assert health[0] == 200 and health[1]['x-singularity-component'] == 'dashboard'
    logged_out = request(port, '/api/account/logout', 'POST', {**cookie, **csrf}, b'{}')
    assert logged_out[0] == 200
    after = request(port, '/api/features', headers=cookie)
    assert after[0] == 401
    return [before[2], refused[2], accepted[2], account[2], features[2], mutation[2], health[2], after[2]]


def read_contract(server, native):
    port = server.server_address[1]
    app = server.RequestHandlerClass.app
    with patch.object(app, 'started_at', 1700000000):
        assert request(port, '/api/health')[0] == 401
        assert request(port, '/api/health', headers={'Authorization': 'Bearer wrong-fixture'})[0] == 401
        assert request(port, '/api/features', headers={
            'Authorization': 'Bearer ' + app.token, 'Sec-Fetch-Site': 'cross-site',
        })[0] == 401
        cookie = {'Cookie': 'srq_session=' + app.local_account.issue_session()}
        machine = {'Authorization': 'Bearer ' + app.token}
        seen = []
        for path, headers in (('/api/features?ignored=1', cookie), ('/api/health', machine),
                              ('/api/account/status', {}), ('/api/account/status', cookie)):
            status, response, body = request(port, path, headers=headers)
            assert status == 200
            seen.append((status, {k: v for k, v in response.items() if k != 'date'}, body))
        if native:
            with patch.object(server.RequestHandlerClass, 'dispatch', side_effect=AssertionError('Python read fallback')):
                assert request(port, '/api/features', headers=cookie)[0] == 200
                assert request(port, '/api/health', headers=cookie)[0] == 200
            with patch('server.hmac.compare_digest', wraps=hmac.compare_digest) as compare:
                assert request(port, '/api/health', headers=machine)[0] == 200
                assert all(not isinstance(args[0], str) for args, _ in compare.call_args_list)
            with patch.object(native, '_control_failed', True):
                assert request(port, '/api/features', headers=machine)[0] == 500
        return seen


def session_lifecycle(server, native):
    account = server.RequestHandlerClass.app.local_account
    port = server.server_address[1]
    origin = f'http://127.0.0.1:{port}'
    csrf = {'Origin': origin, 'X-Requested-With': 'repoql-dashboard',
            'Content-Type': 'application/json'}
    login = json.dumps({'username': 'fixture_owner', 'password': 'fixture-passphrase'}).encode()
    with patch.dict(os.environ, {'SINGULARITY_DASHBOARD_SESSION_TTL': '30'}):
        with patch.object(account, 'clock', return_value=100.0):
            response = request(port, '/api/account/login', 'POST', csrf, login)
            assert response[0] == 200
            cookie = {'Cookie': response[1]['set-cookie'].split(';', 1)[0]}
        with patch.object(account, 'clock', return_value=129.5):
            assert request(port, '/api/features', headers=cookie)[0] == 200
        with patch.object(account, 'clock', return_value=130.0):
            assert request(port, '/api/features', headers=cookie)[0] == 401
    assert account.native_session is not None and account.sessions == {}
    issued = account.issue_session()
    assert account.authenticated('srq_session=' + issued)
    account.set_mode('password')
    assert not account.authenticated('srq_session=' + issued)
    # No fallback to the Python session map when the authority is unavailable.
    with patch.object(native, '_control_failed', True):
        try:
            account.issue_session()
        except RuntimeError as exc:
            assert str(exc) == 'DASHBOARD_NATIVE_SESSION_UNAVAILABLE'
        else:
            raise AssertionError('session was issued after native loss')
    assert account.sessions == {}


def direct_private_refused(native):
    for prefix in (b'', b'SINGULARITY_DASHBOARD_V1 ' + b'0' * 64 + b'\n'):
        with socket.create_connection(('127.0.0.1', native.backend_port), timeout=4) as sock:
            sock.sendall(prefix + b'GET /.well-known/singularity-health HTTP/1.0\r\nHost: localhost\r\n\r\n')
            sock.shutdown(socket.SHUT_WR)
            try:
                assert sock.recv(128) == b''
            except ConnectionResetError:
                pass


@contextmanager
def listener_process(binary, backend_port, public_port=0):
    child = subprocess.Popen([str(binary)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE)
    try:
        child.stdin.write(json.dumps({'port': public_port, 'backend_port': backend_port,
                                     'key': 'b' * 64, 'reply_key': 'c' * 64}).encode() + b'\n')
        child.stdin.flush()
        ready = child.stdout.readline()
        assert ready.startswith(b'READY '), ready
        yield child, int(ready.split()[1])
    finally:
        child.stdin.close()
        try:
            assert child.wait(timeout=4) == 0
        finally:
            if child.poll() is None:
                child.kill()
                child.wait()
            child.stdout.close()
            child.stderr.close()


def websocket_roundtrip(server):
    port = server.server_address[1]
    token = server.RequestHandlerClass.app.token
    with socket.socket() as origin:
        origin.bind(('127.0.0.1', 0))
        origin.listen(1)
        origin.settimeout(5)
        with patch('server.native_repoql_upstream', return_value=origin.getsockname()):
            with socket.create_connection(('127.0.0.1', port), timeout=5) as client:
                client.sendall((
                    'GET /embed/repoql/ws HTTP/1.1\r\n'
                    f'Host: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\n'
                    'Upgrade: websocket\r\nConnection: Upgrade\r\n\r\n'
                ).encode())
                upstream, _ = origin.accept()
                with upstream, upstream.makefile('rb') as origin_in, client.makefile('rb') as client_in:
                    upstream.settimeout(5)
                    assert origin_in.readline() == b'GET /ws HTTP/1.1\r\n'
                    while True:
                        line = origin_in.readline()
                        assert line and b'Authorization:' not in line
                        if line == b'\r\n':
                            break
                    upstream.sendall(b'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n')
                    assert client_in.readline() == b'HTTP/1.1 101 Switching Protocols\r\n'
                    assert client_in.readline() == b'Upgrade: websocket\r\n'
                    assert client_in.readline() == b'\r\n'
                    client.sendall(b'\x81\x82\0\0\0\0ok')
                    assert origin_in.read(8) == b'\x81\x82\0\0\0\0ok'
                    upstream.sendall(b'\x81\x02ok')
                    assert client_in.read(4) == b'\x81\x02ok'


def untrusted_backend_refused(binary):
    with socket.socket() as substitute:
        substitute.bind(('127.0.0.1', 0))
        substitute.listen(1)
        substitute.settimeout(5)
        with listener_process(binary, substitute.getsockname()[1]) as (_, port):
            with socket.create_connection(('127.0.0.1', port), timeout=5) as client:
                client.sendall(b'GET /api/features HTTP/1.0\r\nAuthorization: Bearer synthetic\r\n\r\n')
                upstream, _ = substitute.accept()
                with upstream, upstream.makefile('rb') as body:
                    upstream.settimeout(5)
                    assert body.readline() == b'SINGULARITY_DASHBOARD_V1 ' + b'b' * 64 + b'\n'
                    upstream.sendall(b'c' * 63 + b'0\n')
                    assert body.read() == b''


def main():
    args = argparse.ArgumentParser()
    args.add_argument('--rust-cli', type=Path, required=True)
    binary = args.parse_args().rust_cli.resolve(strict=True)
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        with dashboard(root / 'reference') as (reference, _):
            expected = observe(reference)
            ref_account = reference.RequestHandlerClass.app.local_account.path
            expected_static = static_contract(reference)
            expected_reads = read_contract(reference, None)
            websocket_roundtrip(reference)
        with dashboard(root / 'rust', binary) as (server, native):
            assert native.port != native.backend_port
            assert observe(server) == expected
            session_lifecycle(server, native)
            password_roundtrip(ref_account, native)
            account_store_contract(native, root)
            assert static_contract(server) == expected_static
            assert read_contract(server, native) == expected_reads
            private_static_refusal(native, root)
            direct_private_refused(native)
            websocket_roundtrip(server)
            with socket.create_connection(('127.0.0.1', native.port), timeout=5) as client:
                client.sendall(b'GET /.well-known/singularity-health HTTP/1.0\r\nHost: localhost\r\n\r\n')
                client.shutdown(socket.SHUT_WR)
                chunks = []
                while data := client.recv(1024):
                    chunks.append(data)
                assert b'200 OK' in b''.join(chunks)
            try:
                with dashboard(root / 'occupied', binary, native.port):
                    raise AssertionError('occupied port was accepted')
            except RuntimeError as exc:
                assert str(exc) == 'DASHBOARD_NATIVE_LISTENER_START_REFUSED'
            uncertain_mode_write(native, root)
        untrusted_backend_refused(binary)
        persisted_mode_restart(binary, root)
    print('DASHBOARD_NATIVE_LISTENER_COMPILED: password parity, bidirectional account migration and exclusive create, persisted mode restart, auth, session expiry and invalidation, origin, selected read HTTP byte parity, static byte parity, health, WebSocket, private refusal, half-close, bind conflict, untrusted backend refusal and parent lifetime passed')


if __name__ == '__main__':
    main()
