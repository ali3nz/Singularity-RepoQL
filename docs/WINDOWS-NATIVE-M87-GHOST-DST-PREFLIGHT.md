# Milestone 87 — NZ schedule activation preflight (SOURCE ONLY)

Ghost's schedule planner stores local `Pacific/Auckland` dates and times. Saving or editing an existing **draft** remains allowed, including older draft rows whose proposed execution times are unsafe. The read-only `activation-preview` operation now rejects:

- A one-off local time that is ambiguous (autumn clock rollback) or nonexistent (spring clock advance).
- Daily tasks at 02:00–02:59, and weekly Sunday tasks at 02:00–02:59, since an explicit skip/repeat policy is missing from the Ghost host contract.
- A one-off task whose requested local time has already passed.

These are **preflight refusals**, not scheduler execution or user data deletion. Valid future 02:xx tasks on an ordinary weekday can still be reviewed. Rules are currently NZ-specific and must be verified against the installed Windows timezone database during native acceptance. If the Ghost host later supports explicit DST policies, update the API contract, tests and user interface together.

The native Windows Ghost host still does not implement schedule registration; **RELEASE BLOCKED**.
