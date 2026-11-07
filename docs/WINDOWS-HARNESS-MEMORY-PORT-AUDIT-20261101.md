# Windows migration: Dockerhost Harness and agent memory learning, 1 November 2026

## Inputs

- `singularity-repoql-git-latest.zip`: synced Git source, newer than Windows M91, used as the baseline for this migration.
- `repoql-dashboard-sidebar-icons-20261101.zip`: cumulative Dockerhost dashboard UX source and test assets.
- `repoql-memory-remediation-20261101.zip`: Dockerhost reconciled current `AGENTS.md`, memory retrieval/capture evidence and bounded lookup samples.
- `agents-md-evidence-reviewed-20261101.zip`: reviewed Dockerhost instruction policy.
- `ai-orchestra-harness.zip` and `ai-orchestra-source.zip`: source comparisons for native portability; neither was applied wholesale.
- `harness-scoped-self-learning-20261028.zip`: earlier scoped concept creation and retrieval lessons.
- `repoql-dashboard-latest.zip`: Rust unified gateway baseline and Docker dashboard data contracts.

No Dockerhost machine was modified. Archive ownership and the operator's report identify the sources; live Windows state has **not** been inspected from this environment.

## What has actually been incorporated

| Concern | Windows source change | Acceptance boundary |
| --- | --- | --- |
| Dashboard UX | Docker cumulative HTML/CSS/JS plus native Kanban, 23 SVG icons, compact Command Center, Agent Lounge, mobile layouts, operations overview; merged newer Git backend routes instead of overwriting Ghost changes | Source tests and fixture browser tests; live Windows authentication and UI NOT TESTED |
| Agent presence | Added read-only recent sender projection from Windows Agent Chat inbox; does not mutate claims or cursors | Presence is not active agent execution or a Kanzo claim |
| Unified graph | Ported Dockerhost Rust unified gateway crate, lockfile and read-only graph normalization; pinned Windows local origins/token files and disabled Tencent mutation | Native Windows Rust compile, service listener and local source records NOT TESTED |
| Tunnel defect | Windows bridge checks actual Win32 listener process path, refuses SSH/foreign shims, clears remote cached graph; explicit owner-scoped tunnel disable procedure | The existing `Singularity-Unified-Tunnel` task has NOT been touched |
| Native launch | Plan-first build/managed per-user Task Scheduler lifecycle for the Rust gateway, binary/config/token paths protected, no automatic service or foreign process removal | PowerShell Windows runtime and reboot NOT TESTED |
| Agent instructions | Durable, scoped memory discovery, readback, provenance, review, capture and next-session recall policy in *installed* `adapters/claude-code/singularity-workflow.md`, repository `AGENTS.md` and OpenChamber guidance | Installed agent rules and runtime hook execution NOT TESTED |
| Concept schema | Principle/wisdom/rule/shape/knowledge matrix, verified `**/` globs, source freshness and actual path checks | Concept creation and indexing not executed |
| Harness memory audit | Added bounded read-only native Rust CLI `memory_scope_audit` for concept categories and retrieval ledger counts | Counts only, no private content. It does not substitute for the existing Harness provenance or memory readback tests |
| RepoQL/Tencent | Use local RepoQL 1.7.18 and pinned connector, local Tencent scope and separate identity and index receipts | No imported memory, token, index or account state from Dockerhost |
| CI | Added Windows/Ubuntu `cargo test --locked` and native Windows Rust binary build job, plus source regression gates | Workflow not executed; release remains NOT READY |

## Reused rather than rewritten

The synced Git checkout already carries a portable `harness/kit` engine and its Windows source classifier. Replacing those files with the Dockerhost's `/home/private-owner/docker` specific scripts would reintroduce Linux paths and sometimes bypass source verification. We **did not** copy the Dockerhost's orchestration coordinator, model router, approval semantics, Kanzo lifecycle, scheduled capture timer, Linux service units, SSH host definitions, SQL fixtures, or private memory and account data. No parallel memory backend, generic service layer or alternative orchestration state store was introduced.

Rust was used for the independently useful **local data-plane gateway** and the bounded, read-only **audit**. The Python dashboard remains the current owner of browser security, Cloudflare/capability auth, native Ghost integration, task scheduler bridging, direct repoql.exe invocation and platform-specific Win32 checks. Converting those without a native compiler and differential Windows acceptance would be speculative and risk regressions, so they remain intact.

## Additional indexed Kanzo view limitation

The synced Windows package still pins Kanzo connector 1.0.0, whose `kanzo_imported_tasks` SQL uses a non-existent `properties` column on the `kanzo_tasks` derived view. Dockerhost corrected this in a separately built 1.0.1 package. See `docs/WINDOWS-KANZO-INDEXED-VIEW-COMPATIBILITY.md`. Repacking or relocking the Windows 1.7.18 connector without a local tested package would break its existing immutable package digest, so this change is intentionally described as a **known remaining defect**, not silently applied. Native Kanzo board HTTP operations do not use that historical SQL view.

## Gaps and required runtime evidence

1. `cargo test --locked --all-targets` and a Windows build of the new Rust crate, with actual exit codes and SHA256 of the produced EXE.
2. PowerShell task registration/ACL/ownership tests on Windows, listener PID and verified source paths for dashboard, RepoQL and Tencent.
3. Authenticated Windows graph with separately created Windows-only fixture records in each backend and negative Dockerhost-only marker. No ghost status / healthy listener can substitute.
4. Independent mapped parent/delegated memory capture, later separate-session recall, current RepoQL index freshness, negative cross-role and concept-scope checks, with redacted receipts.
5. Actual Windows browser parity screenshots at desktop/mobile, Kanban lifecycle without changing coordinator rules, Ghost/Office optional integration, reboot, remove/reinstall and rollback.
6. GitHub source review and release acceptance before declaring downloadable Windows installer or fully working public product.

**Verdict:** substantial source parity prepared; correctness of the **runtime Windows release remains unverified**. Do not publish this ZIP under an installer name, silently replace existing Windows files, or claim success based on archived Dockerhost test receipts.
