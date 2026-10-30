#!/usr/bin/env python3
"""Evidence-based runtime closure inventory for *source-only* native Windows variants.

This is deliberately not a portable dependency resolver. It explains what a
source ZIP can and cannot establish. A passing archive scan is never accepted
as proof that backend services exist or behave like production.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import zipfile

from scan_source_archive import scan

# Component id, required source hint (may be None for externally provided
# software), and acceptance contract. The mandatory items are derived from the
# four native installation options and are not guessed from file presence.
BASE = (
    ('repoql', None, 'Real Windows rql.exe --version=1.7.18, ABI-1 indexing, query and readback'),
    ('desktop-bridge', 'native/desktop-bridge/src/main.rs', 'Compiled native bridge, MCP handshake from the actual selected desktop GUI'),
    ('rust-harness-authority', 'harness/rust-authority/src/main.rs', 'Compiled native named pipe; owner security, durable state and restart test'),
    ('rust-service-supervisor', 'native/windows/rust-supervisor/src/lib.rs', 'Compiled supervisor; child lifecycle, Job Object and shutdown containment'),
    ('tencent-memorycore', 'connectors/memorycore/connector.ts', 'Actual native Tencent service and persistence, memory write and semantic recall'),
    ('self-learning', 'scripts/selflearn-candidates.mjs', 'Capture, assess, promote, corrections and evidence-safe doc ingestion'),
    ('agent-chat', 'dashboard/agentchat_feed.py', 'Native relay, durable submit/delivery and restart/replay'),
    ('kanzo', 'connectors/kanzo/connector.ts', 'Actual native board server and create/update/readback, not only connector code'),
    ('dashboard', 'dashboard/server.py', 'Native dashboard listener; embedded service authentication and browser workflow'),
    ('memory-graph', 'dashboard/unified_bridge.py', 'Real live graph backend, streaming/reconnect and graph readback'),
    ('native-telemetry', 'dashboard/native_cpu.py', 'Real Windows process CPU, GUI-sourced subscription receipts'),
)
EXTRAS = (
    ('ghost', 'ghost/prompt-store/prompt_store.py', 'Native Ghost daemon; task lifecycle, prompt edit, revert and audit'),
    ('claude-office', 'dashboard/office_bridge.py', 'Native Office backend; token URL, presence/events, iframe and restart'),
)
GUI_HINTS = {
    1: ('claude-desktop-code', 'adapters/claude-code/doc-hook.mjs'),
    2: ('claude-desktop-code', 'adapters/claude-code/doc-hook.mjs'),
    3: ('openchamber-desktop', 'native/windows/configure_project_mcp.mjs'),
    4: ('openchamber-desktop', 'native/gui-plugins/openchamber/singularity-office.mjs'),
}


def inspect(source_zip: Path) -> dict:
    package = scan(str(source_zip))
    if not package['ok']:
        return {'schema':'singularity-native-runtime-closure/v1', 'ready':False,
                'source_archive_valid':False, 'issues':package['issues'], 'components':[]}
    with zipfile.ZipFile(source_zip) as z:
        names = set(z.namelist())
        manifest = json.loads(z.read('NATIVE_WINDOWS_SOURCE_MANIFEST.json'))
    variant = manifest['variant']
    gui, gui_hint = GUI_HINTS[variant]
    specs = BASE + (EXTRAS if variant in (2,4) else ())
    components=[]
    for cid,hint,acceptance in specs:
        components.append({'id':cid,'source_hint':hint,'source_hint_present':hint in names if hint else None,
                           'actual_windows_binary_present':False,
                           'native_runtime_verified':False,'behavioural_parity_verified':False,
                           'acceptance_required':acceptance,'status':'BLOCKED_UNVERIFIED'})
    # OpenChamber's full-variant Office plugin may be omitted from lean option
    # archives intentionally; native GUI session acceptance is still mandatory.
    components.append({'id':gui,'source_hint':gui_hint,
                       'source_hint_present':gui_hint in names,
                       'actual_windows_binary_present':False,
                       'native_runtime_verified':False,'behavioural_parity_verified':False,
                       'acceptance_required':'Selected native GUI session and persistent hooks work after restart',
                       'status':'BLOCKED_UNVERIFIED'})
    issues=[]
    if variant in (3,4) and not (manifest.get('gui') == 'openchamber-desktop'):
        issues.append('OpenChamber option GUI mismatch')
    if variant in (1,2) and not (manifest.get('gui') == 'claude-desktop-code'):
        issues.append('Claude option GUI mismatch')
    if manifest.get('repoql',{}).get('requiredVersion') != '1.7.18':
        issues.append('Windows RepoQL pin mismatch')
    # The single source ZIP has *no* deployable runtime. This is a hard release
    # barrier independent of how many tests or source hints exist.
    issues.append('source-only package has no native Windows runtime or installation evidence')
    return {'schema':'singularity-native-runtime-closure/v1','variant':variant,'gui':gui,
            'repoql_version_required':'1.7.18','source_archive_valid':True,
            'source_files_checked':package['count'],
            'linux_deployment_entries':0,'components':components,
            'components_without_native_runtime_proof':len(components),
            'ready':False,'issues':issues,
            'note':'Source hints do not establish installation, service health or production parity. Real Windows evidence is mandatory.'}


def main() -> int:
    p=argparse.ArgumentParser()
    p.add_argument('archives', nargs='+', type=Path)
    p.add_argument('--output',type=Path)
    args=p.parse_args()
    result={'schema':'singularity-native-runtime-closure-report/v1',
            'profiles':[inspect(x) for x in args.archives]}
    result['public_release_ready']=all(x['ready'] for x in result['profiles'])
    value=json.dumps(result,indent=2)+'\n'
    if args.output:args.output.write_text(value,encoding='utf-8')
    else:print(value)
    # This audit succeeds as a diagnostic even when an honest release verdict
    # is BLOCKED. CI must separately assert public_release_ready before release.
    return 0 if all(x['source_archive_valid'] for x in result['profiles']) else 1

if __name__ == '__main__':raise SystemExit(main())
