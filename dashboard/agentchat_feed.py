"""Read-only, bounded feed of durable Agent Chat inbox messages.

The existing agentchat relay/CLI is authoritative. This module never advances a
recipient cursor, opens Discord, or sends a message. It runs behind the
RepoQL dashboard's existing authentication and tunnel peer restrictions.
"""
from __future__ import annotations

import json
import os
import re
import stat
import subprocess
from pathlib import Path

def default_state_root(*, platform=None, env=None, home=None):
    platform = platform or os.name
    env = os.environ if env is None else env
    home = Path.home() if home is None else Path(home)
    if platform == 'nt':
        return Path(env.get('LOCALAPPDATA') or home / 'AppData' / 'Local') / 'Singularity' / 'AgentChat'
    return home / '.local' / 'state' / 'singularity-dashboard' / 'agentchat'

ROOT = Path(os.environ.get('SINGULARITY_AGENTCHAT_STATE_DIR')
            or os.environ.get('RQLDASH_AGENTCHAT_STATE_DIR')
            or default_state_root())
# Agent Chat roles are `[a-z0-9_-]` tokens; the 40-char cap matches the relay role
# grammar so a derived `omb-<32 hex>` OpenMausBot role (36 chars) stays readable.
PRESENCE_RE = re.compile(r'^[a-z0-9_-]{1,40}$')
FILE_RE = re.compile(r'^[a-z0-9_-]{1,90}\.jsonl$')
MAX_FILES = 160
TAIL_BYTES = 128 * 1024


def _latest_lines(path: Path):
    """Read the tail without following links or reading historical full inboxes."""
    try:
        # Windows lacks O_NOFOLLOW. Check the entry without following its
        # final link *before* opening it, then verify the opened file identity
        # against that entry. Reject filename swaps, reparse points, and any
        # unverified file identity instead of following an unexpected target.
        before = os.lstat(path)
        if (not stat.S_ISREG(before.st_mode) or stat.S_ISLNK(before.st_mode)
                or (getattr(before, 'st_file_attributes', 0) & 0x400)):
            return []
        fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_CLOEXEC', 0))
        with os.fdopen(fd, 'rb') as stream:
            info = os.fstat(stream.fileno())
            if (not stat.S_ISREG(info.st_mode) or info.st_dev != before.st_dev
                    or info.st_ino != before.st_ino):
                return []
            length = min(info.st_size, TAIL_BYTES)
            stream.seek(-length, os.SEEK_END)
            data = stream.read(length)
            if info.st_size > length:
                data = data.split(b'\n', 1)[-1]  # discard partial first line
    except (OSError, ValueError):
        return []
    return data.splitlines()[-120:]


def _files(root: Path):
    result = []
    for dirname, kind in [('inbox', 'role'), ('inbox-sessions', 'session')]:
        folder = root / dirname
        try:
            with os.scandir(folder) as entries:
                for entry in entries:
                    if not FILE_RE.fullmatch(entry.name):
                        continue
                    try:
                        if entry.is_file(follow_symlinks=False):
                            result.append((entry.stat(follow_symlinks=False).st_mtime,
                                           Path(entry.path), kind, entry.name[:-6]))
                    except OSError:
                        continue
        except OSError:
            continue
    result.sort(key=lambda x: x[0], reverse=True)
    return result[:MAX_FILES]


def _read_feed_python(after=0, limit=80, *, root: Path | None = None) -> dict:
    root = root if root is not None else ROOT
    if not root.is_dir():
        return {'available': False, 'reason': 'Agent Chat state directory unavailable',
                'messages': [], 'last_id': max(0, int(after))}
    after = max(0, int(after))
    limit = min(150, max(1, int(limit)))
    messages = {}
    for _, path, kind, recipient in _files(root):
        for line in _latest_lines(path):
            try:
                record = json.loads(line)
                mid = int(record.get('id') or 0)
                if mid <= after or mid <= 0:
                    continue
                # Never expose optional raw internal metadata, secrets or provider
                # state: the user requests chat envelopes, not full log records.
                entry = messages.setdefault(mid, {
                    'id': mid, 'from': str(record.get('from') or '')[:48],
                    'from_session': str(record.get('fromSession') or '')[:64],
                    'text': str(record.get('text') or '')[:1500],
                    'created_at': str(record.get('createdAt') or '')[:40],
                    'origin': str(record.get('origin') or '')[:20],
                    'run_number': record.get('runNumber') if isinstance(record.get('runNumber'), int) else None,
                    'recipients': [], 'sessions': [],
                })
                target = entry['recipients'] if kind == 'role' else entry['sessions']
                if recipient not in target:
                    target.append(recipient)
            except (ValueError, TypeError, json.JSONDecodeError):
                continue
    ordered = sorted(messages.values(), key=lambda r: r['id'])
    for row in ordered:
        row['recipients'].sort()
        row['sessions'].sort()
    selected = (ordered[:limit] if after else ordered[-limit:])
    return {'available': True, 'messages': selected,
            'last_id': selected[-1]['id'] if selected else after,
            'has_more': len(ordered) > limit,
            'source': 'durable-inbox', 'read_only': True}


def _read_presence_python(*, root: Path | None = None, now=None) -> dict:
    """Return recent observed sender roles, never asserting actual worker activity."""
    from datetime import datetime, timezone, timedelta
    root = root if root is not None else ROOT
    if not root.is_dir():
        return {'available': False, 'agents': [], 'reason': 'Agent Chat state directory unavailable'}
    now = now if now is not None else datetime.now(timezone.utc)
    cutoff = now - timedelta(minutes=5)
    observed = {}
    for _, path, _kind, _recipient in _files(root):
        for line in _latest_lines(path):
            try:
                row = json.loads(line)
                role = str(row.get('from') or '')
                if not PRESENCE_RE.fullmatch(role):
                    continue
                when = datetime.fromisoformat(str(row.get('createdAt') or '').replace('Z', '+00:00'))
                if when.tzinfo is None:
                    continue
                when = when.astimezone(timezone.utc)
                if when < cutoff or when > now:
                    continue
                if role not in observed or observed[role] < when:
                    observed[role] = when
            except (ValueError, TypeError, json.JSONDecodeError, OverflowError):
                continue
    return {'available': True, 'agents': [
        {'role': role, 'status': 'idle', 'last_seen': when.isoformat()}
        for role, when in sorted(observed.items())
    ], 'source': 'durable-inbox-recent-senders', 'read_only': True,
        'working_status_verified': False}


def _native_checked(mode: str, root: Path, args: list[str], reference: dict) -> dict:
    """Explicit read-only Rust opt-in, checked against Python before display.

    A failed or mismatching native projection cannot add unexpected messages
    or forge a sender-presence status. No network or cursor writes occur here.
    """
    binary = os.environ.get('SINGULARITY_AGENTCHAT_RUST_BINARY', '')
    if not binary:
        return reference
    executable = Path(binary)
    if (not executable.is_absolute() or executable.is_symlink()
            or not executable.is_file() or not root.is_absolute()):
        raise RuntimeError('agentchat_native_binary_invalid')
    try:
        result = subprocess.run([str(executable), mode, str(root), *args],
                                capture_output=True, text=True, timeout=5,
                                check=False, shell=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise RuntimeError('agentchat_native_execution_failed') from exc
    if result.returncode or len(result.stdout) > 2 * 1024 * 1024:
        raise RuntimeError('agentchat_native_execution_failed')
    try:
        actual = json.loads(result.stdout)
    except (json.JSONDecodeError, ValueError) as exc:
        raise RuntimeError('agentchat_native_invalid_json') from exc
    if actual != reference:
        raise RuntimeError('agentchat_native_mismatch')
    return actual


def read_feed(after=0, limit=80, *, root: Path | None = None) -> dict:
    root = root if root is not None else ROOT
    reference = _read_feed_python(after, limit, root=root)
    # Match the same bounds and cursor as the authoritative Python projection.
    return _native_checked('feed', root, [str(max(0, int(after))),
                                         str(min(150, max(1, int(limit))))], reference)


def read_presence(*, root: Path | None = None, now=None) -> dict:
    from datetime import datetime, timezone
    root = root if root is not None else ROOT
    instant = now if now is not None else datetime.now(timezone.utc)
    reference = _read_presence_python(root=root, now=instant)
    return _native_checked('presence', root, [instant.isoformat()], reference)
