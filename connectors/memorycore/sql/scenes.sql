-- One row for each scene block of every memorycore import, with its summary, its heat, and the instants the store states.
view
SELECT json_extract_string(properties, '$.frontmatter.scene') AS scene,
       json_extract_string(properties, '$.frontmatter.team') AS team,
       json_extract_string(properties, '$.frontmatter.agent') AS agent,
       json_extract_string(properties, '$.frontmatter.title') AS summary,
       CAST(json_extract_string(properties, '$.frontmatter.heat') AS INTEGER) AS heat,
       json_extract_string(properties, '$.frontmatter.created') AS created,
       json_extract_string(properties, '$.frontmatter.updated') AS updated,
       uri
FROM node
WHERE kind = 'document' AND uri LIKE 'memorycore://%/scenes/%'
