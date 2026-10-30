#!/usr/bin/env python3
"""Fail-closed comparison of independent production and native-Windows receipts.

Read-only; never executes a service. Receipt format deliberately contains only
pass/fail, a stable evidence reference and a timestamp, not tokens or transcripts.
A missing or stale receipt is NOT a pass. This is an acceptance gate, not a test.
"""
from __future__ import annotations
import argparse
from datetime import datetime, timezone, timedelta
import json
from pathlib import Path

SCHEMA = 'singularity-runtime-parity/v1'
COMMON = (
    'clean_install', 'upgrade_rollback', 'service_restart', 'gui_native_session',
    'automatic_capture', 'new_session_recall', 'agent_identity_isolation',
    'memory_extraction', 'documentation_assessment', 'documentation_update',
    'verified_doc_ingestion', 'knowledge_candidate_evaluation',
    'gated_knowledge_promotion', 'conflict_correction',
    'two_provider_failover', 'repoql_cli_connector_compatibility', 'repoql_mcp_query',
    'repoql_index_and_retrieve', 'tencent_connector_abi1',
    'agent_chat_durable_delivery', 'kanban_create_update_readback',
    'dashboard_embedded_login', 'live_memory_graph_refresh',
    'windows_cpu_attribution', 'gui_subscription_usage_source',
)
OPTIONAL = (
    'ghost_task_lifecycle', 'ghost_prompt_edit_history', 'ghost_dream_recovery',
    'office_native_presence_events', 'office_dashboard_embed',
)


def mandatory(variant):
    if type(variant) is not int or variant not in (1, 2, 3, 4):
        raise ValueError('invalid option')
    return COMMON + OPTIONAL if variant in (2, 4) else COMMON


def _date(text):
    try:
        d = datetime.fromisoformat(text.replace('Z', '+00:00'))
        return d.astimezone(timezone.utc) if d.tzinfo is not None else None
    except (ValueError, AttributeError):
        return None


def compare(production, windows, *, now=None, max_age_days=7):
    now = now or datetime.now(timezone.utc)
    problems = []
    if production.get('schema') != SCHEMA or windows.get('schema') != SCHEMA:
        problems.append('receipt_schema_missing_or_wrong')
    if production.get('runtime') != 'production-linux-docker':
        problems.append('production_runtime_not_proven')
    if windows.get('runtime') != 'native-windows-no-wsl':
        problems.append('native_windows_runtime_not_proven')
    variant = windows.get('variant')
    try:
        required = mandatory(variant)
    except ValueError:
        problems.append('invalid_windows_option')
        required = ()
    if production.get('product') != 'Singularity RepoQL' or windows.get('product') != 'Singularity RepoQL':
        problems.append('wrong_product')
    if windows.get('repoql_version') != '1.7.18':
        problems.append('windows_repoql_1_7_18_not_proven')
    # Production is not upgraded by preparing a Windows release. Both sides
    # need independent successful connector receipts; mixed versions are legal.
    if production.get('repoql_version') not in ('1.7.15', '1.7.18'):
        problems.append('production_repoql_version_not_in_comparison_scope')
    if production.get('connector_abi') != 1 or windows.get('connector_abi') != 1:
        problems.append('connector_abi1_not_proven')
    observations = {}
    for feature in required:
        observations[feature] = {}
        for label, receipt in (('production', production), ('windows', windows)):
            entry = (receipt.get('checks') or {}).get(feature)
            if not isinstance(entry, dict):
                observations[feature][label] = 'MISSING'
                continue
            stamp = _date(entry.get('observed_at'))
            evidence = entry.get('evidence_id')
            if entry.get('result') != 'PASS':
                state = 'NOT_PASSED'
            elif not isinstance(evidence, str) or not evidence.strip() or len(evidence) > 512:
                state = 'NO_EVIDENCE'
            elif stamp is None or stamp > now + timedelta(minutes=5) or now - stamp > timedelta(days=max_age_days):
                state = 'STALE_OR_INVALID_TIMESTAMP'
            elif entry.get('synthetic') is True:
                state = 'SYNTHETIC_NOT_ACCEPTED'
            else:
                state = 'PASS_RECEIPTED'
            observations[feature][label] = state
    ok = not problems and bool(required) and all(all(x == 'PASS_RECEIPTED' for x in states.values()) for states in observations.values())
    return {'schema': 'singularity-parity-comparison/v1', 'ready': ok,
            'scope': f'option-{variant}', 'problems': problems,
            'accepted_checks': sum(all(x == 'PASS_RECEIPTED' for x in s.values()) for s in observations.values()),
            'required_checks': len(required), 'checks': observations,
            'note': 'Evidence IDs require independent review. This comparator cannot authenticate the actual production or Windows host.'}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--production', type=Path, required=True)
    parser.add_argument('--windows', type=Path, required=True)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    result = compare(json.loads(args.production.read_text(encoding='utf-8')),
                     json.loads(args.windows.read_text(encoding='utf-8')))
    if args.output:
        args.output.write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    else:
        print(json.dumps(result, indent=2))
    raise SystemExit(0 if result['ready'] else 2)


if __name__ == '__main__':
    main()
