# Milestone 66: recover interrupted Kanzo MCP configuration

Claude Code Complete installer owns only the project Kanzo MCP registration, while the official RepoQL plugin owns the RepoQL MCP server.

`configure_project_mcp.mjs` now journals the exact temporary `.mcp.json` replacement file **before** writing any new bytes, and rollback recognizes an interrupted application where original settings remain unchanged. This also handles a first installation where `.mcp.json` did not previously exist. Temporary file cleanup requires a UUID-owned path and the expected post-configuration SHA256; tampered content is preserved and rollback refuses instead of deleting foreign files. Old rollback receipts without `pendingTmp` remain accepted.

Testing: 18 focused Node tests including three new interruption/tamper tests; source-only on Linux. Production credentials or GUI calls not used. Windows file locks, interrupted process behavior and service restart still require acceptance. No broad suite run.
