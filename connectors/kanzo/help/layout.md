# How the Kanzo import is laid out

One import, `kanzo://board/`, holds the whole board.

```
overview.md                 what the copy holds, when it was last compared, what it leaves out
projects/<slug>.md          one project: counts, repositories, the board's own name
tasks/<id>.md               one task: facts, description, migration provenance, the whole comment thread
.state/kept.json            the connector's own: which cards it has read, and at which board change
```

`tasks/<id>.md` is named by the numeric native id, which never changes. The card's qualified key — `work#12` — is
the `key` fact, and is what to search and join on.

## Asking

```text
# what is in progress, in the asker's words
read("kanzo://board/** => tree: headlines")
explore(uriGlob="kanzo://board/**", keywords="gateway nightly sync failed", question="has this failed like this before?")

SELECT key, title, project, status FROM kanzo_open_tasks ORDER BY project, position;
SELECT * FROM kanzo_tasks_by_status;
SELECT * FROM kanzo_tasks_by_project;
SELECT * FROM kanzo_tasks_with_comments;
SELECT * FROM kanzo_imported_tasks WHERE outcome = 'unknown_legacy';
SELECT * FROM kanzo_projects;
```

The views name `is_open` and `is_human` rather than `open` and `human`, because both are reserved words in SQL.

## Facts on every task

`key`, `id`, `title`, `project`, `project_name`, `status`, `open`, `human`, `tags`, `position`, `comments`, `created`,
`updated`, `repos`, `migrated`, and `coordination_blocks_left_out` when the broker's envelopes were dropped.

An imported card also states `source_key`, `source_path`, `source_sha256`, `source_state`, `source_column`,
`status_at_import`, `legacy_number`, `legacy_owner`, `outcome`, `closure_reason`, `operator_signoff`, `date_basis`,
`record_date`, `flags`, `area`, `imported_at` and `importer`.

## Four things a reader gets wrong without being told

- **`done` is an administrative closure, not a success.** Look at `outcome` on an imported card, and at the closure
  section of a comment, before reading a card as finished work.
- **No claim is in this import.** A `doing` card may be claimed right now by a session, and the copy cannot say so.
  Ask the board.
- **A comment thread is complete or it is old.** The file holds every comment the board had when it was last read;
  `updated` and `overview.md`'s `complete_as_of` bound that.
- **A comment's author is a plain board name**, not an account. There is no person file.
