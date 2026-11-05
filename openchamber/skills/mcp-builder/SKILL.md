---
name: Integration-server builder
description: Design, build, or review integration servers to the project's transport and security conventions. Use when creating or changing an MCP server.
---

# Integration-server builder

## Purpose

Guide design, implementation and review of integration servers (MCP) so the result
fits the project's transport, auth and review conventions. Task guidance only — the
phases below are an internal checklist, never gates or a lifecycle.

## Source

Adapted from the `mcp-builder` skill in anthropics/skills (Apache-2.0; the document
skills in that repository are source-available and their text is **not** carried
here). This skill carries the workflow discipline and local anchors only.

The upstream `reference/` guides are not vendored in this repository. Read them
from the upstream project when you need language-specific detail, and note in your
report which version you consulted.

## Authority boundary (read first)

This skill is subordinate to the workspace `AGENTS.md`, the orchestration policy in
force, the project's change discipline, and the normal review gates. It must not
select agents, create parallel phases or gates, deploy, merge, or alter routing. It
must not write memory, journals, or documentation. Generated code is validated and
reviewed like any other change.

## Use when

Building a new integration server, extending one with tools, or reviewing one.
Task-scoped: load it for integration-server work, not generally.

## Procedure

### 1. Plan

- List the endpoints or operations to cover. Balance full API coverage (flexible
  composition) against narrow workflow tools (convenience for one task). When
  unsure, prefer coverage.
- Name tools consistently with action prefixes (`service_verb_object`) and one-line
  descriptions, so the right tool is discoverable.
- Design for small contexts: focused results, pagination or filters, and actionable
  error messages that name the next step.
- Read the protocol specification for the transport and capabilities that apply.

### 2. Implement

- Local transports: stdio for local servers; stateless JSON over streamable HTTP for
  remote ones. Match the project's existing integration-server example where one
  exists: narrow tools, JSON or Markdown responses, errors that guide.
- One validated schema per tool (Zod for TypeScript, Pydantic for Python):
  constraints plus clear descriptions.
- Auth from environment or configuration, never pasted secrets; no credential,
  token, or secret text in code, fixtures, logs, or test output.
- Bound every outbound call: timeouts, pagination limits, and a maximum response
  size.

### 3. Test

- Unit-test the tool handlers against recorded or synthetic responses.
- Test the failure paths: auth failure, rate limit, malformed response, timeout.
- Prove the server starts and lists its tools before claiming it works.

### 4. Review

- Run the implementation review gate for anything that ships.
- Check the security surface explicitly: what the server can reach, what it can
  write, and what it returns to the model.

## Do not

Do not scaffold a second transport convention, do not add tools the protocol does
not need, and do not weaken auth to make a local test pass.
