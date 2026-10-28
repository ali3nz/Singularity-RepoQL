---
id: S-20260919-2bt0
created: 2026-09-19T21:07:05.157Z
sourceRun: 2026-09-19T04-38-42
area: container-deployment
tags: [docker-compose, loopback-only, tailscale-serve, secret-handling, schema-first, auth-before-expose, zero-state-guard, acl-fallback]
successCount: 1
usedIn: []
stale: false
adopt: 2026-09-22T21:20:00Z
adoptedBy: operator-signoff (Buffy verification 2026-09-22; selftest 375 PASS)
evidence: runs/2026-09-19T04-38-42 COMPLETED_OPERATOR_ACCEPTED
---

# Secure loopback-only service deploy with Tailscale serve
Generalized lessons from this OpenClaw P1 deploy:

1. Zero-state guard first: always verify the target is clean (no existing container, no existing config) before writing anything. Prevents accidental modification of running services.

2. Schema-first writes: extract the image's native config schema and CLI help before creating any config file. Validates field names/values upfront and catches missing capabilities early.

3. Never copy secrets: mount read-only directly from the source path. If source access fails, use the approved ACL fallback (root:gid 0440) — never change ownership of the original secret file, and never create a copy even temporarily.

4. Authenticate locally before exposing remotely: prove token auth works on loopback first, then add the tunnel. If the tunnel breaks auth, you can fall back to loopback without exposing anything.

5. Validate loopback-only binding with docker inspect (no 0.0.0.0) and ss -ltn, not just port checks.

6. trustedProxies for Tailscale Serve: when tunneling through Tailscale Serve, you may need gateway.trustedProxies to avoid proxy-attribution 403s. Scope it narrowly to the observed bridge gateway, schema-validate, and re-prove auth after the change.

7. Remediation must use the exact approved mechanism; shortcuts that change secret ownership invalidate the security model even if the service works.

## When this applies
- loopback only
- tailscale serve
- secret mount read-only
- schema first
- authenticate before expose
- zero state guard
- acl fallback
- docker compose loopback
