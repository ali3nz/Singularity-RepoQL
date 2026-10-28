# Provenance — Claude Office fork pin

| Field | Value |
|---|---|
| Deployed fork | [ali3nz/claude-office](https://github.com/ali3nz/claude-office) — fork of [paulrobello/claude-office](https://github.com/paulrobello/claude-office) |
| Upstream license | MIT |
| **Pinned revision** | `95d8bdc5728b23bcf0fee4c371b35e071c44f642` — "Reject far-future shared layout timestamps and ignore poisoned cache clocks (#807)" |
| Deployed image tag (live host) | `local/claude-office:layout-clock-20261027` |
| Container | `claude-office` |

## Why this pin

The earlier product text named `4ce0d00` as the validated revision. That is no
longer what the live deployment runs: the fork has moved through the Focus /
seating work, the idle-sweep re-arm fix and #807 in four commits, and the
running container was built from this tree.

`95d8bdc` is the tip of the fork's `main` and the commit the live image was built
from. It adds:

| File | Change |
|---|---|
| `backend/app/api/routes/layout.py` | Reject a shared-layout timestamp far in the future; poisoned cache clocks cannot win |
| `backend/tests/test_layout.py` | Regression for that rejection |
| `frontend/src/stores/officeEditStore.ts` | Ignore a far-future cache clock on the client |
| `frontend/tests/layoutTimestampCache.test.ts` | Regression for the client cache |

The fork is a *source* dependency: this repository ships the deployment, never
the application source. Nothing of `claude-office` is redistributed here.

## Deployed override

The live deployment is not quite the plain `office/office.compose.yml`: the
container is started with an extra compose override that pins the built image,

```yaml
# work/office-dashboard-visual-20261027/future-layout/clock-guard-compose.yml
services:
  claude-office:
    image: local/claude-office:layout-clock-20261027
```

and the deployment's own compose project names the container `claude-office`
(not `singularity-office`). The override is one image tag; there is no behavioural
delta in the compose files beyond that. See
[`office.deployed.override.example.yml`](office.deployed.override.example.yml)
for the portable shape of it.

## Portability contract

What the live deployment proves and the product keeps:

- **Loopback only.** `127.0.0.1:3128:8000`. There is no public host, no tunnel
  rule, and **no Cloudflare Access tenant** in the product path: the visualizer
  is a local observer, not a published service. (The live fleet also has a
  same-origin embedding experiment behind Access; that is fleet, not product,
  and is deliberately not carried here.)
- **Local auth.** `CLAUDE_OFFICE_API_KEY` + `CLAUDE_OFFICE_INGEST_KEY` from a
  `0600` env file written by `scripts/provision-secrets.py`; the launch URL
  carries the key. No external identity provider.
- **Metadata-only ingest.** Session/tool names, statuses and project names.
  Prompts, assistant text and tool I/O are never forwarded.

## What is not carried

- Layout state, user names, seating arrangements, sprites chosen by the
  operator, and the SQLite database: those are runtime state.
- The deployed image itself and its build cache.
- The Access tenant, tunnel route and DNS records of the fleet experiment.
