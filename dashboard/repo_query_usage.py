"""Read-only, provenance-aware RepoQL repository query attribution.

Input is an explicitly provisioned, verified host/harness query receipt stream,
not indexing statistics or generic HTTP page views. Never fabricate history.
"""
from collections import defaultdict
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import stat
import threading
import time

SCHEMA = "repoql-query-usage/1"
EVENT_SCHEMA = "repoql-query-event/1"
MAX_BYTES = 32 * 1024 * 1024
MAX_ROWS = 200_000
WINDOWS = {"1d": 86_400, "7d": 7 * 86_400, "30d": 30 * 86_400}
# The source receipt is a dashboard-private file, not a public RepoQL endpoint.
# Never expose complete historical accounting based on an unverified adapter.
_CACHE_LOCK = threading.Lock()
_CACHE_KEY = None
_CACHE_VALUE = None
QUERY_OPERATIONS = frozenset({"explore", "discover_vocabulary", "find", "similar",
    "read", "tree", "grep", "references", "changes", "history", "blame",
    "lint", "coverage", "concepts", "surface_concepts", "query", "explain"})


def report(path: Path, repo_roots: list[str], now: float | None = None) -> dict:
    """Count distinct query calls per explicit repository, not index updates.

    Each event must be emitted at a verified RepoQL tool-call boundary and carry
    a unique invocation id, UTC timestamp and explicit repo_roots. A multi-repo
    call counts as one invocation and one touch per matching repository.
    """
    now = time.time() if now is None else float(now)
    result = {"schema": SCHEMA, "available": False, "coverage": "unverified",
              "source": "authoritative RepoQL host or harness tool-call receipts",
              "windows": list(WINDOWS), "repositories": {},
              "observed_since": None, "latest_at": None,
              "error": "Query-event feed not configured; historical usage cannot be inferred from the index."}
    if not path.is_file():
        return result
    try:
        # Avoid following a symlink into another service's data/secrets and
        # require a non-world-readable operator-managed receipt file.
        # The dashboard may read a 0640 file shared with its collector group.
        if path.is_symlink():
            raise ValueError("query-event feed must not be a symlink")
        source_stat = path.stat()
        if not stat.S_ISREG(source_stat.st_mode):
            raise ValueError("query-event feed must be a regular file")
        if source_stat.st_mode & (stat.S_IROTH | stat.S_IWOTH):
            raise ValueError("query-event feed has unsafe world permissions; use 0640 or stricter")
        if source_stat.st_size > MAX_BYTES:
            raise ValueError("query-event feed exceeds 32 MiB; rotate and reconcile before use")
        roots = set(repo_roots)
        by_repo = {root: {window: 0 for window in WINDOWS} for root in roots}
        calls = {window: 0 for window in WINDOWS}
        unattributed = {window: 0 for window in WINDOWS}
        earliest = None
        latest = None
        seen = set()
        accepted = 0
        bad = 0
        descriptor = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
        with os.fdopen(descriptor, 'r', encoding='utf-8') as handle:
            opened_stat = os.fstat(handle.fileno())
            if not stat.S_ISREG(opened_stat.st_mode) or opened_stat.st_size > MAX_BYTES:
                raise ValueError("query-event feed changed or exceeds safety limits")
            if (opened_stat.st_dev, opened_stat.st_ino) != (source_stat.st_dev, source_stat.st_ino):
                raise ValueError("query-event feed changed during open")
            for i, line in enumerate(handle):
                if i >= MAX_ROWS:
                    raise ValueError("query-event feed exceeds 200,000 rows; rotate first")
                if not line.strip():
                    continue
                if len(line) > 8192:
                    bad += 1
                    continue
                try:
                    event = json.loads(line)
                    if not isinstance(event, dict) or event.get('schema') != EVENT_SCHEMA:
                        raise ValueError('wrong event schema')
                    event_id = event['event_id']
                    ts = event['ts']
                    op = event['operation']
                    targets = event['repo_roots']
                    if not isinstance(event_id, str) or not event_id or len(event_id) > 256:
                        raise ValueError('bad event id')
                    if not isinstance(ts, (int, float)) or isinstance(ts, bool) or not math.isfinite(ts):
                        raise ValueError('bad timestamp')
                    if not isinstance(op, str) or op not in QUERY_OPERATIONS:
                        raise ValueError('not a content query operation')
                    if (not isinstance(targets, list) or len(targets) > 100
                            or any(not isinstance(v, str) or not v or len(v) > 512
                                   or any(ord(c) < 32 for c in v) for v in targets)):
                        raise ValueError('bad repository attribution')
                    agent = event.get('agent')
                    if agent is not None and (not isinstance(agent, str) or len(agent) > 128):
                        raise ValueError('bad agent attribution')
                    if ts > now + 300 or ts < 0:
                        raise ValueError('bad timestamp')
                except (ValueError, KeyError, TypeError, json.JSONDecodeError, OverflowError):
                    bad += 1
                    continue
                # Validate BEFORE deduplication: a corrupt earlier receipt must
                # not suppress a later valid receipt using the same event ID.
                if event_id in seen:
                    continue
                seen.add(event_id)
                # The dashboard's own inventory polling is not an agent query.
                if agent == 'repoql-dashboard':
                    continue
                accepted += 1
                earliest = ts if earliest is None else min(earliest, ts)
                latest = ts if latest is None else max(latest, ts)
                matched = set(targets) & roots
                for window, seconds in WINDOWS.items():
                    if now - seconds <= ts <= now:
                        calls[window] += 1
                        if not matched:
                            unattributed[window] += 1
                        for root in matched:
                            by_repo[root][window] += 1
        if bad:
            # Expose bad receipts; do not claim that totals are complete.
            completeness = 'partial-invalid-rows'
        else:
            completeness = 'partial'
        result.update({"available": True, "coverage": completeness, "error": None,
                       "repositories": by_repo, "calls": calls, "unattributed": unattributed,
                       "accepted_events": accepted, "invalid_events": bad,
                       "counts_are_observed_lower_bounds": True,
                       "observed_since": datetime.fromtimestamp(earliest, timezone.utc).isoformat() if earliest is not None else None,
                       "latest_at": datetime.fromtimestamp(latest, timezone.utc).isoformat() if latest is not None else None,
                       "notice": "Observed query-call receipts only. Older/uninstrumented clients may be missing; a query spanning repositories is counted once per touched repository."})
    except (OSError, UnicodeError, ValueError) as error:
        result['error'] = str(error)
    return result


def from_environment(repo_roots: list[str]) -> dict:
    """Cache by file identity and 15-second wall-clock bucket to bound CPU cost.

    A dashboard may refresh every 15s, while the host exporter appends many
    receipts. Never cache unboundedly or reuse values when the file changed.
    """
    global _CACHE_KEY, _CACHE_VALUE
    default_events = Path(os.environ.get('SINGULARITY_STATE_DIR')
                          or Path.home() / '.local' / 'state' / 'singularity-dashboard') / 'repoql-query-events.jsonl'
    path = Path(os.environ.get('REPOQL_QUERY_EVENTS_FILE') or default_events)
    try:
        st = path.lstat()
        identity = (st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_mode)
    except OSError:
        identity = None
    key = (str(path), tuple(sorted(set(repo_roots))), identity, int(time.time() // 15))
    with _CACHE_LOCK:
        if key == _CACHE_KEY and _CACHE_VALUE is not None:
            return _CACHE_VALUE
    value = report(path, repo_roots)
    with _CACHE_LOCK:
        _CACHE_KEY, _CACHE_VALUE = key, value
    return value
