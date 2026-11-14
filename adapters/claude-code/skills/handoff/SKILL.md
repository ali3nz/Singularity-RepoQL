---
name: Session handoff
description: Compact the current session into a handoff note in the owning work item or session record so another agent can continue. Use at session boundaries or worker transfers.
disable-model-invocation: true
---

# Session handoff

## Purpose

Write one bounded handoff note so a fresh agent can continue the work without
re-deriving state.

## Source

Adapted from the `handoff` skill in mattpocock/skills (MIT). The upstream output
location (an OS temp directory) was replaced: temp output is not a durable home and
is lost between sessions. No orchestration logic was carried over.

## Authority boundary (read first)

This skill is subordinate to the workspace `AGENTS.md` and the orchestration policy
in force. It writes a single note to a task-owned location. It must not select
agents, alter routing, capture memory, or duplicate authoritative artifacts.

## Use when

A session boundary, token pressure, or a worker-to-worker transfer. Explicit
invocation only.

## Procedure

1. Determine the destination first:
   - a claimed work item exists → a `Handoff` section in that item's record;
   - no work item, session-level continuity → the project's session record (for
     example `docs/CURRENT_SESSION_HANDOFF.md`);
   - never an OS temp directory, never a workspace-local scratch file, never chat
     alone.
2. Summarise compactly: next focus (from the caller argument when given), current
   state, open questions with their owners, and pointers — paths, URLs, work-item
   identifiers, commit SHAs — to the specs, plans, diffs and evidence. Reference;
   do not duplicate.
3. Add a `Suggested skills` section naming the skills the next agent should load.
4. Redact secrets, credentials, tokens, and personal data before writing.

## Do not

Do not copy spec, plan, or transcript content into the note. Do not write memory or
journal entries from this skill. Do not invent new handoff locations.
