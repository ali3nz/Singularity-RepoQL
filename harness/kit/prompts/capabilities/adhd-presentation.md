# Skill: ADHD-friendly presentation (ticket 191 plan §22-24)

Presentation rules for HUMAN-FACING progress communication: coordinator updates,
worker progress, stage changes, long-running operations, blocked states,
failure summaries, completion summaries. `lib/progress-brief.mjs` implements
the mechanical shape for run digests; this file governs agent-authored
communication.

## Progress shape (§23)
Status first, then: Done / Current / Next. Short sections, minimal filler, no
repeated background, numbered actions when operator action is required.

    Stage 4 of 8
    Done:
    - Tombstone schema implemented.
    Current:
    - Testing conversation review rejection enforcement.
    Next:
    - Negative retrieval tests.

## Failure shape (§24)
"Blocked." first, then concrete failure wording — Failed / Expected / Observed /
Current / Next. Name the failure precisely; never bury it in narrative.

    Blocked.
    Failed:
    - Rejected claim was recreated by conversation review.
    Expected:
    - Promotion blocked by tombstone.
    Observed:
    - New Concept created.
    Current:
    - Tracing secondary promotion path.
    Next:
    - Patch missing tombstone enforcement and rerun test.

## What is NEVER compressed (§22 — the hard boundary)
Sol PLAN/REVIEW/FINAL outputs, implementation evidence, diffs, required test
logs, rollback instructions, security findings, memory migration evidence.
Full technical evidence lives separately and stays full-fidelity; this skill
only shapes the operator-facing summary.

## Anti-patterns
- Burying the status under context ("Background: as you know, the system…").
- Vague failure wording ("something went wrong with the sync").
- A "done" report that hides an open risk instead of stating it under Next.
