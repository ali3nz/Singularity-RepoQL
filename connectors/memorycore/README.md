# Tencent MemoryCore

This connector copies a Tencent MemoryCore store into a RepoQL workspace, so that you and your agents can search what the store remembered, when it remembered it and in which session, beside the code.

The store has no API that reads its records back, so this connector reads the store's own files from the data folder on this machine: the `records/` JSONL shards (L1), the `scene_blocks/` files under each profile (L2) and the `persona*.md` files under each profile (L3). It sends no request, uses no secret, and never writes to the store's folder: the store's service is the folder's only writer. Its `fetch` pass reads that source and stores only sanitized output-file records in RepoQL's private import database; `render` publishes those records without reading the source.

## What it reads

- Every L1 memory record of every daily shard, `records/<YYYY-MM-DD>.jsonl`: its text, its type (`episodic`, `instruction` or `persona`), its priority, its creation and update instants, the scene name it belongs to, its session, task, team, user and agent ids, and the activity window where the store states one.
- Every L2 scene block, `profiles/<team|agent>/scene_blocks/*.md`: its summary, heat, creation and update instants, and its Markdown.
- Every L3 persona, `profiles/<team|agent>/persona.md` and each `persona.<plane>.md` beside it: its Markdown, kept whole.

## What it leaves out

- The store's raw conversation logs (`conversations/`), its `vectors.db`, and its `metadata/`, `instances/`, `.backup/` folders and every `.metadata/` folder. None of them is a memory, and none is read.
- Of each record: `source_message_ids` (pointers into the conversation logs, which are not in the copy), `sessionKey` (it repeats `sessionId`), and every `metadata` member except the two activity instants.
- A profile folder whose name states no team and an agent: nothing of it is copied, and the import names it as a gap until the store names it properly.
- The text of a file that holds a zero byte, which no workspace file can hold: it is left out and named as a gap.
- An incomplete JSONL line or a source file that changes while it is read: the previous copy of that source file is retained and the import reports a gap until a complete read succeeds.

## What the copy holds about a person

The store's memory is personal by design, and this connector copies it whole apart from the list above. What the import holds is this list and nothing more: the text of each record; its session, task, team, user and agent ids; its instants; the scene name; the scene blocks' summaries and text; and the persona narratives. It holds no conversation log, no message ids, no image or attachment, and no field the store keeps outside these files.

## Credential-shaped text is replaced

A record's text can carry a credential inside a command, a log or a pasted configuration. This connector replaces the shapes it knows, in every file it writes, with `[redacted]` (`[redacted private key]` for a PEM block):

- a private key block (`-----BEGIN ... PRIVATE KEY-----` through `-----END ... PRIVATE KEY-----`);
- `ghp_…`, `github_pat_…`, `sk-…`, `AKIA…` and `xox[abprs]-…` tokens;
- a JWT-shaped `eyJ….….…` value;
- a value after `Bearer `;
- a value directly after `api_key`, `apikey`, `token`, `secret`, `password`, `passwd` or `pwd`, whether followed by `=` or `:`;
- a value after `--password`, `--token`, `--secret` or `--api-key`.

That list is the only guard: a shape it does not name is written as it stands. A value directly after one of those words is replaced even when it is harmless.

## Where it reads from

One folder of this machine, the store's data folder, chosen on RepoQL's local install review page:

```
rql connector install Tencent.MemoryCore.<version>.nupkg
```

The page asks for the source root `data`; choose the folder the store's own service writes. The manifest suggests `~/tencent-memory/data`; keep it or choose your own. Do not pre-grant a folder. The connector may read any file under that folder, and the folder is never written to by anything but the store's service.

## What it needs

Nothing else. No network host is granted, no secret is stored, and no inference is used. Each 15-minute pass reads the complete source listing. RepoQL removes files that the store removed only after the source listing completes unchanged; an interrupted or failed pass does not remove prior records.

## Search by meaning

The default is `embedding: full`: each file's text is sent to the embedding service so a question can find a record that uses other words. That depth is chosen when the import is added, and it can be turned down there for a store whose text must not leave the machine.

## Trying it

```
rql connector test connectors/memorycore/connector.ts --fixtures connectors/memorycore/suite.json  # offline fixture generations
# The product setup builds and pins the 1.0.0 package; do not commit .nupkg bytes.
rql connector install Tencent.MemoryCore.1.0.0.nupkg
rql import memorycore://data
rql connector status
```

The install command opens RepoQL's local review page for the `data` source root; choose the store's folder there. Then read `memorycore://data/overview.md` for what the copy holds, and `memorycore://data/records/<day>/<id>.md` for one memory. The suite's fixtures are shaped after the store's real files as of 2026-10-27, with invented content.


## Scoped writes and the RC probe

MemoryPanel and this connector read the same store the gateway writes. A local
RC check writes one conversation through `POST /v2/conversation/add`, recalls it
through `/v2/conversation/search`, deletes it through `/v2/conversation/delete`
(session plus message ids) and proves the marker is gone. That sequence lives in
[`../../memory/rc_stack.py`](../../memory/rc_stack.py) `probe()`, runs only
against an RC-owned stack, and is what the Windows acceptance evidence used; the
connector's own offline contract is `rql connector test` with `suite.json`.
