# Ghost setup — persistent companion agent that dreams (part of installation options 2 and 4)

Ghost is a persistent AI companion agent bundled into installation options 2
and 4 of the Singularity-RepoQL stack. Unlike stateless task workers, Ghost maintains a
three-tier persistent memory layout, can be driven interactively in OpenChamber
or headlessly for scheduled wakes, and runs a daily **checkpointed six-step
dream cycle** (`experiences -> related -> patterns -> evolution -> consolidate -> summary`)
that reflects on recent conversations and commits provenance-stamped conclusions
into its own git-backed memory directory.

It is not part of installation options 1 and 3, and it cannot be deselected in
options 2 and 4. Memory capture, RepoQL, and OpenChamber work the same either
way — `scripts/start.sh` skips Ghost when `secrets/ghost.env` is
absent, which is the normal state for option 3.

> **Privacy & Clean-Slate Guarantee:** This repository ships **only** the Ghost
> runtime scripts, OpenChamber agent profile (`openchamber/agents/ghost.md`),
> Compose/systemd templates, and blank seed files (`ghost/seed/`). Zero
> personal memories, conversation transcripts, or live system state are
> included.

## 1. Initialize clean-slate Ghost state (option 4)

From the repository root:

```bash
bash ghost/setup-ghost.sh
# or via the secret provisioner:
python3 scripts/provision-secrets.py --with-ghost
```

What this does (idempotent — existing user reflection files are never
overwritten):

1. Creates `data/ghost/{memory,dreams,conversations,current-state}`.
2. Copies blank seed files from `ghost/seed/` (`persona.md`, `MEMORY.md`,
   `digest.md`) when absent and initializes a local git repository inside
   `data/ghost/memory/`.
3. Copies `openchamber/agents/ghost.md` into `data/opencode/config/agents/`
   when the OpenChamber config directory is present.
4. Writes `secrets/ghost.env` (mode 0600) with default settings so
   `scripts/start.sh` knows to start the Ghost services.

## 2. Start Ghost (Docker Compose or host systemd)

### Option A — Docker Compose (via `scripts/start.sh`)

Once `secrets/ghost.env` exists, `scripts/start.sh` starts
`ghost/ghost.compose.yml` automatically alongside OpenChamber and Claude
Office:

```bash
scripts/start.sh
# or directly:
docker compose -f ghost/ghost.compose.yml up -d
docker logs singularity-ghost-dream --tail 30
```

This starts one container on `singularity-product-net`:
- `singularity-ghost-dream` — background runner that checks hourly whether
  today's dream journal (`data/ghost/dreams/YYYY-MM-DD.md`) is due and runs the
  checkpointed 6-step dream cycle once per day. In compose, the dream
  dispatcher talks OpenAI-compatible HTTP directly to the Memory Stack's LLM
  proxy (`proxy:8096`), reported via
  `GHOST_DREAM_GATEWAY_URL` (default `http://proxy:8096/openai/default/v1`).
- **The docker-exec model gateway deliberately does NOT run in a container.**
  `ghost/ghost-gateway.mjs` launches each turn with `docker exec` against the
  OpenChamber container, so it requires the host's docker CLI. It runs on the
  host (Option B below) or in a docker-CLI-enabled container that YOU mount a
  docker socket into — an explicit operator action, never a default. Its
  `/healthz` reports `execAvailable:false` and it cleanly rejects turns with a
  configuration error when docker is not available to its process.

### Option B — Host systemd units (gateway + dream timer)

Copy the unit templates from `ghost/systemd/` into `/etc/systemd/system/` (edit
`/opt/singularity-repoql` paths to your checkout), run
`systemctl daemon-reload`, and enable `ghost-gateway.service` and
`ghost-dream.timer`. The host gateway binds loopback `127.0.0.1:18003`; the
host dream timer runs `dream.mjs` against it (edit `GATEWAY_URL` in
`ghost-dream.service` to match, the unit default already points there).

## 3. How the three-tier memory and dream cycle work

- **Tier 1 — Experiential Memory (Memory Stack):** `node ghost/ghost-memory.mjs recall "<query>"`
  and `remember --role assistant --text "<text>"` talk to the Memory Core `/v3/` API.
- **Tier 2 — Authoritative Code & Knowledge (RepoQL):** `rql` queries and
  concepts over MCP or CLI.
- **Tier 3 — Personal Reflection (`data/ghost/memory/`):** `persona.md`,
  `MEMORY.md`, and `data/ghost/current-state/digest.md`.

During the daily dream cycle (`node ghost/dream.mjs --agent ghost --agent-dir data/ghost`),
the job deterministically collects recent conversation excerpts and current
reflection files, passes them as quoted data through six bounded prompts,
validates any proposed `MEMORY.md` entries against path-traversal and
cross-agent guards (`assertOwnMemfs`), appends up to 3 provenance-stamped
conclusions, commits them to `data/ghost/memory/.git`, and writes the daily
dream journal to `data/ghost/dreams/YYYY-MM-DD.md`.

## 4. Verify

```bash
# 1. Check Ghost memory stats in MemoryCore
node ghost/ghost-memory.mjs stats

# 2. Run the Ghost dream unit test suite
node --test ghost/dream.test.mjs

# 3. Trigger an immediate dream cycle (dream talks to the memory proxy in
#    compose, or to the host gateway at 127.0.0.1:18003/v1 if you run one)
GATEWAY_URL=http://127.0.0.1:18003/v1 node ghost/dream.mjs --agent ghost --agent-dir data/ghost --force
```
