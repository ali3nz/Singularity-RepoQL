# Ghost — Persistent Companion Agent That Dreams (Optional Add-On)

Ghost is an optional persistent AI companion agent for OpenChamber and the Singularity-RepoQL stack. Unlike stateless task workers, Ghost maintains a three-tier persistent memory layout, can be invoked either interactively in OpenChamber or headlessly for scheduled wakes, and runs a daily **checkpointed six-step dream cycle** (`experiences -> related -> patterns -> evolution -> consolidate -> summary`) that reflects on recent sessions and commits provenance-stamped conclusions to its own git-backed memory directory.

> **Privacy & Clean-Slate Guarantee:** This bundle ships **only** the Ghost runtime scripts, OpenChamber agent profile, Compose/systemd templates, and blank seed files (`ghost/seed/`). It contains **zero** personal memories, conversation transcripts, or live system state.

---

## Architecture

1. **OpenChamber Agent Profile (`openchamber/agents/ghost.md`)**
   - Registers `ghost` as a primary OpenChamber agent with full read/write/bash/RepoQL/task capabilities and startup instructions to consult its local digest and long-term memory.
2. **Three-Tier Memory Helper (`ghost/ghost-memory.mjs`)**
   - Unified CLI for reading and recording across three memory layers:
     - **Tier 1 (Experiential):** Memory Stack `/v1/memories` (Memory Core).
     - **Tier 2 (Authoritative):** RepoQL `rql` queries and concepts.
     - **Tier 3 (Personal Reflection):** Local markdown files in `data/ghost/memory/` (`persona.md`, `MEMORY.md`) and `data/ghost/current-state/digest.md`.
3. **Checkpointed Daily Dream Engine (`ghost/dream.mjs`)**
   - Runs a 6-step reflection pipeline:
     1. `experiences` — extracts meaningful events from recent conversations and the current knowledge pack.
     2. `related` — links new experiences to existing reflection files and notes what still holds vs. what changed.
     3. `patterns` — identifies recurring patterns, successful strategies, and contradictions (weaken, revise, or abandon).
     4. `evolution` — tracks shifting goals, workflow understanding, and self-improvement notes.
     5. `consolidate` — proposes up to 3 high-signal long-term conclusions (`<= 300` chars each) in strict JSON, verifies path confinement (`assertOwnMemfs`), appends them with date + confidence provenance to `data/ghost/memory/MEMORY.md`, and commits the change to the local git repository in `data/ghost/memory/`.
     6. `summary` — writes a human-readable daily dream journal to `data/ghost/dreams/YYYY-MM-DD.md`.
   - **Checkpointed & bounded:** Each step is saved to `data/ghost/dreams/.state.json`. If a model provider times out or hits a rate limit, the next run resumes from the unfinished step. Capped at 1 dream/day and 25 minutes total runtime by default.
4. **Headless OpenChamber Turn Runner (`ghost/ghost-turn.mjs`)**
   - Creates a fresh OpenChamber session, posts a scheduled wake or maintenance prompt to the `ghost` agent, polls until completion, and outputs structured JSON (`status`, `sessionId`, `durationSec`, `reply`).
5. **OpenChamber Turn Gateway (`ghost/ghost-gateway.mjs`, HOST-side)**
   - Optional OpenAI-compatible endpoint (`127.0.0.1:18003/v1/chat/completions`)
     that executes each request as ONE bounded turn of the Ghost agent on the
     OpenChamber (opencode) runtime. Every turn shells out to `docker exec`,
     so the gateway must run on the HOST (e.g. via `ghost/systemd/ghost-gateway.service`)
     or inside a container that you yourself give a docker CLI + socket — it is
     never granted container privileges by default and `ghost.compose.yml`
     does not run it. If docker is not available to its process, the gateway
     stays up, reports `execAvailable:false`, `/models` still works, and turn
     requests are rejected with a clear configuration error (no crash).
   - `/healthz` exposes live counters (`requests/completed/failed/rejected`,
     inflight queue). The older documented `GHOST_MODELS` allowlist and
     `ghost_calls.jsonl`/`ghost_usage.json` telemetry files were never part of
     this implementation.

---

## Configure and Run (Optional Add-On)

1. **Initialize clean-slate directories and `secrets/ghost.env`** (from the repository root):

   ```bash
   bash ghost/setup-ghost.sh
   # or via the secret provisioner:
   python3 scripts/provision-secrets.py --with-ghost
   ```

   This creates `data/ghost/{memory,dreams,conversations,current-state}`, copies blank seed files (`persona.md`, `MEMORY.md`, `digest.md`), initializes a local git repository in `data/ghost/memory/`, copies `openchamber/agents/ghost.md` into `data/opencode/config/agents/` when present, and writes `secrets/ghost.env` (mode 0600).

2. **Start Ghost** (from the repository root):

   ```bash
   scripts/start.sh
   # or directly:
   docker compose -f ghost/ghost.compose.yml up -d
   ```

   When `secrets/ghost.env` exists, `scripts/start.sh` automatically starts
   `singularity-ghost-dream` on the `singularity-product-net` network. The
   dream daemon calls the Memory Stack LLM proxy (`proxy:8096`) directly by
   default; set `GHOST_DREAM_GATEWAY_URL` to override. To run the
   reflect-against-Ghost-agent lanes, start the gateway on the host:

   ```bash
   node ghost/ghost-gateway.mjs        # binds 127.0.0.1:18003
   # or: cp ghost/systemd/* /etc/systemd/system/ && systemctl enable --now ghost-gateway
   ```

   Full walkthrough: [`../docs/GHOST-SETUP.md`](../docs/GHOST-SETUP.md).

---

## Manual Usage

```bash
# Check Ghost memory stats in MemoryCore
node ghost/ghost-memory.mjs stats

# Recall memories for a topic
node ghost/ghost-memory.mjs recall "deployment rollback checklist"

# Record a standalone note in MemoryCore
node ghost/ghost-memory.mjs remember --role assistant --text "Prefer explicit healthcheck polling before marking a service ready"

# Run a daily dream cycle against the memory proxy or any OpenAI-compatible endpoint
GATEWAY_URL=http://127.0.0.1:8096/openai/default/v1 node ghost/dream.mjs --agent ghost --agent-dir data/ghost --force

# Run a headless OpenChamber turn as Ghost
OPENCHAMBER_URL=http://127.0.0.1:3127 node ghost/ghost-turn.mjs --slot daily-review "Summarize today's open tasks and update digest.md"
```
