---
id: S-20260922-zmb0
created: 2026-09-22T00:05:00.000Z
sourceRun: manual-issue-041
area: process-management
tags: [zombie, defunct, pid1, wait-reaping, container-init, vendor-app, process-count]
successCount: 1
usedIn: []
stale: false
adopt: 2026-09-22T00:05:00Z
adoptedBy: operator-directive (Buffy root-cause 2026-09-22, live evidence)
evidence: controller ps/proc census 2026-09-22 (194→211 zombies; top parent /app/bun/bun /app/orchestrator/orchestrator.js)
---

# Zombie (defunct) accumulation under a PID-1 vendor app

A zombie/defunct process is an already-dead child whose parent has not called
wait(). It costs no CPU/RAM — only a kernel PID-table entry. You cannot kill
it; only the real parent (or init after the parent dies) can reap it.

## Diagnosis pattern
1. Count and bucket: `ps -eo pid,ppid,stat | awk '$3 ~ /^Z/ {print $2}' | sort | uniq -c | sort -rn` (top parents) or the orch-zombiewatch census.
2. Identify each top parent: `ps -o pid,ppid,cmd -p <ppid>`; then
   `cat /proc/<ppid>/cgroup` → docker-<id> scope → `docker ps` to name the
   container. Inside the container, check whether the parent IS PID 1
   (`/proc/1/exe`).
3. Distinguish vendor leak vs own code: if the parent is a minified vendor
   bundle (e.g. `/app/bun/bun /app/orchestrator/orchestrator.js`, `@bun`
   header), do NOT try to patch it. If it is our own code, fix the spawn site
   (spawnSync reaps synchronously; async spawn needs a close/wait handler).

## Known instance (2026-09-22)
freebuff container PID 1 = Freebuff Desktop vendor app; spawns git/bun/bash
children for workspace tracking, never reaps them; count grows with git
activity (199→211 in one day). Same leak class (small) in OpenChamber's
`bun packages/web/bin/cli.js logs`. The AI Orchestration kit is NOT a source.

## Remediation ladder (codex-verified 2026-09-22)
- Monitor + alert first: `orch-zombiewatch.timer` (15 min) alerts WARN≥60 /
  CRIT≥250 with growth rate + container pids.current/pids.max, via
  nanny-alerts.jsonl → Discord; it never acts.
- Only the operator may run `docker restart freebuff` (reaps existing zombies
  at container exit) — it kills all live agent sessions/consults, so it must
  be a verified quiet window. Restart is the available CLEANUP, not a cure;
  the durable fix is the vendor process reaping its own children. Expect
  recurrence after restart and re-check.
- **A tini/--init entrypoint shim will NOT fix this leak class**: the zombies
  are the vendor PID's own DIRECT children, and init shims only reap orphaned
  descendants (verified from PPID evidence; codex-confirmed). Do not propose
  tini for direct-child leaks — file a vendor defect instead.
- Permanent fix belongs to the vendor process (it must wait() its children).

## Promotion gate for repair lessons (FIX PLAN 6)
A candidate repair lesson is NON-EXECUTABLE until: incident-id + evidence
hash + runbook version recorded; deterministic replay/tests pass; a human
promotes it. Failure or rollback demotes/quarantines. Learned content may
never modify its own permissions, broker policy, or promotion criteria.

## When this applies
- zombie
- defunct
- pid 1 reaping
- container init
- process count growth
