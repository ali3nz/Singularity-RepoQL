"""Read-only RepoQL source-connector inventory, never credentials or configuration.

The dashboard derives its list from RepoQL's connector registry and the connector
imports the host actually serves. Only read-only JSON verbs are run; no install,
bootstrap, credential or import command is ever issued.

CLI contract (rql 1.7.x): ``rql connector list --json`` and ``rql connector
status --json`` both emit ``repoql.imports.status/v1``. ``list`` is preferred
because its connector import rows carry freshness/count fields. The legacy
plural ``connectors list`` is tried last. Registry rows look like
``{"scheme","title","state","version",...}``; imports with
``kind == "connector"`` carry
``{"scheme","root","state","freshAsOf","sweepIntervalSeconds","files","bytes"}``.

Everything outside this closed public subset — envelopes, source roots,
``from.file``, ``by``, secret metadata and raw CLI error output — stays inside
this module. A malformed or unsupported payload is reported as unavailable,
never as an empty installed inventory.

"Active" means the registry entry says ``installed`` AND a matching connector
import is ``current`` AND its ``freshAsOf`` is within three sweep intervals
(floor five minutes). Installed-but-failed, stale, missing or import-less
connectors are reported honestly as such and are not counted active.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import subprocess
from datetime import datetime, timezone

MAX_CONNECTORS = 200
CACHE_TTL_SECONDS = 30.0
SUPPORTED_SCHEMA_PREFIX = 'repoql.imports.status'

# Preferred order: supported singular list, supported singular status, legacy plural.
COMMANDS = (
    ['connector', 'list', '--json'],
    ['connector', 'status', '--json'],
    ['connectors', 'list', '--json'],
)

_SCHEME = re.compile(r'^[a-z0-9][a-z0-9+.-]{0,63}$')
_ROOT = re.compile(r'^[a-z0-9][a-z0-9+.-]{0,63}://[\w./~-]*$')
_TOKEN = re.compile(r'[^a-z0-9 _-]+')

_FAILED_IMPORT_STATES = {'failed', 'error'}
_WAITING_IMPORT_STATES = {'waiting', 'queued', 'pending', 'partial', 'stalled'}


def _text(value, limit):
    return value[:limit] if isinstance(value, str) and value.strip() else ''


def _token(value, limit=32):
    text = _text(value, limit).lower()
    return _TOKEN.sub('', text).strip()


def _count(value):
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


def _stamp(value):
    text = _text(value, 40)
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace('Z', '+00:00'))
    except (TypeError, ValueError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def _import_rows(imports, scheme):
    """Return all import rows for a scheme: duplicates are ambiguous evidence."""
    matches = []
    for entry in imports:
        if not isinstance(entry, dict) or _token(entry.get('kind')) != 'connector':
            continue
        root = _text(entry.get('root'), 200)
        import_scheme = _token(entry.get('scheme'), 64)
        if import_scheme == scheme or root.lower().startswith(scheme + '://'):
            matches.append(entry)
    return matches


def _legacy_row(entry):
    """A pre-registry row (name/id only) cannot prove health; report it as installed."""
    name = _text(entry.get('name'), 120) or _text(entry.get('display_name'), 120)
    if not name:
        return None
    ident = _text(entry.get('id'), 120) or _text(entry.get('scheme'), 64)
    status = _token(entry.get('status')) or _token(entry.get('state')) or 'installed'
    return {
        'id': ident or name,
        'name': name,
        'status': status,
        'active': False,
        'registry_state': status,
        'import_state': '',
        'freshness': 'missing',
        'freshAsOf': '',
        'sweepIntervalSeconds': None,
        'files': None,
        'bytes': None,
        'version': _text(entry.get('version'), 72),
        'description': _text(entry.get('description'), 240),
    }


def _connector_row(entry, imports, now):
    if not isinstance(entry, dict):
        return None
    scheme = _text(entry.get('scheme'), 64).lower()
    if not _SCHEME.match(scheme):
        return _legacy_row(entry)

    registry_state = _token(entry.get('state')) or 'unknown'
    title = _text(entry.get('title'), 120) or scheme
    matched_imports = _import_rows(imports, scheme)
    row = matched_imports[0] if len(matched_imports) == 1 else None
    ambiguous = len(matched_imports) > 1
    # Explicit scheme and root must agree; one malformed row must not
    # simultaneously certify two different connector identities.
    if row is not None:
        named_scheme = _token(row.get('scheme'), 64)
        root_scheme = _text(row.get('root'), 200).split('://', 1)[0].lower() if '://' in _text(row.get('root'), 200) else ''
        if (named_scheme and named_scheme != scheme) or (root_scheme and root_scheme != scheme):
            ambiguous = True
            row = None

    import_state = 'ambiguous' if ambiguous else (_token(row.get('state')) if row else '')
    fresh_as_of = _text(row.get('freshAsOf'), 40) if row else ''
    fresh_ts = _stamp(fresh_as_of) if row else None
    sweep = _count(row.get('sweepIntervalSeconds')) if row else None
    files = _count(row.get('files')) if row else None
    size = _count(row.get('bytes')) if row else None
    root = _text(row.get('root'), 200) if row else ''

    if ambiguous:
        freshness = 'ambiguous'
    elif not row:
        freshness = 'missing'
    elif fresh_ts is None:
        freshness = 'unknown'
    else:
        age = (now - fresh_ts).total_seconds()
        stale_after = max(300, 3 * (sweep or 900))
        # A timestamp from the future is not freshness evidence. Allow a
        # small clock skew, but never certify an unbounded future timestamp.
        freshness = 'future' if age < -120 else ('stale' if age > stale_after else 'fresh')

    if registry_state != 'installed':
        status = registry_state
    elif ambiguous:
        status = 'ambiguous'
    elif not row:
        status = 'installed'
    elif import_state != 'current':
        if import_state in _FAILED_IMPORT_STATES:
            status = 'failed'
        elif import_state in _WAITING_IMPORT_STATES:
            status = 'waiting'
        else:
            status = import_state or 'installed'
    elif freshness == 'fresh':
        status = 'active'
    elif freshness == 'stale':
        status = 'stale'
    elif freshness == 'future':
        status = 'clock_skew'
    else:
        status = 'current'

    return {
        'id': scheme,
        'name': title,
        'status': status,
        'active': status == 'active',
        'registry_state': registry_state,
        'import_state': import_state,
        'freshness': freshness,
        'freshAsOf': fresh_as_of if fresh_ts is not None else '',
        'sweepIntervalSeconds': sweep,
        'files': files,
        'bytes': size,
        'root': root if _ROOT.match(root) else '',
        'version': _text(entry.get('version'), 72),
        'description': '',
    }


def _inventory_from_payload(payload, now):
    """Parse one CLI payload; None means malformed/unsupported, not empty."""
    imports = []
    if isinstance(payload, list):
        entries = payload
        schema = ''
    elif isinstance(payload, dict):
        schema = _text(payload.get('schema'), 80)
        if schema and not schema.startswith(SUPPORTED_SCHEMA_PREFIX):
            return None
        entries = payload.get('connectors')
        if entries is None:
            entries = next((payload[key] for key in ('installed', 'items', 'results')
                            if isinstance(payload.get(key), list)), None)
        if not isinstance(entries, list):
            return None
        imports = payload.get('imports') if isinstance(payload.get('imports'), list) else []
    else:
        return None

    selected = entries[:MAX_CONNECTORS]
    safe = []
    for entry in selected:
        row = _connector_row(entry, imports, now)
        if row is not None:
            safe.append(row)
    if selected and not safe:
        # Every registry row was unusable: the inventory is malformed, not empty.
        return None

    return {
        'available': True,
        'schema': schema,
        'source': 'RepoQL CLI',
        'connectors': safe,
        'active': sum(1 for row in safe if row['active']),
        'installed': len(safe),
        'truncated': len(entries) > MAX_CONNECTORS,
    }



def _native_public_payload(payload):
    """Do not forward registry secrets or private import metadata to Rust.

    Preserve the reference projection's supported shapes and invalid-row
    behaviour so the Rust result must still match the Python authority.
    """
    connector_keys = ('scheme', 'state', 'title', 'version', 'name',
                      'display_name', 'id', 'status', 'description')
    import_keys = ('kind', 'scheme', 'root', 'state', 'freshAsOf',
                   'sweepIntervalSeconds', 'files', 'bytes')

    def safe_rows(value, keys):
        if not isinstance(value, list):
            return None if value is None else False
        return [({key: (val if isinstance(val := item[key], (str, int, float, bool))
                        or val is None else None)
                  for key in keys if key in item}
                 if isinstance(item, dict) else None) for item in value]

    if isinstance(payload, list):
        return safe_rows(payload, connector_keys)
    if not isinstance(payload, dict):
        return None
    clean = {}
    if 'schema' in payload:
        clean['schema'] = payload['schema'] if isinstance(payload['schema'], str) else None
    for key in ('connectors', 'installed', 'items', 'results'):
        if key in payload:
            clean[key] = safe_rows(payload[key], connector_keys)
    if 'imports' in payload:
        clean['imports'] = safe_rows(payload['imports'], import_keys)
    return clean


def _native_checked(payload, moment, reference):
    """Compare an explicit Rust connector projection to the Python authority.

    The Rust process only receives the bounded local RepoQL CLI response and
    the evaluation clock. A mismatch, malformed response or execution fault
    must not turn an unverified connector into an active connector.
    """
    binary = os.environ.get('SINGULARITY_REPOQL_CONNECTORS_RUST_BINARY', '')
    if not binary:
        return reference
    executable = Path(binary)
    if not executable.is_absolute() or executable.is_symlink() or not executable.is_file():
        raise RuntimeError('repoql_connectors_native_binary_invalid')
    request = json.dumps({'payload': _native_public_payload(payload), 'now': moment.isoformat()},
                         ensure_ascii=False)
    if len(request.encode('utf-8')) > 2 * 1024 * 1024:
        raise RuntimeError('repoql_connectors_native_input_too_large')
    try:
        process = subprocess.run([str(executable)], input=request, text=True, encoding="utf-8",
                                 capture_output=True, timeout=10, shell=False, check=False)
    except (OSError, UnicodeError, subprocess.TimeoutExpired) as exc:
        raise RuntimeError('repoql_connectors_native_execution_failed') from exc
    if process.returncode != 0 or len(process.stdout.encode('utf-8')) > 2 * 1024 * 1024:
        raise RuntimeError('repoql_connectors_native_execution_failed')
    try:
        actual = json.loads(process.stdout)
    except (ValueError, TypeError) as exc:
        raise RuntimeError('repoql_connectors_native_invalid_json') from exc
    if actual != reference:
        raise RuntimeError('repoql_connectors_native_mismatch')
    return actual


def connector_inventory(rql, *, now=None) -> dict:
    """Read-only connector inventory; cached for 30 seconds.

    ``now`` exists for deterministic freshness tests. Unsupported, malformed or
    unreachable CLI output is reported as unavailable with a machine-readable
    reason instead of a fabricated empty installed inventory.
    """
    cached = rql.cache.get('connector_inventory')
    if cached is not None:
        return cached
    moment = now or datetime.now(timezone.utc)
    reasons = []
    for args in COMMANDS:
        try:
            process = rql.run(args, timeout=18)
        except (OSError, subprocess.TimeoutExpired):
            reasons.append('cli_unavailable')
            continue
        except Exception:  # adapter failure of any kind is not an empty inventory
            reasons.append('cli_unavailable')
            continue
        if getattr(process, 'returncode', 1) != 0:
            reasons.append('command_failed')
            continue
        try:
            payload = json.loads(process.stdout)
        except (TypeError, ValueError):
            reasons.append('malformed_json')
            continue
        reference = _inventory_from_payload(payload, moment)
        result = _native_checked(payload, moment, reference)
        if result is None:
            reasons.append('malformed_schema')
            continue
        return rql.cache.set('connector_inventory', result, CACHE_TTL_SECONDS)

    if 'malformed_schema' in reasons:
        reason = 'malformed_schema'
    elif 'malformed_json' in reasons:
        reason = 'malformed_json'
    elif reasons and all(item == 'cli_unavailable' for item in reasons):
        reason = 'cli_unavailable'
    else:
        reason = 'enumeration_unsupported'
    result = {
        'available': False,
        'source': 'RepoQL CLI',
        'connectors': [],
        'active': 0,
        'installed': 0,
        'truncated': False,
        'reason': reason,
    }
    return rql.cache.set('connector_inventory', result, CACHE_TTL_SECONDS)
