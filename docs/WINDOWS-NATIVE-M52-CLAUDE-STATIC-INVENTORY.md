# Milestone 52: single read-only Claude Code Complete static installation inventory

`native/windows/claude_complete_static_inventory.mjs` composes the existing, receipt-based Claude settings/agent/skill/hook verifier, official RepoQL plugin cache inspector, and Kanzo project MCP ownership verifier.

It checks exactly **17 Singularity agent definitions, 10 Singularity skills, 11 installed memory/Office hook handlers, 17 upstream RepoQL plugin skill assets**, and exactly one project-scoped Kanzo MCP registration (RepoQL MCP must remain owned by the official plugin). It does not modify plugin caches, install plugins, run MCP tools or log in to Claude Desktop.

Run on the authorized Windows user profile:

```powershell
node native/windows/claude_complete_static_inventory.mjs --home "$HOME" --workspace C:\Workspace --output C:\Private\claude-static-inventory.json --strict
```

`--strict` returns nonzero when the static inventory is incomplete; without it, the report is informative. The result is intentionally free of home paths, memory credentials, URLs and raw settings. Even when `staticInstallationComplete: true`, it **must** keep `nativeClaudeGuiLoadedVerified: false` and `releaseReady: false` until independent real GUI test evidence exists.

Focused tests: five mocked positive/negative source contracts; no native Code-tab or RepoQL plugin installation occurred here. Full regression deferred. Release BLOCKED.
