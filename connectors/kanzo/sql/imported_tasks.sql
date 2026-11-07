-- The tasks that came from an older record, with what the importer recorded about them, for every kanzo import. An
-- outcome of unknown_legacy is not a success: the backlog was closed administratively.
view
SELECT json_extract_string(properties, '$.frontmatter.key') AS key,
       json_extract_string(properties, '$.frontmatter.title') AS title,
       json_extract_string(properties, '$.frontmatter.status') AS status,
       json_extract_string(properties, '$.frontmatter.outcome') AS outcome,
       json_extract_string(properties, '$.frontmatter.closure_reason') AS closure_reason,
       json_extract_string(properties, '$.frontmatter.operator_signoff') AS operator_signoff,
       json_extract_string(properties, '$.frontmatter.legacy_number') AS legacy_number,
       json_extract_string(properties, '$.frontmatter.legacy_owner') AS legacy_owner,
       json_extract_string(properties, '$.frontmatter.source_key') AS source_key,
       json_extract_string(properties, '$.frontmatter.source_sha256') AS source_sha256,
       json_extract_string(properties, '$.frontmatter.imported_at') AS imported_at,
       uri
FROM node
WHERE kind = 'document'
  AND uri LIKE 'kanzo://%/tasks/%.md'
  AND CAST(json_extract(properties, '$.frontmatter.migrated') AS BOOLEAN)
ORDER BY key
