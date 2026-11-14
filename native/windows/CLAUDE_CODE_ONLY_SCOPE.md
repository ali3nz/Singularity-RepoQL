# Windows Singularity: one full Claude Code installation

Only one installation profile is supported: **Claude Code Full**. The internal numeric
source profile is `2` solely to preserve existing staging and receipt compatibility.
No lean option or other agent GUI is supported.

The full product includes the Kanzo connector, Tencent MemoryCore integration,
RepoQL and its MCP integration, the dashboard, Claude Office and OpenMaus bots.
It does not include Ghost or OpenChamber. Upstream third party components are
integrated, not rewritten as first party Rust code.

Source-only distribution is not a deployed or accepted Windows installer.
Rust compilation, end to end behavior, native installation and rollback remain
separate acceptance gates. Historical release archives must stay outside the
product checkout.
