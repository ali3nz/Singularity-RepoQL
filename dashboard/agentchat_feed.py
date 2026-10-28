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
from pathlib import Path

ROOT = Path(os.environ.get('SINGULARITY_AGENTCHAT_STATE_DIR')
            or os.environ.get('RQLDASH_AGENTCHAT_STATE_DIR')
            or Path.home() / '.local' / 'state' / 'singularity-dashboard' / 'agentchat')
FILE_RE = re.compile(r'^[a-z0-9_-]{1,90}\.jsonl$')
MAX_FILES = 160
TAIL_BYTES = 128 * 1024


def _latest_lines(path: Path):
    """Read the tail without following links or reading historical full inboxes."""
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_CLOEXEC', 0))
        with os.fdopen(fd, 'rb') as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode):
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


def read_feed(after=0, limit=80, *, root: Path | None = None) -> dict:
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
