# Singularity RepoQL for Windows: release readiness audit and plan (2026-11-12)

Status: release remains **BLOCKED**. This is an audit of what is done and what is outstanding, plus a work plan. Nothing here is certification.

## Sources read

| Source | Result |
|---|---|
| Repo handovers `docs/WINDOWS-HANDOVER-20261109/20261110-*.md` and the "Outstanding work register" | Read. The best statement of open items. |
| Dockerhost work folders `singularity-completion-989` (fleet #990/#992/#993), `fleet-1183-windows-continuation` | Read handoffs and the PLAN. Alpha (Agents Control, Claude Code config) and Beta (Maintainer, memory proxy) source work is complete and reviewed. |
| Codex transcript (`/root/.codex/sessions/2026/11/09`) | Contains only a screenshot-OCR job. No plan content. |
| Google Drive | The Drive connector is not attached to this session. The fleet `gdrive.py` helper can reach only the shared folder. The V4 package (`1PiP564d...`) and final audit (`1BFiFG3i...`) return 404 there, so they were **not read**. The Google-doc plan the 20261110 Freebuff handover mentions is also unread. |
| Live Windows (windows241) | Scheduled tasks, health endpoints, dashboard routes, graph, repo state. Details below. |

## Live state on 2026-11-12

Working:
- 13 `Singularity*` scheduled tasks. 9 are Running.
- Dashboard 18100 returns 200 on all 13 routes probed (brain, agents, memory, connectors, indexing, concepts, diagnostics, office, openmausbot, lounge, board, kanzo, settings).
- Knowledge Service 8421, panel 18126 and Office 18128 all return 200.
- RepoQL host is ready (317 files, rql 1.7.18).
- Unified graph: repoql=320, tencent=180, edges=421.
- Gateway Tencent fallback, Knowledge Service logon task, OMB to Office bridge are all in place.

Broken or unverified:
- **No Windows service exists.** Everything is a scheduled task. The machine has been up since 2026-11-10 with no reboot test.
- Four tasks are not running and last exited 0xC000013A (terminated): `ClaudeSessionWatcher`, `CpuHistoryCollector`, `RepoQL-Host`, `SingularityDashProbe`. The RepoQL host is up anyway, started some other way.
- `/api/cpu` still returns `native_windows_cpu_history_no_verified_samples`.
- No autologon is configured and the RepoQL host is a logon task, so after a reboot RepoQL is unavailable until someone signs in.
- `cargo` is not on PATH, so the native Rust build and provenance are unverified.
- Source drift: the installed `C:\Users\Ben\Singularity-RepoQL` has 3 uncommitted modified files, and the Knowledge Service patch (`dist/server.mjs` plus the `ks_main.mjs` wrapper) is not in any repo. A MemoryKnowledge rebuild wipes it.
- `SHA256SUMS` and the source manifest are stale.

## Done (carry forward, do not redo)

Agents Control with revision-safe config and restore; roster 15/6/15; parent memory proxy with credential binding; the Singularity Maintainer source (audit, repair, chat, provisioning script, 64 tests); self-learning queue fix (independently reviewed, APPROVE); dashboard fit-to-screen; Ghost retired; Tencent connected; glow tiles, agent chips, OMB to Office bridge; unified gateway with memory fallback.

## Outstanding work, grouped

### A. Reliability foundation (user priority)
1. Windows service design and registration (see below).
2. Persist the MemoryKnowledge Windows fixes in the repo: the `ks_main.mjs` wrapper, the separator patch applied by the build step, a Node 22 pin, the launcher.
3. Fix or retire the four dead tasks (CPU collector, session watcher, DashProbe, RepoQL-Host task definition).
4. Make the installer define the RepoQL host task with `rql serve --path <Workspace>`, and the `extras` scripts (watcher, CPU collector).
5. Reboot, logoff and auto-logon test, with a documented result.

### B. Functionality gaps
6. Office WebSocket through the panel proxy, React #418 and the 502, `OFFICE_TASK_OWNERSHIP_DRIFT`.
7. Verify live: Memory Graph, Connectors, Indexing, Tencent iframe. Decide on Agent Chat panels (ship the relay or hide them).
8. Real Tencent wiki nodes need an LLM key (user decision). Until then the memory fallback stands in.
9. Import `github://ali3nz/Singularity-RepoQL/` and set `hubDocUriPrefix` so synced wiki pages cross-link.
10. Bots: provision the two autonomous OMB bots (user will supply the details). The Maintainer was dropped by the operator on 2026-11-10.

### C. Release gates (all NOT_RUN per the register)
Native Rust build and binary provenance; RepoQL MCP and 17 plugin skills; Kanzo MCP; both connector sweeps; agents and skills inventory; 4 hook events; 7 Office events; fresh-session and delegated memory recall; authenticated dashboard UI session; logon task; reboot; upgrade; uninstall; elevated full dashboard and lifecycle suites; SHA256SUMS and manifest regeneration; independent review; operator sign-off. Do not build an installer without operator sign-off.

## Windows service design

Constraint already learned: a session-0 RepoQL host blocks later interactive hosts ("Access is denied"). Claude Code needs the interactive host. So the RepoQL host must **not** become a service.

Proposal:
- One service, `SingularitySupervisor`, wrapping the existing Rust supervisor (auto-start, delayed; failure actions restart at 5 s, 30 s, 60 s; dependency on Tcpip).
- It owns the session-0-safe components: Knowledge Service, Memory core and panel, unified gateway, Kanzo, dashboard, OMB, Office bridge. Each gets health checks and per-component restart with backoff.
- The RepoQL host stays an interactive AtLogOn task. Add a documented autologon option (or a lock-screen note) so it returns after reboot.
- Replace the S4U boot tasks so there is one owner per component, not a task and a service both starting it.
- Open decision: service account. LocalSystem is simplest but changes file ownership under `%LOCALAPPDATA%\Singularity`. Running as the user needs the user's password. A virtual account would need ACL changes. Recommendation: run as the user via the supervisor's existing S4U-compatible identity if the Rust supervisor supports it, otherwise a dedicated service account with explicit ACLs.

## Proposed phases

1. **Foundation** (A1-A5): repo patch for MemoryKnowledge, dead-task cleanup, service registration, installer changes. Gate: service survives a kill test and a reboot.
2. **Functional close-out** (B6-B9): Office, panel verification, graph and wiki import.
3. **Acceptance** (C): run the gates on a clean reinstall of this machine, regenerate hashes, independent review.
4. **Sign-off**: operator review, then installer build only on their approval.

## Needed from the user

1. The Drive plan: connect Google Drive to this session, or give the file link or a copy, so the missing V4 audit and plan can be reconciled with this list.
2. Service account choice (above).
3. Permission to reboot windows241 for the reboot test.
4. LLM key for real wiki nodes (optional), and the bot details.
