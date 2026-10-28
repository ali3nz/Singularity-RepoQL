-- The tasks of every kanzo import that the board has not closed: every column but done. A task here may be claimed by
-- a session right now, and the claim is not in this import: ask the board who holds it.
view
SELECT key, title, project, project_name, status, is_human, comments, updated, uri
FROM kanzo_tasks
WHERE is_open
ORDER BY project, position, id
