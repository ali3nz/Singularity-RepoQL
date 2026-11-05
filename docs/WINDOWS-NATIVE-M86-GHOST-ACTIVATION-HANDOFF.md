# Milestone 86 — Ghost schedule activation proposal (SOURCE ONLY)

The native Windows Ghost control bridge is a transport to an **external** authenticated loopback Ghost host. Its shipped mutation API supports pause/resume and prompt editing of existing tasks. It **does not** support registering, rescheduling, or deleting an executable job. This remains a real release feature gap; do not infer functionality from the calendar UI.

## Implemented from the source side

The authenticated dashboard now offers **Review activation** for each saved draft. A version-checked `POST /api/ghost/plans` call with `action: activation-preview` returns an operator-facing JSON proposal that includes the exact draft ID, revision, title, prompt, local date/time, recurrence, timezone, and a SHA-256 integrity hint. It expressly records `schedulerRegistered: false` and `executionAuthorized: false`. This endpoint never mutates the ledger or invokes the Ghost control host. The prompt may contain private data; copied proposals must be handled as sensitive material and kept out of public issue trackers.

The create/update idempotency behavior now rejects the reuse of a `requestId` for a **different payload**, rather than silently returning an unrelated earlier draft. The ledger still maintains optimistic revision checks, per-user state, and a bounded size.

The SHA-256 field is **not a signature**, authorization, or runtime evidence. It only detects accidental content drift in the proposal before an operator builds a separate scheduler action.

## What Codex must implement before the UI may show Activate

1. Discover the actual installed Windows Ghost host API and scheduler ownership contract. Do not guess method names, call the old Claude CLI, or introduce WSL/Docker in the native path.
2. Implement a backend-supported register/update/cancel schedule API with explicit capability advertisement and authentication/authorization; use immutable IDs, bounded prompts, replay protection, revision-based concurrency and receipts.
3. Record the schedule and prompt in one owned transactional store. Make interrupted registration/rollback observable. Refuse an ambiguous scheduler state.
4. Require independent scheduler readback of exactly the intended registered task, including recurrence, timezone, execution identity, enabled state and prompt revision, **before** returning `active: true`.
5. Verify run evidence, pause/resume, missed runs, DST transitions, restart/reboot recovery and uninstall on an authorized Windows machine. Never use a successful write response alone as evidence of execution.
6. Only then add a functional **Activate** control and promote calendar drafts to scheduled jobs. Until then label them as drafts.

## Focused checks

- `cd dashboard && python -m unittest -q test_ghost_schedule_plans.py test_ghost_activation_handoff_contract.py`
- `node --check dashboard/static/ghost/tasks.js`
- `node --test dashboard/static/ghost/schedule_model.test.mjs`

The static Chromium fixture smoke test was **not completed**: the execution environment blocked local browser navigation with `ERR_BLOCKED_BY_ADMINISTRATOR`. Do not treat source checks as a browser or native-Ghost acceptance result.

**RELEASE BLOCKED:** real Windows Ghost daemon and scheduler actions are not available/accepted in this source-only build.
