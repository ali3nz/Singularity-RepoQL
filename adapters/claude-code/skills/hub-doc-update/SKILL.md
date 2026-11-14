---
name: Documentation update
description: Update the canonical project documentation after an implementation changes durable behavior
---

# Documentation update

## Purpose

Keep the canonical documentation true after an implementation changes durable
behavior — architecture, operation, configuration, or a support procedure.

## Use when

A completed implementation changes something a future operator or agent would act
on differently. A rename that changes a command, a new setting, a changed default:
document it. A refactor that changes nothing observable: do not.

## Procedure

1. Identify the canonical document before editing — the one the project already
   treats as authoritative for this subject. Search for it (code index or plain
   search) rather than creating a second document.
2. Confirm the implementation evidence — live state and observed output, not the
   narrative of whoever wrote it.
3. Modify only the sections affected by the change. Preserve the document's
   conventions; append rather than rewrite where the document is append-style.
4. Record concrete behavior, not implementation speculation. If a step is untested,
   mark it untested rather than implying it was verified.
5. Bump the document's `Last updated:` line when the document keeps one.
6. Validate the links, paths, commands, and referenced configuration you touched.
7. Report which document changed and which evidence justified it.

## Do not

Do not create duplicate documentation when a canonical document already exists.
Do not document behavior that was not verified. Do not let documentation become a
second source of policy — it describes what is true, it does not grant permission.
