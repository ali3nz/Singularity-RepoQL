# Milestone 79 — RepoQL connector freshness and completeness hardening

**Scope:** Claude Code Complete source only. The native Windows application, third-party connectors, user credentials and installed RepoQL executable were not accessed. Release status remains **BLOCKED**.

## Defects addressed

- The dashboard connector inventory previously selected the first matching connector import. A second import with the same scheme could contradict the first while the dashboard still declared that connector `active`. Duplicate or conflicting scheme/root import records now remain **ambiguous**, and do not count as active, until an operator reconciles actual RepoQL registry state.
- A `freshAsOf` timestamp arbitrarily far in the future was considered fresh due to a negative computed age. Such timestamps now produce `clock_skew` and cannot satisfy the connector acceptance gate. Up to 120 seconds positive clock skew remains tolerated as an operational allowance.
- The exact-two-connector gate previously accepted an inventory that was truncated at 200 records. It now requires explicit `truncated: false`; otherwise registry completeness is unverified and the gate is false. This does not suppress the dashboard's partial inventory display; it only prevents a release PASS.

Windows and Linux CI now run the same focused connector checks. The release source audit requires the integrity test source to be shipped. The safe reports do not disclose connector import roots or credentials. These rules enforce source-level evidence integrity, **not** actual RepoQL v1.7.18 CLI schema compatibility or any live MCP call.

## Focused checks

Run in a source checkout:

```sh
python -m unittest discover -s dashboard -p 'test_repoql_connector_inventory_integrity.py' -v
python -m unittest discover -s native/windows -p 'test_option2_dashboard_wiring.py' -v
```

Then, on authorized Windows with a real, independently verified RepoQL 1.7.18 host, run the preexisting read-only `native/windows/verify_option2_connectors.py`. Observe both imports, full registry, current timestamps and successful real connector tool calls independently. **Do not auto-repair an ambiguous registry or overwrite a production import.**
