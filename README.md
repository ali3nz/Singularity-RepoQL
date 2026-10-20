# Singularity-RepoQL — agent memory and code intelligence that survive the session

Self-hosted memory for coding agents, built for integrating with what you
already run. Your agent talks to an LLM proxy; every conversation is captured
through a single-owner pipeline, an asynchronous extraction process turns it
into durable memory, later sessions receive bounded relevant context back,
verified lessons flow through automatic knowledge promotion, and material
changes are caught, documented and ingested without user commands.

This is the **RepoQL package**: it wires Tencent MemoryCore, specialised
agents, RepoQL code intelligence and — in installation options 2 and 4 — Ghost
and the Claude Office visualizer into your existing harness — Claude Code or
OpenChamber. It never installs a duplicate harness and never touches a
managed instance.

## START HERE: GIVE THIS TO YOUR AI AGENT

Paste **one** of these four briefs to your coding agent in the WSL2 terminal
where your harness and `rql` already work — the agent performs the install and
the verification. Exactly four installation options exist — no component
selectors, no alternative package combinations; Ghost and Claude Office are
automatically included in options 2 and 4 and absent from options 1 and 3;
everything beyond the four choices below is advanced configuration inside the
selected option:

1. **Claude Code + MemoryCore** — your existing Claude Code, plus MemoryCore,
   the seven specialist agents, the documentation lifecycle and RepoQL MCP.
2. **Claude Code Complete** — everything in option 1 **plus** Ghost and Claude
   Office. Both are mandatory; no selector adds or removes them.
3. **Existing OpenChamber + MemoryCore** — your existing OpenChamber, attached
   and never reinstalled, plus the same memory, agents, documentation
   lifecycle and RepoQL MCP.
4. **OpenChamber Complete** — everything in option 3 **plus** Ghost and Claude
   Office. Both are mandatory; no selector adds or removes them.

**Option 1 — Claude Code + MemoryCore:**

```text
Clone https://github.com/ali3nz/Singularity-RepoQL into your home directory.
Start the memory stack: bash scripts/start-memory-stack.sh (loopback
publishing by default; it verifies auth before proceeding). Then run
node scripts/install-claude-code.mjs install --enable-main-memory --variant 1
from the clone. This installs the seven specialised subagents with their
persistent MemoryCore identities, ordinary-session proxy routing, the
documentation hooks and RepoQL MCP against your existing Claude Code
installation — no OpenChamber, no Ghost, no Claude Office (these are not
part of option 1 and cannot be added by any selector). Verify with
node scripts/install-claude-code.mjs status --probe (expect MAIN AGENT
MEMORY: VERIFIED and INSTALL COMPLETE), then bash tests/validate-memory-loop.sh
(expect LOOP OK). Never run memory/upstream/start-all.sh directly. Report
every command, its result, and anything that deviated from the documented
behavior.
```

**Option 2 — Claude Code Complete (Ghost + Claude Office included automatically and cannot be deselected):**

```text
Clone https://github.com/ali3nz/Singularity-RepoQL into your home directory.
Start the memory stack: bash scripts/start-memory-stack.sh (loopback
publishing by default; it verifies auth before proceeding). Enable Ghost for
the claude-code backend: bash ghost/setup-ghost.sh (see docs/GHOST-SETUP.md),
then build and start Claude Office per docs/OFFICE-SETUP.md — both are
mandatory parts of option 2. Then run
node scripts/install-claude-code.mjs install --enable-main-memory --variant 2
from the clone. It installs everything from option 1 plus the Ghost gateway
check and Claude Office verification; the option gate requires BOTH to be
present and functional before it reports INSTALL COMPLETE — a missing dream
checkpoint or unreachable Office endpoint yields INSTALL INCOMPLETE (exit 5)
and nothing is forced. Verify the memory loop with
bash tests/validate-memory-loop.sh (expect LOOP OK). Follow
ghost/README.md, office/README.md exactly for the two bundled components.
Never run memory/upstream/start-all.sh directly. Report every command, its
result, and anything that deviated from the documented behavior.
```

**Option 3 — existing OpenChamber + MemoryCore (attach, never reinstall):**

```text
Clone https://github.com/ali3nz/Singularity-RepoQL into your home directory.
Have OpenChamber running already (any variant; it is reused as-is and never
reinstalled). Start the memory stack: bash scripts/start-memory-stack.sh.
Then run SINGULARITY_VARIANT=3 bash scripts/start.sh — the option number is
the one explicit input, and it detects the existing OpenChamber
(container or native ~/.config/opencode), attaches the plugin bundle with
node scripts/attach-openchamber.mjs, provisions plugin credentials with
python3 scripts/provision-secrets.py --variant 3 (Office/Ghost credentials
are refused in this option), and connects the stack to the existing container
without creating a second OpenChamber. Follow docs/OPENCHAMBER-SETUP.md and
verify: real RepoQL tool calls inside OpenChamber, memory capture of a
completed turn, later-session recall, the documentation closeout gate
(DOC_UPDATED / DOC_NOT_REQUIRED) and bash tests/validate-memory-loop.sh
(expect LOOP OK). No Ghost, no Claude Office — option 3 excludes both and
offers no selector to add them. Report every command, its result, and
anything that deviated from the documented behavior.
```

**Option 4 — OpenChamber Complete (attach, Ghost + Claude Office included automatically and cannot be deselected):**

```text
Clone https://github.com/ali3nz/Singularity-RepoQL into your home directory.
Have OpenChamber running already (it is reused as-is and never reinstalled).
Start the memory stack: bash scripts/start-memory-stack.sh. Run
bash ghost/setup-ghost.sh (the dream daemon uses the openchamber backend;
docs/GHOST-SETUP.md) with secrets/ghost.env present, and build/start Claude
Office per docs/OFFICE-SETUP.md. Then run SINGULARITY_VARIANT=4 bash scripts/start.sh — the option number is
the one explicit input — it attaches
to the existing OpenChamber, provisions plugin credentials with
python3 scripts/provision-secrets.py --variant 4 --with-ghost, and never
creates a second OpenChamber. The option gate verifies Ghost (dream
checkpoint recovery) AND Claude Office (event flow) before reporting
INSTALL COMPLETE; anything missing yields INSTALL INCOMPLETE (exit 5) with
nothing forced. Verify per docs/OPENCHAMBER-SETUP.md plus
bash tests/validate-memory-loop.sh (expect LOOP OK). Report every command,
its result, and anything that deviated from the documented behavior.
```

The installer verifies every mandatory capability of the selected option
(specialist MemoryCore profiles, memory + documentation hooks, RepoQL MCP,
normal-session routing — plus Ghost and Claude Office for options 2/4) against
live state before reporting success: a declined consent or missing component
leaves the install `INSTALL INCOMPLETE` (exit 5); nothing was forced and no
mandatory capability was ever waived. The attach options expose the same
checks without installing Claude Code:
`node scripts/install-claude-code.mjs gate --variant 3|4` (exit 0 = verified,
exit 5 = incomplete, nothing is written).

Status: **release candidate**. A partial Windows 11 + WSL2 acceptance run
passed on one machine on 2026-10-19 using the WSL-native Docker Engine: the
memory/proxy loop, Claude Code proxy smoke test, OpenChamber and Office HTTP
endpoints, and RepoQL MCP handshake. Docker Desktop WSL integration, an actual
UI RepoQL tool call, reboot resilience, and backup/restore remain unverified;
Windows support therefore remains **experimental**. See
[`docs/platforms/windows.md`](docs/platforms/windows.md).

## Requirements

- Docker Engine 24+ with Compose v2. On Windows, run one engine reachable
  from WSL2: either Docker Desktop WSL integration or a Linux Engine inside
  WSL2 (the latter was used for the acceptance runs).
- Two configured processing-provider credentials for extraction (a ladder).
  NVIDIA build, GroqCloud, Cerebras and OpenRouter all publish
  OpenAI-compatible endpoints.
- An OpenAI-compatible or Anthropic-compatible endpoint for user-visible proxy
  traffic. A local model server is valid when reachable from both WSL2 and
  the containers; successful connectivity checks do not establish model
  quality.
- RepoQL installed for this installation (`rql` — see
  [`docs/REPOQL-SETUP.md`](docs/REPOQL-SETUP.md); the OpenChamber container
  needs a Linux rql, installed in WSL2 on Windows).
- Ports: `8420` core · `8125` panel · `8424` knowledge · `8096` proxy (all
  loopback-bound by default via `scripts/start-memory-stack.sh`); `3127`
  OpenChamber · `3128` Office (loopback) · `8430` failover router when used.
- Disk: plan ≈ 6 GB headroom for options 1–2, and ≈ 12 GB only if you also
  pull OpenChamber (4.9 GB) and Office (0.6 GB) from scratch. Measured
  per-image sizes: [`docs/platforms/windows.md`](docs/platforms/windows.md).

## Sign-up — the first identity

The memory stack keeps its admin key in `memory/upstream/.admin-key` (mode
0600, never printed). Sign in to the Panel at `http://<host>:8125` with that
key, create a **Team** and a business user, and drive the harness with the
user's key — never the admin key. The full walkthrough (start the stack,
verify auth, first login, point the harness at the proxy, prove the loop,
backup and restore) is in
[`docs/MEMORY-SETUP.md`](docs/MEMORY-SETUP.md); the loop proof itself is
[`docs/MEMORY-LOOP.md`](docs/MEMORY-LOOP.md).

## Where the details live

- **Components, networks, trust boundaries, repository layout** —
  [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- **Memory stack, first login, harness routing, backup/restore** —
  [`docs/MEMORY-SETUP.md`](docs/MEMORY-SETUP.md)
- **Claude Code setup (options 1 and 2)** —
  [`docs/CLAUDE-CODE-SETUP.md`](docs/CLAUDE-CODE-SETUP.md)
- **OpenChamber attach, never reinstall (options 3 and 4)** —
  [`docs/OPENCHAMBER-SETUP.md`](docs/OPENCHAMBER-SETUP.md)
- **RepoQL MCP and `rql` installation** —
  [`docs/REPOQL-SETUP.md`](docs/REPOQL-SETUP.md)
- **Claude Office (options 2 and 4)** —
  [`docs/OFFICE-SETUP.md`](docs/OFFICE-SETUP.md) ·
  [`office/README.md`](office/README.md)
- **Ghost (options 2 and 4)** —
  [`docs/GHOST-SETUP.md`](docs/GHOST-SETUP.md) ·
  [`ghost/README.md`](ghost/README.md)
- **Documentation policy, ingestion and supersession** —
  [`docs/DOC-INGESTION.md`](docs/DOC-INGESTION.md)
- **Knowledge promotion and extraction failover** —
  [`docs/memory-capture-promotion.md`](docs/memory-capture-promotion.md) ·
  [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- **Troubleshooting** — [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md)
- **Windows/WSL2 walkthrough** —
  [`docs/platforms/windows.md`](docs/platforms/windows.md) ·
  [`INSTRUCTIONS.md`](INSTRUCTIONS.md)

## Install — give this to your agent

Use the copyable briefs in **START HERE** above: they are the four
installation options, selected with `--variant 1|2|3|4` (options 1 and 2) or
`SINGULARITY_VARIANT=3|4 bash scripts/start.sh` (options 3 and 4, which attach
to an existing OpenChamber; interactive installs offer the same numbered
menu). The option number is the ONE explicit input in both forms. There are no other installation options and no optional component
selectors: Ghost and Claude Office are automatically included in options 2
and 4 and absent from options 1 and 3; everything else (scope, team/user,
provider replacement, probes, dry runs) is advanced configuration within the
selected option. The full Windows-specific walkthrough is in
[`INSTRUCTIONS.md`](INSTRUCTIONS.md). An install refuses to report success
while a mandatory capability (profiles, routing, hooks, RepoQL MCP — or Ghost
and Office for options 2/4) is missing or unverified.

## License

MIT — see [`LICENSE`](LICENSE). Upstream components keep their own licenses;
see [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
