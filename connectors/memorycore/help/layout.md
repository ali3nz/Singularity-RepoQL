---
description: How an import of the memorycore connector is laid out - what a record file, a scene block and a persona hold, how to ask for memories by meaning, by fact with the views memorycore_records, memorycore_scenes, memorycore_personas and memorycore_daily, and what the import does not hold.
tags: [memorycore, tencent memory, memory, records, scenes, personas, layout, frontmatter, provenance, session, stale, overview, sql, views, gaps, personal data]
---

# Reading a Tencent MemoryCore import

An import of `memorycore://<root>` is a copy of a Tencent MemoryCore store, read from the store's data folder. A file is named by the store's own ids, so it keeps its address when the store rewrites a persona or a scene, and a record keeps the id it was created with.

| File | What it is |
|---|---|
| `memorycore://<root>/records/<YYYY-MM-DD>/<id>.md` | One L1 memory record, under the day it was created, as `records/2026-01-07/m_1736233200000_aa01bb02.md` |
| `memorycore://<root>/scenes/<team>/<agent>/<Scene>.md` | One L2 scene block, as `scenes/team-fixture/agt-fixture/Setup-Session.md` |
| `memorycore://<root>/personas/<team>/<agent>/persona.md` | One L3 persona per agent and extraction plane; a second plane adds `persona.<plane>.md` beside it |
| `memorycore://<root>/overview.md` | What the copy holds, what it leaves out, and when it was last compared with everything the store lists |

## What a record file holds

| Part | Where | What it is |
|---|---|---|
| Headline | The file's `title` | The record's opening words, so a search result shows what it says and not only its id |
| `id` | Frontmatter | The store's own id for the record, which is the file's name |
| `type` | Frontmatter | `episodic`, `instruction` or `persona`, as the store typed it |
| `priority`, `version` | Frontmatter | The store's own numbers when it states them |
| `created`, `updated` | Frontmatter | Instants in UTC with milliseconds, as `2026-01-07T08:02:00.000Z`, which compare as text. The file's modification time is `created` |
| `day` | Frontmatter | The day folder the file sits under, the day part of `created` |
| `scene_name` | Frontmatter | The scene the store grouped the record under, in the store's own words |
| `session`, `task`, `team`, `agent`, `user` | Frontmatter | The store's ids for where the memory came from. `session` is the id a conversation is cited by |
| `activity_start`, `activity_end` | Frontmatter | The window the store states for the activity, when it states one |
| `source_file` | Frontmatter | The store's own file the record was read from, as `records/2026-01-07.jsonl` |
| The text | Under the frontmatter | The record exactly as the store wrote it, with known credential shapes replaced by `[redacted]` |

A record is evidence of what was remembered at its instant, never a claim about what is true now: the store only appends, so a changed fact is a newer record beside the older one, and the instants are what tell them apart. Quote a record by its `id` and its `session`.

## What a scene file holds

A scene block merges related episodes for one agent. Its file holds `scene` (the store's name for it), `team` and `agent`, the store's `created` and `updated` instants, its `heat`, and its `summary` as the file's `title`. The Markdown that follows is the scene's narrative, with the store's `----META----` header lifted out of the body and into the frontmatter. A scene whose summary is rewritten keeps its address; its `updated` fact moves.

## What a persona file holds

A persona is the store's narrative profile of the user for one agent. Its file holds `team`, `agent`, `plane` (only for a second extraction plane) and `source_file`. The narrative is kept whole, with `[redacted]` for known credential shapes.

## Asking

Read the overview first; it says what the copy holds and what it leaves out:

```
read("memorycore://data/overview.md")
```

Find memories by what they say, in your own words:

```
search("the user asked to confirm the site status before the daily summary")
```

Count and join by fact with the views, one row for each record, scene or persona of every memorycore import:

```sql
-- How many records each agent and type hold
SELECT agent, record_type, count(*) AS records
FROM memorycore_records
GROUP BY agent, record_type
ORDER BY records DESC;

-- A session's memories, oldest first
SELECT id, record_type, created, title
FROM memorycore_records
WHERE session = 'ses_fixture01'
ORDER BY created;

-- What the site summaries said, and when
SELECT id, created FROM memorycore_records
WHERE title LIKE '%site status%' ORDER BY created;
```

`memorycore_records`, `memorycore_scenes`, `memorycore_personas` and `memorycore_daily` are the views; `grep` finds a fact as text, and the frontmatter names are the columns' names, with `user` served as `user_id`.

## What the import does not hold

- The store's raw conversation logs, its vectors, and its internal metadata and checkpoints. None is read, so no file here holds a message body; `source_message_ids` and `sessionKey` are left out too.
- A profile folder whose name states no team and an agent, and any file whose text holds a zero byte. Each is named under the sweep's `missing` and counted in the overview, so an import that is complete says so.
- Nothing outside the store: the import is the store's memory as the store wrote it, with no summary added, no merge, and no rewriting of a record's words.
