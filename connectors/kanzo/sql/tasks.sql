-- One row for each task of every kanzo import, with the board's own facts and the file that holds the task.
view
SELECT json_extract_string(properties, '$.frontmatter.key') AS key,
       CAST(json_extract(properties, '$.frontmatter.id') AS INTEGER) AS id,
       json_extract_string(properties, '$.frontmatter.title') AS title,
       json_extract_string(properties, '$.frontmatter.project') AS project,
       json_extract_string(properties, '$.frontmatter.project_name') AS project_name,
       json_extract_string(properties, '$.frontmatter.status') AS status,
       CAST(json_extract(properties, '$.frontmatter.open') AS BOOLEAN) AS is_open,
       CAST(json_extract(properties, '$.frontmatter.human') AS BOOLEAN) AS is_human,
       CAST(json_extract(properties, '$.frontmatter.comments') AS INTEGER) AS comments,
       CAST(json_extract(properties, '$.frontmatter.position') AS DOUBLE) AS position,
       json_extract_string(properties, '$.frontmatter.created') AS created,
       json_extract_string(properties, '$.frontmatter.updated') AS updated,
       CAST(json_extract(properties, '$.frontmatter.migrated') AS BOOLEAN) AS migrated,
       json_extract_string(properties, '$.frontmatter.outcome') AS outcome,
       CAST(json_extract(properties, '$.frontmatter.tags') AS VARCHAR[]) AS tags,
       uri
FROM node
WHERE kind = 'document' AND uri LIKE 'kanzo://%/tasks/%.md'
