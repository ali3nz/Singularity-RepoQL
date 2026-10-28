# Kanzo board → RepoQL

Copies the whole **Kanzo** board of this machine into a RepoQL workspace: one Markdown file for every task with its
comment thread, one for every project, and an overview. Read-only — every request is a `GET`, and nothing is ever
written back to the board.

## What it reads

| It reads | From |
|---|---|
| The whole board listing, every sweep | `GET http://localhost:4242/api/board?done=all` |
| One task's comments | `GET http://localhost:4242/api/tasks/<id>` — only for a task that has comments and whose count, `updated_at` or the board's change counter moved |

That is the Kanzo service's own loopback API: no authentication, no credential, nothing sent with a request, and
nothing that leaves the machine. The manifest grants exactly `http://localhost:4242` and paces the connector at 6
requests a minute. A sweep normally makes **one** request; the full board of 494 cards with its one comment costs two.

## What the import holds, field by field

Per task: the qualified native key (`work#12`), the numeric id, project slug and name, the raw board column
(`status`), `open` (false only for `done`), `human`, `tags`, `position`, the comment count, `created`, `updated`, and
the project's repositories. Provenance of an imported card: `source_key`, `source_path`, `source_sha256`,
`source_state`, `source_column`, `status_at_import`, `legacy_number`, `legacy_owner`, `outcome`, `closure_reason`,
`operator_signoff`, `date_basis`, `record_date`, `flags`, `area`, `imported_at`, `importer`.

Per task body: the card's own description text, a `## Board state` summary, a `## Migration provenance` list when it
was imported, and `## Comments` with one heading per comment (author name and the comment's own instant).

Per project: slug, name, id, `repos`, `color`, `created`, the board's own `open` and `total`, and the board version.
The overview says what the copy holds, what it leaves out, and when it was last compared with the whole board.

## What it leaves out — the closed list

- **Live claims, check receipts and their HMAC signatures.** A claim is a lease of minutes, and an indexed copy of
  one would be read as current. `coordination_blocks_left_out` on a task counts what was dropped; no file says who
  holds a card now. Ask the board (`kanzo mcp` → `check_work`, or the OpenChamber Kanzo tools).
- **The session id, identity and claim receipt inside a closure envelope.** The closure's outcome, declared outcome,
  mismatch flag, summary, validation results, remaining work, sign-off and closed-at are kept.
- **Attachments and images** (`/api/images`, the `images` list of a task answer).
- **Credentials pasted into a description or a comment**, as far as the shapes in `connector.ts` know them:
  `Authorization: …`, `Bearer …`, a name that says it is a credential (`API_KEY=`, `KANZO_TOKEN=`, `password:` …),
  GitHub, Slack, OpenAI and AWS key shapes, JWTs, a PEM private key, `user:password@` in a URL, and a
  `hmac-sha256:` signature outside its envelope. **This is the only guard.** A shape it does not name is written and
  embedded. Nothing else is redacted: a SHA-256, a date, a version and a path stand as they were.

What the import holds about a person is a comment author's plain board name, and nothing else: the board keeps no
account of its own.

## What "done" means

A task in the `done` column was **closed administratively**. The board records the closure, not a result. It does not
say the work succeeded, that tests passed, or that the operator approved it. Most of this board is an imported
backlog whose recorded outcome is `unknown_legacy`; the overview and the `kanzo_imported_tasks` view say so.

## Freshness

A sweep runs every 15 minutes and reads the **whole** board listing, so a title, column, tag or project change is at
most 15 minutes old. A task's comment thread is re-read when its comment count, its `updated_at`, or the board's
change counter moved; between those, the thread is as old as the last read. Because every sweep reads the whole board,
every sweep that completes removes the file of a card the validated listing no longer names — a malformed,
incomplete or contradictory answer publishes nothing, removes nothing, and is retried by the next sweep.
`complete_as_of` in `overview.md` is when the whole board was last compared.

## Grants it asks for, and why

| Grant | Why |
|---|---|
| Host `http://localhost:4242`, local | The Kanzo service's own loopback bind. Nothing else is reachable. |
| 6 requests a minute | One listing a sweep; the rest is a task's comments. |
| Semantic embedding (`embedding: full`) | It is what lets a question find a card that uses other words. **Each file's text is sent to the embedding service the host is configured with.** Turn it off with `embedding: none` only if that text must not leave the machine. |

No secret, no source root, no inference: the connector never reads a credential and never asks a model.

## Toolchain note — read this before installing

The board's host runs **rql 1.7.15**. The connector is built for the 1.7.15 connector contract (`abi: 1`, `sync`,
`sweepIntervalSeconds`). A later rql (1.7.17, the current `rql` on PATH) speaks a different, incompatible connector
contract and refuses this manifest with *"Manifest abi names a connector contract an earlier RepoQL ran"*. Install,
test and pack with the 1.7.15 client:

```sh
/root/.repoql/versions/1.7.15/rql connector install <package> --allow-local-host http://localhost:4242
```

Upgrading the host to 1.7.17 is a separate decision and would require every installed connector (including
`memorycore`) to be rebuilt for the new contract.

## Ask it

`sql/` ships seven views — `kanzo_tasks`, `kanzo_open_tasks`, `kanzo_tasks_by_status`, `kanzo_tasks_by_project`,
`kanzo_tasks_with_comments`, `kanzo_imported_tasks`, `kanzo_projects` — and `help/layout.md` says how to ask.
