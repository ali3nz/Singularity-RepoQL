"""Supervise the opt-in compiled loopback TCP listener.

The private Python HTTP handler keeps the legacy protocol, browser authority
and authentication decisions. Only the child holding the per-run capability
can inject a stream into that handler.
"""
from __future__ import annotations

from http.server import ThreadingHTTPServer
import hmac
import json
import os
from pathlib import Path
from queue import Empty, Full, Queue
import re
import socket
import stat
import subprocess
import threading

BINARY_ENV = 'SINGULARITY_DASHBOARD_NATIVE_LISTENER'
PREFACE = b'SINGULARITY_DASHBOARD_V1 '


def private_handler(handler, key, reply_key):
    expected = PREFACE + key.encode('ascii') + b'\n'
    reply = reply_key.encode('ascii') + b'\n'

    class RelayedHandler(handler):
        def handle(self):
            # Reading through rfile preserves any request bytes already buffered
            # with the preface. Reset the timeout before the original handler.
            self.connection.settimeout(3)
            try:
                actual = self.rfile.read(len(expected))
                if not hmac.compare_digest(actual, expected):
                    return
                self.connection.sendall(reply)
            except OSError:
                return
            finally:
                self.connection.settimeout(None)
            super().handle()

    return RelayedHandler


class PrivateHTTPServer(ThreadingHTTPServer):
    request_queue_size = 32
    allow_reuse_address = False

    def __init__(self, *args, **kwargs):
        self._slots = threading.BoundedSemaphore(128)
        super().__init__(*args, **kwargs)

    def server_bind(self):
        if hasattr(socket, 'SO_EXCLUSIVEADDRUSE'):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()

    def process_request(self, request, client_address):
        if not self._slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self._slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._slots.release()


def trusted_binary(value):
    path = Path(value)
    if not path.is_absolute() or (os.name == 'nt' and not re.fullmatch(r'[A-Za-z]:', path.drive)):
        raise ValueError('DASHBOARD_NATIVE_LISTENER_PATH_INVALID')
    for entry in (path, *path.parents):
        info = entry.lstat()
        if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
            raise ValueError('DASHBOARD_NATIVE_LISTENER_PATH_INVALID')
    if not stat.S_ISREG(path.lstat().st_mode):
        raise ValueError('DASHBOARD_NATIVE_LISTENER_PATH_INVALID')
    return path


class NativeListener:
    def __init__(self, binary, server, public_port, key, reply_key):
        self.server = server
        self.backend_port = server.server_address[1]
        self._stopping = threading.Event()
        self._ready = threading.Event()
        self._broken = threading.Event()
        self._reply = b''
        self._thread = None
        self._control_lock = threading.Lock()
        self._responses = Queue(maxsize=1)
        self._control_failed = False
        self._env = {k: v for k, v in os.environ.items() if k.upper() in {'SYSTEMROOT', 'WINDIR'}}
        self._binary = str(trusted_binary(binary))
        self._child = subprocess.Popen(
            [self._binary], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, env=self._env, shell=False,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
        )
        try:
            startup = {'port': public_port, 'backend_port': self.backend_port, 'key': key, 'reply_key': reply_key}
            self._child.stdin.write(json.dumps(startup, separators=(',', ':')).encode() + b'\n')
            self._child.stdin.flush()
            self._thread = threading.Thread(target=self._watch, daemon=True)
            self._thread.start()
            if not self._ready.wait(5):
                raise RuntimeError('DASHBOARD_NATIVE_LISTENER_START_TIMEOUT')
            match = re.fullmatch(rb'READY (\d{1,5})\n', self._reply)
            if match is None or self._child.poll() is not None:
                raise RuntimeError('DASHBOARD_NATIVE_LISTENER_START_REFUSED')
            self.port = int(match[1])
            if not 1024 <= self.port <= 65535 or (public_port and self.port != public_port):
                raise RuntimeError('DASHBOARD_NATIVE_LISTENER_PORT_MISMATCH')
            # Handler compares browser Host/Origin to this address, not the
            # private port. The socket and server.server_port remain private.
            server.server_address = ('127.0.0.1', self.port)
        except BaseException:
            self.close()
            raise

    def _watch(self):
        try:
            self._reply = self._child.stdout.readline(64)
        except OSError:
            pass
        finally:
            self._ready.set()
        while True:
            try:
                line = self._child.stdout.readline(8200)
                if not line:
                    break
                self._responses.put_nowait(line)
            except (OSError, ValueError, Full):
                # A selected executable may not emit unsolicited frames.
                try:
                    self._child.kill()
                except OSError:
                    pass
                break
        self._child.wait()
        if not self._stopping.is_set():
            self._broken.set()

    def _exchange(self, frame, accept, error):
        with self._control_lock:
            if self._control_failed or self._stopping.is_set() or self._broken.is_set():
                raise RuntimeError(error)
            try:
                self._child.stdin.write(frame + b'\n')
                self._child.stdin.flush()
                result = accept(self._responses.get(timeout=2))
                if result is not None:
                    return result
            except (OSError, ValueError, Empty):
                pass
            # A timed-out response cannot be attributed to a later request.
            self._control_failed = True
            raise RuntimeError(error)

    def session(self, op, **fields):
        def accept(reply):
            if reply == b'YES\n' or (reply == b'NO\n' and op in {'valid', 'bearer'}):
                return reply == b'YES\n'
            return None
        data = json.dumps({'op': op, **fields}, separators=(',', ':')).encode()
        return self._exchange(data, accept, 'DASHBOARD_NATIVE_SESSION_UNAVAILABLE')

    def account(self, operation, state, **fields):
        from local_account import AccountRefused
        error = 'DASHBOARD_NATIVE_ACCOUNT_UNAVAILABLE'
        if self._stopping.is_set() or self._broken.is_set() or self._control_failed:
            raise RuntimeError(error)
        refused = None
        try:
            data = json.dumps({'op': operation, 'state': str(state), **fields},
                              ensure_ascii=False, separators=(',', ':')).encode('utf-8')
            if len(data) > 8192:
                raise ValueError
            result = subprocess.run([self._binary, '--account-stdin'], input=data, stdout=subprocess.PIPE,
                                    stderr=subprocess.DEVNULL, env=self._env, shell=False, timeout=10,
                                    check=False, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            if result.returncode == 0 and 2 <= len(result.stdout) <= 256:
                reply = json.loads(result.stdout)
                if type(reply) is dict:
                    if set(reply) == {'ok', 'value'} and reply['ok'] is True and type(reply['value']) is bool:
                        return reply['value']
                    if set(reply) == {'ok', 'code'} and reply['ok'] is False and reply['code'] in {
                        'account_file_invalid', 'account_path_reparse_refused', 'account_already_configured',
                        'auth_mode_write_failed', 'invalid_username', 'invalid_password', 'invalid_credentials',
                    }:
                        refused = reply['code']
        except (ValueError, TypeError, OSError, subprocess.SubprocessError):
            pass
        if refused is not None:
            raise AccountRefused(refused)
        if operation in {'create', 'set_mode'}:
            # An unknown write result may mean storage changed before the
            # child died. Do not continue using the old session/mode state.
            with self._control_lock:
                self._control_failed = True
        raise RuntimeError(error)

    def password(self, password, salt, expected=None):
        if self._stopping.is_set() or self._broken.is_set() or self._control_failed:
            raise RuntimeError('DASHBOARD_NATIVE_PASSWORD_UNAVAILABLE')
        request = {'op': 'derive' if expected is None else 'verify',
                   'password': password, 'salt': list(salt)}
        if expected is not None:
            request['expected'] = list(expected)
        # UTF-8 avoids unnecessarily expanding a valid Unicode password into
        # six-byte escapes. No credentials are passed on argv or in env.
        try:
            data = json.dumps(request, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
            if len(data) > 4096:
                raise ValueError
            result = subprocess.run(
                [self._binary, '--password-stdin'], input=data, stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL, env=self._env, shell=False, timeout=10, check=False,
                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
            )
            if result.returncode == 0:
                if expected is None and len(result.stdout) == 32:
                    return result.stdout
                if expected is not None and result.stdout in (b'\0', b'\x01'):
                    return result.stdout == b'\x01'
        except (ValueError, OSError, subprocess.SubprocessError):
            pass
        raise RuntimeError('DASHBOARD_NATIVE_PASSWORD_UNAVAILABLE')

    def asset(self, root, relative):
        request = json.dumps({'root': str(root), 'relative': relative},
                             ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        if len(request) > 8192:
            raise RuntimeError('DASHBOARD_NATIVE_STATIC_UNAVAILABLE')
        try:
            result = subprocess.run(
                [self._binary, '--static-stdin'], input=request, stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL, env=self._env, shell=False, timeout=5, check=False,
                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
            )
            if result.returncode == 0 and len(result.stdout) <= 8 * 1024 * 1024 + 64:
                if result.stdout == b'NOT_FOUND\n':
                    return None
                header, sep, body = result.stdout.partition(b'\n')
                marker, colon, mime = header.partition(b':')
                if sep and colon and marker in (b'0', b'1') and mime in {
                    b'text/html; charset=utf-8', b'application/javascript; charset=utf-8',
                    b'text/css; charset=utf-8', b'image/svg+xml', b'image/webp',
                    b'image/png', b'image/jpeg', b'application/json', b'application/octet-stream',
                }:
                    return marker == b'1', mime.decode('ascii'), body
        except (OSError, ValueError, subprocess.SubprocessError):
            pass
        raise RuntimeError('DASHBOARD_NATIVE_STATIC_UNAVAILABLE')

    def read_api(self, route, **fields):
        error = 'DASHBOARD_NATIVE_READ_API_UNAVAILABLE'
        data = json.dumps({'route': route, **fields}, separators=(',', ':')).encode('utf-8')
        if len(data) >= 8192:
            raise RuntimeError(error)

        def accept(reply):
            if not reply.startswith(b'READ ') or not reply.endswith(b'\n'):
                return None
            body = reply[5:-1]
            if 2 <= len(body) <= 8192 and isinstance(json.loads(body), dict):
                return body
            return None
        return self._exchange(b'READ ' + data, accept, error)

    def serve(self):
        # Polling handle_request avoids calling shutdown from a thread before
        # serve_forever has entered, including a child that dies during startup.
        self.server.timeout = 0.25
        while not self._stopping.is_set() and not self._broken.is_set():
            self.server.handle_request()
        if self._stopping.is_set():
            return
        raise RuntimeError('DASHBOARD_NATIVE_LISTENER_EXITED')

    def close(self):
        self._stopping.set()
        try:
            self._child.stdin.close()
        except OSError:
            pass
        try:
            self._child.wait(timeout=2)
        except subprocess.TimeoutExpired:
            self._child.kill()
            self._child.wait()
        if self._thread is not None:
            self._thread.join(timeout=2)
        self._child.stdout.close()
