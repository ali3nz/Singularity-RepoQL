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
