"""Read-only native Windows service readiness probes for clean-install testing.

This endpoint is *diagnostic*, not a bootstrapper. Never exposes tokens, URLs,
filesystem paths, private user names, raw exceptions or host IPs. A live
service probe does not imply GUI, connector or public release acceptance.
"""
from __future__ import annotations
import http.client
import json
import os
from pathlib import Path
import subprocess
from variant_features import features


def _status(enabled=True, verified=False, reason='not_tested'):
    if not enabled:
        return {'state': 'excluded', 'verified': False}
    return {'state': 'reachable' if verified else 'unverified', 'verified': bool(verified),
            'reason': None if verified else reason}


def _ping_kanzo():
    from native_panel_proxy import UPSTREAM
    conn = http.client.HTTPConnection(*UPSTREAM['kanzo'], timeout=2)
    try:
        conn.request('GET', '/api/ping')
        r = conn.getresponse()
        return r.status == 200 and r.read(64) == b'kanzo'
    finally:
        conn.close()


# These are the only probe results permitted to cross into the native read model.
# Keep credentials, endpoints, private paths and probe exceptions in Python.
PROBE_NAMES = (
    'repoql_version', 'tencent_session', 'kanban_http',
    'agent_chat_state', 'harness_rust_coordinator',
    'unified_graph_gateway', 'claude_office_http',
)
NOTE = ('Reachable verifies only a specific local probe. It does not prove '
        'installation, full authentication, capture, memory graph updates or real GUI acceptance.')


def _project_python(profile, verified):
    """Pure, reference readiness projection. Never infer release approval."""
    office = bool(profile['features']['office'])
    results = {
        'repoql_version': _status(verified=verified['repoql_version'], reason='repoql_1_7_18_not_verified'),
        'tencent_session': _status(verified=verified['tencent_session'], reason='tencent_login_not_verified'),
        'kanban_http': _status(verified=verified['kanban_http'], reason='kanzo_ping_not_verified'),
        'agent_chat_state': _status(verified=verified['agent_chat_state'], reason='agent_chat_state_unavailable'),
        'harness_rust_coordinator': _status(verified=verified['harness_rust_coordinator'], reason='authenticated_rust_coordinator_unavailable'),
        'unified_graph_gateway': _status(verified=verified['unified_graph_gateway'], reason='unified_gateway_not_verified'),
        'claude_office_http': _status(enabled=office, verified=verified['claude_office_http'], reason='office_login_not_verified'),
        'native_gui_session': _status(reason='real_windows_gui_acceptance_required'),
        'connector_indexing': _status(reason='actual_connector_sweep_required'),
        'subscription_token_receipts': _status(reason='authoritative_gui_receipts_required'),
        'claude_office_event_delivery': _status(enabled=office, reason='live_gui_event_ack_required'),
        'installed_windows_service': _status(reason='windows_service_lifecycle_required'),
    }
    return {
        'platform': 'windows-native', 'variant': profile['variant'],
        'repoql_required_version': '1.7.18', 'services': results,
        'release_ready': False, 'note': NOTE,
    }


def _native_checked(profile, verified, expected):
    """Opt in to native rendering only when it exactly matches Python."""
    binary = os.environ.get('SINGULARITY_NATIVE_READINESS_RUST_BINARY', '')
    if not binary:
        return expected
    executable = Path(binary)
    if not executable.is_absolute() or executable.is_symlink() or not executable.is_file():
        raise RuntimeError('native_readiness_rust_binary_invalid')
    # The seven validated booleans are the only values passed to Rust.
    request = json.dumps({'variant': profile['variant'],
                          'office': bool(profile['features']['office']),
                          'probes': {name: bool(verified[name]) for name in PROBE_NAMES}},
                         ensure_ascii=False)
    if len(request.encode('utf-8')) > 65536:
        raise RuntimeError('native_readiness_rust_request_too_large')
    try:
        completed = subprocess.run([str(executable)], input=request, text=True,
                                   encoding='utf-8', capture_output=True,
                                   timeout=10, shell=False, check=False)
    except (OSError, UnicodeError, subprocess.TimeoutExpired) as exc:
        raise RuntimeError('native_readiness_rust_execution_failed') from exc
    if completed.returncode != 0 or len(completed.stdout.encode('utf-8')) > 65536:
        raise RuntimeError('native_readiness_rust_execution_failed')
    try:
        actual = json.loads(completed.stdout)
    except (ValueError, TypeError) as exc:
        raise RuntimeError('native_readiness_rust_invalid_json') from exc
    if actual != expected:
        raise RuntimeError('native_readiness_rust_mismatch')
    return actual


def report(config, *, profile=None, probes=None):
    """Run actual service probes once; render an unprivileged read-only status."""
    profile = profile or features()
    flags = profile['features']
    probes = probes or {}

    def probe(label, test):
        try:
            return bool(probes[label]()) if label in probes else bool(test())
        except Exception:
            # Exception content could include keys or private paths.
            return False

    def check_repoql():
        from native_repoql_gate import check_native_repoql
        return check_native_repoql(config, native=True).get('ok') is True

    def check_tencent():
        from native_panel_proxy import tencent_session
        return tencent_session().get('authenticated') is True

    def check_office():
        from office_bridge import office_status, embed_url
        from native_panel_proxy import backend_key
        backend_key('office')
        return office_status().get('available') is True and embed_url() is not None

    def check_unified():
        from unified_bridge import forward_unified
        data = forward_unified('GET', '/api/unified/health')
        return isinstance(data, dict) and data.get('available') is not False and data.get('ok') is True

    def check_chat():
        from agentchat_feed import read_feed
        return read_feed(limit=1).get('available') is True

    def check_harness():
        from harness_rust import RustHarness
        return RustHarness().health().get('available') is True

    verified = {
        'repoql_version': probe('repoql_version', check_repoql),
        'tencent_session': probe('tencent_session', check_tencent),
        'kanban_http': probe('kanban_http', _ping_kanzo),
        'agent_chat_state': probe('agent_chat_state', check_chat),
        'harness_rust_coordinator': probe('harness_rust_coordinator', check_harness),
        'unified_graph_gateway': probe('unified_graph_gateway', check_unified),
        'claude_office_http': flags['office'] and probe('claude_office_http', check_office),
    }
    reference = _project_python(profile, verified)
    return _native_checked(profile, verified, reference)
