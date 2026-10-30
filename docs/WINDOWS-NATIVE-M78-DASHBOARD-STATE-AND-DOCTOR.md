# Milestone 78: dashboard state preservation and truthful doctor output

**Scope:** source-only improvement to Claude Code Complete. Native Windows runtime acceptance remains BLOCKED.

## Fixed behavior

- `dashboard/server.py` no longer interprets an existing corrupt/unreadable `exclusions.json` as an empty list. This prevents a subsequent add/remove from erasing previously recorded exclusions due to a parser failure. Unknown or malformed ledger state now fails closed. An actually absent ledger is still an empty list.
- Writes refuse symlinked ledger files and an existing `exclusions.json.tmp` from an interrupted write. Pending state is preserved for review instead of overwritten, and new pending data is flushed before rename. The source does not yet prove native Windows power-loss durability; the filesystem and live app must be tested.
- Root `README.md` no longer hardcodes an outdated source checkpoint; use the packaged milestone pointer and receipt.
- `scripts/doctor.mjs` does not claim the dashboard is VERIFIED just because a directory exists. A plain file or symlink is not accepted as dashboard directory evidence. When the directory exists, the state is CONFIGURED, and login/listener/connector health are specifically NOT verified.
- The general RepoQL doctor uses the same bounded version parser as the Option 2 project MCP integration, accepts `1.7.18` (and pinned banner), rejects an unpinned/ambiguous response, and never labels a bare version reply as full operational verification. A pinned version is CONFIGURED until functional readbacks are independently checked.

## Narrow offline verification

- Python: `PYTHONPATH=dashboard:. python -m unittest dashboard.test_exclusion_store_contract -q` (6 focused tests)
- Node: `node --test --test-name-pattern=dashboard scripts/doctor.test.mjs` (2 focused tests)
- Node: `node --test native/windows/configure_project_mcp.test.mjs` (20 focused tests; shared version parser)

## Windows acceptance still required

- Run dashboard with real RepoQL 1.7.18 and genuine StateDir ACL; confirm malformed exclusion state blocks writes and preserves bytes.
- Confirm the dashboard task, authenticated browser, MemoryCore/Kanzo panels, RepoQL index and MCP activity.
- Compare actual boot/restart/rollback behavior and staged source with this source revision. No publisher-signature, Windows Rust build, or GUI acceptance is claimed here.

**Release: BLOCKED.**
