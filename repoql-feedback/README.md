# RepoQL feedback collection

Every suspected RepoQL fault, limitation or undocumented behaviour must be separately reproduced and attributed before it is reported as a RepoQL defect. Use [TEMPLATE.md](TEMPLATE.md). Separate a problem in Singularity Harness, Tencent MemoryCore, Windows paths, authentication or user configuration from a problem in RepoQL itself. Never include credentials, user data or private repository content. A failed test or incomplete integration should be reported as unverified until the actual upstream component is tested.

## Delivery status

Delivery is via the RepoQL `feedback` command (needs a signed-in RepoQL account and a running host). A report is **SENT** only when that command returned a receipt.

| Report | Status | Notes |
| --- | --- | --- |
| [2026-11-10-session0-host-blocks-interactive-host.md](2026-11-10-session0-host-blocks-interactive-host.md) | **NOT SENT** (2026-11-10) | `feedback` returned "Not authenticated"; `account whoami` reports not logged in. Send after `rql account login`, then change this row to SENT with the date. |
