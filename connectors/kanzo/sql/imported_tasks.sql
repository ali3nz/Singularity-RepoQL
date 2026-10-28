-- The tasks that came from an older record, with what the importer recorded about them, for every kanzo import. An
-- outcome of unknown_legacy is not a success: the backlog was closed administratively.
view
SELECT key, title, status,
       json_extract_string(properties, '$.frontmatter.outcome') AS outcome,
       json_extract_string(properties, '$.frontmatter.closure_reason') AS closure_reason,
       json_extract_string(properties, '$.frontmatter.operator_signoff') AS operator_signoff,
       json_extract_string(properties, '$.frontmatter.legacy_number') AS legacy_number,
       json_extract_string(properties, '$.frontmatter.legacy_owner') AS legacy_owner,
       json_extract_string(properties, '$.frontmatter.source_key') AS source_key,
       json_extract_string(properties, '$.frontmatter.source_sha256') AS source_sha256,
       json_extract_string(properties, '$.frontmatter.imported_at') AS imported_at,
       uri
FROM kanzo_tasks
WHERE migrated
ORDER BY key
