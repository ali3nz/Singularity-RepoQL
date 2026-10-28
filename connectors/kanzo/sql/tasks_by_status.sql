-- How many tasks each board column holds, and how many of them are not closed, for every kanzo import.
view
SELECT status,
       count(*) AS tasks,
       sum(CASE WHEN is_open THEN 1 ELSE 0 END) AS open_tasks,
       max(updated) AS last_change
FROM kanzo_tasks
GROUP BY status
ORDER BY status
