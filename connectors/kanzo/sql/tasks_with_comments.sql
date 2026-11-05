-- The tasks with at least one comment, and how many comments each has, for every kanzo import. The comment bodies are
-- in the task's own file, under "## Comments".
view
SELECT key, title, project, status, comments, updated, uri
FROM kanzo_tasks
WHERE comments > 0
ORDER BY comments DESC, updated DESC
