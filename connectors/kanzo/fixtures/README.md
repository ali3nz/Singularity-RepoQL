# Kanzo fixture responses (synthetic)

Two responses, shaped exactly like the board's API and containing invented
content only:

- `board.json` — `GET /api/board?done=all` shape: `changes`, `done_hidden`,
  `projects`, `statuses`, `tasks`, `version`.
- `task-1.json` — `GET /api/tasks/1` shape: `task`, `comments`, `images`.

They are response samples, not a recorded `rql connector test` suite. The live
recording that drove the 1.0.0 package contains real board records and is not
shipped. Re-record a suite against your own board before trusting a fixture run.
