# Singularity RepoQL Windows Setup

`Singularity-RepoQL-Setup.exe` installs the per-user native Windows product, the
Claude Code integration, a Windows-local Kanzo board, and the local Tencent
MemoryCore/MemoryPanel stack. It does not use Dockerhost or an SSH tunnel for
Kanzo, memory, RepoQL or the dashboard.

## Release artifact

| Field | Value |
| --- | --- |
| File | `Singularity-RepoQL-Setup.exe` |
| SHA256 | `FD953454D1455E5A3BA92351FCFCD96DCE8F936CE90DD89D7CD17E9616F73821` |
| Size | 424,160,256 bytes (404.5 MiB) |
| Built | 2026-11-01 on `windows241` (Windows, .NET Framework 4.x `csc.exe`) |
| Payload | 915 source files, Node 24.22.2, Python 3.12, RepoQL 1.7.18, Codex CLI, Kanzo 0.1.3, dashboard and MemoryCore/MemoryPanel builds |

The executable is unsigned. Windows SmartScreen may warn on first run.

## Install and verify

```powershell
.\Singularity-RepoQL-Setup.exe
```

The guided UI installs and verifies. Silent modes:

```powershell
.\Singularity-RepoQL-Setup.exe --silent
.\Singularity-RepoQL-Setup.exe --repair --silent
.\Singularity-RepoQL-Setup.exe --verify --silent
.\Singularity-RepoQL-Setup.exe --uninstall --silent
```

`--verify` checks the dashboard, the Tencent same-origin handshake, the Kanzo
panel, the local memory graph, and the Claude configuration. `--repair`
preserves the Kanzo board, memory data, workspace, dashboard state and Claude
settings. `--uninstall` removes product tasks and program files but preserves
user data.

## Authentication model

- The installer removes the legacy `Singularity-Kanzo-Tunnel` and
  `Singularity-Unified-Tunnel` tasks and any matching `ssh.exe` forwards.
- Kanzo 0.1.3 runs from `%LOCALAPPDATA%\Singularity\Runtime\kanzo\kanzo.exe`
  with `--home %USERPROFILE%\kanzo --port 4242 --no-open` as the
  `Singularity-Kanzo` task (S4U, boot trigger).
- The dashboard proxies the fixed loopback upstream `127.0.0.1:4242`; the
  board is a separate Windows-local instance, not the fleet board.
- The unified gateway uses `http://127.0.0.1:18100` for RepoQL and
  `http://127.0.0.1:18126` for MemoryPanel. The Tencent owner key is read from
  `%LOCALAPPDATA%\Singularity\WindowsNative\memory\state\secrets\admin-user-key`
  server-side. It never appears in a URL, HTML, JavaScript, log or command line.
- Fresh installs provision the MemoryCore admin identity; upgrades preserve it.
- Groq/Cohere ingestion keys are not required for installation and are not
  bundled. MemoryCore starts in degraded mode until the owner enrolls them.

## Build shape

The release is a C# WinForms launcher with an embedded `Payload.zip` containing
`Complete-Setup.ps1`, `source/`, `bin/` and `runtime/`. The launcher extracts the
payload to a short per-user cache path, then runs:

```text
powershell.exe -NoProfile -ExecutionPolicy Bypass -File Complete-Setup.ps1 -Mode <Install|Repair|Verify|Uninstall> -PayloadRoot <cache>
```

`Setup.cs` is compiled with `/target:winexe` and `/resource:Payload.zip,Payload.zip`.
The build inputs are the installed native source tree (`native/windows`), the
compiled Rust binaries (`singularity-desktop-bridge.exe`,
`singularity-windows-supervisor.exe`, `unified-repoql-control.exe`), the bundled
runtimes, and the Kanzo 0.1.3 Windows executable (SHA256
`70efcc527042b73a0bf0bb9f306b197f14013b4120ed1f99c7615ed892758fcf`).

The launcher writes `%LOCALAPPDATA%\Singularity\SetupLogs\setup-*.log` and a
machine-readable receipt at `%LOCALAPPDATA%\Singularity\Setup\receipt.json`.

## Known limitations

- The artifact is unsigned.
- The Tencent wiki graph source remains unavailable until local WikiJS IDs are
  configured (`no_wiki_ids_configured`); the MemoryCore `memories` source and
  the Tencent panel authentication do work.
- Claude Code provider login is a separate operator step; the installer
  installs rules, hooks, agents, skills and the local Kanzo MCP registration,
  but does not create an Anthropic credential.
- A clean-machine install without Visual C++/Windows prerequisites was not
  repeated after the final payload change; the tested host already had the
  supported runtimes used by other Windows software.
