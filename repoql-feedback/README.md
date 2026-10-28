# RepoQL feedback

This directory is for **structured reports about RepoQL itself** — the product:
its MCP server, CLI, indexer, query surface, concept memory, connectors, and the
documentation that ships with it.

The rule this directory exists for: **every RepoQL defect, limitation, or
confusing behavior an agent or contributor hits gets a report here**, using
[`TEMPLATE.md`](TEMPLATE.md). Not a paragraph in a chat, not a note in a task
summary, not a silent workaround.

## What belongs here

- A defect: RepoQL did something wrong.
- A limitation: RepoQL cannot do something it reasonably should, and the
  workaround is not obvious from the docs.
- A confusing behavior: RepoQL's behavior, naming, output, or error was harder to
  understand than it should be — including version skew between the MCP surface and
  the host, index coverage that is not what the output implies, and tools whose
  result shape surprises a careful reader.

One report per issue. If you hit three problems in one session, that is three
reports.

## What does not belong here

Attribution is the whole value of this directory, so be strict. These are **not**
RepoQL reports, and filing them here corrodes the signal:

- harness, client, or UI faults (the agent runtime, the editor integration, a
  plugin wrapper you wrote);
- fleet or environment faults (host capacity, network, a service you deployed
  badly, your own credentials or permissions);
- agent mistakes (a wrong command, a misread output, a hallucinated tool argument);
- feature wishes with no observed behavior behind them.

If you are unsure, the honest test is: *could a RepoQL maintainer reproduce this
from the report alone, on a clean installation?* If not, it is not ready to file —
gather the missing evidence first, or file it somewhere it belongs.

## Requirements for every report

A report is only usable if it carries all of this:

1. **Version and environment** — the exact RepoQL version, how it was installed,
   the operating system, and the client that talked to it. Version skew between
   client and host must be stated, because it changes the diagnosis.
2. **The exact command or call** — copy-pasteable, with the arguments as issued.
3. **Expected versus actual** — what you expected, what happened, and why the
   expectation was reasonable (the doc line, the schema, the sibling command that
   behaves differently).
4. **Reproduction** — the smallest sequence that shows it, ideally on a fresh or
   synthetic index. State whether it reproduces reliably, intermittently, or once.
5. **Evidence** — the output, redacted. A report without observed output is an
   anecdote.
6. **Attribution** — the section in the template that says, in your own words, why
   this is RepoQL's behavior and not the harness's or the environment's.

## Redaction — non-negotiable

Never put any of the following in a report:

- credential, token, key, or password values (report the variable name and where it
  is configured, never the value);
- personal data, customer data, or private repository contents;
- private hostnames, internal addresses, or filesystem paths that identify an
  installation.

Redact by shape, not by guessing: replace the value with `<redacted:api-key>` and
keep the surrounding structure intact, so the maintainer can still see the shape of
the problem. Paths become `<workspace>/src/...`. If a report cannot be written
without a secret, it cannot be written.

## Filing

Copy [`TEMPLATE.md`](TEMPLATE.md) into the issue tracker or review channel your
installation uses for RepoQL, fill every section, and keep the `Version`,
`Environment`, and `Attribution` sections even when they feel repetitive — they are
the parts that make a report actionable.

If you cannot file it, record the completed template in your own task evidence and
say that it is unfiled. An unfiled report is a known gap; a lost one is a repeated
bug.
