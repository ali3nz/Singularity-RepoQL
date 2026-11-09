"""Native Windows source packaging boundary, not proof of runtime parity."""

# Keep Linux production sources in the FULL repository snapshot for parity review,
# but never place their deployment entrypoints in a native Windows option archive.
# This is a package-content rule, NOT a claim that remaining code works on Windows.
LINUX_RUNTIME_PREFIXES = (
    'compose/', 'systemd/', 'memory/upstream/', 'memory/portable/systemd/',
)
LINUX_RUNTIME_FILES = {
    'dashboard/docker-compose.yml', 'dashboard/.env.example',
    'dashboard/config.example.json', 'dashboard/collector.py',
    # OpenCode v1/Linux example; Windows must generate OpenCode 2 mcp.servers.
    'openchamber/opencode.jsonc',
}

# These are the Windows-specific Ghost scheduler files. They remain named
# explicitly as a backstop, while windows_ghost_source below covers Ghost
# runtime, module, and agent files no matter which classifier group contains
# them.
WINDOWS_GHOST_ONLY_FILES = frozenset({
    'native/windows/ghost_scheduler_host.py',
    'native/windows/ghost_task_scheduler.ps1',
    'native/windows/manage_ghost_scheduler.ps1',
    'native/windows/test_ghost_scheduler_host.py',
})

WINDOWS_OFFICE_ONLY_PREFIXES = (
    'office/',
    'openchamber/plugins/product-office/',
)
WINDOWS_OFFICE_ONLY_FILES = frozenset({
    'native/desktop-bridge/src/office.rs',
    'dashboard/office_bridge.py',
    'native/gui-plugins/openchamber/singularity-office.mjs',
})
WINDOWS_OFFICE_GHOST_REMOVAL_PATCH = 'office/patches/windows-ghost-only.patch'


def windows_ghost_source(name: str) -> bool:
    """Return true for Ghost payloads wherever the bundle classifier put them."""
    normalized = name.replace('\\', '/').casefold()
    if normalized == WINDOWS_OFFICE_GHOST_REMOVAL_PATCH:
        return False
    return 'ghost' in normalized


def windows_office_source(name: str) -> bool:
    """Return true for Office-only payloads that must stay out of options 1/3."""
    normalized = name.replace('\\', '/').casefold()
    return (normalized.startswith(WINDOWS_OFFICE_ONLY_PREFIXES)
            or normalized in WINDOWS_OFFICE_ONLY_FILES
            or 'office' in normalized)


def windows_variant_excludes(name: str, variant: int) -> bool:
    if variant not in (1, 2, 3, 4):
        raise ValueError('variant must be 1 through 4')
    if windows_ghost_source(name):
        return True
    return variant in (1, 3) and windows_office_source(name)

def linux_deployment_asset(name: str) -> bool:
    basename = name.rsplit('/', 1)[-1].lower()
    return (name.startswith(LINUX_RUNTIME_PREFIXES)
            or name in LINUX_RUNTIME_FILES
            or basename.endswith(('.sh', '.service', '.timer', '.compose.yml'))
            or basename == 'dockerfile' or basename.startswith('dockerfile.'))
