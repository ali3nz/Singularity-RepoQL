#!/usr/bin/env python3
"""Read-only native-Windows source/package inventory.

Never treats code presence, local tests, or health pings as deployment proof.
The findings list contains specific, testable release blockers; it is not a
regex-only assertion that arbitrary strings imply executed dependencies.
"""
from __future__ import annotations
import argparse
import json
from pathlib import Path
import zipfile
from windows_source_policy import linux_deployment_asset
from compare_production_parity import mandatory

ROOT = Path(__file__).resolve().parents[2]
KNOWN = [
    ('P0','tencent_native_runtime', 'memory/upstream/start-all.sh',
     'Legacy Tencent stack uses shell/Compose. Native Windows service, storage and startup not end-to-end accepted.'),
    ('P0','legacy_installer', 'scripts/install-claude-code.mjs',
     'Legacy installer calls Docker and shell. Explicit Windows refusal added; no complete native installer yet.'),
    ('P0','legacy_doctor', 'scripts/doctor.mjs',
     'Legacy doctor includes Docker/Compose-oriented runtime probes and cannot certify a native Windows install.'),
    ('P0','harness_process_identity', 'harness/kit/lib/consult-liveness.mjs',
     'Windows liveness now fails closed; native Rust owner proof must replace the unavailable Linux /proc check.'),
    ('P0','harness_linux_orchestration', 'harness/kit/orchestrate.mjs',
     'Shared Harness code still contains /proc, Docker/SSH worker instructions and Linux process assumptions; named-pipe adapter alone does not port the workflows.'),
    ('P0','rust_harness_build', 'harness/rust-authority/src/authority_windows.rs',
     'Windows named-pipe authority remains uncompiled and untested on native Windows.'),
    ('P0','rust_supervisor_build', 'native/windows/rust-supervisor/src/lib.rs',
     'Windows Job Object process supervisor remains uncompiled, with process containment spawn race.'),
    ('P0','agent_chat_dispatch', 'scripts/orch-chat',
     'Windows local mailbox CLI has guarded compatibility code, but consult dispatch/relay and restart delivery remain unverified.'),
    ('P0','ghost_native_service', 'ghost/ghost-gateway.mjs',
     'Complete variants still need native Windows Ghost backend, prompt mutations and dream recovery.'),
    ('P0','office_native_service', 'office/office.compose.yml',
     'Office frontend remains a separate service; proven token-URL proxy does not establish native Windows startup/event delivery.'),
    ('P0','kanban_native_service', 'connectors/kanzo/connector.ts',
     'A source adapter is not a native Kanzo board installation nor verified task readback.'),
    ('P0','real_repoql_connector', 'connectors/memorycore/connector.ts',
     'RepoQL 1.7.18 and connector ABI 1 pin is checked statically, not exercised with a real rql.exe.'),
    ('P0','self_learning_e2e', 'scripts/selflearn-candidates.mjs',
     'Document review, candidate assessment, promotion and conflict correction lack production-to-Windows behavioural receipts.'),
    ('P1','legacy_linux_cpu_collector', 'dashboard/collector.py',
     'Linux /proc CPU collector excluded from Windows option archives; native Rust sampling still needs live ownership evidence.'),
    ('P1','linux_telemetry_branch', 'dashboard/harness_telemetry.py',
     'Dashboard still includes Linux systemd telemetry; Windows-specific wiring must be verified.'),
    ('P0','dashboard_live_parity', 'dashboard/server.py',
     'GUI dashboard routes exist, but connected services, graph streaming, cookies, CPU and subscription telemetry need real Windows receipts.'),
]


def inspect(directory: Path, archives: list[Path]):
    findings=[]
    for priority, component, path, note in KNOWN:
        if (directory/path).exists():
            findings.append({'priority':priority,'component':component,'path':path,'issue':note,'state':'UNVERIFIED'})
    packages=[]
    for archive in archives:
        with zipfile.ZipFile(archive) as z:
            names=z.namelist()
            linux=[n for n in names if linux_deployment_asset(n)]
            manifests=[n for n in names if n=='NATIVE_WINDOWS_SOURCE_MANIFEST.json']
            manifest=json.loads(z.read(manifests[0])) if manifests else {}
            packages.append({'name':archive.name,'variant':manifest.get('variant'),
                'source_only':manifest.get('release_status')=='SOURCE_ONLY_UNCOMPILED_NOT_INSTALLER',
                'linux_deployment_entries':linux,
                'native_binary_included':any(n.lower().endswith(('.exe','.msi')) for n in names),
                'files':len(names)})
    return {'schema':'singularity-windows-portability-audit/v1',
        'base':'source-snapshot-not-runtime-proof', 'repoql_version_required':'1.7.18',
        'linux_deployment_files_in_windows_packages':sum(len(p['linux_deployment_entries']) for p in packages),
        'packages':packages,'findings':findings,
        'production_baseline_test_evidence':'NOT_PROVIDED',
        'windows_native_runtime_test_evidence':'NOT_RUN',
        'required_feature_checks_per_variant':{str(n):list(mandatory(n)) for n in (1,2,3,4)},
        'native_release_ready':False,
        'linux_production_files_in_complete_source':'RETAINED_SEPARATELY_FOR_SOURCE_COMPARISON',
        'note':'No WSL/Docker runtime dependency may be asserted only after a real Windows process/dependency trace and successful native end-to-end tests.'}


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, default=ROOT)
    parser.add_argument('--archives', nargs='*', type=Path, default=[])
    parser.add_argument('--output', type=Path)
    args=parser.parse_args()
    result=inspect(args.root,args.archives)
    data=json.dumps(result,indent=2)+'\n'
    if args.output:args.output.write_text(data,encoding='utf-8')
    else:print(data)
    return 0

if __name__=='__main__':raise SystemExit(main())
