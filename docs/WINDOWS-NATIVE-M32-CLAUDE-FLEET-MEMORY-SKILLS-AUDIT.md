# Milestone 32 — Claude Code Complete: skills, models, memory and dual-index audit

**Release state: BLOCKED.** This is verified source and offline functional behaviour, not a native Windows installed service, GUI, or self-learning acceptance receipt.

## Claude Code complete installed skills

The Windows Claude configuration installer (`native/windows/configure_claude_code_windows.mjs`) now plans and opt-in-installs these **10** skills to `~/.claude/skills/<slug>/SKILL.md`, in addition to 17 `~/.claude/agents/singularity-*.md` agents and 4 hooks:

`board`, `claude-office-visual`, `consult-dispatch`, `handoff`, `hub-doc-update`, `implementation-review`, `issue-closeout`, `mcp-builder`, `retro`, `statusline-builder`.

The **lean** Claude configuration excludes the Office skill (9 total). The installed `name:` frontmatter is canonicalized to the slug, and only the Windows installed Office skill receives a native service instruction replacing an old Compose deployment instruction. OpenChamber source skill definitions remain unchanged. Exact source hashes, hashes of normalized outputs, foreign skill collision refusal, drift detection, interrupted-install recovery journal and guarded rollback are covered by filesystem tests. The release does **not** embed the external licensed RepoQL plugin skills; those require a separately verified RepoQL install, nor does it include the Claude Office executable.

## Models — no hidden assumptions

All 17 shipped Claude agent definitions have **no explicit `model:` field**. Their effective model is inherited from the current Claude Code session/user/provider configuration. There is NO supported claim that a given agent defaults to Sonnet, Opus, Haiku, DeepSeek, or any subscription quota. `free-mode` restricts dispatched routes to explicit free capacity; it cannot change the model selected for its own session. A release acceptance test must report each agent's observed selected model, routing/account cost policy and subagent dispatch outcome; do not publish a fabricated model matrix. An agent can be used with different models according to the actual Claude Code installation policy.

## Persistent Tencent MemoryCore agent profiles

`adapters/claude-code/agent-map.mjs` maps **8 delegated** roles to scoped MemoryCore identities: board, code-reviewer, explore, fleet-reviewer, general, quality-fixer, researcher-web, thinker. `SubagentStart` retrieves L0/L1 from the role's own identity; `SubagentStop` writes a bounded reconciled lesson. The native hooks are source-integrated, **not live verified**.

**M32 fix:** Claude subagent hook now uses the same explicit `AGENT_PROFILE_IDENTITY_MAP` as the agent-profile seeder when configured; a missing/invalid map entry refuses memory operations rather than silently writing into a different namespace. Without a map, it derives team/user from the same configured team/user and MemoryCore profile identity as seeding. Offline mocked-memory tests cover mapping and fallback refusal.

The **9 main-session surfaces** (orchestrator, solo-coordinator, duel-coordinator, quad-coordinator, duo, super, standalone, free-mode, ghost) are NOT separately attributed by SubagentStart/Stop. The normal parent-session memory proxy is separate, and does not prove per-role conversation history. Ghost uses its own `ghost-companion` scope. The native configuration installer requires a memory config file but **does not seed or live-verify all profiles**; call `scripts/setup-agent-profiles.mjs` with the intended identity map against a running native Tencent service and verify a stored charter and cross-session recall for every applicable role before release.

## Shared fleet memory — correct isolation

There is no single unrestricted shared conversation history across the fleet. Individual agent L0/L1 memories are role-scoped to avoid cross-contamination. Shared, revisioned documentation lives separately under the `singularity-docs/shared/docs-keeper` scope and may be searched by any agent; normal project file and RepoQL contexts are other shared sources. Ghost is deliberately isolated, not merely another alias for an agent profile. A shared curated-knowledge layer should be used if wider dissemination is required; do not treat private agent conversations as globally readable without a deliberate access policy.

## Automatic documentation ingestion and RepoQL

Claude Code `SessionStart` saves documentation baseline, `Stop` discovers eligible changed Markdown and uses `scripts/doc-ingest-node.mjs` to ingest into Tencent shared documentation scope and verify all chunk markers. **M32 fix:** this engine now honours `SINGULARITY_MEMORY_CONFIG` from the Windows installer, uses its configured `hostBaseUrl` when no explicit gateway URL is set, and refuses HTTP redirects while transmitting credentials. It still requires a running compatible MemoryCore and a correct workspace allowlist to complete.

**RepoQL is NOT currently part of the same atomic ingestion transaction.** A RepoQL host attached to and indexing the same project or imported documentation tree can independently see file changes, but source does not prove the designated docs roots are mounted/imported, indexed or searchable in RepoQL. The current `DOC_INGEST_INDEXED` receipt proves the Tencent chunk/ledger path only. To certify **dual indexing**, run two independent real readbacks on Windows after editing a hub doc: (1) Tencent document revision/marker search and (2) RepoQL `read`/`query` showing the exact updated document content and source address, with its index ready. A Tencent-only receipt MUST NOT be presented as proof of RepoQL ingestion. A newer revision must supersede the older in Tencent and be visible via RepoQL. Missing index, source roots or stale results BLOCK RELEASE.

## Reproducible source inventory and regression contract

Run `node native/windows/audit_claude_fleet_contract.mjs` to generate a JSON
inventory without opening credentials or claiming runtime health. The inventory
lists every agent's inherited model policy, memory route, the ten skill sources
and the unverified independent RepoQL documentation index. The native release
CI runs this inventory's source-contract test. The repo's previously referenced
but absent `repoql-feedback/TEMPLATE.md` and `README.md` are also restored and
included in package classification; the portable-agent-bundle regression now
passes.

## Release blockers and handoff

1. Build/install actual Windows Rust, native Tencent, RepoQL 1.7.18, Kanzo, Ghost and Office runtimes, and deploy the Claude configuration with both validated `node.exe` and memory config.
2. Live Claude Code Desktop Code-tab skill discovery, 17-agent selection/model observation, hook events and MCP tools/list; verify no foreign settings/skills changed.
3. Seed and verify identities for all applicable roles and test L0/L1 across a **fresh** session; test main-session proxy separately and Ghost isolation explicitly.
4. Create/edit/supersede a hub doc: prove two independent backends can retrieve the current revision, with documented provenance. Verify restart, failure/retry and offline degradation.
5. Real self-learning extraction, promotion, contradiction resolution, Agent Chat/Kanzo, Office/Ghost and dashboard/usage parity; clean install, reboot, upgrade/rollback/uninstall without Ubuntu, WSL or Docker.

Keep RepoQL pinned to 1.7.18 (ABI 1) until real connector conformance proves a newer version. The Office server-side token-in-URL flow remains unmodified. No Claude free workers are assumed.
