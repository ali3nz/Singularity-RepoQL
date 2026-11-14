"""Single full Claude Code source scope for Windows. No retired assistant GUI."""

LINUX_RUNTIME_PREFIXES = (
    'compose/', 'systemd/', 'memory/upstream/', 'memory/portable/systemd/',
)
LINUX_RUNTIME_FILES = {
    'dashboard/docker-compose.yml', 'dashboard/.env.example',
    'dashboard/config.example.json', 'dashboard/collector.py',
}
RETIRED_PREFIXES = (
    'ghost/', 'openchamber/', 'native/gui-plugins/openchamber/',
    'harness/openchamber-patches/', 'harness/kit/prompts/',
)
RETIRED_FILES = {
    'native/desktop-bridge/src/ghost.rs',
    'office/patches/windows-ghost-only.patch',
    'native/windows/ghost_scheduler_host.py',
    'native/windows/ghost_task_scheduler.ps1',
    'native/windows/manage_ghost_scheduler.ps1',
    # Retired multi-product entrypoints. The supported Windows installer is
    # native/windows/install_claude_complete.ps1.
    'native/windows/manage_native_windows.ps1',
    'native/windows/bootstrap_runtime.ps1',
    'native/windows/a4_run_step.ps1',
    'native/windows/test_native_windows_manager_contract.py',
    'native/windows/test_native_install_lifecycle_contract.py',
    'native/windows/test_native_install_lifecycle_behaviour.ps1',
    'scripts/install-claude-code.mjs',
    'scripts/doctor.mjs',
    'scripts/provision-secrets.py',
    'scripts/install-claude-code.gate.test.mjs',
    'scripts/install-claude-code.components.test.mjs',
    'scripts/install-claude-code.profiles.test.mjs',
    'scripts/doctor.test.mjs',
}

def windows_retired_source(name: str) -> bool:
    normalized = name.replace('\\', '/').casefold()
    return (normalized.startswith(RETIRED_PREFIXES) or normalized in RETIRED_FILES
            or 'ghost' in normalized or 'openchamber' in normalized)

def windows_office_source(name: str) -> bool:
    normalized = name.replace('\\', '/').casefold()
    return normalized.startswith('office/') or normalized in ('native/desktop-bridge/src/office.rs', 'dashboard/office_bridge.py')

def windows_variant_excludes(name: str, variant: int) -> bool:
    if variant != 2:
        raise ValueError('Windows product supports only Claude Code Full')
    return windows_retired_source(name)

def linux_deployment_asset(name: str) -> bool:
    basename = name.rsplit('/', 1)[-1].lower()
    return (name.startswith(LINUX_RUNTIME_PREFIXES)
            or name in LINUX_RUNTIME_FILES
            or basename.endswith(('.sh', '.service', '.timer', '.compose.yml'))
            or basename == 'dockerfile' or basename.startswith('dockerfile.'))
