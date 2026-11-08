#!/usr/bin/env python3
"""Actual archive-level release contract for native Claude Code option 2.

Fails CLOSED for an executable release. Passing source checks cannot certify
an installed GUI, pinned external Office frontend/backend, or service parity.
Does not read credentials or execute launchers.
"""
from __future__ import annotations
import argparse
import json
import zipfile
from pathlib import Path
from scan_source_archive import scan

AGENTS = (
    'singularity-board', 'singularity-code-reviewer', 'singularity-duel-coordinator',
    'singularity-duo', 'singularity-explore',
    'singularity-free-mode', 'singularity-general', 'singularity-ghost',
    'singularity-orchestrator', 'singularity-quad-coordinator',
    'singularity-researcher-web',
    'singularity-solo-coordinator', 'singularity-standalone',
    'singularity-super', 'singularity-thinker',
)
SKILLS = ('board','claude-office-visual','consult-dispatch','handoff','hub-doc-update','implementation-review','issue-closeout','mcp-builder','retro','statusline-builder')
# Official plugin inventory reviewed at M34. Not redistributed in the source archive.
REPOQL_PLUGIN_SKILLS_EXPECTED = 17
REQUIRED = (
    'adapters/claude-code/memory-hook.mjs',
    'adapters/claude-code/doc-hook.mjs',
    'adapters/claude-code/settings-merge.mjs',
    'adapters/claude-code/office-hook.mjs',
    'adapters/claude-code/agent-map.mjs',
    'native/windows/plan_claude_code_windows.mjs',
    'native/windows/configure_claude_code_windows.mjs',
    'native/windows/claude_complete_memory_profiles.mjs',
    'native/windows/claude_complete_static_inventory.mjs',
    'native/windows/configure_parent_memory_proxy.mjs',
    'native/windows/configure_project_mcp.test.mjs',
    'native/windows/claude_complete_doc_parity.mjs',
    'native/windows/claude_complete_gui_acceptance_plan.py',
    'native/windows/claude_complete_doc_reconciliation.mjs',
    'native/windows/claude_complete_tencent_recovery.mjs',
    'native/windows/claude_complete_ghost_scope_probe.mjs',
    'native/windows/build_option2_acceptance_bundle.py',
    'native/windows/prepare_option2_candidate.py',
    'native/windows/verify_prepared_option2_candidate.py',
    'native/windows/claude_complete_acceptance_matrix.py',
    'native/windows/verify_option2_expected_digest.py',
    'native/windows/install_claude_complete.ps1',
    'native/windows/uninstall_claude_complete.ps1',
    'native/windows/plan_option2_upgrade.py',
    'native/windows/verify_supervisor_task.ps1',
    'native/windows/test_supervisor_registration_source_contract.py',
    'native/windows/test_verify_installed_contract.py',
    'native/windows/test_scheduler_fail_closed_contract.py',
    'native/windows/test_option2_acceptance_bundle.py',
    'docs/WINDOWS-NATIVE-M42-OPTION2-BUILD-CANDIDATE.md',
    'scripts/setup-agent-profiles.mjs',
    'native/windows/variants.json',
    'dashboard/server.py',
    'dashboard/repoql_connectors.py',
    'dashboard/test_repoql_proxy_credential_boundary.py',
    'dashboard/test_repoql_connector_inventory_integrity.py',
    'dashboard/native_repoql_gate.py',
    'native/windows/claude_complete_dashboard_host.py',
    'native/windows/manage_claude_complete_dashboard.ps1',
    'native/windows/verify_option2_connectors.py',
    'native/windows/check_rust_lock_provenance.py',
    'native/windows/test_rust_lock_release_gate.py',
    'dashboard/native_gui_usage.py',
    'dashboard/office_bridge.py',
    'dashboard/native_ghost.py',
    'dashboard/ghost_schedule_plans.py',
    'dashboard/test_ghost_activation_handoff_contract.py',
    'docs/WINDOWS-NATIVE-M86-GHOST-ACTIVATION-HANDOFF.md',
    'docs/WINDOWS-NATIVE-M87-GHOST-DST-PREFLIGHT.md',
    'dashboard/test_ghost_plan_origin_boundary.py',
    'docs/WINDOWS-NATIVE-M88-GHOST-DRAFT-ORIGIN.md',
    'docs/WINDOWS-NATIVE-M89-GHOST-DRAFT-LOCK.md',
    'docs/WINDOWS-NATIVE-M90-GHOST-IDEMPOTENCY-HISTORY.md',
    'docs/WINDOWS-NATIVE-M91-GHOST-REQUEST-RETIREMENT.md',
    'dashboard/static/ghost/index.html',
    'dashboard/static/ghost/dashboard.js',
    'dashboard/static/ghost/tasks.js',
    'dashboard/static/ghost/schedule_model.mjs',
    'ghost/ghost-gateway.mjs',
    'ghost/prompt-store/prompt_store.py',
    'office/PROVENANCE.md',
    'office/README.md',
    'native/desktop-bridge/src/office.rs',
    'native/desktop-bridge/src/ghost.rs',
    'connectors/memorycore/connector.ts',
    'connectors/kanzo/connector.ts',
)

def inspect(archive: Path) -> dict:
    checked = scan(str(archive))
    if not checked['ok']:
        return {'sourceValid':False, 'releaseReady':False,'issues':checked['issues']}
    with zipfile.ZipFile(archive) as z:
        names=set(z.namelist())
        manifest=json.loads(z.read('NATIVE_WINDOWS_SOURCE_MANIFEST.json'))
        option=manifest.get('variant')
        issues=[]
        if option != 2 or manifest.get('gui') != 'claude-desktop-code':
            issues.append('Option 2 Claude Code complete source profile required')
        if manifest.get('repoql',{}).get('requiredVersion') != '1.7.18':
            issues.append('RepoQL 1.7.18 pin missing')
        if manifest.get('features',{}).get('office') is not True or manifest.get('features',{}).get('ghost') is not True:
            issues.append('Complete Ghost/Office feature flags missing')
        missing=[p for p in (*REQUIRED,*(f'adapters/claude-code/agents/{a}.md' for a in AGENTS),*(f'openchamber/skills/{name}/SKILL.md' for name in SKILLS)) if p not in names]
        if missing:issues.append(f'{len(missing)} required Claude Code source assets absent')
        office_app=any(p.startswith(('office/frontend/','office/backend/')) for p in names)
        executable=any(p.lower().endswith(('.exe','.msi','.msix')) for p in names)
        # External installed Office is acceptable only with signed/provenanced
        # native Windows binary and a real app test. Neither exists in source ZIP.
        blockers=[
            'Windows CI now has an Option 2 AMD64 bridge/supervisor build and guarded preparation candidate workflow; no CI execution receipt, signed installer or installed service stack is verified',
            'Claude Code settings/agents now have an opt-in native config installer, but actual Windows CLI/Desktop Code-tab execution, MCP and hooks remain untested',
            'Pinned Claude Office frontend/backend is external, not included or verified on Windows',
            'Windows Ghost daemon/prompt editing/restart recovery not accepted',
            'Tencent MemoryCore, RepoQL connectors and complete self-learning parity not accepted',
            'Option 2 now has opt-in delegated profile seed and live readback tooling; actual Tencent live readbacks, main-session proxy capture and Ghost isolation not yet demonstrated',
            'Read-only dual-doc readback tool included; real Windows Tencent and RepoQL indexing, exact revision and supersession acceptance not yet demonstrated',
            'Ten Singularity skills and 17 official RepoQL plugin skills requested; native Claude Desktop Code-tab discovery and invocation not verified',
            'Native dashboard startup is opt-in and wired to a per-user task; real authenticated HTTP/UI and both RepoQL connector sweeps remain unverified',
            'No authoritative Claude subscription usage collector or genuine Windows GUI test',
            'No no-Docker/no-WSL native process trace, upgrade/uninstall/reboot receipts',
        ]
        return {'schema':'singularity-claude-complete-release/v1','option':option,
                'sourceValid':not issues,'sourceIssues':issues,'missingSourceAssets':missing,
                'agentDefinitions':len(AGENTS),'skillDefinitions':len(SKILLS),
                'repoqlPluginSkillsExpected':REPOQL_PLUGIN_SKILLS_EXPECTED,
                'delegatedMemoryProfileToolBundled':'native/windows/claude_complete_memory_profiles.mjs' in names,
                'dualDocReadbackToolBundled':'native/windows/claude_complete_doc_parity.mjs' in names,
                'windowsBuildCandidateAssemblerBundled':'native/windows/build_option2_acceptance_bundle.py' in names,
                'windowsCandidatePreparationBundled':'native/windows/prepare_option2_candidate.py' in names,
                'windowsPhasedInstallationWorkflowBundled':'native/windows/install_claude_complete.ps1' in names,
                'windowsPreparedCandidateVerificationBundled':'native/windows/verify_prepared_option2_candidate.py' in names,
                'windowsAcceptanceEvidenceMatrixBundled':'native/windows/claude_complete_acceptance_matrix.py' in names,
                'repoqlPluginCacheAndGuiVerified':False,'skillsInstalledByNativeConfig':False,'allAgentProfilesLiveVerified':False,'repoqlDocsIndexedVerified':False,'pinnedOfficeApplicationBundled':office_app,
                'nativeWindowsExecutableBundled':executable,'releaseReady':False,
                'blockers':blockers, 'sourceArchive':archive.name}

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('archive',type=Path)
    parser.add_argument('--require-release-ready',action='store_true')
    parser.add_argument('--output',type=Path)
    args=parser.parse_args()
    report=inspect(args.archive)
    data=json.dumps(report,indent=2)+'\n'
    if args.output: args.output.write_text(data,encoding='utf8')
    else: print(data,end='')
    if not report['sourceValid']:return 2
    if args.require_release_ready and not report['releaseReady']:return 3
    return 0
if __name__=='__main__':raise SystemExit(main())
