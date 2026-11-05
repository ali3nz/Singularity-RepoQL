---
name: Consult dispatch
description: Route a question or evidence pack to a configured consultant through its broker and poll the pointer for the result
---

# Consult dispatch

## Purpose

Get independent senior reasoning, a plan decision, or a review verdict from a
consultant configured in this installation, through its broker path rather than by
guessing.

## Use when

A decision needs independent review the operator has asked for, a plan needs
approval, or implementation evidence needs a verdict. Never use it implicitly: a
consult spends someone's budget and must be requested.

## Prerequisite (check before you promise anything)

This skill requires a consultant endpoint and a broker configured in the
installation — an environment variable, a config key, or a documented command that
the installation provides. **If no consultant is configured, stop here:** say so
plainly and fall back to local review (`code-reviewer`, `fleet-reviewer`). Do not
invent a broker, do not call an endpoint you found somewhere else, and do not
answer in the consultant's name.

## Procedure

1. Assemble the complete question WITH every piece of evidence inline. The
   consultant has no tools: requirements, file excerpts, diffs, command output,
   error text and acceptance criteria must all be in the text.
2. Dispatch through the configured broker and keep the returned pointer — the exact
   one it gave you. Never look up a "latest" pointer, and never assume the newest
   file is yours.
3. Poll that pointer until it reports a terminal state. Continue read-only work
   while waiting; do not block on it and do not start the change it is reviewing.
4. A terminal result means the consult **returned**, not that it **approved**
   anything. Read the actual consultant turn for the answer or verdict. Use the
   exact artifact paths the pointer names; never guess a path.
5. A failed result is a failure: report it with the engine's own message, and
   report which engine was unavailable. Never substitute a different engine, and
   never loosen the question to get an answer.
6. Record the verdict and the pointer with the task's evidence.

## Redaction

Strip credentials, tokens, personal data and private host details from the pack
before dispatch. Reference them by variable name or file location. A consult that
needs a secret value is a consult that needs a different question.
