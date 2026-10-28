# Skill: Debugging and Error Recovery (local adaptation, ticket 191)

## When this skill is active
A failure needs systematic root-causing: recurring error, unknown cause,
intermittent behaviour, or a validation that keeps failing.

## Workflow (in order — do not skip to the fix)
1. **Preserve the original failure**: capture the exact error, command, and
   context (log excerpt, rc, timestamp) BEFORE touching anything. If evidence
   is ephemeral (a container log, a timer state), snapshot it now.
2. **Reproduce** deterministically if possible; if not, characterize the
   intermittency (rate, correlation, timing) — that IS evidence.
3. **Collect evidence** around the failure (configs, recent changes, logs,
   live state). Read the hub doc for the service first (fleet rule 2).
4. **Localize**: bisect the failure surface (component, layer, commit, config
   key) until the fault lives in one identifiable place.
5. **Root cause**: state it as a sentence with a mechanism ("X fails because Y
   does Z when W"). A cause you cannot state as a mechanism is a hypothesis —
   test it, don't ship it.
6. **Smallest correction** that addresses the root cause. No drive-by fixes,
   no unrelated cleanup, no refactoring the neighbourhood.
7. **Re-run the ORIGINAL failing validation** — the exact command/case that
   failed, not a similar one.
8. **Run the relevant regression tests** around the changed surface.

## Hard boundaries (plan §10)
- NEVER alter Orchestra retry limits, gates, or timeouts to make a failure go
  away.
- NEVER hide an error or downgrade it to a warning solely to obtain success.
- NEVER spawn uncontrolled agents to parallelize debugging.
- If the root cause is outside your assignment or authority: report it with the
  evidence and stop — do not expand scope silently.

## If you must report failure
Report it honestly with the §24 failure shape (Blocked / Failed / Expected /
Observed / Current / Next). A truthful blocker is actionable; a masked one is a
future outage.
