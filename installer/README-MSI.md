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

## Release-candidate isolation

Before installing a candidate beside an existing product, run the read-only gate:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Test-RCIsolation.ps1 -ReceiptPath .\RC-ISOLATION-RECEIPT.json
```

Exit code `0` means the candidate carries its own MSI and Bundle identities, its own install directory, its own state root and its own loopback port, and the production task set is unchanged. A non-zero exit lists the failed checks in `failed`; do not install the candidate until they are resolved. Build the candidate package with `build-msi.ps1 -WxsFile .\SingularityRepoQLRC.wxs -MsiFileName Singularity-RepoQL-Fleet861RC-x64.msi`; the default parameters still produce the reviewed production package.

## Release candidate 3 (0.5.0.0)

The candidate is distributed as **one self-contained MSI**. Its CAB is embedded
(`MediaTemplate EmbedCab="yes"`), so a folder holding only
`Singularity-RepoQL-Fleet861RC-v3-x64.msi` installs without any companion file;
`build-msi.ps1` fails the build if an external `*.cab` is emitted and the build
receipt lists every distribution file with its SHA-256.

It is a **per-user, limited-privileges** package (`Scope="perUser"`,
`InstallPrivileges="limited"`). Install it as the owner, from a normal (not
elevated) shell or by double-clicking the MSI: no elevation is requested, and
the ARP entry, files and state stay in `%LOCALAPPDATA%\Singularity\Fleet861RC`.
An earlier per-user candidate still registered under `HKLM` because Windows
Installer discards `ALLUSERS=2`/`MSIINSTALLPERUSER` on a UAC-compliant package;
the limited-privileges authoring is what makes the per-user scope effective.
Uninstall removes every payload file and any runtime `__pycache__` the installed
tree accumulated. RC-owned runtime state (`state`, `workspace`, `memory`,
`logs`, `provision`) is deliberately preserved, exactly like the production
product's user state.

Start it with:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Start-Singularity.ps1
```

That launcher starts the candidate's own local backends and then the dashboard:

| Backend | What starts | Port |
|---|---|---|
| RepoQL host | RC-owned workspace (`workspace\.repoql` marker + import of the installed source), launched by `rql` itself | repoql host, local |
| MemoryCore + MemoryPanel | the vendor memory supervisor from this machine's build dirs, configured into `memory\` and started on RC ports | 18221 core / 18226 panel |
| Dashboard | auto-local session, loopback only | 18200 |

No dockerhost, fleet endpoint or production credential is involved. Claude
Office (port 8001) and the local Kanzo board (port 4242) are **third-party
products this candidate does not ship**: the launcher does not start them and
the dashboard reports them as unavailable until they are installed and, for
Office, until the owner completes its own login. `Start-Singularity.ps1
-NoDashboard` starts only the local backends, which is what the acceptance run
uses to prove the panels independently of the browser.
