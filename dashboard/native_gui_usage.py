"""Source-scoped native GUI usage view, never a subscription-quota estimator.

Receipts currently originate from the legacy unified gateway recent-event feed.
That feed is not complete and cannot establish totals or plan allowances.
An installer profile may only expose its *own* desktop GUI; another GUI's
receipts and all provider/Fleet/Freebuff receipts are excluded.
"""
from __future__ import annotations
import json
import os
from pathlib import Path
import subprocess

GUI_SOURCE_FOR_GUI = {
    'claude-desktop-code': 'claude-desktop-code',
    'openchamber-desktop': 'openchamber-desktop-subscription',
}
GUI_SOURCES = frozenset(GUI_SOURCE_FOR_GUI.values())


def _project_python(payload: dict, *, profile: dict | None = None) -> dict:
    if profile is None:
        from variant_features import features
        profile = features()
    gui = profile.get('gui')
    source = GUI_SOURCE_FOR_GUI.get(gui)
    # This function should not be used for a legacy installation: the legacy
    # fleet dashboard needs the original unfiltered response.
    if source is None:
        return {'available': False, 'error': 'native_gui_variant_required',
                'native_gui_only': True}
    result = {
        'native_gui_only': True, 'gui': gui, 'expected_source': source,
        'measurement_status': 'NO_VERIFIED_GUI_RECEIPTS',
        'input_tokens_recorded': None, 'output_tokens_recorded': None,
        'input_token_events': None, 'output_token_events': None,
        'allowance': None, 'daily': [], 'freebuff': None, 'recent': [],
        'sources': [], 'collected_at': None,
        'note': ('Only receipts explicitly attributed to this installation GUI may appear. '
                 'Recent events are a partial sample, not a full usage history. '
                 'Subscription plan quotas, allowance balances, and unreported tokens are unknown.'),
    }
    if not isinstance(payload, dict) or payload.get('available') is False:
        return {**result, 'available': False, 'error': 'unified_usage_upstream_unavailable'}
    # Output fields are intentionally allowlisted: arbitrary upstream metadata
    # must not become HTML, hidden URLs, auth data or another GUI's events.
    sources = [
        {'id': source, 'label': source, 'status': s.get('status') if s.get('status') in ('ok','partial','unavailable') else 'unverified',
         'events': s.get('events') if type(s.get('events')) is int and 0 <= s['events'] <= 2**64 - 1 else None,
         'latest_at': s.get('latest_at') if isinstance(s.get('latest_at'), str) and len(s['latest_at']) <= 40 else None}
        for s in payload.get('sources', []) if isinstance(s, dict) and s.get('id') == source
    ] if isinstance(payload.get('sources'), list) else []
    recent = []
    for e in (payload.get('recent') if isinstance(payload.get('recent'), list) else []):
        if not isinstance(e, dict) or e.get('source') != source:
            continue
        def reported(k):
            v = e.get(k)
            return v if type(v) is int and 0 <= v <= 10**15 else None
        stamp = e.get('timestamp')
        model = e.get('model')
        recent.append({
            'source': source,
            'timestamp': stamp if isinstance(stamp, str) and len(stamp) <= 40 else None,
            'model': model if isinstance(model, str) and len(model) <= 128 else None,
            'input_tokens': reported('input_tokens'),
            'output_tokens': reported('output_tokens'),
        })
        if len(recent) >= 50:
            break
    return {**result, 'available': True, 'sources': sources, 'recent': recent,
            'measurement_status': 'SAMPLE_ONLY' if recent else 'NO_VERIFIED_GUI_RECEIPTS',
            'collected_at': payload.get('collected_at') if isinstance(payload.get('collected_at'), str) and len(payload['collected_at']) <= 40 else None}


def _public_native_payload(payload):
    """Forward no GUI receipts other than the installed Claude Code identity."""
    if not isinstance(payload, dict):
        return None
    allowed = {'available': payload.get('available') if payload.get('available') is False else True}
    source = 'claude-desktop-code'
    rows = payload.get('sources')
    if isinstance(rows, list):
        allowed['sources'] = [
            {key: row[key] if isinstance(row[key], (str, int, float, bool)) or row[key] is None else None
             for key in ('id', 'status', 'events', 'latest_at') if key in row}
            for row in rows if isinstance(row, dict) and row.get('id') == source
        ]
    rows = payload.get('recent')
    if isinstance(rows, list):
        allowed['recent'] = [
            {key: row[key] if isinstance(row[key], (str, int, float, bool)) or row[key] is None else None
             for key in ('source', 'timestamp', 'model', 'input_tokens', 'output_tokens') if key in row}
            for row in rows if isinstance(row, dict) and row.get('source') == source
        ][:50]
    value = payload.get('collected_at')
    if isinstance(value, str):
        allowed['collected_at'] = value
    return allowed


def _native_checked(payload, profile, expected):
    """Require exact source-only Python parity before accepting Rust output."""
    binary = os.environ.get('SINGULARITY_NATIVE_GUI_USAGE_RUST_BINARY', '')
    if not binary:
        return expected
    executable = Path(binary)
    if not executable.is_absolute() or executable.is_symlink() or not executable.is_file():
        raise RuntimeError('native_gui_usage_rust_binary_invalid')
    request = json.dumps({'gui': profile.get('gui'), 'payload': _public_native_payload(payload)},
                         ensure_ascii=False)
    if len(request.encode('utf-8')) > 2 * 1024 * 1024:
        raise RuntimeError('native_gui_usage_rust_input_too_large')
    try:
        process = subprocess.run([str(executable)], input=request, text=True, encoding='utf-8',
                                 capture_output=True, timeout=10, shell=False, check=False)
    except (OSError, UnicodeError, subprocess.TimeoutExpired) as exc:
        raise RuntimeError('native_gui_usage_rust_execution_failed') from exc
    if process.returncode != 0 or len(process.stdout.encode('utf-8')) > 2 * 1024 * 1024:
        raise RuntimeError('native_gui_usage_rust_execution_failed')
    try:
        actual = json.loads(process.stdout)
    except (ValueError, TypeError) as exc:
        raise RuntimeError('native_gui_usage_rust_invalid_json') from exc
    if actual != expected:
        raise RuntimeError('native_gui_usage_rust_mismatch')
    return actual


def project(payload: dict, *, profile: dict | None = None) -> dict:
    if profile is None:
        from variant_features import features
        profile = features()
    reference = _project_python(payload, profile=profile)
    return _native_checked(payload, profile, reference)
