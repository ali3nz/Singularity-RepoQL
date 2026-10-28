-- One row for each project of every kanzo import, with the board's own counts and the file that holds the project.
view
SELECT json_extract_string(properties, '$.frontmatter.slug') AS slug,
       json_extract_string(properties, '$.frontmatter.name') AS name,
       CAST(json_extract(properties, '$.frontmatter.id') AS INTEGER) AS id,
       CAST(json_extract(properties, '$.frontmatter.total') AS INTEGER) AS total,
       CAST(json_extract(properties, '$.frontmatter.open') AS INTEGER) AS open_tasks,
       json_extract_string(properties, '$.frontmatter.created') AS created,
       CAST(json_extract(properties, '$.frontmatter.repos') AS VARCHAR[]) AS repos,
       uri
FROM node
WHERE kind = 'document' AND uri LIKE 'kanzo://%/projects/%.md'
