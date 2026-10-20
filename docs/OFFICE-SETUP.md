# Office setup — activity visualizer (part of installation options 2 and 4)

Claude Office turns agent activity into a live pixel-art office: sessions are
bosses, subagents are employees, and tool calls, waits and completions animate
as work happens. It ships with installation options 2 and 4; memory works
without it, and the plugin
reports the Office channel as `not-configured` when it is absent (the normal
state for options 1 and 3).

## 1. Build the image

The reference deployment builds from the public fork
[`ali3nz/claude-office`](https://github.com/ali3nz/claude-office) (fork of
[`paulrobello/claude-office`](https://github.com/paulrobello/claude-office),
MIT), which carries the Focus/seating and idle-sweep updates used here.
Upstream alone also works; the co-ordinates differ.

```bash
git clone https://github.com/ali3nz/claude-office
cd claude-office
git checkout 1fce512        # optional: the validated revision
docker build -t claude-office:local .
```

## 2. Provision keys and start

From the repository root:

```bash
python3 scripts/provision-secrets.py
docker compose -f office/office.compose.yml up -d
docker logs singularity-office --tail 30
```

The backend listens on `127.0.0.1:3128` (loopback only) and joins the
`singularity-product-net` network under the alias `product-office`. The
provisioner wrote `secrets/claude-office.env` (API key + ingest key) and
`data/opencode/config/product-secrets/office.json` for the plugin.

Open `http://127.0.0.1:3128`. The API key is delivered through the `?token=`
launch URL described in the upstream project's docs; the scene renders once
the app has loaded. Fresh installations open on the bundled default
arrangement; edits publish over it (newest wins).

## 3. Feed it

- **OpenChamber sessions** — automatic. With the plugin installed and
  `office.json` present, session/tool lifecycle events are queued and POSTed
  to the Office ingest endpoint (with dedup markers, so restarts never
  double-post).
- **Claude Code** — via the harness adapter
  ([`../adapters/claude-code/`](../adapters/claude-code/)): merge
  `settings-snippet.json` into `~/.claude/settings.json`, point
  `OFFICE_CONFIG` (or `OFFICE_ENDPOINT` + `OFFICE_INGEST_KEY`) at your
  instance, and every session appears as `Claude Code <last-8>`.

Events carry whitelisted metadata only — prompts, assistant text and tool
input/output are never forwarded.

## 4. Verify

1. Start a session that uses at least one tool.
2. The session should appear in the scene and animate tool activity.
3. If nothing appears: `docker logs singularity-office`, then check the
   channel state (below).

## Operations and caveats

- `CLAUDE_OFFICE_ALLOW_CIDR` (default `127.0.0.0/8,172.16.0.0/12`) gates the
  ingest API. The product-network range must stay included or the plugin
  cannot deliver events.
- Data (SQLite) lives in `./data/office` — include it in backups.
- Rollback: before upgrading, `docker tag claude-office:local
  claude-office:pre-upgrade`; to revert, point `CLAUDE_OFFICE_IMAGE` at the
  old tag and re-run `docker compose up -d`.
- Failure isolation: Office down ⇒ plugin shows the Office channel
  `invalid-endpoint`/degraded; memory capture and recall are unaffected.
