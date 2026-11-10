# Windows handover — 2026-11-10 (Freebuff/buffy session)

Status: source work complete and independently reviewed; release remains **BLOCKED**
per standing rules (installer needs operator sign-off + test; live A/B/C acceptance
needs operator GUI session; RepoQL feedback submission needs `rql feedback` run).

## What this session did

Self-learning pipeline fix (Google-doc plan defect: stranded candidates after a dedup
outage + unsafe promotion command with invented `--relevance '**'`). Implemented in
the authoritative Windows checkout `C:\Users\Ben\Singularity-RepoQL` (branch `main`,
HEAD `d502211`), 6 files modified, left **uncommitted** for operator inspection.

- `scripts/selflearn-candidates.mjs` — safe promotion path: new operator-gated
  `recordPromotionMetadata` / `validatePromotionMetadata` + `promotionCommand(lesson,
  metadata)`. No command without validated operator metadata; bare `**` relevance
  refused; knowledge requires anchored verification + TTL 1..3650; all free text
  single-quoted. Plus: dedup retries without re-calling the model, lesson persisted
  before the RepoQL call, provider backoff no longer starves dedup recovery,
  rediscovery holds the lock and never resets claims/backoff/evidence, queue never
  evicts NEEDS_VERIFICATION/AWAITING_APPROVAL.
- `tests/selflearn-candidates.test.mjs` — 25 tests (was 13): recovery, queue,
  rediscovery, persistence, metadata-gate, legacy-bypass, injection quoting.
- `adapters/claude-code/doc-hook.mjs` — passes `installRoot` so CLI resolves the
  same provider as hooks (the stranded-queue defect).
- `scripts/doc-policy.mjs` — surfaces `queueRefusal` instead of silently dropping.
- `scripts/doctor.mjs` — reports `queueFull` as DEGRADED.
- `docs/memory-capture-promotion.md` — documents the `record-metadata` step.

## Independent review (rule 4b): APPROVE, no BLOCKING findings

`code-reviewer` via PiChamber `pi` CLI (opencode-go/deepseek-v4.1-flash, thinking max,
`--exclude-tools subagent`), exact 6 paths named. Verdict: APPROVE. 6 non-blocking
notes; items 1–3 applied as one-line fixes with 4 new tests (markPromoted requires
operator metadata + conceptName match; dedup recovery regenerates the recorded
command; shellQuote single-quotes model text). Full verdict: fleet#1159 evidence /
`work/review-1159/verdict.md`. Sol consult was NOT used (timed out from this surface;
reviewed via PiChamber instead per operator instruction).

Kanzo: `fleet#1158` (implementation) done, `fleet#1159` (review) done.

## Validation observed on Windows Node (this session)

- tests/selflearn-candidates.test.mjs: **25/25 pass**
- scripts/doctor.test.mjs: 12/12 pass
- scripts/doc-policy-batch.test.mjs: 3/3 pass
- adapters/claude-code/doc-hook.test.mjs: 12/12 pass

## Still open (operator actions)

1. **Commit?** 6 files uncommitted. Suggested trailer:
   `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
2. **RepoQL feedback:** operator reports `rql account login` done. Still to run:
   `rql feedback` with the session-0 host report, then mark SENT in both
   `repoql-feedback/README.md` files and move the Dockerhost copy to `past/`.
3. **Full release gates** on the working tree (per docs/WINDOWS-RELEASE-ACCEPTANCE.md):
   Node diagnostic discovery, Python discovery, dashboard contract suite.
4. **Installer:** `installer/Test-RCIsolation.ps1` gate, then
   `build-msi.ps1 -WxsFile .\SingularityRepoQLRC-v4.wxs ...`, install/uninstall
   pass, `Start-Singularity.ps1` acceptance. Only on explicit operator go-ahead.
5. **Live A/B/C** GUI acceptance (recall, dashboard/Office, scheduled repair,
   GUI reviewer path, recovery) — needs operator GUI session.
6. Prior handover leftovers still standing: logoff/reboot test, Dockerhost pages
   visual check, cargo PATH, OMB AppContainer negative test, Office install record.

## Pitfalls hit this session

- `ssh windows241` is cmd.exe: no `head`/`tail`/`ls`; use `dir`, `type`, or
  `powershell -NoProfile -Command`. `node --test` (not `bun`) runs tests there.
- `scp -O` works to/from windows241; `ssh` arg is one shell string (no heredocs).
- Review dispatch: `ai-orchestra session-consult` timed out from here; PiChamber
  `pi -p --no-session` with the code-reviewer persona works (smoke-test first).
- Windows checkout line endings are mixed CRLF/LF: use `git diff --ignore-cr-at-eol`.
- `scripts/doc-hook.mjs` is NOT a repo path — the real file is
  `adapters/claude-code/doc-hook.mjs`. Do not create the former.
