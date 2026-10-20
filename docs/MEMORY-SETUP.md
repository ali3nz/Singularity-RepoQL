# Memory setup — fresh system walkthrough

This is the complete walkthrough from a bare machine to a working, self-learning
memory system. Budget ~30 minutes plus image downloads.

## Prerequisites

- Linux or macOS with Docker Engine 24+ and Compose v2 (Windows via WSL2 is
  experimental — see [`platforms/windows.md`](platforms/windows.md)).
- ~12 GB free disk for images and volumes.
- An OpenAI-compatible or Anthropic-compatible endpoint for memory
  extraction and proxy traffic. A local model server is valid if WSL2 and the
  containers can reach it; endpoint success proves transport, not output
  quality. Two configurations are requested and may use the same provider.

## 1. Start the memory stack

```bash
git clone https://github.com/ali3nz/Singularity-RepoQL
cd Singularity-RepoQL
(cd memory/upstream && ./verify.sh --skip-llm)
scripts/start-memory-stack.sh
(cd memory/upstream && ./verify.sh)
```

The wrapper invokes the vendored upstream setup interactively: it copies
`.env.example` on first run, confirms the memory and proxy LLM groups, and
starts memory-core → memory-hub → proxy on `tdai-memory-stack`. It filters
startup output and validates the key with the API's `data.valid` field. The
admin key is saved in `memory/upstream/.admin-key` with mode 0600 and is not
printed. Do not invoke the byte-exact upstream `start-all.sh` directly; it
prints the key and treats any HTTP 200 auth/verify response as success.

For non-interactive setup, fill `memory/upstream/.env` first, then run
`scripts/start-memory-stack.sh`; the upstream setup still confirms each group
and Enter keeps the saved values.

Defaults: Core `8420` · Panel `8125` · Knowledge `8424` · Proxy `8096`.

## 2. Verify

```bash
(cd memory/upstream && ./verify.sh)  # re-runs environment + endpoint checks
docker ps | grep tdai-               # three containers, healthy
docker logs tdai-memory-core --tail 50
```

## 3. First login and scoping

Open the Panel at `http://127.0.0.1:8125` and log in with the admin
credentials. The generated admin key is in `memory/upstream/.admin-key`; the
safe wrapper does not print it. Keep the file private and use a business-user
key for routine agent traffic.

1. Create a **Team**.
2. Create a **business user** inside the team.
3. Use that user's key for day-to-day agent traffic instead of the admin key —
   scopes (`team_id`, `user_id`, `agent_id`) keep memory isolated per
   workspace/person/agent.
4. Wire the plugin to that key: `python3 scripts/provision-secrets.py --memory-user-key <the key>`
   (or set `MEMORY_USER_KEY` in the environment). The provisioner never
   defaults the plugin to the admin key; `--allow-admin-plugin-key` exists
   only as an explicit, temporary bring-up fallback.
5. Loopback boundary: `scripts/start-memory-stack.sh` refuses to finish while
   any `tdai-*` port is published on the wildcard interface (override ONLY with
   `SINGULARITY_ALLOW_WIDE_MEMORY_PORTS=1`), because the quickstart upstream
   publishes on all host interfaces by default.

## 4. Point your harness at the proxy

Claude Code (persist in `~/.claude/settings.json`):

```json
{ "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8096/claude-code/default",
    "ANTHROPIC_AUTH_TOKEN": "<your user key — sk-mem-…>",
    "ANTHROPIC_MODEL": "<your upstream model>" } }
```

Other harnesses follow the same pattern (Anthropic- or OpenAI-compatible base
URL pointing at the proxy). The proxy passes requests upstream, captures the
conversation, and injects relevant memory back on session start.

## 5. Prove the loop

```bash
python3 scripts/provision-secrets.py    # plugin credentials (used by validators + OpenChamber)
bash tests/validate-memory-loop.sh
```

`validate-memory-loop.sh` runs real API calls against your running stack:
conversation add → search → knowledge propose/promote/index. Then do the
human check: chat with your agent about a distinctive topic, watch the session
appear in the Panel, and in a later session ask about it — the recall should
carry the earlier context. Details of the loop itself:
[`MEMORY-LOOP.md`](MEMORY-LOOP.md).

## Backup and restore

The data lives in two Docker volumes. Simplest consistent snapshot — stop the
stack first:

```bash
cd memory/upstream
./stop-all.sh
docker run --rm -v tdai-memory-core-data:/data -v "$PWD/../../backups":/backup \
  alpine tar czf /backup/memory-core-$(date +%F).tgz -C /data .
docker run --rm -v tdai-panel-data:/data -v "$PWD/../../backups":/backup \
  alpine tar czf /backup/memory-panel-$(date +%F).tgz -C /data .
cd ../..
scripts/start-memory-stack.sh
```

Restore is the same in reverse: stop the stack, extract the archives back into
the volumes, then run `scripts/start-memory-stack.sh`. (Live-snapshotting SQLite while the stack runs is not
covered here; stop first for a guaranteed-consistent copy.)

## Upgrade, restart policy, uninstall

- Upgrade images: from the repository root run
  `PULL=1 scripts/start-memory-stack.sh`; pin explicit tags in `.env` for
  reproducibility.
- The upstream scripts create containers without a restart policy. For reboot
  resilience: `docker update --restart unless-stopped tdai-memory-core tdai-memory-hub tdai-proxy`.
- Uninstall: `./stop-all.sh --purge` removes containers and volumes. Back up
  first — this deletes your memory.

## Agent profiles (MemoryCore)

Every shipped OpenChamber agent in `openchamber/agents/` gets its own
persistent MemoryCore profile, the same way Ghost has one: a
`team_id` / `user_id` / `agent_id` scope (`agent_id` = the agent name) plus one
seeded charter record stating its role. `scripts/start.sh` runs this step
automatically when `data/opencode/config/product-secrets/memory.json` exists;
it is non-fatal and bounded (`timeout 120`), so a MemoryCore that is still
warming up or stalled cannot block or indefinitely delay startup.

```bash
node scripts/setup-agent-profiles.mjs --dry-run   # plan only, no network
node scripts/setup-agent-profiles.mjs             # seed missing profiles
```

- Idempotent: seeded profiles are recorded in `data/agent-profiles/ledger.json`
  and skipped on re-run. Only failed agents are retried. The ledger is saved
  after every success, so an interrupted run does not re-seed finished agents.
- Re-seed after a MemoryCore reset or purge: the ledger is the source of truth
  and survives `./stop-all.sh --purge`. Delete `data/agent-profiles/ledger.json`
  and re-run the script. A corrupt ledger makes the script fail loudly rather
  than re-seed everything silently.
- Scope note: the runtime `product-office` plugin captures and recalls under its
  own project scope (`project-<hash>`, agent `build`). These per-agent profiles
  are separate identities for explicit recall (`POST /v3/conversation/search`
  with the agent's scope); the plugin does not read them automatically.
- Claude Code note: seeding a profile alone does NOT wire a runtime to it.
  For Claude Code, `node scripts/install-claude-code.mjs` closes that gap: it
  installs native `singularity-*` subagent definitions, merges SubagentStart
  (bounded recall from the agent's OWN profile) and SubagentStop (one bounded
  redacted lesson capture per finished agent through the reconciled write
  path) hooks, and binds the Claude Code names to the SAME identities recorded
  here — one logical agent, one identity across OpenChamber and Claude Code.
  Details and verification: [`CLAUDE-CODE-SETUP.md`](CLAUDE-CODE-SETUP.md).
- Ghost is excluded: it keeps its own `ghost-companion` profile (see
  [GHOST-SETUP.md](GHOST-SETUP.md)); a second `ghost` scope would conflict.
- Defaults: team `openchamber-agents`, user from the memory config
  (`pilot-operator` when unset). Override with `AGENT_PROFILE_TEAM` and
  `AGENT_PROFILE_USER`.
- Verify: the script prints `seeded` / `present` / `failed` per agent and
  exits 1 if any failed. Recall one agent's profile with
  `POST /v3/conversation/search` using its scope.
- Troubleshoot: `no-service-key` means the memory config lacks a key; a
  MemoryCore `code` other than 0 is shown in the `failed` line.
- Tested: unit tests with a faked MemoryCore (`node --test scripts/setup-agent-profiles.test.mjs`).
  NOT verified against a live MemoryCore in this change.

## Configuration reference

Every variable is documented in [`../memory/.env.example`](../memory/.env.example)
(English, same names as the upstream template in `upstream/.env.example`).
The ones worth knowing early:

| Variable | Meaning |
|---|---|
| `MEMORY_PROMPT_MODE` | `code` (engineering/team memory) or `chat` (personal/episodic) |
| `KNOWLEDGE_PUBLIC_BASE_URL` | how memory-hub reaches the knowledge service; must include `/v3` |
| `MEMORY_CORE_GATEWAY_API_KEY` | empty = local zero-config; see caveats in the template |
| `KNOWLEDGE_SERVICE_KEY` | auto-generated when left empty |

### Binding to an existing MemoryCore (identity map)

Set `AGENT_PROFILE_IDENTITY_MAP=<path>` to a JSON file shaped `{"agents": {"<agent>": {"team_id": "...", "user_id": "...", "agent_id": "..."}}}`. Each agent is then bound to its mapped identity. The seeder first searches that identity: if a stored message already exists, the profile is recorded as `verified` (ledger `source: existing`) and nothing is written. Only a missing charter is seeded. Agents absent from the map fail with `no identity in map`. `AGENT_PROFILE_TEAM` and `AGENT_PROFILE_USER` are ignored in this mode. Use this to point the variant at a MemoryCore that already holds these roles, so charters are not duplicated.

Verification rule: a search hit counts as a charter only when it is this agent's own (the seeder session `agent-profile-<name>`, or the roster wording `OpenChamber agent role '<name>'` / `OpenChamber agent "<name>"`). Other stored messages under the identity do not count. A stored record is reused only when team, user and agent id all match.

Live result (2026-10-20, shared MemoryCore): the seeder ran inside the memory container with its own service endpoint and key, against the eight roles mapped from the identity snapshot. All eight charters were verified (`source: existing`) and nothing was written.
