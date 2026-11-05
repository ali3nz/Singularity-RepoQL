# Kanzo fixture responses (synthetic)

Two responses, shaped exactly like the board's API and containing invented
content only:

- `board.json` — `GET /api/board?done=all` shape: `changes`, `done_hidden`,
  `projects`, `statuses`, `tasks`, `version`.
- `task-1.json` — `GET /api/tasks/1` shape: `task`, `comments`, `images`.

They are response samples, not live board data. `../suite.json` uses both saved
responses verbatim for a normal import and repeated full scan. All task
`project` fields use Kanzo's upstream slug-string contract. Its derived cases
reject a numeric project id, reject a partial listing whose project total is
unchanged, and adjust the project counts to verify that a complete validated
listing removes the stale task file. These are constructed test cases, not
observed API replies.
The live recording that drove the 1.0.0 package contains real board records and
is not shipped. Re-record a suite against your own board before relying on a
fixture run for local data.
