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

# Ghost's native Windows host, Task Scheduler adapter, lifecycle manager and
# tests belong to options 2/4 only. Keep this small explicit backstop beside
# the general source archive policy so a future classifier regression cannot
# leak these files into a lean option.
WINDOWS_GHOST_ONLY_FILES = frozenset({
    'native/windows/ghost_scheduler_host.py',
    'native/windows/ghost_task_scheduler.ps1',
    'native/windows/manage_ghost_scheduler.ps1',
    'native/windows/test_ghost_scheduler_host.py',
})


def windows_variant_excludes(name: str, variant: int) -> bool:
    if variant not in (1, 2, 3, 4):
        raise ValueError('variant must be 1 through 4')
    return variant in (1, 3) and name in WINDOWS_GHOST_ONLY_FILES

def linux_deployment_asset(name: str) -> bool:
    basename = name.rsplit('/', 1)[-1].lower()
    return (name.startswith(LINUX_RUNTIME_PREFIXES)
            or name in LINUX_RUNTIME_FILES
            or basename.endswith(('.sh', '.service', '.timer', '.compose.yml'))
            or basename == 'dockerfile' or basename.startswith('dockerfile.'))
