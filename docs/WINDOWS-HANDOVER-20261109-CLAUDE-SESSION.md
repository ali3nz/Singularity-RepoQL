# Windows handover — Claude session, 2026-11-09

Authoritative tree: `C:\Users\Ben\Singularity-RepoQL` (`work\release` is an older snapshot). Nothing is committed. The installer has NOT been built and must not be until the operator signs off after personal testing.

## Standing operator constraints
- Do not build the installer before the operator's own sign-off.
- Ghost is retired from the Windows product. The Bot operations page should match Dockerhost minus anything Ghost-related.
- Retired roles: standalone, solo-coordinator, quality-fixer, orchestrator, ghost, free-mode, fleet-reviewer, researcher-web. Remove from installs and from the operator's live Claude Code (live `~/.claude/agents` already holds exactly the 9 retained agents).
- The Maintainer bot needs an enforced independent review gate.
- No credentials, Office capability URLs, Tencent identities or private paths in docs, commits or logs. Never print secret-bearing files.
- Do not touch Dockerhost production (read-only audit only). No force-push or history rewrite. Focused tests only.
- RepoQL defects get a structured report in `repoql-feedback/` (TEMPLATE.md), attribution argued from observed behaviour.
- If a commit is requested, end the message with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Operator's original goal (verbatim summary)
Out of the box on Windows with no flashing cmd/PowerShell windows: dashboard auto sign-in; RepoQL dashboard, Tencent, Claude Office and Kanzo kanban all auto sign-in; live memory graph working; no Ghost; no Dockerhost-specific material; bring across relevant Dockerhost AGENTS.md/hooks/gates and the "agents get faster per task" note (line 54), and make those functions actually work. When ready, tell the operator so they can test personally; installer and uninstaller testing come after.

## Done (Claude-side source)
- Roster is 9 agents: delegated code-reviewer, thinker, explore, general, board; main duel-coordinator, quad-coordinator, duo, super. `adapters/claude-code/agent-map.mjs`, `claude_agents_control.py` (`_OWNED_NAMES`), release audit, memory profile provisioning, dashboard `agent_reference.js`, docs and tests all updated to 9.
- `variants.json` ghost false on all four variants; `configure_claude_code_windows.mjs` `verifyRoot` requires `features.ghost === false`.
- Learning loop: `docs/WINDOWS-LEARNING-LOOP.md`, workflow rules lines 9 and 11.
- Passing focused tests: `configure_claude_code_windows.test.mjs` (61), `test_project_mcp_package`, `audit_claude_fleet_contract.test.mjs`, agents control (11/12; the one failure is the no-symlink-privilege environment limit).
- Restored `repoql-feedback/` (README.md, TEMPLATE.md) into the authoritative tree from the older snapshot.

## In progress when this session stopped (OpenChamber cleanup, operator said "Remove them too")
Done:
- Deleted `openchamber/agents/{fleet-reviewer,free-mode,ghost,orchestrator,quality-fixer,researcher-web,solo-coordinator,standalone}.md`.
- Removed retired-role references from `openchamber/agents/duo.md` and `super.md`.
- `tests/portable-agent-bundle.test.mjs`: `EXPECTED_ROSTER` trimmed to 4 primary + 5 subagent (plus the earlier `RETIRED` exclusion in the adapter-mirror test).

Still failing in that test file (4 tests) — fix by updating the test to the 9-role contract:
1. "roster is exactly the seventeen shipped roles": the `expected.length, 17` assertion and title -> 9.
2. "the eight coordination roles are all present": `ORCHESTRATION_ROLES` still lists free-mode, orchestrator, solo-coordinator, standalone -> reduce to duel-coordinator, duo, quad-coordinator, super (and fix the count/title).
3. "coordinator roles drive the shipped engine": `engineRoles` (line ~200) lists retired roles -> keep duel-coordinator, quad-coordinator, super; the reviewer-seat loop should drop solo-coordinator; remove the free-mode "never switch to a paid model" assertion (~line 220).
4. "consultation is opt-in": `agentText("orchestrator")` assertion (~line 227) -> remove; keep super/consult-dispatch.
Also check the "catalogue documents every agent" test and `docs/AGENTS-SKILLS.md`.

Then also clean:
- `openchamber/AGENTS.md:167` (Ghost "required for variants 2/4") and any other Ghost wording.
- Stale docs: `docs/AGENTS-SKILLS.md:26-41`, `docs/OPENCHAMBER-SETUP.md:49-60`, `docs/WINDOWS-NATIVE-M32-CLAUDE-FLEET-MEMORY-SKILLS-AUDIT.md`, `MANIFEST.json:54`.
- `scripts/install-claude-code.mjs:160,162` (ghost:true for options 2/4; flagged by `native/windows/audit_portability.py:20`).
- Other tests that name retired roles: `scripts/acceptance-ordinary-session.test.mjs`, `scripts/attach-openchamber.test.mjs`, `scripts/setup-agent-profiles.test.mjs`, `scripts/native-memory-supervisor.mjs` (grep for the retired names; run those tests after).
- Historical/Linux-only (treat as non-blocking unless shipped): `harness/kit/*` free-model/quality-pipeline files, `INSTRUCTIONS.md`.

## Open items
- `NATIVE_WINDOWS_SOURCE_MANIFEST.json` and `SHA256SUMS` are stale (still ghost=true, lists removed agent files). Regenerate ONLY in the build phase via `build_source_variants.py --output-dir`; never hand-edit. Until then `verifyRoot` and `stage-native.ps1 Assert-Manifest` fail by design.
- Installer upgrade path: confirm the guarded unlink of previously installed retired agent files (relies on the prior journal) and the updated `consult-dispatch` skill copy.
- Live repair/reinstall AFTER the operator's review: regenerate Tencent panel with the `default` instance (stale admin key and `native-default` mismatch break the live graph), re-provision its admin key, remove the legacy Ghost scheduled task. Then verify auto sign-in (Tencent, Office, Kanzo), live memory graph, flash-free launch.
- Non-blocking: `verify_after_reboot` readback passes on zero items; `windowsHide`/`creationflags` gaps and `test_no_flash_spawns.py` minimum-match assertion; duplicate `windowsHide` in `scripts/acceptance-ordinary-session.mjs` (~99/105); a test for graph wiki discovery; relaxed `length>17` legacy journal cap at `configure_claude_code_windows.mjs:670,898`.
- Not yet done: cargo 32/32 (cargo not on PATH — locate it), SubagentStart and fresh-session recall proof, Office stale installation record, OMB AppContainer negative test, Maintainer bot review gate, acceptance tests A/B/C, NOT_RUN evidence rows, Kanzo board check, RepoQL feedback report if attributable, concept capture "RetiredRolesRemovedInLockstep" (RepoQL host was not running). Re-run the Haiku `singularity-code-reviewer` after the cleanup.
- Pre-existing, not product defects: `installer.test.mjs` resolveVariant failures (old portable four-profile tool); WinError 1314 symlink test; SeSecurityPrivilege, POSIX-permission, `test-memory-security.py` and two N1 Office-restage failures in `test_native_install_lifecycle_contract`.

## Environment notes
- Git index is mixed CRLF: use `--ignore-cr-at-eol`, keep CRLF when editing (scripts that read/replace `\r\n` then restore it work well).
- Bash `python` is the Store shim: use `py -3`. pytest is not installed; run `cd <dir> && py -3 -m unittest <module>`.
- Bash cwd resets to `work\release`; `cd /c/Users/Ben/Singularity-RepoQL` first.
- Doc ingest after doc changes: `node scripts/doc-ingest-node.mjs ingest --file DOC --root .` then `status --root .`.
- Ports: Tencent 18126, core gateway 18421, Kanzo 4242, Office 18128, dashboard 18100, unified Rust gateway 18101, OpenMausBot 18211.

## Final state (end of Claude session)
- OpenChamber cleanup DONE: `tests/portable-agent-bundle.test.mjs` 14/14, `configure_claude_code_windows.test.mjs` 61/61, `setup-agent-profiles.test.mjs` updated to the 9-role list, docs (`AGENTS-SKILLS`, `OPENCHAMBER-SETUP`, `openchamber/AGENTS.md`, `AGENTS.md`, `CLAUDE-CODE-SETUP`) cleaned and re-ingested.
- 4 failures in `scripts/attach-openchamber.test.mjs` are PRE-EXISTING and unrelated: `openchamber/opencode.jsonc` was never tracked in git, so merge-jsonc/refuse-JSONC/plan assertions cannot hold. Fix the test fixture or add the file; not a retirement regression.
- Deliberately left: `MANIFEST.json` (historical portable manifest; Ghost source dirs still exist), `scripts/install-claude-code.mjs` (Linux-only legacy installer), `docs/WINDOWS-NATIVE-M32-...AUDIT.md` (historical).
- Not re-run: independent Haiku reviewer. Installer NOT built; await operator sign-off.

## Codex source continuation on 9 November 2026

The operator requested Luna workers at max effort for delegated reviews. This continuation uses that preference. The entries below supersede the corresponding earlier pending items.

### Completed source work

- Fixed the four OpenChamber fixture failures using an isolated temporary bundle. The source merge now reads integration keys from each planned file's actual source directory. The shipped bundle remains the target of the separate real-bundle retirement checks. A fresh independent Luna review approved the two-file change.
- Ported the current dashboard presentation into the authoritative Windows source, including phone Command Center cards, phone Kanban KPI tiles and filters, compact bot-operation headers and routine rows, and the blue/purple memory cortex. The existing timezone selector, native workspace links, persisted task-stage readback and Windows Ghost guards are retained.
- Fixed the secondary UX helper that still displayed and queried Ghost and Harness on Windows. Hidden navigation entries are filtered from the command palette, and native palettes avoid the fleet-only agent-control endpoint. A focused browser regression fails against the backed-up helper and passes with the patch for Windows variants 1–4 and the legacy profile.
- Regenerated the CSS bundle and updated changed asset cache versions. A fresh independent Luna POST review approved the exact eleven-path dashboard patch. Its normalized diff is at Dockerhost `/home/ali3nz/docker/work/singularity-1086/resume-20261109/windows-design-exact.diff`, SHA-256 `8fb693fff5356e2679c800ddf2d84273a8cae59c8b41ff575a463bebe069a76e`.

### Verified checks

- Source configuration, bundle, profile and OpenChamber suites passed 117 tests with one Windows symlink-privilege skip out of 118.
- Dashboard JavaScript checks passed all seven test files.
- Windows Rust supervisor tests passed 16 tests. The unified gateway passed four unit tests and 32 integration tests. Both Cargo runs used the existing lockfiles and offline dependencies and returned exit code zero.
- The five existing Kanban browser checks passed queue/backlog separation, native responsive layout, refresh ordering, persisted stage readback and usability. The obsolete queue-summary assertion now checks the new KPI layout while preserving its task/filter/move/overflow assertions.
- The full-entrypoint browser fixture passed Command Center, Kanban and bot operations at 390px and 1280px, with no horizontal overflow or JavaScript errors. The actual neural canvas rendered all three synthetic sources with the blue/purple cortex and no JavaScript errors. These browser checks use isolated test data.
- Evidence logs and screenshots are under Dockerhost `/home/ali3nz/docker/work/singularity-1086/resume-20261109/`. Verified before-change backups and their checksum manifest are under `/mnt/newdata/backups/singularity-1086-resume-20261109/`.

### Operator and runtime gates

- The installer build requires the operator's personal testing and explicit sign-off. Native packaging manifests and hashes await the build phase described above.
- Live repair/reinstall requires the operator's review under the existing handover constraint. The source and fixture checks above do not provide live-runtime acceptance evidence.
- The earlier fresh-session recall/SubagentStart, Office installation-record, OpenMausBot AppContainer negative-test and acceptance A/B/C checks still need their live evidence. The operator reports that Claude Code is signed in.
- Independent reviews of the retained-role cleanup and the Maintainer's enforced review requirement are in progress. Their conclusions will be appended before closeout.


## Codex Maintainer and launcher continuation on 9 November 2026 UTC

### Current source implementation and checks

The maintenance review adapter invokes the existing canonical `singularity-code-reviewer` through Claude Code's Agent tool in a bounded, nonpersistent CLI invocation. The dispatcher is restricted to that named Agent tool. The reviewer profile supplies its read-only tools. Existing Claude settings, hooks and process environment are retained. The invocation uses hidden Windows child processes and does not print raw CLI output or credentials.

Approval is bound to the exact before/after file images, proposed diff, request nonce and canonical reviewer-profile hash. The gate requires the matching Agent call and tool result plus one successful terminal event with `is_error` explicitly false. Dispatcher text, an errored result, a missing terminal error state, a stale nonce, changed content or an unavailable reviewer cannot authorize promotion.

The implemented repair remains bounded to receipt-owned OpenMausBot shared rules and their ownership receipt. Reports include the observed detector cause, before-image hashes, bounded change summaries, the actual review result, test statuses, verification and rollback evidence. The copied backups are checked against the reviewed before-images. The baseline is checked again after backup and before replacement. Failed mutations and failed postrepair checks generate failure reports. Rollback preserves newer foreign bytes and claims restoration only after readback.

Production repair and CLI entrypoints reject caller-supplied reviewer, execution and gate hooks, including inherited, non-enumerable and symbol-keyed options. Tests use a capability closed over a factory-created fresh temporary tree. A pathname or fixture flag cannot enable production injection.

The final independent review found that the byte-only backup and rollback path did not preserve Windows ownership, ACLs and full file metadata. Production now fails closed with `REVIEW_METADATA_PRESERVATION_UNSUPPORTED` if either target before-image exists. Only the case where both rules and receipt were absent can reach exclusive `wx` creation. Existing-file restoration and recurrent-defect repair remain capability-bound fixture results until full metadata support is implemented. This input restriction resolves the unsafe replacement path while leaving the broader autonomous repair requirement pending.

The existing OMB routine definition now plans a 60-minute interval and skips overlapping runs. Fixture checks cover repeated defects, idempotent retries, pending-chat acknowledgement handling, blocking/stale approval, concurrent writes and failure recovery. These checks exercise source and isolated fixtures. They provide no observed scheduled live-bot repair or real reviewer invocation.

Root independently ran the following five suites against the frozen source snapshot. All 69 tests passed, with zero failures and zero skips, and the command returned exit zero.

- `maintenance_audit.test.mjs`
- `maintenance_repair.test.mjs`
- `provision_maintainer.test.mjs`
- `omb_chat.test.mjs`
- `omb_integration.test.mjs`

The Windows reparse-path rejection test now uses a directory junction under the normal account, retaining its security rejection assertion. The source Maintainer prompt removes operational Ghost checks and documents the `ROLLED_BACK` status with verified before-image restoration. Its negative retired-persona impersonation guard is retained.

The exact nine source/template hashes are recorded in Dockerhost `/home/ali3nz/docker/work/singularity-1086/resume-20261109/maintainer-metadata-postfix-source.sha256`. The matching root test log is `maintainer-metadata-postfix-combined-tests.txt` in the same directory. The final independent reviewer is a Luna worker at maximum effort. Its POST verdict and this document's new ingestion receipt must be verified before the source checkpoint is described as approved.

### Installed dashboard launcher correction

The reported Windows dialog came from the installed legacy C# dashboard opener. Its `GetOwnedTask` check expected Task Scheduler logon type 7 while the product-owned dashboard task uses InteractiveToken, type 3. A reviewed one-byte correction changes that check to type 3. The installed executable has SHA-256 `27e1fd1abc10e97ce1390f9d0ec35963e7ca550beb032193b11b24ca602ffc76`, and its hidden `--verify` check returned zero on independent readback. The source dashboard-task registration already specifies Interactive logon.

The byte backup, preserved ownership/DACL evidence and repair receipt are recorded under Dockerhost `/mnt/newdata/backups/singularity-dashboard-shortcut-1086/` and the task evidence directory. The normal desktop-opening check was rejected by automatic approval and was not repeated. The desktop browser-opening outcome therefore still needs operator observation.

This legacy EXE correction is local runtime work. There is no tracked, buildable legacy C# dashboard-launcher source in this repository. The current source shortcut targets the Rust `singularity-dashboard-open.exe`, so the local legacy patch does not establish reproducible release provenance for that EXE.

### Remaining acceptance and release boundaries

The operator uses Claude through its desktop GUI and does not use the standalone Claude CLI. The existing reviewer adapter depends on a standalone CLI session, which remains a live acceptance blocker for this workflow. A supported canonical reviewer invocation through the GUI remains unverified.

The checked-in provisioner still requests `computer: off` and `approval: edits`. A supported model, scoped unattended execution, effective filesystem restrictions and the absence of an alternative unrestricted write path still need live configuration and verification. The narrow rules/receipt repair does not implement broad autonomous source repair for every requested product component.

Required live acceptance A/B/C remains pending. There is no observed scheduled autonomous repair, actual approved source repair through the canonical reviewer, blocking-verdict live denial, acknowledged repair message from such a run, or interrupted-runtime recovery acceptance. Fixture approvals and simulated chat acknowledgements must retain their fixture attribution. Installed model, bot configuration and live routine state need fresh bounded readback before being claimed current.

The earlier fresh-session memory recall, SubagentStart, Office installation-record and AppContainer negative-test acceptance gaps remain in the handover. Source publication awaits complete intended-path/dependency validation of the mixed working tree and the final reviewer gate. The existing dirty installer/setup paths require provenance and remain outside this continuation's write scope. Installer creation, modification, build, packaging and release publication remain held under the operator's instruction.

Before-image backups for the source continuation remain under `/mnt/newdata/backups/singularity-1086-resume-20261109/` and `/mnt/newdata/backups/singularity-1086/`. The latter includes verified document, prompt, integration-fixture and adapter-terminal snapshots with manifests. The implementation record remains fleet#1086.

## Operator-led GUI acceptance on 10 November 2026

The operator will perform GUI acceptance after desktop input returned `GetCursorPos` access denied with `0x80070005` and a subsequent capture was black. The cause remains unconfirmed. Automated GUI acceptance remains pending.

Use the installed desktop entry points for the integration checks and an isolated, Singularity-owned test installation or checkout for controlled defects. Retain the observed result, a redacted screenshot when relevant, report references and actual acknowledgement identifiers.

1. **Fresh Claude session and memory.** Open the installed project in Claude, start a fresh chat and inspect the nine retained agents and available connectors. Exercise RepoQL and Kanzo readback, the paired OpenMausBot connector, and one configured delegated agent. Capture hook outcomes. Store a harmless unique phrase through the approved memory path, start another fresh chat for the same mapped role, and verify recall from a retrieval receipt.
2. **Windows dashboard and Office.** Open the normal dashboard shortcut. Confirm the window opens, the updated design and Agents Control appear, the live memory graph works, and the expected local integrations reach their signed-in state. Record the observed browser-opening result separately from the launcher's existing hidden verification result.
3. **A scheduled basic repair.** Introduce a safe reversible defect in owned test configuration and let the existing Maintainer schedule discover it. Verify detection, repair, readback, a Markdown report and acknowledgement in the Maintainer's own conversation. The current production helper supports exclusive creation only when both rules and receipt targets were absent. Existing-target replacement remains blocked by its metadata-preservation guard.
4. **B reviewed source repair.** First establish a supported GUI-native canonical reviewer invocation. The current adapter's CLI dependency and the helper's narrow repair scope remain blockers for broad autonomous source repair. Once that entry point is implemented, verify a controlled source defect, a verdict against the exact diff, application after approval, post-fix checks and reporting. Repeat with a blocking verdict and with a changed or stale diff.
5. **C recovery.** After an eligible controlled repair run is available, interrupt it safely and restart through the supported runtime entry point. Verify recovery, one application of the approved fix, deduplicated reporting, a retained schedule and accurate failure verdicts.

Live A/B/C acceptance, effective bot permissions, installed instructions and runtime freshness remain pending. Installer construction awaits the operator's testing and sign-off.

## Follow-up maintenance source checkpoint on 10 November 2026

Blocked and unsuccessful repair attempts now return explicit report and notification states. Safe bookkeeping paths queue a bounded notification before delivery and record acknowledgement only for this attempt. Unsafe bookkeeping paths return an unavailable state and can use the verified sender for a bounded direct notice. The exclusive repair lock spans asynchronous delivery.

The audit explicitly records retired Windows Ghost execution as `NOT_APPLICABLE` with `WINDOWS_GHOST_RETIRED`. Its health calculation accepts only this exact retirement case. The Maintainer prompt records the Windows retirement policy.

Root independently ran the five focused suites with 75 passes, zero failures and zero skips. The Windows metadata-preservation guard passed 1/1 with zero skips while `SINGULARITY_SKIP_WINDOWS_TESTS=1` was set. Path-safety coverage uses a real directory junction because file-symlink creation was unavailable. The junction test verifies the external marker, nested files, directory listing and junction remain intact. These results are source and controlled-fixture evidence. Live A/B/C acceptance remains pending.

The latest source manifest is `blocked-reporting-final-source.sha256`. Root test evidence is retained in `blocked-reporting-final-tests.txt` and `blocked-reporting-final-windows-guard.txt` under the existing task evidence directory. Read `blocked-reporting-post-review.txt` for the independent review decision. The configured ingestion receipt for this document is retained in `handover-doc-blocked-reporting-configured-ingest.txt`.

## Operator GUI check on 10 November 2026

The operator supplied a fresh Claude GUI read-only test result. The installed workflow rules and repository AGENTS.md were loaded. RepoQL reported ready with 1,269 indexed files, version 1.7.18 and zero imports. A source exploration returned relevant native installer and acceptance files. The account was signed out, with an account-backed feature warning. Local source search worked.

Kanzo MCP tools loaded and responded. Project and all-task readbacks were empty, and the test created or changed no objects. The effective endpoint was not included in the supplied result and remains to be checked. No tool or hook error was reported.

The nine retained agent names came from the session catalog. This first check did not exercise actual delegation or SubagentStart and supplied no MemoryCore recall receipt. Root requested an actual read-only singularity-explore invocation, effective Kanzo hostname and port, installed parent and delegated memory-hook wiring, and existing receipt status. These are operator-reported observations, separate from source fixture proofs. Broad live acceptance A/B/C remains pending.
## Resume guide — 10 November 2026

### Operator direction and next owner

The operator requested an immediate handover, stopped further implementation and testing, and allowed the existing reviewers to finish. Resume implementation only after the operator asks to continue.

The owning card is `fleet#1086`. The current session is `01a1be0f-1c9e-7832-b9fa-db5bc02882b2`, with Kanzo identity `codex`. Administrative closure is partial. The next agent must read this card, run the complete board check, and acquire its own exact scope before writes.

The Windows checkout is `C:\Users\Ben\Singularity-RepoQL`. Preserve its existing modified and untracked work. Dockerhost is reachable as `root@192.168.1.240`. Task evidence is under `/home/ali3nz/docker/work/singularity-1086/resume-20261109/`. Backups are under `/mnt/newdata/backups/singularity-1086/`.

### Current review blocker

The final source review identified an unresolved notification/ledger defect in `native/windows/openmausbot/maintenance_repair.mjs`.

`reportAndNotify` flushes the whole outbox for blocked, detection-failure, and attempt-outcome notifications. Those callers do not pass `onDelivered`. An older pending FIXED notification can therefore be acknowledged and removed without persisting its occurrence and send ID in the ledger. A later genuine repair can reuse the earlier occurrence ID and be deduplicated by the vendor.

The reviewer requests delivery persistence on every relevant flush, or equivalent retention until the occurrence and acknowledgement are durable. The missing regression should leave a FIXED row pending, acknowledge it during a later blocked run while the new blocked message remains pending, then verify that the next genuine recurrence uses occurrence `-2`.

This defect remains open at the operator’s stop instruction. Final source approval is withheld.

### Completed source work and checks

The maintenance corrections cover bounded detection-failure reporting, detector-state sanitization, durable queue-before-send ordering, queue/ledger interruption recovery, recurrence bookkeeping, and exclusive report-file collision handling. The remaining cross-path flush defect above still requires correction.

Root independently ran the five canonical suites — `maintenance_audit`, `maintenance_repair`, `provision_maintainer`, `omb_chat`, and `omb_integration`. All 80 tests passed, with zero failures and zero skipped tests. The Windows metadata-preservation guard also passed 1/1 with `SINGULARITY_SKIP_WINDOWS_TESTS=1`. These are source and fixture checks. Live A/B/C acceptance remains pending.

One reviewer-approved test-only change replaced the provisioning fixture’s hardcoded PID 12345 with `process.pid`. The explicit dead-PID case remains unchanged. The frozen maintenance hashes are:

- `maintenance_repair.mjs` — `8c20c636fcc8bae57a4a6fda9a9930f3169a7f776227e2f32729007a635f7082`
- `maintenance_repair.test.mjs` — `e3c5da00bdb1d85756dde358e4874dc8ea26573dbfd5159b5e3e9cfb6f2e0410`

The evidence directory contains `blocked-reporting-final-source/`, `blocked-reporting-final-source.sha256`, `blocked-reporting-incremental.diff`, `blocked-reporting-final-tests.txt`, and `blocked-reporting-final-windows-guard.txt`. The earlier 75-pass snapshot and initial review findings are retained under `blocked-reporting-before-review-corrections/`. This new handover section postdates that source snapshot and the earlier document-ingestion receipt.

### Dashboard work still to do

The operator requested the latest live Dockerhost dashboard design changes on Windows. The read-only analysis is complete. The latest changes have not been ported.

Upstream is `/home/ali3nz/docker/repoql-dashboard`, clean branch `main`, at `279abed908819d9fba1941f84684655bb991c3aa`. Its systemd service was active and its process working directory matched that repository. Windows `dashboard/PROVENANCE.md` already records refresh `9fb6ebad76e162486448bfc77cacb8c60b1fc878`.

The six changed files within the original 32-file projection are `agentchat_feed.py`, `embed_config.py`, `server.py`, `static/app.js`, `static/index.html`, and `static/navigation_ui.js`. Related changes also touch `static/ux_pack.js`, `static/overrides.css`, generated `static/bundle.css`, and new `agent_avatars.py`.

Merge selectively against the recorded provenance. Preserve Windows routes, authentication, native Kanban stage readback and Closed label, OpenMausBot integration, and local styling. Account for upstream AgentChat name display, navigation removals, and message colors. The embedded Kanzo view and PiChamber collector depend on fleet services and need Windows compatibility decisions before adoption. Preserve credentials, runtime state, databases, and existing local changes.

The dashboard analyst observed no overlapping live claim on the upstream dashboard path. `fleet#1078` remained doing without a live claim and covers Singularity docs/service. Owner contact is still pending before touching that scope. The analyst did not make a Windows HTTP request, establish its port, rebind RepoQL, or create an evidence bundle. Detailed read-only findings remain in this session’s `luna_dashboard_port_analysis` final result.

### Runtime and acceptance boundaries

The operator has now run a Claude Code GUI check. Their report says project instructions and agent discovery worked, RepoQL and Kanzo responded, RepoQL showed ready with 1,269 indexed files at 1.7.18, its account was not signed in, and the project Kanzo board appeared empty. This supersedes earlier statements here that no operator GUI check had occurred. It is operator-reported evidence.

Claude Code sign-in was separately confirmed by the operator. RepoQL account sign-in is a separate outstanding item. Investigate the empty project board and correct project binding before claiming end-to-end project acceptance.

The release remains BLOCKED. The installer and dashboard remain source-only and uncertified on Windows. Live Maintainer registration/routine, content-bound independent review, A/B/C repair acceptance, acknowledged notifications, original Windows parity, and Ghost-removal acceptance require the existing evidence to be checked and remaining cases completed. Preserve MausBot and credentials. Continue under the existing installer approval/sign-off boundaries.

### Suggested skills

Load Implementation review gate for resumed code changes, Session handoff for transfer, and Fleet issue closeout when stopping. Use Hub documentation update for durable behavior changes, Integration-server builder for an MCP gate change, and Sol consult dispatch for a sanctioned consultation.

### First steps after an explicit resume

1. Read `fleet#1086`, this resume guide, and the reviewers’ final messages in the session store.
2. Recheck ownership and claim the precise scope.
3. Fix the unresolved cross-path outbox/ledger defect under fresh review, add its regression, and rerun the five canonical suites and Windows guard.
4. Complete the selectively merged dashboard port with Windows verification.
5. Finish the outstanding runtime and release acceptance, then obtain final independent review and operator sign-off.

## Resumption log, 10 November 2026

- Outbox/ledger defect fixed in two layers in `maintenance_repair.mjs` (a pending FIXED row is
  acknowledged on a blocked run, and an orphaned queued row is recovered into the ledger before
  persisting). Two regression tests added; independently reviewed twice and approved. The five
  canonical suites pass (11, 49, 10, 5 and 7 tests).
- Selective dashboard port from `279abed` completed as source (see `dashboard/PROVENANCE.md`).
- Kanzo: `list_projects` returns no projects and no project is bound to this folder, so `fleet#1086`
  cannot be read, a claim cannot be made and `doing` cannot be read back. Nothing was fabricated.
  Binding a project remains an operator action.
- Still outstanding: live A/B/C acceptance, empty project board, RepoQL account sign-in, fresh-session
  recall and SubagentStart, Office installation record, AppContainer negative test, final
  independent review and operator sign-off. The release remains BLOCKED; no installer was built.

## Brain colour comparison (10 November 2026)

`dashboard/static/observability.js` is content-identical to the live Dockerhost copy (differs by line endings only). The calm, dull-coloured brain is drawn only when the active theme is `charcoal` (`isCalm()`), and `charcoal` is the default theme on both hosts. The theme is stored per browser origin (`repoql.dashboard.theme` in localStorage), so a fresh Windows origin shows the calm brain until a neon theme (Neon Grid, Violet, Emerald) is chosen in the theme switcher. No code was missing. Live viewing of the Windows dashboard remains NOT_RUN (no local listener found).

Kanzo: project `repoql` is bound to the local Windows Kanzo (0 tasks). Stray `dashboard/_probe_*` memory records from ingest probing remain indexed with no known delete command.

## Maintainer outbox/ledger hardening (10 November 2026)

Three non-blocking reviewer findings in `native/windows/openmausbot/maintenance_repair.mjs` are fixed:

1. **BLOCKED rows acknowledge their report.** `persistFixedDelivery` now acknowledges a valid `reportName` even when the delivered row has no FIXED occurrence.
2. **Corrupt outbox/ledger is quarantined, not overwritten.** `readJson` renames an unreadable or wrong-shape file to `<file>.corrupt-<ms>-<id>` so pending rows and history survive as evidence.
3. **Occurrence floor salvaged from a corrupt ledger.** `salvageLedger` recovers per-fingerprint `occurrences` from the raw text, so a later FIXED never reuses an acknowledged `sendId`.

Evidence (focused only): `maintenance_repair` 51/51 (two new tests for items 2 and 3), `maintenance_audit` 11/11, `provision_maintainer` 10/10, `omb_chat` 5/5, `omb_integration` 7/7. Windows lifecycle guard: only the 2 known OfficeRestage failures that also fail on clean HEAD. Item 1 has no dedicated test (existing BLOCKED-acknowledged tests still pass). Nothing is committed; the release remains BLOCKED.

### Operator steps remaining
1. Review and, if wanted, commit the working tree.
2. Approve/start the dashboard (generates a capability link) and check the brain under a neon theme and the `#/kanban?task=N` link.
3. RepoQL sign-in; live A/B/C runs; fresh-session recall and SubagentStart; Office install record; AppContainer negative test.
4. Decide on a Kanzo-only project `.mcp.json` and confirm the user-level Kanzo entry is local-only.
5. Final independent review and sign-off, then (only then) build the installer.

## Dashboard design refresh (commit bdd6ed6) and reinstall status

- The live :18100 dashboard serves the installed snapshot under `WindowsNative\current`, which predates the current `dashboard/static/` (no `tintedBrain` blue/violet memory brain, old Charcoal calm theme). The source tree is newer than both the installed copy and Dockerhost; no port was needed. Source is pushed in bdd6ed6.
- `RefreshSource` is refused (`NATIVE_STAGE_IDENTITY_OR_PIN_INVALID`) because the installed stage is a legacy Ghost-era snapshot. The authorized path is `manage_native_windows.ps1 -Mode Reinstall -SkipOffice -Apply -Confirm:$false` with the existing bridge, supervisor, rql, python, workspace and supervisor.json inputs.
- **Blocked (not done):** Reinstall aborted before any mutation (receipt still `installed_not_started`) with `NATIVE_DASHBOARD_MANAGER_FAILED`. Cause: unregistering `Singularity-ClaudeComplete-Dashboard` returns Access denied from a non-elevated session; the task ACL grants Ben read-only and delete/write only to Administrators/SYSTEM. An elevated PowerShell is required to run the Reinstall. Nothing was reinstalled and the dashboard is not currently listening on :18100.

### Reinstall result (2026-11-10)

The live dashboard on :18100 now serves the refreshed design (`observability.js` carries `tintedBrain`, `bundle.css?v=bd-20261110-windows`). Dashboard, Kanzo, OpenMausBot, RepoQL-Host, Rust supervisor and Unified Gateway tasks are Running.

Blockers cleared on the way, useful for the next reinstall:

- The desktop bridge must be built with `cargo build --release --features office` (Ghost-free). A default build reports `featureGhost=true` and stage fails with `BRIDGE_BUILD_FEATURE_MISMATCH`.
- `-SourceRoot` must be an extracted variant source archive, not the repo checkout. The checkout's `NATIVE_WINDOWS_SOURCE_MANIFEST.json` is a dev leftover with `features.ghost=true` and fails `SOURCE_FEATURE_MISMATCH`. Build it with `py -3 native/windows/build_source_variants.py --output-dir <dir> --variant 2` and extract the zip.
- Omit `-SupervisorConfig` so the manager generates it; a stale path fails `SUPERVISOR_CONFIG_REQUIRED`.
- Stop the Unified Gateway task before Reinstall (file lock), run elevated, then `-Mode Start`.
- `Invoke-Stage` masks inner errors as `NATIVE_STAGE_OPERATION_FAILED`; use a transcript to see them.

Still not certified: release remains BLOCKED. Office health is false and no Ghost host is present by design.
