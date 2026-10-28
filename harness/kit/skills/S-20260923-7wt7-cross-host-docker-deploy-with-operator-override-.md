---
id: S-20260923-7wt7
created: 2026-09-23T15:57:17.721Z
sourceRun: 2026-09-23T11-26-32
area: deployment
tags: [deploy, rsync, docker, compose, network-overlap, defer, operator-override, rollback]
successCount: 1
usedIn: []
stale: false
---

# Cross-host docker deploy with operator override and DEFER pattern
When deploying docker compose stacks across hosts under explicit operator override, follow these generalized practices: (1) Always do a read-first preflight — capture baselines (file checksums, image IDs, network config, listening ports) on both source and target before any writes, and read all referenced evidence/config files to catch contradictions early. (2) Make every step idempotent (rsync, docker save/load, compose up -d) and snapshot-config files before editing so rollback is a simple restore. (3) When a step would require stopping a live source (e.g. copying a browser profile), apply the DEFER pattern: leave the source untouched, deploy with a fresh profile path, and clearly document the deferral and its rationale. (4) Before creating any docker network, inspect all existing networks on the target and check for subnet overlap (especially private ranges like 10.224.0.0/24); reuse a subnet only if free, otherwise pick a non-overlapping one. (5) For cloned services, prefer loopback bindings first; if LAN access is needed, bind explicitly and record the security risk in writing. (6) Always document operator overrides (e.g. force-start despite guardrails) with the exact authorization context, so future reviewers understand why standard advice was bypassed. (7) Validate deterministically: checksums for file transfers, image ID/label inspection for image transfers, compose config grep for resource caps, ss/curl for ports, and docker inspect for runtime settings.

## When this applies
- cross-host deploy
- copy compose
- docker save load
- operator override
- force-start
- defer profile
- network overlap
- subnet conflict
