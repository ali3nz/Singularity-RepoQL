-- How many tasks each project holds, how many are open, and when its newest card changed, for every kanzo import.
view
SELECT project, project_name,
       count(*) AS tasks,
       sum(CASE WHEN is_open THEN 1 ELSE 0 END) AS open_tasks,
       sum(CASE WHEN migrated THEN 1 ELSE 0 END) AS imported,
       max(updated) AS last_change
FROM kanzo_tasks
GROUP BY project, project_name
ORDER BY project
