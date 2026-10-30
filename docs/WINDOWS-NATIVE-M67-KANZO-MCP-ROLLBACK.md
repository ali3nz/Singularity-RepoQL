# Milestone 67 — resumable project MCP rollback

In addition to the pending apply file recorded in Milestone 66, `configure_project_mcp.mjs` now journals an exact UUID-named `.restore-` temporary file before writing the previous `.mcp.json` or `opencode.json`. Interrupted rollback is repeatable; the restore file must be within the same directory and match the original SHA-256. A modified file is preserved and rollback refuses. Successful rollback removes only receipt-owned files.

`verifyProjectMcp` rejects a rollback-in-progress receipt even if the currently deployed configuration hashes correctly. This is source-tested with 20 focused Node cases, including resume and tamper refusal. Nothing here verifies Windows locks, native Claude Code MCP connectivity or runtime. Release remains BLOCKED.
