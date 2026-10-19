# Ghost setup — persistent companion agent that dreams (optional)

Ghost is an optional persistent AI companion agent for OpenChamber and the
Singularity-RepoQL stack. Unlike stateless task workers, Ghost maintains a
three-tier persistent memory layout, can be driven interactively in OpenChamber
or headlessly for scheduled wakes, and runs a daily **checkpointed six-step
dream cycle** (`experiences -> related -> patterns -> evolution -> consolidate -> summary`)
that reflects on recent conversations and commits provenance-stamped conclusions
into its own git-backed memory directory.

It is optional — memory capture, RepoQL, OpenChamber, and Claude Office work
without it, and `scripts/start.sh` skips Ghost when `secrets/ghost.env` is
absent.

> **Privacy & Clean-Slate Guarantee:** This repository ships **only** the Ghost
> runtime scripts, OpenChamber agent profile (`openchamber/agents/ghost.md`),
> Compose/systemd templates, and blank seed files (`ghost/seed/`). Zero
> personal memories, conversation transcripts, or live system state are
> included.

## 1. Initialize clean-slate Ghost state and enable the add-on

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
docker logs singularity-ghost-gateway --tail 30
```

This starts two lightweight Node containers on `singularity-product-net`:
- `singularity-ghost-gateway` (`127.0.0.1:18003` loopback) — OpenAI-compatible
  model allowlist gateway that forwards to the Memory Stack proxy and records
  call telemetry in `data/ghost/ghost_calls.jsonl` and
  `data/ghost/ghost_usage.json`.
- `singularity-ghost-dream` — background runner that checks hourly whether
  today's dream journal (`data/ghost/dreams/YYYY-MM-DD.md`) is due and runs the
  checkpointed 6-step dream cycle once per day.

### Option B — Host systemd timer

If you prefer running the dream cycle directly on a Linux host without a
background container, copy the unit templates from `ghost/systemd/` into
`/etc/systemd/system/`, run `systemctl daemon-reload`, and enable
`ghost-gateway.service` and `ghost-dream.timer`.

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

# 3. Trigger an immediate dream cycle (when the gateway/proxy is running)
GATEWAY_URL=http://127.0.0.1:18003/v1 node ghost/dream.mjs --agent ghost --agent-dir data/ghost --force
```
