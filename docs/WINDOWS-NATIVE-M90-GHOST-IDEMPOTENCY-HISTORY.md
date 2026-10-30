# Milestone 90 — Ghost draft request history (SOURCE ONLY)

## Defect reproduced in M89

Create a draft using request ID R1, edit it using R2, then replay the original create R1. The M89 ledger retained only `lastRequestId=R2`; the replay returned HTTP 200 with a distinct draft ID, leaving two drafts. This violates the intended replay boundary of the private calendar draft API.

## Minimal correction

Each surviving draft now stores the ordered `requestIds` used for successful saves and edits. The previous `lastRequestId` remains present and must equal the final history item. The existing read path accepts historical rows that have no request history, treating their last request ID as the initial history and populating it on the next edit.

A prior request ID cannot create a second draft, overwrite another draft, or replay an older edit after a later revision. Immediate identical replay of the latest request retains the original idempotent response. Different payloads under that ID return a conflict. Invalid stored request history is rejected without overwriting it. Revision checks and non-execution behavior remain unchanged.

This is a scoped integrity correction, **not** a native scheduler feature. It records IDs on surviving drafts only; it does not implement permanent request tombstones after deletion, live schedule registration, rollback, Windows execution, or scheduler readback.

## Acceptance status

Focused Ghost unit and HTTP boundary tests are run against the cumulative source. Full Windows runtime and UI acceptance, Rust build, actual Ghost host, RepoQL/Tencent/Office integration and release signing remain blocked. An accepted source audit establishes file inventory only and does not establish executable scheduling.
