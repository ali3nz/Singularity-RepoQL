# Memory setup — fresh system walkthrough

This is the complete walkthrough from a bare machine to a working, self-learning
memory system. Budget ~30 minutes plus image downloads.

## Prerequisites

- Linux or macOS with Docker Engine 24+ and Compose v2 (Windows via WSL2 is
  experimental — see [`platforms/windows.md`](platforms/windows.md)).
- ~12 GB free disk for images and volumes.
- At least one LLM provider key with an OpenAI-compatible or
  Anthropic-compatible endpoint. Two configurations are requested during
  setup (memory group and proxy group); the same provider can serve both.

## 1. Start the memory stack

```bash
git clone https://github.com/ali3nz/Singularity-RepoQL
cd Singularity/memory/upstream
./verify.sh --skip-llm     # optional dry-run: docker, bash and prereq checks
./start-all.sh
```

`start-all.sh`:

1. copies `upstream/.env.example` → `upstream/.env` (first run only),
2. walks you through the **memory group** (LLM used for extraction and
   summarization) and the **proxy group** (the upstream LLM your agent's
   requests are forwarded to), verifying each endpoint answers before saving,
3. starts memory-core → memory-hub → proxy on the `tdai-memory-stack` network,
4. prints the Panel URLs and generates the admin user key into
   `upstream/.admin-key` (`sk-mem-…`).

Non-interactive option: copy `../.env.example` to `upstream/.env`, fill it in,
then run `./start-all.sh` — it still confirms each group; press Enter to keep.

Defaults: Core `8420` · Panel `8125` · Knowledge `8424` · Proxy `8096`.

## 2. Verify

```bash
./verify.sh                  # re-runs environment + endpoint checks
docker ps | grep tdai-       # three containers, healthy
docker logs tdai-memory-core --tail 50
```

## 3. First login and scoping

Open the Panel at `http://127.0.0.1:8125` and log in with the admin
credentials; the generated admin key is in `memory/upstream/.admin-key` (also
printed by `start-all.sh` on first run).

1. Create a **Team**.
2. Create a **business user** inside the team.
3. Use that user's key for day-to-day agent traffic instead of the admin key —
   scopes (`team_id`, `user_id`, `agent_id`) keep memory isolated per
   workspace/person/agent.

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
cd ../..                      # repository root
python3 scripts/provision-secrets.py    # plugin credentials (used by validators + OpenChamber)
tests/validate-memory-loop.sh
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
./start-all.sh
```

Restore is the same in reverse: stop the stack, extract the archives back into
the volumes, start again. (Live-snapshotting SQLite while the stack runs is not
covered here; stop first for a guaranteed-consistent copy.)

## Upgrade, restart policy, uninstall

- Upgrade images: `PULL=1 ./start-all.sh`; pin explicit tags in `.env` for
  reproducibility.
- The upstream scripts create containers without a restart policy. For reboot
  resilience: `docker update --restart unless-stopped tdai-memory-core tdai-memory-hub tdai-proxy`.
- Uninstall: `./stop-all.sh --purge` removes containers and volumes. Back up
  first — this deletes your memory.

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
