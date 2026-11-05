# Milestone 64: Ghost/delegated memory search-scope probe (SOURCE ONLY)

Scope: Claude Code Complete on native Windows. This is a read-only **search separation** acceptance check, **not an authorization or confidentiality proof**.

## Operator preparation

1. Use approved identities and the existing MemoryCore account/configuration. Establish one private, harmless random marker in the isolated Ghost scope and another in exactly one of the eight delegated Claude scopes. Only the trusted Windows operator should create them. The probe never writes, seeds or mutates profiles.
2. Save a private probe JSON locally with the exact schema below. Never commit the real identity values or marker strings to source control or upload them with test receipts.

```json
{
  "schema": "singularity-option2-ghost-scope-probe/v1",
  "ghost": {"team_id": "GHOST_TEAM", "user_id": "OPERATOR", "agent_id": "ghost"},
  "delegated": {"team_id": "TEAM", "user_id": "OPERATOR", "agent_id": "board"},
  "ghostMarker": "GHOSTPROOF-UNIQUEEXAMPLE2026",
  "delegatedMarker": "DELEGATEPROOF-UNIQUEEXAMPLE2026"
}
```

3. With a validated locally secured, loopback MemoryCore gateway, run on native Windows:

```powershell
node .\native\windows\claude_complete_ghost_scope_probe.mjs --probe-file C:\Private\ghost-probe.json --memory-config C:\Private\memory.json --live --output C:\Private\ghost-search-separation-receipt.json
```

The probe searches each marker in its own identity first. Without **both positive controls**, it does not accept negative cross-scope searches. It then searches both markers across the identities and reports any cross-scope results. Backend failures cannot pass. Reports contain no credentials, identity values or marker contents. Output must be a new user-owned file; existing files are never overwritten.

Even when `searchSeparationObserved` is true, `securityAuthorizationProven` and `releaseReady` remain false. Independent authorization-denial tests, account/service ACL checks, memory tenancy enforcement, retention and genuine native Claude Code tab behavior remain required. Do not claim secure isolation based solely on negative search results.
