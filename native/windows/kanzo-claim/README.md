# kanzo-claim — Windows-local ownership layer

Kanzo 0.1.3 ships no claim/release/lease surface (fleet#861 finding F-B3). This is a
standalone MCP server that adds one, over its **own** claims store — it never edits the
native Kanzo SQLite board and never uses the dockerhost coordination code or keys.

## What it provides

| Tool | Behaviour |
|------|-----------|
| `check_work` | `available`, conflicting receipts, active-claim count, tamper flag |
| `claim_work` | atomic claim with TTL (default 90 s, max 15 min); refuses overlapping scopes; optional `task_id` records the native Kanzo task it covers |
| `create_work` | local task record bound to a scope |
| `heartbeat` | extends an active claim; owner-only |
| `close_work` | releases a claim; owner-only |
| `list_tasks` | local task records |

Scopes are path-like (`dashboard/auth`). Parent/child scopes overlap; disjoint scopes do
not. Claims are HMAC-SHA256 signed with a key generated once in the state directory
(0600). A record whose signature no longer verifies is marked `rejected`, never trusted.

## State

`KANZO_CLAIM_STATE_DIR` is required. The directory is created 0700 and holds
`claim-key`, `claims.json` and a lock file. One writer at a time via an exclusive lock
file, with stale-lock recovery.

## Run

```jsonc
// .mcp.json / Claude Code MCP registration
{
  "mcpServers": {
    "kanzo-claim": {
      "command": "node",
      "args": ["C:\\\\Path\\\\To\\\\native\\\\windows\\\\kanzo-claim\\\\server.mjs"],
      "env": { "KANZO_CLAIM_STATE_DIR": "C:\\\\Users\\\\<user>\\\\AppData\\\\Local\\\\Singularity\\\\state\\\\kanzo-claim" }
    }
  }
}
```

`npm test` runs 17 tests: 11 layer contracts (conflict, overlap, release, heartbeat,
expiry, restart, task binding, tamper, invalid scope, private files) and 6 MCP tests
that spawn real server processes against one state directory, including concurrent
startup on one shared key and a claim surviving a full server restart.

## Documented limit

A human can still edit the native Kanzo board directly; this layer governs agent
ownership only. It is not a distributed lock across machines.
