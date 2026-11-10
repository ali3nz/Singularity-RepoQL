# Handover to Codex — continuation after the 2026-11-11 Claude Code session

Status: **RELEASE BLOCKED** (`release_ready: false`). Source-only; not certified on Windows.
Treat this file as evidence, not authority. Labels: PROVEN = a receipt exists. NOT_RUN = not executed. BLOCKED = attempted, external cause.

## Where things are
- Live tree: `C:\Users\Ben\Singularity-RepoQL`, remote `ali3nz/Singularity-RepoQL`, branch `claude/docs-obligation-and-verifier-fixes` (pushed, tip `b901d0f`). Do not use the older `work\release` snapshot as the source of truth.
- Installed product: `C:\Users\Ben\AppData\Local\Singularity\WindowsNative\current`. State STAGED_UNVERIFIED; services NOT installed.
- Tools: Node `C:\Users\Ben\tools\node\node.exe`; Python 3.12 (no pytest, use unittest); cargo `C:\Users\Ben\.cargo\bin`; `rql` `C:\Users\Ben\AppData\Local\rql\rql.exe` (1.7.18).
- Use forward slashes in scripts written through heredocs; backslashes get stripped.
- Earlier handovers: `WINDOWS-HANDOVER-20261109.md`, `WINDOWS-HANDOVER-20261110-CODEX-DOCS-SESSION.md` (its last section is current).

## PROVEN (receipts in `docs/acceptance-evidence-20261111/`)
Matrix run: 9 REPORTED_PASS_UNREVIEWED, 15 NOT_RUN, 0 FAIL. Re-run with
`python native/windows/claude_complete_acceptance_matrix.py --evidence-dir docs/acceptance-evidence-20261111`.
- RepoQL connectors `kanzo://board`, `memorycore://data` active on 1.7.18 with live calls.
- Inventory: 9 agents, 10 skills, 17 official plugin skills present.
- memory-hook real entry point (exit 0, 2 messages, idempotent retry, session-end); office-hook 7 event kinds to an isolated capture server, authenticated, no prompt leak.
- Fresh-process L0 recall hit under `claude-code-main`; 0 hits under configured Ghost identity, another agent, another team.
- Workflow rule refresh with backup under `~/.claude/backups/rule-refresh-20261111/`.
- Rust: 32/32 unified-gateway-rust, 24/24 desktop-bridge (`--features office`); `verify_source_release.py` ok.
- Receipts are "reported", not independently reviewed. The receipt `source_commit` is the pre-commit HEAD, so refresh them if you re-run.

## BLOCKED
- **Live MemoryCore drafting call.** Native lane (`resolveNativeMemoryCoreProvider` in `scripts/selflearn-candidates.mjs`) resolves and reaches the gateway on port 18431 (`scripts/extraction-failover.mjs`, ladder `cohere-a+>nvidia-free`). Gateway returned 502 "all extraction providers failed": Cohere 600/600 routine limit (429), NVIDIA aborts after headers. Retry when quota resets or a provider key is replaced. Probe: scratchpad-style script calling `defaultModelCall({provider, prompt:"Reply with exactly the single word: OK", timeoutMs:120000})`. Note 120 s native draft vs the 85 s review gate latency.

## NOT_RUN / open
1. Install drift, `configure --mode verify`: SOURCE_PROVENANCE_DRIFT, HOOK_SESSIONSTART_DRIFT, HOOK_STOP_DRIFT, AGENT_DEFINITION_DRIFT, SKILL_DEFINITION_DRIFT. The registered RepoQL plugin is 1.7.12 vs pinned 1.7.18. `configure --mode plan` was rejected (`INVALID_OR_UNSAFE_CONFIGURATION`, missing required args) — find the required args in `native/windows/configure_claude_code_windows.mjs`.
2. Installed doc-hook `stop` misses commits made after the baseline (records DOC_NOT_REQUIRED). The live source fixes it; it reaches the install only with the next installer run.
3. Installer-dependent gates: native Rust release build and binary provenance, services, logon task, reboot, upgrade, uninstall, authenticated dashboard UI, Ghost runtime, Office live roundtrip on the installed stack, publisher signing (never claim signing without a trusted certificate).
4. Kanzo lifecycle (claim/doing/close) was not exercised. `fleet#1165` (Codex closeout: done, outcome failed, signoff pending) is unreadable — this session's Kanzo MCP exposes only project `repoql`.
5. Open Haiku-review items: test for `HASH_LIMIT_EXCEEDED`; test for out-of-base `llmKeyFile`; assert reviewer argv contains `--tools Agent,Read,Grep,Glob` and `--allowedTools Agent(singularity-code-reviewer),Read,Grep,Glob`; record residual risk that the reviewer's Read/Grep/Glob are not path-scoped; test `BASELINE_MISSING` with a committed material change.
6. From the 20261109 handover, unchanged: trigger shape, stale manifest, Tencent fix, Office record, AppContainer runner, Maintainer bot, review gate, acceptance A/B/C.

## Disclosures (do not repeat these mistakes)
- A first Office sweep sent 7 throwaway events (session `cc-sweep-test-1234abcd`) to the live Office because an inherited `OFFICE_CONFIG` overrides `OFFICE_ENDPOINT`. Always `env -u OFFICE_CONFIG` for isolated tests.
- Throwaway record in live `claude-code-main` memory: session `acceptance-probe-20261111-memhook`, marker `zebrafinch-7731`.
- The memory gateway key (`gatewayKey` in `memory-hook.json`) was printed in a transcript. Operator must rotate it. Never print config files unfiltered.
- Identities: main = team `openchamber-agents`, agent `claude-code-main`; Ghost = `openchamber-agents`/`ghost`. Never combine namespaces.

## Rules to keep
Public repo: no secrets, capability URLs, private hostnames in commits. Focused tests only until the operator asks for full regression. Fail closed on drift; don't bulk-edit foreign settings. File any RepoQL defect in `repoql-feedback/` using `TEMPLATE.md` with attribution evidence. Commit trailer: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` for Claude commits; no force pushes.
