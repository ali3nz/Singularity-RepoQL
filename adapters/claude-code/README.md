# Claude Code adapter — harness integration for Singularity

Two independent pieces live here:

1. **Office visualizer adapter** (below): hook-based metadata events for the
   Claude Office visualizer.
2. **Native agent integration** ([`docs/CLAUDE-CODE-SETUP.md`](../../docs/CLAUDE-CODE-SETUP.md)):
   the seven `singularity-*` subagent definitions in `agents/`, the
   SubagentStart (recall) / SubagentStop (lesson capture) MemoryCore hooks in
   `memory-hook.mjs`, and an idempotent installer (`scripts/install-claude-code.mjs`)
   that wires them to persistent identities and registers RepoQL MCP.

---

Lets Claude Code (or any harness with lifecycle hooks) drive the **Claude Office** visualizer
without OpenChamber. The Office event contract is small and stable: eight event types with
whitelisted metadata only — prompts, assistant text and tool input/output are **never** forwarded.

## Setup (3 steps)

1. Point the adapter at your Office instance — either a config file with the same shape as
   `office.json` (`{ "endpoint": "...", "ingestKey": "..." }`):

   ```bash
   export OFFICE_CONFIG=/path/to/office.json
   # or:
   export OFFICE_ENDPOINT=http://product-office:8000
   export OFFICE_INGEST_KEY='<ingest key>'
   ```

2. Merge `settings-snippet.json` into `~/.claude/settings.json` and replace `/path/to` with this
   checkout's path.

3. Run Claude Code. Every session appears in the Office scene as `Claude Code <last-8>` with
   session start / prompt / tool / stop / end events.

## Event mapping

| Hook | Office event |
|---|---|
| SessionStart | `session_start` |
| UserPromptSubmit | `user_prompt_submit` |
| PreToolUse | `pre_tool_use` (tool name only) |
| PostToolUse | `post_tool_use` (tool name + success flag only) |
| Stop | `stop` |
| SubagentStop | `subagent_stop` |
| SessionEnd | `session_end` |

## Notes

- Best-effort by design: any network failure exits 0 and never blocks the harness (1.5 s timeout).
- Session ids are namespaced `cc-<native id>` so they never collide with OpenChamber (`oc-…`) sessions.
- Other harnesses: implement the same table — one HTTP POST per event to the Office endpoint with the
  `X-API-Key` header is the whole contract.
