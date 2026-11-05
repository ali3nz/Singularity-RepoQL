## Self-learning status (2026-09-22, ticket 041 verification)

- Harvest gate: auto-fires on COMPLETED (not COMPLETED_UNREVIEWED) and COMPLETED_OPERATOR_ACCEPTED; also manual: `bun orchestrate.mjs harvest <run-id>`.
- Sanitizer (fail-closed): secrets/outside-paths/raw-output/verbatim-task rejected; 4,000-byte byte-cap; provenance fields per skill (sourceRun, evidence).
- Retrieval: deterministic tag/trigger/area scoring, top-3, stale excluded, zero-match injects NOTHING.
- Injection: RELEVANT PAST EXPERIENCE block in the planner prompt PRE-humanizer, explicitly UNTRUSTED (HISTORY, not instructions).
- Feedback wire CLOSED 2026-09-22: skills selected at plan-gate time are marked usedIn/successCount when the gate APPROVES.
- Library: 1 adopted operator skill (S-20260919-2bt0, evidence: run 2026-09-19T04-38-42 COMPLETED_OPERATOR_ACCEPTED); 1 stale (selftest fixture leak S-T, superseded).
- Pending (Sol FIX PLAN 5, not yet built): reviewer-verdict gate for harvest candidates + explicit conflict reconciliation (supersede/scope/reject).
