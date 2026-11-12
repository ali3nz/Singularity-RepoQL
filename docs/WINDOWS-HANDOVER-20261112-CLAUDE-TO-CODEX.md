# Windows handover: Claude to Codex (2026-11-12)

Goal: take Singularity RepoQL on Windows from "works on windows241" to a public release that a non-technical user can install, that runs entirely in the background, and that survives crashes and reboots.

Status: release is **BLOCKED**. Nothing here is certification. Read `docs/WINDOWS-RELEASE-PLAN-20261112.md` as well; this file supersedes its "Live state" section.

## Standing rules from the operator (do not break)

1. **Do not build an installer, tag a release or publish anything without explicit operator sign-off.**
2. Never type passwords, credentials or tokens into fields or scripts. Never store a password. Do not set up autologon.
3. Do not loosen the owner-only ACL on `%LOCALAPPDATA%\Singularity\WindowsNative\memory\state`.
4. Do not modify security settings unasked.
5. Everything Singularity runs must be hidden and background. Nothing may open a console or window for the user.
6. After dashboard updates, always commit and push to main without asking.
7. Operator decisions already made: after a reboot, RepoQL stays down until someone signs in (correct, no autologon). Agent Chat is removed from the Windows product. Hold the remaining functional work until the operator releases it.
8. Fleet rules in `AGENTS.md` apply (dockerhost first, issue claims, RepoQL prework, no secrets in output).

## Access and layout

- Repo: `github.com/ali3nz/Singularity-RepoQL`, branch `main`. Local clone on dockerhost: `/home/ali3nz/docker/work/singularity-glow-push`. Head at handover: `e52c925`. Working tree clean.
- Test machine: `windows241` (`ssh windows241`, account `Ben`, an administrator; there is no UAC prompt over SSH). The remote shell is cmd. `tail` does not exist there; pipe to a Linux-side `tail`. For anything with quoting, write a `.ps1` locally, `scp` it to `C:\Users\Ben\`, and run `powershell -NoProfile -ExecutionPolicy Bypass -File`.
- `rql` must be run from the Workspace dir `%LOCALAPPDATA%\Singularity\Workspace`.
- Install root: `%LOCALAPPDATA%\Singularity\WindowsNative` (`current\bin`, `current\source`, `supervisor.json`, `extras`, `memory`). Runtime: `%LOCALAPPDATA%\Singularity\Runtime` (python, repoql). Dashboard state: `%LOCALAPPDATA%\Singularity\Dashboard`.
- Cargo is not on PATH on windows241. Use `%USERPROFILE%\.cargo\bin\cargo.exe`. Build by tarring `native/windows/rust-supervisor` (put `--exclude` before the directory) to `%TEMP%\rust-supervisor`, then `cargo.exe build --release --locked --bin singularity_windows_supervisor_service`.
- The `tests` are mostly Python `unittest` run from the repo root as `python3 -m unittest native.windows.<module>` (some must be run from `native/windows`). No pytest. Do not run the whole `native/windows` suite in one foreground call; it times out.

## Architecture as it now stands

| Piece | How it runs | Notes |
|---|---|---|
| Memory gateway 18431, core 18421, panel 18126 | Rust supervisor, started by scheduled task `Singularity-Rust-Native-Supervisor` (S4U, logon + startup triggers) | Runs as the user. Fail-closed Job Object (KILL_ON_JOB_CLOSE): any child exit stops the lot, then it is restarted. |
| `SingularitySupervisor` Windows service | SYSTEM, delayed-auto, **watchdog mode** (no password) | Polls `GET /health` on 18431/18421/18126 every 15 s. After 3 straight failures it runs `schtasks /End` then `/Run` on the supervisor task, then waits 90 s. SCM failure actions restart the service itself (5 s, 30 s, 60 s). Stopping the service does not stop the stack. |
| Dashboard 18100, Office 18128, Knowledge 8421, unified gateway 18101, Kanzo, OMB bridge, Cloudflare adapter | S4U scheduled tasks with AtStartup (45 s delay) plus logon triggers | Registered by `register-boot-tasks.ps1`. They start at boot with nobody signed in. |
| RepoQL host (`rql serve`) | Interactive AtLogOn task `Singularity-RepoQL-Host` | Must stay interactive. A session-0 host blocks the interactive host that Claude Code needs ("Access is denied"). It only returns after sign-in, by decision. |
| CPU collector, Claude session watcher | Interactive logon tasks | Launched through the hidden launcher. |

### Why a watchdog and not "run the stack in the service"
A SYSTEM service running the stack fails: the memory component exits 1 with `EPERM mkdir ...\memory\state\tmp` because that state dir is owner-only (the user). Running the service as the user needs their Windows password, which we refuse to handle. Hence: S4U tasks run the stack as the user without a password, and a SYSTEM watchdog supervises them. The `service` mode (stack inside the service, `-RunAsUser`/`-Credential`) still exists in the binary and script but is opt-in and untested end to end.

### Hidden launching
Console exes (`rql.exe`, `cmd`, `pwsh`) show a window when started from an interactive task. `hide-console-tasks.ps1` writes `extras\hidden-run.vbs` (WScript.Shell.Run, window style 0) and rewrites the `RepoQL-Host`, `ClaudeSessionWatcher` and `CpuHistoryCollector` task actions to `wscript.exe //B //Nologo <vbs> <command>`. It also retires the stale `SingularityDashProbe` test dashboard. Idempotent. Rust spawns use creation flag `0x08000000` (CREATE_NO_WINDOW).

## What was done in this session (all on main)

| Commit | Change |
|---|---|
| 2da9ba9 and earlier | `SingularitySupervisor` service (Rust, `windows-service` crate), MemoryKnowledge Windows build fixes (`applyKnowledgeWindowsPaths`, `scripts/knowledge-windows-main.mjs`), the release plan, `Cargo.lock` regenerated so `--locked` builds work |
| 3e7614a | Component logs (`component-<id>.log`, opt-in via `SINGULARITY_SUPERVISOR_LOG_DIR`, 4 MiB truncate); installer health check with automatic rollback to the old task |
| 2d76c8b | Password-free watchdog mode is the default |
| 62e8685, b6c380d | `register-boot-tasks.ps1` (S4U boot tasks). b6c380d fixes a broken task list committed in 62e8685 |
| 2b79651 | `hide-console-tasks.ps1` |
| 8e461b2 | `Complete-Setup.ps1` now calls the three scripts (non-fatal) and removes the service on uninstall; CPU collector fixed; account-name bug fixed; stale registration contract test updated |
| e52c925 | `agent_chat=false` in all four variants (`variants.json`, `variant.rs` test, `test_variant_features.py`, readiness reports "excluded") |

### Verified on windows241 (2026-11-12)
- Service installed, delayed-auto, SYSTEM watchdog. A killed stack recovered in about 50 s. A killed service process was restarted by the SCM with the stack unaffected. After a full reboot with nobody signed in, the service and the whole headless stack came back (ports 18431, 18421, 18126, 8421, 18100, 18128, 18101 answer; a 401/404 on `/` means listening).
- All 12 `Singularity*` tasks Running; DashProbe retired.
- `/api/cpu` returns `available: true` after the collector fix (only the first minutes of data were seen).
- Over SSH, no windows from rql, cmd, PowerShell, Python, node or wscript were found. **SSH cannot see session-2 windows, so this is not proof.** The operator was asked to confirm the RepoQL console is gone and has not yet replied.

### Not applied to the live machine
The Agent Chat removal (`e52c925`) and the `WindowsIdentity` account-name fix are in the repo, but the installed copy under `current\source` was not restaged. The Agent Chat link still shows on windows241 until a restage. Restaging must go through the stager, because the staged tree is receipt-owned and refuses unowned files.

## Known bugs and gotchas (learned the hard way)

- `$env:USERDOMAIN\$env:USERNAME` is `WORKGROUP\ben` in an SSH session and breaks task registration (`0x80070534`). Always use `[Security.Principal.WindowsIdentity]::GetCurrent().Name` (now done in four scripts). Grep for any remaining uses before release.
- Task result `0x800710E0` after boot is not a failure by itself; check the task is Running and its port answers.
- The installed `cpu_collector.cmd` was a stale hand-edited copy missing `SINGULARITY_NATIVE_BRIDGE_EXE`; re-running `register_cpu_collector.ps1` regenerates it. A rebuild or restage may overwrite hand edits, so never fix the live box by hand without fixing the repo script.
- Two collector processes can run at once after a restart; kill duplicates before re-registering.
- `Register-ScheduledTask` for the CPU collector and watcher resets the action; run `hide-console-tasks.ps1` after any re-registration.
- A boot-time check right after a reboot can fail with "No route to host" while Windows is still starting.
- The classifier blocks broad SYSTEM probe scripts that kill all session-0 node processes. Do not write them; capture logs instead.
- `sed` generated scripts once dropped a line (the `$names` task list). Read generated PowerShell back before committing.
- Knowledge Service `dist/server.mjs` only auto-starts when `import.meta.url === file://${argv[1]}`, which never matches Windows paths. The build step applies `applyKnowledgeWindowsPaths` and copies `ks_main.mjs` from `scripts/knowledge-windows-main.mjs`. It is unit-tested only; **it has never been proven by a clean rebuild on Windows.** Node must be 22 (pinned in `runtime-pins.json`).

## Work remaining, in priority order

### P0. Prove the install path on a clean machine
The new setup steps have never run through the real installer. The service binary `singularity_windows_supervisor_service.exe` is not staged by the existing setup, so `Invoke-Hardening` currently skips the service step (`service_binary_not_staged`).
1. Add the service binary to the staging/export and to `MANIFEST.json`/provenance, so `stage-native.ps1` copies it to `WindowsNative\current\bin`.
2. Extend the stage and install contract tests for the new files.
3. On a clean Windows VM (not windows241), run `Complete-Setup.ps1 -Mode Install` end to end, then Verify, Repair, Uninstall. Record results. Confirm uninstall removes the service and re-enables the legacy task.
4. Confirm the installer prompts for elevation once, normally, and that non-admin users get a clear message. The hardening scripts need admin (`#Requires -RunAsAdministrator` on the service script).

### P1. Native Rust build and provenance
`cargo` is not on PATH, so the native build and binary provenance are unverified. Build with `--locked`, run `check_rust_lock_provenance.py`, record hashes, and confirm `windows_subsystem = "windows"` for the service exe (no console). Run `cargo test` (the repo has Rust tests including `variant.rs`; I could not run them).

### P2. Functional gaps (the operator said to hold these; confirm before starting)
- Office WebSocket through the panel proxy, React #418, the 502, and `OFFICE_TASK_OWNERSHIP_DRIFT`.
- Verify live: Memory Graph, Connectors, Indexing, Tencent iframe, all dashboard panels.
- Wiki nodes: real Tencent wiki nodes need an LLM key (operator's call, optional). Until then the gateway's memory fallback stands in.
- Import `github://ali3nz/Singularity-RepoQL/` and set `hubDocUriPrefix` so synced wiki pages cross-link.
- Provision the 2 autonomous OMB bots. **Blocked on the operator supplying details.**
- Verify `ClaudeSessionWatcher` does its real job (it shows Running but has not been checked).
- Confirm `rql.exe` child processes (`cmd.exe /c ssh ...`) stay hidden under the hidden parent.

### P3. Release gates (all NOT_RUN)
Native Rust build and provenance; RepoQL MCP and 17 plugin skills; Kanzo MCP; both connector sweeps; agents and skills inventory; 4 hook events; 7 Office events; fresh-session and delegated memory recall; authenticated dashboard UI session; logon task; reboot; upgrade; uninstall; elevated full dashboard and lifecycle suites; regenerate `SHA256SUMS` and `NATIVE_WINDOWS_SOURCE_MANIFEST.json` (stale, and `SHA256SUMS` also changed on main with the phone-view commit); independent review; operator sign-off. Then, and only then, ask the operator about building the installer.

### P4. Docs and runbook
Write or update a service runbook (operate, validate, troubleshoot, recover) for the supervisor service, boot tasks and hidden launch; update the hub documentation per `AGENTS.md`; mark untested recovery procedures as untested. Update the README install section for non-technical users. Note that the Agent Chat page is not part of the Windows product.

## Outstanding input from the operator
- The Google Drive plan: the V4 package `1PiP564d...` and final audit `1BFiFG3i...` were never read (the Drive connector is not attached; the fleet `gdrive.py` helper returns 404 for them). The plan the 20261110 Freebuff handover mentions is also unread. Ask for a link, a copy or a connected Drive, then reconcile it against this list.
- Details for the 2 autonomous OMB bots.
- Optionally an LLM key for real wiki nodes.
- Confirmation that no console window appears at sign-in or after a reboot.

## How to check the live box quickly
Copy a `.ps1` that does: `Get-ScheduledTask -TaskName 'Singularity*'` with `Get-ScheduledTaskInfo`; `Get-Service SingularitySupervisor`; `Invoke-WebRequest` to each port above; `GET http://127.0.0.1:18100/api/cpu`; and list processes with a non-zero `MainWindowHandle`. Run `rql host status` from the Workspace for the host (expect ready, 317 files, rql 1.7.18).

## Recovery
- Remove the service and restore the old task: `register-supervisor-service.ps1 -Uninstall` (re-enables `Singularity-Rust-Native-Supervisor`). The installer also rolls back automatically if the stack is not healthy within 120 s.
- If the stack is down and the service is not recovering it: `schtasks /End /TN Singularity-Rust-Native-Supervisor` then `/Run`, and read `WindowsNative\supervisor-service.log` and `component-*.log`.
- `hide-console-tasks.ps1` is idempotent; rerun it after any task re-registration.
