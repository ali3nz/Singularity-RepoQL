# runbook-nudge plugin

An OpenChamber plugin that keeps runbook and RepoQL-concept discipline in the
primary agent's context. It is a reminder, not a gate: it cannot block,
intercept or edit anything, and it never writes documentation itself.

## What it injects

- **Start reminder** (first model request of a session): check the project's
  tracking records for active related work before starting parallel efforts,
  read the runbook covering the task, and search existing RepoQL concepts for
  the files and decisions the task touches.
- **Closing reminder** (every context refresh, so it is present before the
  final answer): create or update the runbook when the work is likely to
  recur, update or capture RepoQL concepts through the project's documented
  capture path, and report what was verified versus untested.

## Behaviour

- Registers a single `context` hook via the OpenCode plugin session-hook API
  and appends one reminder block to the request's system context. The block
  carries a marker, so a reused draft never accumulates duplicates.
- Start text is delivered once per session (persisted under
  `capability-state/runbook-nudge-state/`); the closing reminder is delivered
  on every request.
- Fail-open everywhere: unreadable or unwritable state, malformed drafts or a
  missing session hook never block a request; every fallback is audited.
- Kill switch: set `OPENCHAMBER_RUNBOOK_NUDGE=off` to disable both reminders.
- Environment overrides: `OPENCHAMBER_CAPABILITY_DIR` (state directory base,
  default `~/.local/share/opencode/capability-state`) and
  `OPENCHAMBER_AUDIT_LOG` (JSONL audit file, default
  `~/.local/share/opencode/capability-audit.jsonl`).

The `AGENTS.md` runtime policy carries the same rules in words; the plugin
supplies them at decision time, before inference.

## Files

| File | Role |
|---|---|
| `index.js` | plugin entrypoint (`id: runbook-nudge`) |
| `runbook-nudge.test.mjs` | unit tests (`node --test`) |

## Tests

```bash
node --test openchamber/plugins/runbook-nudge/runbook-nudge.test.mjs
```

## Install

Copy this directory into the instance's OpenCode config `plugins/` directory —
see [`../../../docs/OPENCHAMBER-SETUP.md`](../../../docs/OPENCHAMBER-SETUP.md).
