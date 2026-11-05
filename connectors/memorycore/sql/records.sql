-- One row for each memory record of every memorycore import, with the store's own facts and the file that holds the record.
view
SELECT json_extract_string(properties, '$.frontmatter.id') AS id,
       json_extract_string(properties, '$.frontmatter.type') AS record_type,
       json_extract_string(properties, '$.frontmatter.title') AS title,
       json_extract_string(properties, '$.frontmatter.day') AS day,
       CAST(json_extract_string(properties, '$.frontmatter.priority') AS INTEGER) AS priority,
       json_extract_string(properties, '$.frontmatter.created') AS created,
       json_extract_string(properties, '$.frontmatter.updated') AS updated,
       json_extract_string(properties, '$.frontmatter.scene_name') AS scene_name,
       json_extract_string(properties, '$.frontmatter.session') AS session,
       json_extract_string(properties, '$.frontmatter.task') AS task,
       json_extract_string(properties, '$.frontmatter.team') AS team,
       json_extract_string(properties, '$.frontmatter.agent') AS agent,
       json_extract_string(properties, '$.frontmatter.user') AS user_id,
       json_extract_string(properties, '$.frontmatter.activity_start') AS activity_start,
       json_extract_string(properties, '$.frontmatter.activity_end') AS activity_end,
       uri
FROM node
WHERE kind = 'document' AND uri LIKE 'memorycore://%/records/%'
