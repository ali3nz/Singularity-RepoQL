---
name: Implementation review gate
description: Run the pre-completion code-reviewer pass for significant changes before claiming done
---

# Implementation review gate

## Purpose

Independently review a significant change before declaring it complete.

## Use when

The change is significant: it affects runtime behavior, permissions, security
controls, deployment, shared infrastructure, orchestration logic, or more than one
file.

## Procedure

1. Collect the original requirement, the changed files or diff, and the validation
   evidence.
2. Invoke the `code-reviewer` subagent with all three — it is read-only and reviews
   what you supply. Supply evidence, not a summary of what you believe you did.
3. Resolve every BLOCKING finding. Handle NON-BLOCKING findings at your judgement.
4. If the review lacked evidence, supply the missing evidence and re-run the review
   rather than arguing with the finding.
5. Record the outcome — approved, or findings resolved — before declaring
   completion.

## Do not

Do not skip the review for significant changes. Do not let the reviewer redesign
working code or expand scope. Do not declare completion while a BLOCKING finding is
open. Do not run the review on a diff you have since changed: review what ships.
