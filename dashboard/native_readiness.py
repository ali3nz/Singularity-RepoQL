"""Read-only native Windows service readiness probes for clean-install testing.

This endpoint is *diagnostic*, not a bootstrapper. Never exposes tokens, URLs,
filesystem paths, private user names, raw exceptions or host IPs. A live
service probe does not imply GUI, connector or public release acceptance.
"""
from __future__ import annotations
import http.client
import json
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


def report(config, *, profile=None, probes=None):
    """Use injected fake probes for hermetic cross-platform acceptance tests."""
    profile = profile or features()
    flags = profile['features']
    probes = probes or {}
    def probe(label, test):
        try:
            return bool(probes[label]()) if label in probes else bool(test())
        except (Exception,):
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
    def check_ghost():
        from ghost_bridge import control_request
        code, result = control_request('GET')
        return code == 200 and isinstance(result, dict) and result.get('ok') is True
    def check_unified():
        from unified_bridge import forward_unified
        data = forward_unified('GET', '/api/unified/health')
        return isinstance(data, dict) and data.get('available') is not False and data.get('ok') is True
    def check_chat():
        from agentchat_feed import read_feed
        return read_feed(limit=1).get('available') is True
    def check_harness():
        # Actual authenticated Rust coordinator read-model health, not an
        # inferred green status from a listening port or a JavaScript shim.
        from harness_rust import RustHarness
        return RustHarness().health().get('available') is True
    results = {
        'repoql_version': _status(verified=probe('repoql_version',check_repoql), reason='repoql_1_7_18_not_verified'),
        'tencent_session': _status(verified=probe('tencent_session',check_tencent), reason='tencent_login_not_verified'),
        'kanban_http': _status(verified=probe('kanban_http',_ping_kanzo), reason='kanzo_ping_not_verified'),
        'agent_chat_state': _status(verified=probe('agent_chat_state',check_chat), reason='agent_chat_state_unavailable'),
        'harness_rust_coordinator': _status(verified=probe('harness_rust_coordinator',check_harness), reason='authenticated_rust_coordinator_unavailable'),
        'unified_graph_gateway': _status(verified=probe('unified_graph_gateway',check_unified), reason='unified_gateway_not_verified'),
        'claude_office_http': _status(enabled=flags['office'],verified=flags['office'] and probe('claude_office_http',check_office), reason='office_login_not_verified'),
        'ghost_control_http': _status(enabled=flags['ghost'],verified=flags['ghost'] and probe('ghost_control_http',check_ghost), reason='ghost_control_not_verified'),
        'native_gui_session': _status(reason='real_windows_gui_acceptance_required'),
        'connector_indexing': _status(reason='actual_connector_sweep_required'),
        'subscription_token_receipts': _status(reason='authoritative_gui_receipts_required'),
        'claude_office_event_delivery': _status(enabled=flags['office'], reason='live_gui_event_ack_required'),
        'ghost_prompt_editing': _status(enabled=flags['ghost'], reason='native_ghost_prompt_mutation_required'),
        'installed_windows_service': _status(reason='windows_service_lifecycle_required'),
    }
    return {
        'platform':'windows-native','variant':profile['variant'],
        'repoql_required_version':'1.7.18', 'services':results,
        'release_ready':False,
        'note':'Reachable verifies only a specific local probe. It does not prove installation, full authentication, capture, memory graph updates or real GUI acceptance.',
    }
