---
name: Work item closeout
description: Close the tracked work item in one action after the change, recording the real outcome
---

# Work item closeout

## Purpose

Close the work item you were doing, with truthful metadata, in one action. Closure
is administrative and always happens; it is not a verdict on the work.

## Prerequisite

This skill needs a work tracker connected to the session (for example a Kanzo MCP
server, or the project's own tracker CLI). If none is connected, report that and
stop — do not invent an identifier, and do not record the outcome only in chat.

## Identifier

Use the qualified native identifier the tracker assigned, in its own format. Do not
invent a number, do not pass a legacy issue number, and do not use a documentation
file path as an identifier. Historical filenames are reference material, not ids.

## Always close when you stop

Close the item when you stop for any reason — including when the work failed and
the cause is not yet known: `success`, `failed`, `partial` or `stopped`. Pending
operator sign-off does not delay closure; record it as pending and close anyway. A
closed card is a valid record of failed or partial work, and the operator can
reopen it.

Closed means **administratively closed**. It is not a claim of success, not an
approval, and not a test pass. The receipt keeps the real outcome beside it.

## Procedure

1. Collect what actually happened: each check with `pass`, `fail` or `not_run` plus
   one line of evidence. If you cannot evidence a check, mark it `not_run`.
2. Close with the tracker's close operation, supplying:
   - summary — what changed, specifically;
   - outcome — `success` only with passing validation; `failed`, `partial` or
     `stopped` otherwise;
   - validation — the per-check list with its evidence;
   - remaining — the unresolved work, the blocker, or the cause;
   - operator sign-off — `pending` when the operator has not yet accepted.
3. Read the receipt, not just the exit code. A success receipt means the tracker
   closed the card **and** its read-back showed the closed state with the claim
   released. A failure receipt means the card is **not closed** — fix the
   transport and re-run. Never report closed on a failure receipt.
4. Update documentation, capture a concept, or add a journal note only when the
   change actually warrants it. There is no documentation diff, concept, activity
   or inbox-drain requirement for closure.

## Do not

- Do not emit or request a pass token to satisfy a run gate. Work closure and run
  success are separate gates.
- Do not report success when checks failed or were not run; record the truth in
  the outcome.
- Do not leave a card open because the work failed, is partial, or awaits
  sign-off. Close it and say so.
- Do not invent an identifier; the tracker's id is authoritative.
