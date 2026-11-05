# Singularity RepoQL Windows setup file package

This MSI installs the pinned Windows source, compiled native Rust executables, and the first-run credential wizard. A WiX Burn `Singularity-RepoQL-Setup-x64.exe` bundles the MSI into one graphical install experience. The separate cross-compiled Go `Singularity-RepoQL-Setup-DeveloperPreview-x64.exe` can build/install an MSI on a developer-equipped Windows machine.

## Installed layout

- `%ProgramFiles%\Singularity RepoQL\source` holds the pinned Windows source, Claude Code hook and rule code, dashboard, Kanzo integration and existing lifecycle scripts.
- `bin` holds the actual Windows Rust bridge, supervisor, unified memory gateway and Kanzo board audit executables.
- `Configure-Singularity.cmd` opens the masked first-run API key and Tencent identity wizard **as the interactive user**, not as an elevated installer custom action.
- `Readiness.ps1` prints a read-only checklist. `Start-Here.ps1` describes installed-file readiness.

## Credential enrollment and automatic Tencent login

The existing MemoryCore extraction failover router accepts **Groq and/or Cohere API keys** from current-user private `state\secrets` files. At least one provider is needed for extraction; the installer preserves any existing user key files and creates its private router token only when absent. No provider key is embedded in the release, passed as a command argument, or displayed in the dashboard.

Tencent's **MemoryPanel owner key is not a Groq/Cohere provider key**. The existing Windows MemoryCore identity provisioner creates and persists `admin-user-key` after a healthy local MemoryCore is available. The Windows dashboard automatically uses that very same key file and the local MemoryPanel port **18126** for its embedded `/embed/tencent/` session. The browser receives only a scoped HttpOnly session cookie. The original Tencent panel itself is not rewritten or impersonated.

The setup wizard can invoke the existing MemoryCore identity lifecycle only when the native stack is already installed and running. It never creates a fake owner key or falls back to the Docker host.

## Boundaries and upgrades

The MSI installs files. It does not silently register tasks, install provider dependencies or approve Claude Code MCP/skills/hooks. Those are managed by `source/native/windows/manage_native_windows.ps1`, `install_claude_complete.ps1`, `manage_unified_gateway.ps1` and connector provisioning after separate runtime checks. The user-scoped memory database, credentials and external Claude Code settings are **not removed** by the MSI uninstaller.

The native Rust binaries must be built on an actual Windows x64 MSVC toolchain before the MSI is produced. The WiX Burn executable must also be built on Windows with WiX 6.0.2. A source hash or successful ZIP extraction does **not** establish runtime acceptance.

## Acceptance

Verify Windows service ownership, local RepoQL/Tencent data without the Dockerhost SSH tunnel, the original Tencent panel's authenticated owner session, first-run API keys, Claude Code memory recall and capture, Kanzo `todo -> doing -> review/done` persistence, reboot and rollback. Until a Windows install/uninstall pass, mark the MSI and Burn EXE as **NOT NATIVE TESTED** and do not advertise as a finished public release.
