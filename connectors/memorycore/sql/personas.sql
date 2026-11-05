-- One row for each persona file of every memorycore import: one narrative for each agent and extraction plane the store keeps.
view
SELECT json_extract_string(properties, '$.frontmatter.title') AS title,
       json_extract_string(properties, '$.frontmatter.team') AS team,
       json_extract_string(properties, '$.frontmatter.agent') AS agent,
       json_extract_string(properties, '$.frontmatter.plane') AS plane,
       json_extract_string(properties, '$.frontmatter.source_file') AS source_file,
       uri
FROM node
WHERE kind = 'document' AND uri LIKE 'memorycore://%/personas/%'
