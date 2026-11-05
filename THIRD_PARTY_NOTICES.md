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
| [Kanzo](https://github.com/emanuele-em/kanzo) | Work-item tracker read by the RepoQL Kanzo connector; **not bundled and never modified** — it runs as its own separate process and the connector only calls its API | AGPL-3.0-only, upstream `v0.1.3` (commit `986f0fac5fb46f9d8c8422deeec66069aa9bc002`). Source pointer: the upstream repository tarball for that tag. Because it is an unmodified separate program that this repository merely talks to over its API, we treat it as an aggregate rather than a combined work — see the AGPL note below. |
| [Singularity plugin and skill bundles](openchamber/plugins) | The OpenChamber plugins and `openchamber/skills/*` shipped here are this repository's own work | MIT, same as the rest of this repository. |
| Tencent MemoryCore derivative patches (`memory/patches/`) | Two patch series over TencentDB Agent Memory `v2.0.2` (commit `99a1a2c`) | MIT, derived from the Tencent MIT source. `memory/patches/*/PROVENANCE.md` records the base/head hashes and what each patch changes. |
| Docker images pulled at runtime | `agentmemory/memory-core`, `agentmemory/memory-hub`, `agentmemory/memory-proxy`, `node:22-slim`, `oven/bun` base for the OpenChamber build | Referenced, not redistributed. Each image carries its own notices. |

If you redistribute Singularity, keep this file and the upstream license texts
that come with the components you redistribute (notably
`memory/upstream/LICENSE`).

## Notes on specific components

- **Kanzo (AGPL-3.0-only).** Kanzo is *not* bundled, *not* vendored and *not*
  modified. The connector reads it through the API of a separately running
  process, which is why we treat the two as an aggregate. **Whether an AGPL
  combined-work obligation could attach to a deployment that ships both is
  unresolved**; if you redistribute Singularity together with Kanzo, review
  AGPL-3.0 §13 yourself and offer the corresponding source of Kanzo as that
  licence requires.
- **RepoQL engine (`rql`).** The engine is a commercial product, installed by
  the user under the RepoQL Customer Terms and Software Licence of
  **2026-09-11** (see §3.5 for the licence grant/restrictions). The licence
  excludes certain territories (**EEA, UK and Switzerland**, §1.6); this
  repository neither bundles nor redistributes `rql`.
- **RepoQL plugin/skills.** Singularity's own plugin and skill bundles are MIT.
  RepoQL itself is referenced, never redistributed.
- **OpenCode DCP.** `@tarquinen/opencode-dcp` is AGPL-3.0-or-later and is an
  externally installed npm plugin, neither bundled nor modified here.
- **Claude Office.** Built from the MIT-licensed upstream project; the
  reference deployment pins the fork commit `95d8bdc5728b23bcf0fee4c371b35e071c44f642`
  (`office/PROVENANCE.md`). Preserve the upstream licence when you build it.
- **Tencent MemoryCore.** MIT. The vendored upstream quickstart stays
  byte-exact; `memory/patches/` carries only clearly-attributed derivative
  patches.
- **Unaffiliated.** This project is not affiliated with, endorsed by or
  sponsored by Tencent, RepoQL, OpenChamber, OpenCode, Anthropic, Kanzo or
  Claude Office; their names are used only to describe interoperability.
- **Windows.** The only Windows configuration tested for this release is
  **WSL2 with a POSIX shell and Node 22** for the harness launcher. Native
  `cmd`/PowerShell is not a supported shell for `bin/ai-orchestra`; the Docker
  stack assumes a Linux host with Docker Compose.

## Licence texts

The full GNU Affero General Public License v3 text for the AGPL components named above (Kanzo and, separately, OpenCode DCP) is included at [	hird-party/AGPL-3.0-only.txt](third-party/AGPL-3.0-only.txt). Kanzo itself is not bundled or modified; the text is included so a deployment that combines the two can satisfy AGPL-3.0 section 13.

