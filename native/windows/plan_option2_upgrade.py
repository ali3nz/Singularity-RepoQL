#!/usr/bin/env python3
"""Read-only, fail-closed dependency plan for native Claude Code Complete upgrades.

Nothing is installed, stopped, unregistered, restored or deleted here. Presence
of a receipt is NOT proof of healthy installation. PowerShell supplies task
state from the native scheduler, never from a user-editable receipt.
"""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
import stat

from rust_release_policy import checked_policy

SCHEMA = 'singularity-option2-upgrade-dependency-plan/v1'
RECEIPTS = {
    'claude': ('.claude/.singularity-native-claude-journal.json', None),
    'parent': ('.claude/.singularity-parent-memory-proxy-receipt.json',
               'singularity-option2-parent-proxy/v1'),
    'kanzo': ('.singularity-native-mcp-receipt.json', None),
    'current': ('current/STAGING_RECEIPT.json', None),
    'previous': ('previous/STAGING_RECEIPT.json', None),
    'retired': ('held-retired/STAGING_RECEIPT.json', None),
}


def _plain(path: Path) -> bool:
    """Examine every existing ancestor; refuse dangling symlinks as well."""
    for item in reversed((path, *path.parents)):
        try:
            st = item.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(st.st_mode) or (getattr(st, 'st_file_attributes', 0) & 0x400):
            raise ValueError('UPGRADE_REPARSE_PATH_REFUSED')
    return True


def _receipt(path: Path, schema: str | None) -> bool:
    _plain(path)
    try:
        st = path.lstat()
    except FileNotFoundError:
        return False
    if not stat.S_ISREG(st.st_mode) or st.st_size < 8 or st.st_size > 32768:
        raise ValueError('UPGRADE_RECEIPT_TYPE_OR_SIZE_INVALID')
    try:
        obj = json.loads(path.read_text(encoding='utf-8'))
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError('UPGRADE_RECEIPT_JSON_INVALID') from exc
    if not isinstance(obj, dict):
        raise ValueError('UPGRADE_RECEIPT_NOT_OBJECT')
    if schema and obj.get('schema') != schema:
        raise ValueError('UPGRADE_RECEIPT_SCHEMA_INVALID')
    return True


def upgrade_plan(stage_root: Path, claude_home: Path, workspace: Path,
                 task_state: str = 'UNKNOWN', dashboard_task_state: str = 'UNKNOWN') -> dict:
    if task_state not in ('UNKNOWN', 'REGISTERED', 'ABSENT'):
        raise ValueError('UPGRADE_TASK_STATE_INVALID')
    if dashboard_task_state not in ('UNKNOWN','REGISTERED','ABSENT'):
        raise ValueError('UPGRADE_DASHBOARD_TASK_STATE_INVALID')
    paths = [stage_root, claude_home, workspace]
    if any(not p.is_absolute() for p in paths):
        raise ValueError('UPGRADE_ABSOLUTE_PATHS_REQUIRED')
    for p in paths:
        _plain(p)
    statuses = {}
    for name, (rel, schema) in RECEIPTS.items():
        parent = workspace if name == 'kanzo' else claude_home if name in ('claude', 'parent') else stage_root
        statuses[name] = _receipt(parent / rel, schema)
    # A stage directory without its owned receipt is an unknown, not a fresh
    # or safe-to-overwrite installation. Do not guess ownership.
    for key, directory in (('current','current'),('previous','previous'),('retired','held-retired')):
        path = stage_root / directory
        _plain(path)
        if path.exists() and not statuses[key]:
            raise ValueError('UPGRADE_UNOWNED_STAGE_DIRECTORY_REFUSED')
    actions = []
    if task_state == 'REGISTERED':
        actions.append('REMOVE_OWNED_SUPERVISOR_AFTER_VERIFYING_TASK_OWNER')
    elif task_state == 'UNKNOWN':
        actions.append('VERIFY_NATIVE_SCHEDULER_TASK_OWNERSHIP')
    if dashboard_task_state == 'REGISTERED':
        actions.insert(0,'REMOVE_OWNED_DASHBOARD_AFTER_VERIFYING_TASK_OWNER')
    elif dashboard_task_state == 'UNKNOWN':
        actions.insert(0,'VERIFY_DASHBOARD_TASK_OWNERSHIP')
    if statuses['parent']:
        actions.append('ROLLBACK_RECEIPT_OWNED_PARENT_PROXY')
    if statuses['claude'] or statuses['kanzo']:
        actions.append('ROLLBACK_RECEIPT_OWNED_CLAUDE_AND_KANZO')
    if statuses['current']:
        if statuses['previous']:
            actions.append('REVIEW_UPGRADE_SNAPSHOT_BEFORE_STAGE_REPLACEMENT')
        elif statuses['retired']:
            actions.append('RESOLVE_RETIRED_SNAPSHOT_COLLISION')
        actions.append('VERIFY_AND_STAGE_APPROVED_REPLACEMENT')
    else:
        actions.append('PREPARE_FIRST_STAGE_AFTER_BUNDLE_VERIFICATION')
    dependencies_clear = (task_state == 'ABSENT' and dashboard_task_state == 'ABSENT' and
                          not statuses['parent'] and
                          not statuses['claude'] and
                          not statuses['kanzo'])
    can_stage_fresh = dependencies_clear and not statuses['current'] and not statuses['retired']
    can_replace_owned = (dependencies_clear and statuses['current'] and
                         not statuses['previous'] and not statuses['retired'])
    reference = {
        'schema': SCHEMA, 'option': 2,
        'receipt_presence': statuses,
        'supervisor_task_state_from_scheduler': task_state,
        'dashboard_task_state_from_scheduler': dashboard_task_state,
        'dependencies_cleared_for_stage_replacement': dependencies_clear,
        'first_stage_clear': can_stage_fresh,
        'existing_owned_stage_can_be_replaced': can_replace_owned,
        'ordered_operator_actions': actions,
        'performed_changes': False, 'windows_runtime_verified': False,
        'release_ready': False,
    }
    return checked_policy('upgrade-plan-stdin', {
        'receipts': statuses,
        'taskState': task_state,
        'dashboardTaskState': dashboard_task_state,
    }, reference)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description='Read-only native Windows Option 2 upgrade dependency planner')
    parser.add_argument('--stage-root', type=Path, required=True)
    parser.add_argument('--claude-home', type=Path, required=True)
    parser.add_argument('--workspace', type=Path, required=True)
    parser.add_argument('--task-state', choices=('UNKNOWN','REGISTERED','ABSENT'), default='UNKNOWN')
    parser.add_argument('--dashboard-task-state', choices=('UNKNOWN','REGISTERED','ABSENT'), default='UNKNOWN')
    args = parser.parse_args(argv)
    try:
        result = upgrade_plan(args.stage_root, args.claude_home, args.workspace, args.task_state, args.dashboard_task_state)
    except (ValueError, OSError):
        print('UPGRADE_PLAN_REFUSED')
        return 2
    print(json.dumps(result, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
