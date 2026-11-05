"""Source-scoped native GUI usage view, never a subscription-quota estimator.

Receipts currently originate from the legacy unified gateway recent-event feed.
That feed is not complete and cannot establish totals or plan allowances.
An installer profile may only expose its *own* desktop GUI; another GUI's
receipts and all provider/Fleet/Freebuff receipts are excluded.
"""
from __future__ import annotations

GUI_SOURCE_FOR_GUI = {
    'claude-desktop-code': 'claude-desktop-code',
    'openchamber-desktop': 'openchamber-desktop-subscription',
}
GUI_SOURCES = frozenset(GUI_SOURCE_FOR_GUI.values())


def project(payload: dict, *, profile: dict | None = None) -> dict:
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
         'events': s.get('events') if type(s.get('events')) is int and s['events'] >= 0 else None,
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
