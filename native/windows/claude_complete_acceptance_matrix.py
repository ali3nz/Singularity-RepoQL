#!/usr/bin/env python3
"""Produce a redacted evidence inventory for native Claude Code Complete acceptance.

This is an organizer, NOT a substitute for a native GUI/service test. It never
asserts release readiness: receipt success is *reported*, not independently
certified. All evidence and credentials stay on the operator's machine.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import stat

from rust_release_policy import checked_policy

SCHEMA = 'singularity-claude-complete-acceptance-evidence/v1'
RECEIPT_SCHEMA = 'singularity-claude-complete-gate-evidence/v1'
MAX_RECEIPT = 8192
MAX_EVIDENCE = 16 * 1024 * 1024
GATES = (
    'windows_rust_binaries',
    'windows_candidate_preparation',
    'native_claude_desktop_code_tab',
    'singularity_agents_9',
    'singularity_skills_10',
    'official_repoql_skills_17',
    'repoql_1_7_18_plugin_mcp',
    'kanzo_project_mcp',
    'kanzo_todo_doing_closed_lifecycle',
    'repoql_connectors_kanzo_memorycore_active',
    'native_dashboard_authenticated_http',
    'docker_dashboard_visual_parity',
    'windows_unified_graph_locality',
    'claude_memory_and_office_hooks',
    'claude_workflow_rule_refresh',
    'repoql_import_freshness_readback',
    'tencent_delegated_profiles_8',
    'tencent_parent_new_session_recall',
    'ghost_negative_scope_isolation',
    'tencent_repoql_doc_revision_parity',
    'claude_office_live_event_roundtrip',
    'windows_service_reboot_recovery',
    'windows_upgrade_rollback_uninstall',
    'native_no_wsl_docker_cli_dependency',
)


def _regular(path: Path, max_bytes: int) -> bool:
    # Refuse symlink/reparse file and any symlinked parents, not just final leaf.
    cursor = path
    while True:
        info = cursor.lstat()
        if stat.S_ISLNK(info.st_mode) or (getattr(info, 'st_file_attributes', 0) & 0x400):
            raise ValueError('REPARSE_EVIDENCE_PATH_REFUSED')
        if cursor == path and (not stat.S_ISREG(info.st_mode) or not (1 <= info.st_size <= max_bytes)):
            raise ValueError('EVIDENCE_TYPE_OR_SIZE_INVALID')
        if cursor == cursor.parent:
            break
        cursor = cursor.parent
    return True


def _read_gate(evidence_dir: Path, gate: str) -> dict:
    receipt_path = evidence_dir / f'{gate}.json'
    if not receipt_path.exists() and not receipt_path.is_symlink():
        return {'gate': gate, 'status': 'NOT_RUN'}
    _regular(receipt_path, MAX_RECEIPT)
    try:
        receipt = json.loads(receipt_path.read_text('utf-8'))
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError('GATE_RECEIPT_INVALID_JSON') from exc
    if (not isinstance(receipt, dict) or set(receipt) !=
        {'schema', 'gate', 'result', 'source_commit', 'evidence_name', 'evidence_sha256'} or
        receipt.get('schema') != RECEIPT_SCHEMA or receipt.get('gate') != gate or
        receipt.get('result') not in ('PASS', 'FAIL') or
        not isinstance(receipt.get('source_commit'), str) or
        not re.fullmatch(r'[0-9a-fA-F]{40}', receipt['source_commit']) or
        not isinstance(receipt.get('evidence_name'), str) or
        not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,95}', receipt['evidence_name']) or
        receipt['evidence_name'].split('.',1)[0].upper() in {'CON','AUX','PRN','NUL'} or
        not isinstance(receipt.get('evidence_sha256'), str) or
        not re.fullmatch(r'[a-f0-9]{64}', receipt['evidence_sha256'])):
        raise ValueError('GATE_RECEIPT_SCHEMA_OR_SCOPE_INVALID')
    evidence_path = evidence_dir / receipt['evidence_name']
    _regular(evidence_path, MAX_EVIDENCE)
    digest = hashlib.sha256()
    with evidence_path.open('rb') as f:
        while chunk := f.read(1024 * 1024):
            digest.update(chunk)
    if digest.hexdigest() != receipt['evidence_sha256']:
        raise ValueError('GATE_EVIDENCE_HASH_MISMATCH')
    return {
        'gate': gate,
        'status': 'REPORTED_PASS_UNREVIEWED' if receipt['result'] == 'PASS' else 'REPORTED_FAIL',
        'source_commit': receipt['source_commit'].lower(),
        'evidence_sha256': receipt['evidence_sha256'],
    }


def matrix(evidence_dir: Path | None = None) -> dict:
    if evidence_dir is None:
        rows = [{'gate': gate, 'status': 'NOT_RUN'} for gate in GATES]
    else:
        evidence_dir = Path(os.path.abspath(evidence_dir))
        if not evidence_dir.is_dir():
            raise ValueError('EVIDENCE_DIRECTORY_MISSING')
        # The report deliberately excludes local paths, raw logs and secrets.
        rows = [_read_gate(evidence_dir, gate) for gate in GATES]
    statuses = [row['status'] for row in rows]
    commits = {row.get('source_commit') for row in rows if row['status'] != 'NOT_RUN'}
    reference = {
        'schema': SCHEMA,
        'scope': 'Claude Code Complete native Windows',
        'required_gates': len(GATES),
        'not_run': statuses.count('NOT_RUN'),
        'reported_pass_unreviewed': statuses.count('REPORTED_PASS_UNREVIEWED'),
        'reported_fail': statuses.count('REPORTED_FAIL'),
        'mixed_source_revisions': len(commits) > 1,
        'all_live_tests_independently_verified': False,
        'release_ready': False,
        'gate_results': rows,
    }
    return checked_policy('acceptance-matrix-stdin', {'gateResults': rows}, reference)


def main() -> int:
    parser = argparse.ArgumentParser(description='Read-only evidence matrix; never release approval')
    parser.add_argument('--evidence-dir', type=Path, help='Local directory of operator-reviewed, redacted gate evidence')
    parser.add_argument('--output', type=Path, help='New report file; refuses overwrite')
    args = parser.parse_args()
    data = json.dumps(matrix(args.evidence_dir), indent=2, sort_keys=True) + '\n'
    if args.output:
        # File-exclusive create, no overwriting any existing receipts, config or logs.
        with args.output.open('x', encoding='utf-8') as f:
            f.write(data)
    else:
        print(data, end='')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
