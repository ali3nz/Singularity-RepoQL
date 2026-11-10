# Windows handover — 2026-11-10 (Claude session)

Status: release remains **BLOCKED** (AGENTS.md). Nothing here is production-readiness or publisher-signing evidence.

## Done and pushed (origin/main)
- RepoQL works inside Claude Code: scheduled task `Singularity-RepoQL-Host` is now **interactive logon, AtLogOn trigger** (the old S4U/session-0 boot task was unregistered). Verified with a real `explore`.
- Dashboard fits the screen: all 18 Windows routes fit; 375px width showed no overflow on the 7 routes checked. Minimal-padding rule in `dashboard/static/overrides.css`, `bundle.css` rebuilt (`py -3 dashboard/tools/build_css.py`) and deployed to Windows and Dockerhost. Saved "Ben" Office layout kept.
- `openmausbot` launch-cookie audience covered by `dashboard/test_native_auth_broker.py` (4 tests pass).
- Feedback report `repoql-feedback/2026-11-10-session0-host-blocks-interactive-host.md`; status table in `repoql-feedback/README.md`.
- Same report filed in Dockerhost `documentation/repoql-feedback/` (Current, not submitted).
- Ghost removed; sign-in automated; Tencent connected.

## Remaining issues
1. **RepoQL feedback not submitted.** Needs `rql account login` (operator), then `rql feedback`; afterwards mark SENT in both READMEs (Windows `repoql-feedback/README.md`, Dockerhost `documentation/repoql-feedback/README.md`) and move the Dockerhost copy to `past/`.
2. **Logoff/reboot not tested.** The host task fires at logon, not boot, so RepoQL is unavailable between boot and sign-in. Test logoff, reboot and auto-logon behaviour.
3. **Dockerhost pages not viewed in a browser.** CSS is identical and deployed; fit-to-screen there is inferred, not observed.
4. **Acceptance evidence NOT_RUN** (see `native/windows/claude_complete_acceptance_matrix.py` and `docs/WINDOWS-RELEASE-ACCEPTANCE.md`): native Rust build/provenance, 17 plugin skills, both connector sweeps, 17 agents/10 skills, hook events, 7 Office events, fresh-session memory recall, real authenticated dashboard UI, logon task, reboot, upgrade, uninstall. Per-item state has not been re-checked this session.
5. **Prior-handover leftovers** (`docs/WINDOWS-HANDOVER-20261109-CLAUDE-SESSION.md`): cargo not on PATH, SubagentStart/fresh-session recall proof, Office stale installation record, OMB AppContainer negative test, maintainer-bot review gate, concept capture `RetiredRolesRemovedInLockstep`. Not re-verified here.
6. **Docs ingest** of this and the prior handover not run.
7. **Dropped by operator:** supervisor bot. **Do not build an installer without operator sign-off.**

## Pitfalls learned
- A session-0 RepoQL host blocks later interactive hosts ("Access is denied"); never register the host task as S4U/boot.
- Elevation: `Start-Process powershell -Verb RunAs -File <script.ps1>` (inline `-Command` breaks on quoting).
- pytest is not installed: use `py -3 -m unittest`. `SHA256SUMS` is a curated list; the source manifest needs per-file sha256/bytes refreshed after edits.
- Dockerhost: `ssh root@dockerhost`, `/home/ali3nz/docker/repoql-dashboard`, `repoql-dashboard.service`; preserve its divergent files.
