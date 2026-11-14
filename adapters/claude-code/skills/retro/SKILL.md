---
name: Session retrospective
description: Suggest environment, tooling, docs, and check improvements after a session, most severe first. Use when asked for a retrospective on completed work.
disable-model-invocation: true
---

# Session retrospective

## Purpose

Suggest improvements to the agent working environment so future runs go better.
Proposals only — this skill never edits docs, skills, instructions, or memory
itself.

## Source

Adapted from the `retro` skill in mattpocock/skills (MIT). Foreign path assumptions
(a repo standards file, an upstream issue-tracker doc) are remapped below onto
project documentation, run records, and review gates. No orchestration logic was
carried over.

## Authority boundary (read first)

This skill is subordinate to the workspace `AGENTS.md`, the orchestration policy,
and every gate in force. It proposes; owners and gates dispose. It must not select
agents, alter routing, override coordinator decisions, bypass gates, write memory,
or perform remediation. A proposal that would change the workspace rules file is
recorded as a work item against the canonical source — generated copies are never
edited directly.

## Use when

The operator or workflow asks for a retrospective after a session or task.
Explicit invocation only.

## Procedure

1. Load the `effective-markdown` skill for style where the installation provides it.
   Otherwise apply its core rules inline: pointer wording decides reach, reference
   material sits behind pointers, one meaning in one place.
2. Read the primary sources for the session named. If none was named, use the
   current one: the run directory (status, evidence, transcript), the claimed work
   item, and related activity records.
3. Look for improvement candidates in these categories:
   - **Navigation** — was a fact slow to find? Hidden file dependencies? A pointer
     (skill description, index line) that would have routed faster? *When* finding
     took long.
   - **Automated checks** — could lint, typecheck, tests, or a filesystem check have
     caught an error that was made? Read the existing checks first: an
     existing-but-unwired check is the finding, not a reinvention. No guardrail at
     all is itself a finding. *When* a mistake was machine-catchable.
   - **Review-lane rules** — should the existing review lane gain, drop, or clarify
     a rule? Mechanical violations (fixed pattern, banned API, file-location rule)
     deserve a deterministic check first; written rules are for judgement calls no
     check could enforce. *When* review missed something.
   - **Steering size** — do instructions belong in checks or standards instead of
     the always-loaded rules? *When* steering files are large.
   - **Tool economy** — expensive or wasteful tool calls; token-inefficient custom
     tooling. *When* observed.
   - **No-ops** — steering lines that do not change behavior. *When* steering is
     large.
   - **Information access** — missing logs, read-only integrations, or context that
     would have helped. *When* a gap blocked progress.
4. Present candidates ordered by severity. Each states the observation, the
   proposed change, the owning destination (documentation section, skill file,
   check script, or work item), and explicitly `No action` where nothing earns its
   cost.

## Reference

### Propose, never promote

Every candidate is a proposal until an owner applies it through the normal path: a
documentation edit with a `Last updated` bump, a skill edit, a check script plus
validation, or a gated knowledge capture. A retro suspects; the gates decide.
Conversation review asks what knowledge to keep; retro asks what should change
about the environment. A session may need one, both, or neither.

### Implementer versus reviewer pressure

The implementing agent carries exploration, code and debugging context; the
reviewer receives a diff. Review-time standards belong to the review lane, not to
implementation-time instructions.

## Do not

Do not remediate findings inside the retro — file them. Do not write memory, docs,
skills, or instructions from this skill. Do not move canonical rules content into
generated copies. Do not invent a second planning or review workflow.
