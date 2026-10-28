-- How many memory records each day holds, by type, for every memorycore import.
view
SELECT json_extract_string(properties, '$.frontmatter.day') AS day,
       json_extract_string(properties, '$.frontmatter.type') AS record_type,
       count(*) AS records
FROM node
WHERE kind = 'document' AND uri LIKE 'memorycore://%/records/%'
GROUP BY day, record_type
