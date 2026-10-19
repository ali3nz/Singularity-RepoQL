# Third-party notices

Singularity's original code and documentation are MIT-licensed (see `LICENSE`).
The components below keep their own licenses and copyrights; upstream files are
not relicensed by this repository.

| Component | What Singularity uses | Treatment |
|---|---|---|
| [TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory) | Memory core / hub / proxy stack; the `memory/upstream/` quickstart is vendored byte-exact from tag `v2.0.2` (commit `99a1a2c`) | MIT, copyright (C) 2026 Tencent. Upstream `LICENSE` shipped verbatim in `memory/upstream/LICENSE`. Note: some upstream documents (e.g. `README.docker.md`) contain wording that reads as proprietary; the repository's root license is MIT and is preserved here as-is. |
| [RepoQL](https://github.com/RepoQL/RepoQL) | Code-intelligence host and MCP server the OpenChamber bundle connects to; **not vendored** — installed and licensed separately by the user | Commercial product; its own [Customer Terms and Software Licence](https://repoql.com/terms/2026-09-11/) apply. Not relicensed by this repository. |
| [OpenChamber](https://github.com/openchamber/openchamber) | Workspace UI the memory plugin integrates with; **not vendored** — installed separately from upstream | MIT. See `docs/OPENCHAMBER-SETUP.md`. |
| [Claude Office](https://github.com/paulrobello/claude-office) | Optional activity visualizer; **not vendored** — built separately from the upstream project (a fork carries the Focus/seating updates used by the reference deployment) | MIT, copyright Paul Robello. Preserve the upstream license when building the image. |
| [OpenCode](https://opencode.ai) | Agent runtime the OpenChamber image embeds (CLI installed inside the image) | MIT. |
| [OpenCode DCP](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning) (`@tarquinen/opencode-dcp`) | Context-pruning plugin referenced by `openchamber/opencode.jsonc`; installed separately as an npm plugin | AGPL-3.0-or-later. It is a separately installed dependency — review its license before redistributing modifications. |
| Docker images pulled at runtime | `agentmemory/memory-core`, `agentmemory/memory-hub`, `agentmemory/memory-proxy`, `node:22-slim`, `oven/bun` base for the OpenChamber build | Referenced, not redistributed. Each image carries its own notices. |

If you redistribute Singularity, keep this file and the upstream license texts
that come with the components you redistribute (notably
`memory/upstream/LICENSE`).
