# M40: Claude Code Complete delegated MemoryCore profiles (SOURCE ONLY)

## Scope

Option 2 only. **Not** a Windows installation receipt, not a full-memory certificate.
The live credential and namespace ownership decisions remain operator-supplied.

Existing source provided a general seeder for all 16 non-Ghost OpenChamber roles, a
Claude delegation map for eight of those roles, and a separate parent-session
memory proxy acceptance script. Those are not interchangeable: a parent
conversation is not a delegated agent, and Ghost must not be seeded using
these identities.

M40 adds `native/windows/claude_complete_memory_profiles.mjs`:

- `plan` validates **exactly eight delegated mappings**, rejects absent,
  duplicate, invalid, or Ghost identities and reports the parent routing
  configuration status, without writing or contacting MemoryCore.
- `verify` performs authenticated **search-only** charter readbacks from
  Tencent MemoryCore under each provided delegated identity. It never seeds,
  modifies the profile ledger, or claims successful parent memory.
- `seed --apply` is **Windows-only** and explicitly opt-in. It seeds only the
  eight delegated mappings, preserves the existing shared identity scopes,
  and independently re-reads all eight before reporting verified. Reruns
  reconcile against actual stored charters and avoid duplicated writes.
- It refuses non-loopback memory endpoints. Use an operator-managed local
  proxy/tunnel as appropriate rather than putting a privileged service key
  on the command line.
- The report excludes credentials, identity values, memory content, and raw
  API replies. The configuration file and identity map remain on local disk;
  never include them in evidence attachments.

## On Windows, after explicitly setting up the real service and identity map

Use a private JSON identity map (not distributed in this source archive):

```json
{"agents":{"board":{"team_id":"<existing team>","user_id":"<existing user>","agent_id":"board"}}}
```

That fragment is only illustrative. The actual private file **must** contain
all eight canonical names from `DELEGATED_ROLES` and their real, previously
approved MemoryCore identities; do not invent a new shared namespace. Ghost
and main roles are intentionally excluded.

```powershell
node .\native\windows\claude_complete_memory_profiles.mjs plan --identity-map C:\Private\claude-agent-map.json --memory-config C:\Private\memory.json --settings "$HOME\.claude\settings.json"
node .\native\windows\claude_complete_memory_profiles.mjs verify --identity-map C:\Private\claude-agent-map.json --memory-config C:\Private\memory.json --settings "$HOME\.claude\settings.json"
# Only after operator approval and verified backups/ACLs:
node .\native\windows\claude_complete_memory_profiles.mjs seed --identity-map C:\Private\claude-agent-map.json --memory-config C:\Private\memory.json --settings "$HOME\.claude\settings.json" --ledger C:\Private\agent-profiles-ledger.json --apply
```

The `seed` command **requires** `--ledger` pointing to an approved
user-writable private data file, not a system installation directory.
Read-only commands may use the legacy default ledger path. No automatic service install or credential
creation is attempted. Seed creates or updates the ledger only when necessary.

## Remaining acceptance after all eight live charter readbacks

1. Separate parent-session proxy routing requires explicit provider consent,
   authenticated model roundtrip, ordinary-session capture, persistence and
   recall from a **different** Claude Code session using
   `scripts/acceptance-ordinary-session.mjs`. Static proxy settings cannot
   establish these facts.
2. Ghost requires an independently isolated identity and negative cross-scope
   readback, never a delegated profile.
3. RepoQL documentation indexing and exact-revision independent readback
   must be established separately from Tencent conversation charter storage.
4. The official RepoQL plugin must install, discover all 17 upstream skills,
   and connect to the pinned native `rql.exe` 1.7.18 on the real Code tab.
5. Native Rust binaries, GUI behavior, Office service, reboot, rollback and
   uninstall require Windows acceptance.

Offline tests use a fake `fetch` service, never production keys or network;
source and CI receipts remain `releaseReady:false`.
