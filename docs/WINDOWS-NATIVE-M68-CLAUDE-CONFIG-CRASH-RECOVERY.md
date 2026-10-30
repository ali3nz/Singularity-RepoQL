# Milestone 68 — Claude Code settings crash-recovery ownership

`configure_claude_code_windows.mjs` writes the durable `PREPARED` ownership journal **before** writing an existing settings backup. Its exact UUID-named settings replacement temp is also journaled before any bytes are written. Recovery can clean the owned temporary file only after its SHA-256 matches the expected post-configuration settings, and recognizes an interrupted PREPARED journal with no backup only if the original file is unchanged. Drift or a partial/tampered temporary file is preserved and refused for manual review. Preexisting journals without the new field remain supported.

These are **source-level** changes. 41 focused Node tests pass; real Windows filesystem, ACLs, Claude Desktop Code tab hooks and service execution are untested. `releaseReady:false`. Other untracked `.pending` files from earlier versions are **never** globbed or auto-deleted.
