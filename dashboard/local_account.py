"""Single-owner, local-only dashboard login for the public Windows distribution.

No model calls or external identity service. The current Windows user's private
state directory owns the account file. The server keeps short-lived sessions in
memory and never sends its automation capability token into a browser.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import stat
import threading
import time

COOKIE_NAME = 'srq_session'
COOKIE_TTL = 8 * 3600
# Only ever shortens a session; the shape of the cookie (HttpOnly,
# SameSite=Strict, Path=/) is unchanged. Used by short-TTL acceptance runs.
TTL_ENV = 'SINGULARITY_DASHBOARD_SESSION_TTL'
MIN_TTL = 30
# Owner addendum A2: 'auto-local' is the RC default (silent loopback session);
# 'password' keeps the original create-account flow as an explicit opt-in.
AUTH_MODES = ('auto-local', 'password')
MODE_FILE = 'auth-mode.json'
_PASSWORD_N = 1 << 14
_USER_RE = re.compile(r'[A-Za-z][A-Za-z0-9_.-]{2,39}\Z')
_COOKIE_RE = re.compile(r'(?:^|;\s*)srq_session=([A-Za-z0-9_-]{43,64})(?:;|$)')


def session_ttl() -> int:
    """Session lifetime in seconds, clamped to [MIN_TTL, COOKIE_TTL].

    A configured value can only shorten a session, so this switch cannot be
    used to extend or bypass the product's authentication window.
    """
    raw = os.environ.get(TTL_ENV, '').strip()
    if not raw:
        return COOKIE_TTL
    try:
        value = int(raw)
    except ValueError:
        return COOKIE_TTL
    return max(MIN_TTL, min(value, COOKIE_TTL))


class AccountRefused(ValueError):
    pass


class LocalAccount:
    def __init__(self, state_dir: Path, *, clock=time.monotonic, mode: str | None = None):
        self.path = state_dir / 'local-account.json'
        self.mode_path = state_dir / MODE_FILE
        self.clock = clock
        self.lock = threading.Lock()
        self.sessions: dict[str, float] = {}
        self.native_session = None
        self.native_store = None
        self._password_lock = threading.Lock()
        self.failed: dict[str, list[float]] = {}
        self._check_file()
        self._mode = self._resolve_mode(mode)

    def _check_file(self):
        for path in (self.path, self.path.parent):
            if path.is_symlink():
                raise AccountRefused('account_path_reparse_refused')
            if path.exists() and getattr(path.stat(), 'st_file_attributes', 0) & getattr(stat, 'FILE_ATTRIBUTE_REPARSE_POINT', 0x400):
                raise AccountRefused('account_path_reparse_refused')

    def _native(self, op, **fields):
        return self.native_store(op, self.path.parent.absolute(), **fields)

    def configured(self) -> bool:
        if self.native_store is not None:
            return self._native('configured')
        self._check_file()
        return self.path.exists()

    # -- auth mode (owner addendum A2/A5) ----------------------------------
    def _resolve_mode(self, explicit: str | None) -> str:
        if explicit is not None:
            if explicit not in AUTH_MODES:
                raise AccountRefused('invalid_auth_mode')
            return explicit
        env = os.environ.get('SINGULARITY_DASHBOARD_AUTH_MODE', '').strip()
        if env:
            if env not in AUTH_MODES:
                raise AccountRefused('invalid_auth_mode')
            return env
        if self.native_store is not None:
            return 'password' if self._native('password_mode') else 'auto-local'
        if self.mode_path.is_symlink():
            raise AccountRefused('account_path_reparse_refused')
        try:
            doc = json.loads(self.mode_path.read_text(encoding='utf-8'))
            mode = doc.get('mode') if isinstance(doc, dict) else None
            if mode in AUTH_MODES:
                return mode
        except (OSError, ValueError):
            pass
        # The product default is passwordless local sessions.
        return 'auto-local'

    def use_native_store(self, store):
        self.native_store = store
        self._mode = self._resolve_mode(None)

    @property
    def mode(self) -> str:
        return self._mode

    @property
    def auto_local(self) -> bool:
        return self._mode == 'auto-local'

    def set_mode(self, mode: str) -> str:
        """Persist the mode in the private state dir and revoke existing sessions."""
        with self._password_lock:
            return self._set_mode(mode)

    def _set_mode(self, mode: str) -> str:
        if mode not in AUTH_MODES:
            raise AccountRefused('invalid_auth_mode')
        if self.native_store is not None:
            if self._native('set_mode', mode=mode, nonce=secrets.token_hex(16)) is not True:
                raise RuntimeError('DASHBOARD_NATIVE_ACCOUNT_UNAVAILABLE')
        else:
            self._check_file()
            tmp = self.mode_path.with_name(self.mode_path.name + '.tmp')
            try:
                if tmp.is_symlink():
                    raise AccountRefused('account_path_reparse_refused')
                fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
                with os.fdopen(fd, 'w', encoding='utf-8') as out:
                    json.dump({'version': 1, 'mode': mode}, out, separators=(',', ':'))
                    out.flush()
                    os.fsync(out.fileno())
                os.replace(tmp, self.mode_path)
            except OSError:
                raise AccountRefused('auth_mode_write_failed') from None
        # Switching mode invalidates outstanding sessions.
        with self.lock:
            if self.native_session is not None:
                self.native_session('clear')
            self.sessions.clear()
            self._mode = mode
        return mode

    def _record(self) -> dict:
        self._check_file()
        try:
            if self.path.stat().st_size > 4096:
                raise ValueError('oversized')
            doc = json.loads(self.path.read_text(encoding='utf-8'))
            if (type(doc) is not dict or set(doc) != {'version', 'username', 'salt', 'hash'}
                    or doc['version'] != 1 or not isinstance(doc['username'], str)
                    or not _USER_RE.fullmatch(doc['username']) or not isinstance(doc['salt'], str)
                    or not isinstance(doc['hash'], str)):
                raise ValueError('invalid')
            salt = base64.b64decode(doc['salt'], validate=True)
            digest = base64.b64decode(doc['hash'], validate=True)
            if len(salt) != 16 or len(digest) != 32:
                raise ValueError('invalid')
            return doc
        except (OSError, ValueError, KeyError, TypeError):
            raise AccountRefused('account_file_invalid') from None

    @staticmethod
    def _validate(username: str, password: str):
        if not isinstance(username, str) or not _USER_RE.fullmatch(username):
            raise AccountRefused('invalid_username')
        if (not isinstance(password, str) or len(password) < 12 or len(password) > 256
                or len(password.encode('utf-8')) > 1024
                or any(ord(c) < 32 for c in password)):
            raise AccountRefused('invalid_password')

    def setup(self, username: str, password: str):
        self._validate(username, password)
        salt = secrets.token_bytes(16)
        with self._password_lock:
            if self.native_store is not None:
                if self._native('create', username=username, password=password, salt=list(salt)) is not True:
                    raise RuntimeError('DASHBOARD_NATIVE_ACCOUNT_UNAVAILABLE')
            else:
                if self.configured():
                    raise AccountRefused('account_already_configured')
                digest = hashlib.scrypt(password.encode('utf-8'), salt=salt, n=_PASSWORD_N, r=8, p=1, dklen=32)
                doc = {'version': 1, 'username': username,
                       'salt': base64.b64encode(salt).decode('ascii'),
                       'hash': base64.b64encode(digest).decode('ascii')}
                with self.lock:
                    self._check_file()
                    try:
                        # Exclusive creation also prevents replacement across processes.
                        fd = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                    except FileExistsError:
                        raise AccountRefused('account_already_configured') from None
                    with os.fdopen(fd, 'w', encoding='utf-8') as out:
                        json.dump(doc, out, separators=(',', ':'))
                        out.flush()
                        os.fsync(out.fileno())
        return self.issue_session()

    def _allow_attempt(self, peer: str) -> bool:
        now = self.clock()
        with self.lock:
            rows = [n for n in self.failed.get(peer, []) if now - n < 60]
            self.failed[peer] = rows
            return len(rows) < 5

    def login(self, username: str, password: str, peer: str):
        # Reserve one derivation at a time so concurrent requests cannot pass
        # the throttle together or launch a burst of memory-heavy KDFs.
        with self._password_lock:
            return self._login(username, password, peer)

    def _login(self, username: str, password: str, peer: str):
        if not self._allow_attempt(peer):
            raise AccountRefused('too_many_attempts')
        if self.native_store is not None:
            if not isinstance(password, str) or len(password) > 256 or len(password.encode('utf-8')) > 1024:
                raise AccountRefused('invalid_credentials')
            # Account names cannot exceed 40 bytes. A wrong name must still
            # verify the password and count as a failed attempt.
            candidate = username if isinstance(username, str) and len(username) <= 40 else None
            good = self._native('verify', username=candidate, password=password)
        else:
            doc = self._record()
            salt = base64.b64decode(doc['salt'])
            expected = base64.b64decode(doc['hash'])
            if not isinstance(password, str) or len(password) > 256 or len(password.encode('utf-8')) > 1024:
                raise AccountRefused('invalid_credentials')
            candidate = hashlib.scrypt(password.encode('utf-8'), salt=salt,
                                       n=_PASSWORD_N, r=8, p=1, dklen=32)
            password_ok = hmac.compare_digest(expected, candidate)
            good = (password_ok and isinstance(username, str)
                    and hmac.compare_digest(doc['username'].encode('ascii'), username.encode('utf-8')))
        if not good:
            with self.lock:
                self.failed.setdefault(peer, []).append(self.clock())
            raise AccountRefused('invalid_credentials')
        with self.lock:
            self.failed.pop(peer, None)
        return self.issue_session()

    def issue_session(self) -> str:
        value = secrets.token_urlsafe(32)
        key = hashlib.sha256(value.encode('ascii')).hexdigest()
        with self.lock:
            now = self.clock()
            if self.native_session is not None:
                self.native_session('issue', key=key, now=now, ttl=session_ttl())
            else:
                self.sessions = {k: exp for k, exp in self.sessions.items() if exp > now}
                self.sessions[key] = now + session_ttl()
        return value

    @staticmethod
    def _cookie_value(header: str) -> str | None:
        match = _COOKIE_RE.search(header[:4096])
        return match.group(1) if match else None

    def authenticated(self, header: str) -> bool:
        value = self._cookie_value(header)
        if not value:
            return False
        key = hashlib.sha256(value.encode('ascii')).hexdigest()
        with self.lock:
            if self.native_session is not None:
                return self.native_session('valid', key=key, now=self.clock())
            return self.sessions.get(key, 0) > self.clock()

    def revoke(self, header: str):
        value = self._cookie_value(header)
        if not value:
            return
        key = hashlib.sha256(value.encode('ascii')).hexdigest()
        with self.lock:
            if self.native_session is not None:
                self.native_session('revoke', key=key)
            else:
                self.sessions.pop(key, None)
