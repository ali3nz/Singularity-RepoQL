# Native Windows GUI + Rust-first architecture (development)

## Target surfaces

The supported **goal** is to operate within the GUI processes for
**OpenChamber Desktop Windows** and **Claude Desktop Code tab Windows**, without
making a terminal-based `openchamber` or `claude` session the primary client.
Claude Desktop *Chat*'s `claude_desktop_config.json` is another integration
source and can also be loaded by Code-tab sessions, potentially overriding a
server of the same name in other scopes. The Chat GUI is NOT the target.
Claude Desktop's Code tab shares
Claude Code's `.claude` hooks, agent files, settings and MCP configuration.
OpenChamber Desktop embeds OpenCode: its plugins must comply with the OpenCode
JavaScript plugin API even when they delegate substantial work to Rust.

## Rust-first ownership boundary

| Component | Target language | Status |
|---|---|---|
| Local GUI MCP memory lookup | Rust | Initial source at `native/desktop-bridge/` (read only) |
| Document revision hashing and ledger concurrency | Rust | Unimplemented; current Node/Python race remains blocking |
| Native supervisor, stop ownership and Windows lifecycle | Rust | Unimplemented; current Node supervisor is not production-safe |
| Scoping, memory capture, reconciliation, session recall | Rust core + host adapters | Unimplemented in bridge; existing Node plugins/hooks remain |
| RepoQL MCP implementation | Upstream RepoQL binary | External and unbundled; do not rewrite commercial engine |
| Claude Code lifecycle integration | Thin host-prescribed hook invocation | Existing Node hooks; no Rust replacement yet |
| OpenChamber lifecycle integration | Thin OpenCode JS plugin shim | Existing JS plugin; no Rust replacement yet |
| Claude Desktop Code tab and OpenChamber GUI | Upstream GUI apps | Never vendored, rewritten or patched by this repository |

Do not port upstream Tencent sources or paid RepoQL internals to Rust without
provenance, compatibility and licensing review. Place security-sensitive state
and networking in Rust where host APIs allow; retain a minimal JavaScript/TS
boundary where OpenCode requires it.

## Rules for subsequent development

- Make installation **discovery first**: inspect the GUI app version, current
  OpenCode/Claude Code config, app-level MCP servers and agent directories.
  Back up before changing existing files, and never reset authentication.
- Make native installation opt-in, scope-aware and reversible. Preserve all
  unrelated MCP servers, config comments, plugins, models, projects and secrets.
- Never replace the Anthropic provider or OAuth settings to route Claude Desktop
  through an unsupported proxy. Never claim CLI `--init-only` success proves a
  Code tab GUI session successfully captured and recalled memory.
- Use a scoped user key rather than a MemoryCore administrative credential.
  Restrict secrets with enforced Windows DACLs, not POSIX mode assumptions.
- Require byte-verified cross-session recall, capture, restart survival, two
  identity isolation and real GUI session evidence before a release verdict.
- Never overwrite `main` with a draft Rust migration; use review branches and
  publish test outcomes with precise revision and native Windows version.

The existing `docs/platforms/windows.md` documents a **different**, WSL-based
container route. It does not validate native Windows operation.

## Milestone 2: GUI registration plan and response compatibility

- `singularity-desktop-bridge plan` requires a real scoped team/user/agent
  identity because provisioned memory.json normally lacks that identity.
  Never invent or default to a shared scope.
- `singularity-desktop-bridge plan` is Rust source that emits read-only
  per-app MCP proposals, without printing any existing config or credentials.
- It distinguishes legacy `mcp.<name>` from OpenCode v2 `mcp.servers.<name>`.
  Targeting the wrong schema is rejected if the opposite schema is present.
- The MemoryCore reader now recognizes `data.messages`, `data.items`,
  `data.atoms`, `data.results` and legacy `data: [ ... ]` response shapes.
- No installer write operation, host GUI hook, persistent service or automatic
  capture/recall is implemented by this milestone.
- Rust unit tests and Windows GUI acceptance remain **unexecuted** until
  a native Windows toolchain is available.

Current authoritative references for the GUI config shapes:
- https://opencode.ai/docs/en/mcp-servers (v1)
- https://opencode.ai/v2/docs/mcp-servers (v2)
- https://code.claude.com/docs/en/desktop (Code tab; verify live installed version)

## Milestone 4: Office visualization and JSONC support

- New source-only Rust `office-claude` and `office-opencode` CLI entrypoints map
  whitelisted metadata to the **existing** Claude Office event API through
  loopback HTTP. The real Office backend/frontend are separately deployed.
- A minimal native OpenCode plugin adapter (`native/gui-plugins/openchamber/`)
  handles only host event subscription and starting the Rust executable. It
  does not depend on the OpenCode CLI or touch model/provider settings.
- Claude Desktop Code tab Office forwarding can use exec-form hooks directly to
  the Rust `.exe`, without starting a CLI user session. This is proposed
  integration, not demonstrated GUI behavior.
- Read-only Rust planning now parses JSONC comments/trailing commas without
  changing files, so OpenCode GUI config proposals no longer fail merely due
  to standard JSONC syntax.
- See `docs/WINDOWS-GUI-OFFICE-INTEGRATION.md` for exact setup and acceptance.
- No Cargo toolchain here, so the Rust implementation is UNCOMPILED. Office
  runtime, GUI loading, prompt-leak inspection and restart persistence are not
  accepted. No credential or production configuration file was modified.
