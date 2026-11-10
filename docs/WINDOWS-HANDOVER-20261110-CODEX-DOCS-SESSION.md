# Windows handover — Codex documentation session (reconstructed)

Status: **RELEASE BLOCKED.** Source-only; not certified on Windows. This file was
reconstructed by a Claude Code session from Codex's local logs and the working
tree, because Codex exhausted its usage before writing a handover. Treat it as
evidence, not authority.

Labels: **EVIDENCE** = observed in this session. **NOT_RUN** = not executed.

## Correction to the earlier handover

`WINDOWS-HANDOVER-20261109.md` names Kanzo card `fleet#1086`. Codex's later
closeout was `fleet#1165` (its `STOP-CLOSEOUT.json`: closed `done`, outcome
`failed`, signoff `pending`). `done` is administrative closure only.
This session's Kanzo MCP exposes only the `repoql` project; `get_task fleet#1165`
returned "no task #1165". The closeout is therefore **not independently read
back** — NOT_RUN. Nothing was claimed, moved or created on the board.

## What this session finished (EVIDENCE, focused tests only)

| Item | Change | Result |
|---|---|---|
| Change observation | Baselines retain HEAD; observation unions `git status` with `git diff --name-only -z <baseline>..HEAD`; bounded hashing; reason codes for unobservable cases; obligation recorded for omitted material changes | doc-policy tests pass |
| Reviewer launcher | `--tools Agent,Read,Grep,Glob`, `--allowedTools Agent(singularity-code-reviewer),Read,Grep,Glob`, nested events bound by `parent_tool_use_id` | 53/53 |
| Drafting via MemoryCore lane | `resolveNativeMemoryCoreProvider` (win32 only; loopback `/v1` from the native stack file; key file must be a regular, non-symlink file; key non-enumerable); explicit providers keep precedence; `doc-program` opts in, 120 s timeout for the native lane | selflearn 42 pass / 1 skipped; **fixture only — no live model call (NOT_RUN)** |
| RepoQL scope | `doc-repoql` passes `--uri-glob docs/**`; exact-argv test added | 5/5 |

## Installed-state findings (EVIDENCE)

- **Workflow rule.** Installed `~/.claude/rules/singularity-workflow.md` differed
  from the packaged source and was not recorded as owned. It was backed up
  (content and journal) under `~/.claude/backups/rule-refresh-20261111/`,
  replaced with the packaged `current\source` copy, and registered in the
  journal `rules` entry with its sha256. `configure --mode verify` no longer
  reports `WORKFLOW_RULE_DRIFT`. The rule in the live source tree is newer
  (documentation-obligation prose); it reaches the install only with the next
  installer, which needs the owner's sign-off. The installation receipt was
  not edited.
- **Remaining verify drift (pre-existing, not touched):** `SOURCE_PROVENANCE_DRIFT`,
  `HOOK_SESSIONSTART_DRIFT`, `HOOK_STOP_DRIFT`, `AGENT_DEFINITION_DRIFT`,
  `SKILL_DEFINITION_DRIFT`. The registered RepoQL plugin reports version
  1.7.12 against the pinned 1.7.18. `configured: false`.
- **Installed hooks**, run through the real entry points in `current\source`
  against a throwaway git repo:
  - `doc-hook session-start`: exit 0, wrote a baseline, emitted context.
  - `doc-hook stop` after a code commit made post-baseline: recorded
    `DOC_NOT_REQUIRED` ("no material change observed"). **The installed copy
    misses commits made after the baseline.** The live-source hook, same
    scenario, blocked with three findings and deferred a selflearn candidate.
  - Not run: memory-hook and office-hook entry points, other doc-hook paths.
- **RepoQL discovery** with `docs/**` scope returned `claude-code-setup.md` and
  `doc-ingestion.md` (quality reported weak). Index freshness against the live
  revision was not separately proven.

## Remaining work (from the 20261109 handover, unchanged unless stated)

Trigger shape; stale manifest; Tencent fix; Office record; AppContainer runner;
Maintainer bot; review gate; acceptance A/B/C. All evidence-matrix rows not
listed above stay **NOT_RUN**: native Rust build provenance, 17 plugin skills,
both connector sweeps, 17 agents / 10 skills, Office event types, fresh-session
memory recall, Ghost isolation, authenticated dashboard UI, logon task, reboot,
upgrade, uninstall.

The installer was not built or modified.

## Later verification pass (EVIDENCE, read-only)

- `verify_source_release.py`: stale Ghost-gating check replaced (bridge gates Ghost as `all(feature = "ghost", not(windows))`); now `ok: true`.
- Rust lock provenance valid; `cargo test --locked` 32/32 (unified-gateway-rust) and 24/24 (desktop-bridge, `--features office`).
- `verify_option2_connectors.py` against RepoQL 1.7.18: registry complete; `kanzo` and `memorycore` connectors **installed but not active**; `liveMcpCallsVerified: false`; `releaseReady: false`.
- Haiku review fixes applied: `DOC_NOT_REQUIRED` now refused when no session baseline exists (`BASELINE_MISSING`); HEAD diff uses `--no-renames`; native MemoryCore key path must sit under the base directory. Focused doc-policy/selflearn/doc-program/doc-repoql tests: 0 failures.
- Still **NOT_RUN** (need installer, services, reboot or uninstall, which require owner sign-off): native release build and binary provenance, live connector calls, 17 plugin skills, 17 agents / 10 skills install check, memory/office hook entry points, Office event types, fresh-session recall, Ghost isolation, authenticated dashboard UI, logon task, reboot, upgrade, uninstall, live MemoryCore drafting call, publisher signing. `fleet#1165` remains unreadable from this session.
