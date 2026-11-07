# Singularity RepoQL Windows setup file package

This MSI installs the pinned Windows source, the compiled native Rust
executables, the launcher scripts and the first-run credential wizard. The
production pipeline can wrap a production MSI in a WiX Burn
`Singularity-RepoQL-Setup-x64.exe`; the Fleet861 release candidate documented at
the end of this file intentionally ships **no Burn bootstrapper**, only the MSI.

## Installed layout (release candidate)

Under `%LOCALAPPDATA%\Singularity\Fleet861RC`:

- `source` holds the pinned Windows source, Claude Code hook and rule code,
  dashboard, Kanzo integration and existing lifecycle scripts.
- `bin` holds the actual Windows Rust bridge, supervisor, unified memory gateway
  and Kanzo board audit executables.
- `Configure-Singularity.cmd` opens the masked first-run API key and Tencent
  identity wizard **as the interactive user**, not as an elevated installer
  custom action.
- `Readiness.ps1` prints a read-only checklist. `Start-Here.ps1` describes
  installed-file readiness. `Start-Singularity.ps1` starts the local backends
  and the dashboard.

The reviewed production package installs the same layout under
`%ProgramFiles%\Singularity RepoQL`; the candidate never writes there.

## Credential enrollment and automatic Tencent login

The existing MemoryCore extraction failover router accepts **Groq and/or Cohere API keys** from current-user private `state\secrets` files. At least one provider is needed for extraction; the installer preserves any existing user key files and creates its private router token only when absent. No provider key is embedded in the release, passed as a command argument, or displayed in the dashboard.

Tencent's **MemoryPanel owner key is not a Groq/Cohere provider key**. The existing Windows MemoryCore identity provisioner creates and persists `admin-user-key` after a healthy local MemoryCore is available. The Windows dashboard automatically uses that very same key file and the candidate's local MemoryPanel port (18226; production 18126) for its embedded `/embed/tencent/` session. The browser receives only a scoped HttpOnly session cookie. The original Tencent panel itself is not rewritten or impersonated.

The setup wizard can invoke the existing MemoryCore identity lifecycle only when the native stack is already installed and running. It never creates a fake owner key or falls back to the Docker host.

## Boundaries and upgrades

The MSI installs files. It does not silently register tasks, install provider dependencies or approve Claude Code MCP/skills/hooks. Those are managed by `source/native/windows/manage_native_windows.ps1`, `install_claude_complete.ps1`, `manage_unified_gateway.ps1` and connector provisioning after separate runtime checks. The user-scoped memory database, credentials and external Claude Code settings are **not removed** by the MSI uninstaller; neither is the candidate's own runtime state.

The native Rust binaries must be built on an actual Windows x64 MSVC toolchain before the MSI is produced. The WiX Burn executable must also be built on Windows with WiX 6.0.2. A source hash or successful ZIP extraction does **not** establish runtime acceptance.

## Acceptance

Verify Windows service ownership, local RepoQL/Tencent data without the Dockerhost SSH tunnel, the original Tencent panel's authenticated owner session, first-run API keys, Claude Code memory recall and capture, Kanzo `todo -> doing -> review/done` persistence, reboot and rollback. Until a Windows install/uninstall pass, mark the MSI and Burn EXE as **NOT NATIVE TESTED** and do not advertise as a finished public release. Packaging, install/uninstall and the loopback HTTP/auth surface have their own recorded evidence; they do not substitute for the product-runtime acceptance above.

## Release-candidate isolation

Before installing a candidate beside an existing product, run the read-only gate:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Test-RCIsolation.ps1 -ReceiptPath .\RC-ISOLATION-RECEIPT.json
```

Exit code `0` means the candidate carries its own MSI identity, its own install directory, its own state root and its own loopback port, and the production task set is unchanged. A non-zero exit lists the failed checks in `failed`; do not install the candidate until they are resolved. Build the candidate package with `build-msi.ps1 -WxsFile .\SingularityRepoQLRC-v4.wxs -MsiFileName Singularity-RepoQL-Fleet861RC-v3-x64.msi`; the default parameters still produce the reviewed production package.

## Release candidate 3 (0.5.1.0)

The version moved from `0.5.0.0` to `0.5.1.0` with a new `ProductCode`
(`FD77347A-07F3-4CBC-97D4-D19103888AB9`, same `UpgradeCode`). The `0.5.0.0`
candidate was rebuilt with the corrected Option 2 source archive and the
installed-dashboard sign-in fix, and Windows Installer refuses a different
payload that carries the same product code *and* version (`1638`,
`ERROR_PRODUCT_VERSION`). With the version bump, an owner holding `0.5.0.0`
takes the fix through an ordinary major upgrade instead of uninstalling first.

### Distribution

The candidate is **one self-contained file**,
`Singularity-RepoQL-Fleet861RC-v3-x64.msi` (~7.4 MB). Its payload CAB is
embedded (`MediaTemplate EmbedCab="yes"`), so a folder that holds only the MSI
installs without any companion file. The earlier 0.3.0.0 candidate split the
payload into a 205,752-byte MSI plus an external 7,238,629-byte `cab1.cab`, which
made the MSI alone unusable; that is fixed here.

`build-msi.ps1` enforces the property instead of trusting it: it fails with
`EXTERNAL_MEDIA_EMITTED` if any `*.cab` appears beside the output, and its
receipt (`Singularity-RepoQL-MSI-BUILD-RECEIPT.json`, schema
`singularity-msi-build/2`) records `media: "embedded-cab"`, the MSI byte count
and SHA-256, and the complete `distribution_files` list with per-file hashes.
Verification of a delivered folder is therefore `certutil -hashfile
Singularity-RepoQL-Fleet861RC-v3-x64.msi SHA256` against that receipt; nothing
else has to travel with the MSI.

### Scope and elevation

The package is authored per user: `Scope="perUser"`, no
`ALLUSERS`/`MSIINSTALLPERUSER` properties, payload and install root under the
owner's profile. WiX 6 writes SummaryInformation Word Count `0xA` — compressed
(bit 1) and *elevated privileges not required* (bit 3) — and Windows Installer
executes the install with user privileges. Verified by installing the delivered
MSI from a medium-integrity scheduled task: no UAC prompt, install exit `0`,
payload under `%LOCALAPPDATA%\Singularity\Fleet861RC`.

Platform behaviour worth knowing: Windows 11 build 26300 still publishes the
Add/Remove Programs entry under
`HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{C41F8E27-6D95-5B3C-9A18-73E2D0B6F4A9}`
for this per-user package, with no matching `HKCU` entry. The install needs no
elevation; uninstalling through Apps & Features may therefore prompt for it. The
candidate does not claim an HKCU uninstall entry.

### Lifecycle

Uninstall removes every payload file and any runtime `__pycache__` the installed
tree accumulated (a deferred, install-root-bounded action that ignores errors).
RC-owned runtime state (`state`, `workspace`, `memory`, `logs`, `pkgs`,
`provision`) is deliberately preserved, exactly like the production product's
user state. A reinstall replaces the previous package in place through the
shared UpgradeCode.

```powershell
msiexec /x .\Singularity-RepoQL-Fleet861RC-v3-x64.msi /qn
```

### Running it

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Start-Singularity.ps1
```

That launcher starts the candidate's own local backends and then the dashboard:

| Backend | What starts | Port |
|---|---|---|
| RepoQL host | RC-owned workspace (`workspace\.repoql` marker + import of the installed source), launched by `rql` itself | repoql host, local |
| MemoryCore + MemoryPanel | the vendor memory supervisor from this machine's build dirs, configured into `memory\` and started on RC ports | 18221 core / 18226 panel |
| Kanzo board | the real local `kanzo.exe` staged into the RC root and started with an RC-owned `--home` and port | 18202 |
| Claude Office | the locally installed Claude Office distribution, started from RC-owned service config, state and log dirs with RC API/ingest keys | 18203 |
| Dashboard | auto-local session, loopback only | 18200 |

No dockerhost, fleet endpoint or production credential is involved, and no
production port or board is touched: the production Kanzo board (`--home
C:\Users\Ben\kanzo`, port 4242) and production Office (18128) are separate
instances. The RC owns its Kanzo home (`kanzo\`), its Office service/state/logs
(`office\`) and its Office panel key (`state\office-panel-key`); the dashboard
proxies all panels through its authenticated same-origin `/embed/<panel>/`
handshake. The Claude Office distribution and the `kanzo.exe` binary are
local installs the launcher reuses — it does not download or fake them, and a
missing local install is reported as a failure with its exact path.
`Start-Singularity.ps1 -NoDashboard` starts only the local backends, which is
what the acceptance run uses to prove the panels independently of the browser.
