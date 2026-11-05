# Windows Kanzo connector: indexed historical tasks SQL compatibility

The synced Windows source currently pins `RepoQL.Connectors.Kanzo` **1.0.0** in `connectors/packages.lock.json` with an exact package SHA256 and byte length. Its `connectors/kanzo/sql/imported_tasks.sql` contains an independently documented Dockerhost defect: the query selects the `properties` JSON column while reading `FROM kanzo_tasks`, a derived view that has no `properties` column. The copied historical task provenance view `kanzo_imported_tasks` therefore cannot register. Other Kanzo board and task views may continue working, and the native dashboard's Kanzo API does **not** depend on this indexed SQL view.

The reviewed Dockerhost source fixed that view in connector version 1.0.1 by reading the indexed document `node` relation directly:

```sql
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
```

**The Windows locked connector package is not changed in this candidate.** Repacking a patched connector under 1.0.0 would invalidate its exact archive SHA256 and bytes; adopting Dockerhost's 1.0.1 package hash would assume cross-version compatibility without testing against Windows's pinned RepoQL 1.7.18. Neither is justified by source-only evidence.

To close the compatibility gap onsite with the existing authorized connector build workflow:

1. Verify the actual Windows `rql.exe` is exactly 1.7.18 and its connector contract matches the pinned package.
2. Compare the installed Kanzo connector's source, version, and registry list (including failed SQL views) to this known defect; if `kanzo_imported_tasks` is already healthy, **do not overwrite it**.
3. If the defect is confirmed, apply the SQL correction only in a **separate build candidate**, increment Kanzo package version and regenerate package with the pinned Windows toolchain, run the existing fixture suite, inspect `rql connector list` for all seven query views, and update `connectors/packages.lock.json` with the actual produced package SHA256/bytes. Reconcile packaging documentation and tests in that same reviewed change. Do not import Dockerhost task records.
4. Confirm the subset count and distinct keys for imported tasks match native Kanzo's actual migrated cards; zero duplicate or null keys and no false `done` success inference. Preserve the existing native Kanzo status/claim workflow separately.

**Effect on current migration:** This is a known indexed-view limitation, not a reason to rewrite the Kanzo state machine or block the standalone dashboard UI parity. Mark the historical indexed view `NOT VERIFIED` until independently tested; do not silently claim all seven views healthy from a successful connector installation exit code.

## Additional source repair prepared in the 1 November second pass

`connectors/kanzo/sql/imported_tasks.sql` now contains the reviewed source
correction above, and `connectors/kanzo/SOURCE-SHA256` reflects that changed SQL.
The pinned `RepoQL.Connectors.Kanzo.1.0.0.nupkg` hash and metadata in
`connectors/packages.lock.json` intentionally remain unchanged: this is an
**unpackaged source correction**, not proof the installed historical view is
fixed. The new source contract test verifies that imported task provenance is
read from `node`, not from the derived `kanzo_tasks` projection. Rebuild and
lock a new package using the installed supported RepoQL tooling before claiming
that the connector's indexed view is repaired at runtime.
