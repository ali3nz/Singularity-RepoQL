# Singularity desktop bridge (Rust)

A **development-stage**, read-only native MCP executable for **Claude Desktop's
Code tab** and **OpenChamber Desktop on Windows**. It does not require launching
the Claude Code CLI or OpenChamber CLI as the user interface. Both GUIs can
start a local MCP executable via their normal integration mechanism.

This is the first step in a Rust-first port, **not** a complete Windows release.
The current bridge exposes a bounded L0/L1 scoped MemoryCore lookup. It does
not yet implement automatic memory capture, source-backed RepoQL lookups, native
memory services, the orchestration engine, or unattended GUI-session recall.
Existing app-specific OpenCode plugins and Claude hooks are JavaScript because
the hosts consume those APIs; their substantive logic is intended to migrate to
Rust with thin compatible adapters.

## Build on native Windows (no WSL)

Install the official Rust toolchain for `x86_64-pc-windows-msvc`, with the
required Visual Studio Build Tools. From this directory:

```powershell
cargo test
cargo build --release
```

The expected executable is `target\release\singularity-desktop-bridge.exe`.
No Rust toolchain or Windows GUI was available in the development environment
that authored this component. CI must compile and run its tests on Windows;
passing source inspection alone is not deployment acceptance.

## Secrets and identity

Use the existing Singularity MemoryCore `memory.json` **without copying a key
into an MCP command or into a project file**. The file must provide:
`hostBaseUrl` (a Windows-reachable **loopback HTTP** address), `gatewayKey`,
`userKey`, `serviceId` and optionally `authPrefix`.

The bridge requires an explicit identity using `SINGULARITY_MEMORY_TEAM`,
`SINGULARITY_MEMORY_USER`, and `SINGULARITY_MEMORY_AGENT` or a corresponding
`identity` object in the secrets file. It refuses missing identity rather than
falling back to a shared/default profile. It never enables network access to
Docker service names, remote IPs or untrusted URLs. If your memory service is
in a container, first arrange an authenticated **loopback** port on Windows;
do not expose MemoryCore publicly or change its existing firewall configuration.
The local MCP transport is stdio; the executable is not a listening server.

## Claude Desktop Code tab (not Claude Desktop Chat)

Create or merge a project-level `.mcp.json` in the **project folder selected
in the Code tab**. Preserve existing `mcpServers` entries. This example uses
placeholder paths and an identity, not a credential:

```json
{
  "mcpServers": {
    "singularity-memory": {
      "command": "C:\\Singularity\\bin\\singularity-desktop-bridge.exe",
      "args": ["serve"],
      "env": {
        "SINGULARITY_MEMORY_CONFIG": "C:\\Singularity\\config\\memory.json",
        "SINGULARITY_MEMORY_TEAM": "my-team",
        "SINGULARITY_MEMORY_USER": "my-user",
        "SINGULARITY_MEMORY_AGENT": "my-agent"
      }
    }
  }
}
```

The Code tab reads `.mcp.json` / `~/.claude.json`, **and can inherit**
`claude_desktop_config.json` defined for the Chat tab. If server names collide,
the Desktop chat config can take precedence. Before touching any files, check
**all three** sources and resolve name conflicts without overwriting a user
server. Agent definitions, hooks and skills use the regular `.claude` layout. This bridge does not write
to any of those files and cannot certify whether a GUI session loads them.

## OpenChamber Desktop (native Windows)

Use OpenChamber's MCP settings if the specific installed GUI version exposes
this configuration. Register `singularity-memory` with the absolute executable
path, argument `serve` and the same environment variables as above. The
actual OpenCode configuration schema is **version-sensitive**:

- OpenCode v1: `mcp.singularity-memory = { type: "local", command: [EXE, "serve"], enabled: true, environment: ... }`
- OpenCode v2: `mcp.servers.singularity-memory = { type: "local", command: [EXE, "serve"], environment: ... }`

Confirm the underlying OpenCode version and which configuration file the native
OpenChamber app uses. Do not silently switch schemas or write both. A future
installer must preserve unrelated settings and comments. Until GUI discovery,
these remain candidate registration paths rather than verified app-specific
wiring.

Do **not** apply the existing WSL2 `openchamber/opencode.jsonc` bundle directly:
its `/usr/local/bin/rql` MCP command is a Linux path. The RepoQL executable
must be independently installed on Windows and registered through OpenChamber
Settings → MCP, or a future safe native installer. This change neither patches
OpenChamber binaries nor replaces any existing agent, plugin or memory store.

## Acceptance

1. Windows Rust CI passes unit tests; a native Windows Code tab connects and
   lists `singularity_memory_search` with no console window interaction.
2. OpenChamber Desktop Settings → MCP connects to the same executable and lists
   the same tool without changing any existing servers.
3. Authorized L0 and L1 searches retrieve bounded records from an existing
   test MemoryCore instance; wrong-scope or unavailable instances return errors.
4. Run two distinct identities and verify no data leaks across them.
5. Quit both GUIs and relaunch them. Ensure integrations reconnect and existing
   agent settings, auth and indexed data are unchanged.

Until live on-host tests pass, status is **RUST_SOURCE_ONLY / GUI_UNVERIFIED**.

## Native Rust planning (no configuration writes)

The bridge includes `plan`, a **read-only** native configuration proposal
command. For example, after you have identified the actual file and built
`singularity-desktop-bridge.exe`:

```powershell
& 'C:\Singularity\bin\singularity-desktop-bridge.exe' plan `
  --target claude-code-tab-project `
  --existing 'C:\Projects\MyApp\.mcp.json' `
  --exe 'C:\Singularity\bin\singularity-desktop-bridge.exe' `
  --memory-config 'C:\Singularity\config\memory.json' `
  --team 'actual-team-id' --user 'actual-user-id' --agent 'actual-agent-id'
```

For OpenChamber, use `--target openchamber-opencode-v1` **or**
`openchamber-opencode-v2` only after confirming its version. `plan` prints
only the proposed `singularity-memory` entry, target shape, an explicit team/user/agent scope, whether the entry
already exists and whether it collides. The scope must match the role that
actually recorded the memory; a standard provisioned `memory.json` does not
carry the scope identity by default. It does not echo other settings,
credentials, or write anything. Existing JSONC comments fail closed because
lossless configuration preservation has not yet been implemented.

On a separate user-approved test machine, Codex can use the proposal to
prepare a backup-first, ownership-safe merge and launch the actual GUIs. The
plan output alone is not an installation or a successful GUI validation.


## Rust Office event support (Milestone 4)

The same executable has `office-claude KIND` for Claude Desktop Code-tab hook
entrypoints and `office-opencode` for the minimal OpenCode plugin adapter.
These modes take one bounded event JSON payload from stdin, whitelist only
session/tool metadata, and POST through a local authenticated loopback Office
endpoint. Both modes are optional/best effort. The backend is an independent
Claude Office service and must be present locally or privately forwarded.
The real Office ingest key is read from a local restricted
`SINGULARITY_OFFICE_CONFIG` file, never command-line arguments or a project file.
See `docs/WINDOWS-GUI-OFFICE-INTEGRATION.md`.

`plan` now accepts read-only JSONC (comments and trailing commas) while still
refusing malformed configuration and performing no writes. Existing
configuration bytes, comments, and unrelated keys are not changed.

## Native Windows installation feature profiles

`singularity-desktop-bridge variant 1|2|3|4` displays the shared feature
contract for planning; it does not install or modify a GUI. Options 1/3 must
build with `--no-default-features`; options 2/4 explicitly enable `--features
office`. All options retain the RepoQL dashboard, Kanban, Agent Chat and
Tencent connector. These flags do not replace the native Office/Ghost services
required for 2/4. See `docs/WINDOWS-NATIVE-RELEASE.md` before distribution.

## Office credential compatibility for native Windows

For options 2/4, the Rust `office-claude` and `office-opencode` event paths now accept the existing `CLAUDE_OFFICE_PUBLIC_URL` + `CLAUDE_OFFICE_EMBED_URL` token source by default, with a fixed loopback event backend; an explicitly configured `SINGULARITY_OFFICE_CONFIG` or `OFFICE_CONFIG` continues to take precedence and must contain its own `endpoint`/`ingestKey`. Run `office-auth-check` for **redacted configuration validation only** (not live authentication). The dashboard uses the same token-URL method by default and keeps the token out of iframe URLs. See `docs/WINDOWS-OFFICE-AUTH-ROLLBACK.md`. This source is not yet compiled or GUI-accepted on Windows.
