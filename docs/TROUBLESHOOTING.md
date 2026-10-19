# Troubleshooting

Work through the section that matches the symptom. Commands assume the
repository root as the working directory unless stated otherwise.

## Memory stack

Use `scripts/start-memory-stack.sh` rather than invoking the byte-exact
`memory/upstream/start-all.sh` directly. The wrapper filters key-shaped output
and verifies `auth/verify` `data.valid=true`; upstream HTTP 200 alone is not
proof that a user key is valid.

**A container exits or restarts immediately**

```bash
docker ps -a | grep tdai-
docker logs tdai-memory-core --tail 100
cd memory/upstream && ./verify.sh
```

Common causes: port already in use (`8420`, `8125`, `8424`, `8096`), a
`REPLACE_ME` value left in `memory/upstream/.env`, or an LLM endpoint the
container cannot reach (see below).

**LLM endpoint works from the host but not from containers**

Containers resolve the host as `host.docker.internal` on Docker Desktop; on
Linux add it explicitly, e.g. run the affected container with
`--add-host host.docker.internal:host-gateway` (compose:
`extra_hosts: ["host.docker.internal:host-gateway"]`), or use the host's LAN
address in `MEMORY_LLM_BASE_URL` / `PROXY_UPSTREAM_URL`.

**Extraction stalls or times out**

Check the memory-group LLM first: `./verify.sh` re-probes it. A hung provider
call is bounded per task and fails over only if a router is configured — the
optional [`../compose/extraction-failover.compose.yml`](../compose/extraction-failover.compose.yml)
ladder adds transient-failure retries across multiple provider accounts.

**Panel login problems**

The admin key lives in `memory/upstream/.admin-key`. Prefer creating a
business user in the Panel and using that key for agents; the admin key is for
administration.

**Knowledge service errors**

`KNOWLEDGE_PUBLIC_BASE_URL` must include the `/v3` suffix and be reachable
from the memory-hub container (default uses `host.docker.internal`).

## OpenChamber + plugin

**The UI does not open**

The compose file binds `127.0.0.1:3127` on purpose. Check
`docker logs singularity-openchamber`. `OPENCHAMBER_UI_PASSWORD` must be set
(add it to `secrets/openchamber.env` or export it) or compose refuses to
start the service. OpenChamber and Office images run as UID:GID 1000:1000;
`scripts/start.sh` pre-creates their bind-mount directories and verifies write
and execute access for that container identity so the Docker daemon does not
create root-owned directories on first start.

If logs show `EACCES` creating `.config/openchamber/run` or SQLite reports
`unable to open database file`, inspect only the product data directories:

```bash
stat -c '%u:%g %a %n' data/openchamber data/opencode/share data/opencode/state data/opencode/config data/ssh data/office workspaces
```

If a failed first Compose run created these paths as root, repair ownership
only after confirming the target directories are the product mounts and the
stack processes use UID:GID 1000:1000:

```bash
sudo chown -R 1000:1000 data/openchamber data/opencode/share data/opencode/state data/opencode/config data/ssh data/office workspaces
scripts/start.sh
```

Do not use `chmod 777`; preserve the 0600 modes on files under
`data/opencode/config/product-secrets/`. On Windows, keep these directories on
the WSL2 Linux filesystem, not DrvFs.

**Plugin channel says `not-configured` or `invalid-endpoint`**

- `not-configured`: the config file is missing — run
  `python3 scripts/provision-secrets.py`; paths are
  `data/opencode/config/product-secrets/{memory,office}.json` (override with
  `SINGULARITY_MEMORY_CONFIG` / `SINGULARITY_OFFICE_CONFIG`).
- `invalid-endpoint`: the JSON exists but its URL fails host/port validation.
  Memory must be `http://memory-core:8420`; Office must be
  `http://product-office:8000/api/v1/events` (full path, not just the base).
- Re-check that files are mode 0600 and parse as JSON.

**A chat was not captured (or does not appear in the Office)**

The plugin only ingests sessions whose directory lies under the capture
roots — default the OpenChamber home (`/home/openchamber`). Chats opened
outside the roots are skipped by design; extend with
`SINGULARITY_MEMORY_ROOTS` (comma-separated absolute prefixes).

**Memory capture works, Office does not (or vice versa)**

The channels are independent. For Office: is the container up
(`docker logs singularity-office`)? Does `CLAUDE_OFFICE_ALLOW_CIDR` include
the product network range? Does `office.json` hold the ingest key that
matches `secrets/claude-office.env`?

**`memory/status` reports degraded**

The plugin could not reach Memory Core. Check the network alias:
`docker network inspect singularity-product-net | grep -A2 memory-core`, then
re-run `scripts/start.sh` to re-attach it. Also confirm the gateway key in
`memory.json` matches `MEMORY_CORE_GATEWAY_API_KEY` in the stack's `.env`
(both empty is the default and correct for local use).

**Plugin not loaded at all**

Confirm the layout exactly: `data/opencode/config/plugins/product-office/`
with `index.js` at its root, and `data/opencode/config/package.json`
(`{"type":"module"}`) present. OpenCode installs the `opencode-dcp` plugin
from its config list on first start — it needs network access to npm.

## Composition and compose

**Compose rejects `singularity-product-net` because of a network label**

The product network is deliberately created by `scripts/start.sh` and shared
with the separately-defined Office compose project. Both product compose files
must declare it `external: true`. Use the repository's current compose files
and rerun `scripts/start.sh`; do not delete a network that contains the
memory-core attachment.

**Compose can't find volume/network `tdai-…`**

The optional compose files reference the memory stack's network and volume as
external. Start the memory stack first with `scripts/start-memory-stack.sh`.

**Validate before/after edits**

```bash
OPENCHAMBER_UI_PASSWORD=x docker compose -f compose/compose.yml config -q
docker compose -f office/office.compose.yml config -q
docker compose -f compose/extraction-failover.compose.yml config -q
```

Run compose from the repository root: the compose files resolve their
relative paths against their own directory.

## Validators

- `tests/validate-local.sh` — static checks, no containers needed. If the
  reference scan flags a hit, fix the text (or narrow the pattern in
  `tests/forbidden-refs.txt` after review — never delete a pattern silently).
- `tests/validate-memory-loop.sh` — needs the stack running and plugin
  secrets provisioned; it writes a marked unit, searches it back, and
  round-trips a knowledge promotion.

## Still stuck

Each upstream component keeps its own documentation: TencentDB Agent Memory
(the memory stack), OpenChamber, and Claude Office all publish their own
docs — when a question is about one of those internals, their docs are the
source of truth.
