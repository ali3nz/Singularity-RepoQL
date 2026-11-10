# Dashboard setup

The Singularity dashboard is a **portable projection of the operator's live
RepoQL dashboard**: the same read-only control surface, static UI and panel
integrations, with every fleet-specific host, path, identity, token and endpoint
replaced by configuration. It answers "what is my RepoQL host doing, what is
indexed, and what do the attached panels report?" — it never indexes, re-derives
or duplicates a second knowledge store.

It is **not** a replacement for the operator's deployment and **not** a fifth
installation option. The four numbered product options are unchanged. This is an
optional service you can run beside an existing RepoQL installation.

## What you need

| Requirement | Detail |
| --- | --- |
| Python | 3.11 or newer; standard library only. PyJWT is imported lazily and only for optional Cloudflare Access verification. |
| RepoQL runtime | A user-installed `rql` CLI and a workspace it serves. The supported connector runtime for this export is **1.7.18**; setup does not upgrade it. |
| Node (optional) | Only to run `tests/dashboard-portable.test.mjs` and the static JS checks. |
| Attached panels (optional) | Kanzo, Tencent MemoryPanel and Claude Office are **separate programs**. Nothing here installs, starts or bundles them. |

The dashboard binds `127.0.0.1:18100` by default and authenticates every API
call with a generated capability token. You do not need Cloudflare or a public
hostname to use it.

## Quick start (host)

```sh
# from the repository root
python3 dashboard/server.py link       # prints the capability link and creates the token
python3 dashboard/server.py check      # one bridge probe: verdict, phase, pid
python3 dashboard/server.py serve      # foreground; Ctrl-C to stop
```

`link` writes `<state_dir>/token` with mode `0600` on first use and prints a URL
with the capability in the fragment (`#k=...`). The fragment never reaches the
server or its logs. Open the printed link; the browser stores it for that tab.

To use a JSON file instead of environment variables:

```sh
cp dashboard/config.example.json dashboard/config.json
# edit workspace, rql, state_dir, bind, port
python3 dashboard/server.py --config dashboard/config.json serve
```

`config.json` is **not** part of this export and should not be committed. Keep it
and the runtime directory outside the shipped tree.

## Configuration

Environment variables win over the JSON file, which wins over neutral defaults.
`RQLDASH_*` names are accepted as legacy aliases.

| Variable | Default | Purpose |
| --- | --- | --- |
| `SINGULARITY_WORKSPACE` | `$HOME` | Existing RepoQL workspace passed as the CLI working directory. |
| `SINGULARITY_RQL_BIN` | `rql` | Path or name of the installed RepoQL CLI. |
| `SINGULARITY_STATE_DIR` | `~/.local/state/singularity-dashboard` | Token, CPU samples, exclusions, telemetry. Must be writable and outside this tree. |
| `SINGULARITY_BIND` | `127.0.0.1` | Listener address. Loopback is the safe default. |
| `SINGULARITY_PORT` | `18100` | Listener port. |
| `SINGULARITY_ALLOW_PEERS` | `127.0.0.1/32,::1/128` | Comma-separated CIDRs accepted at TCP accept time. Anything else is dropped without a response. |
| `SINGULARITY_SAMPLE_INTERVAL` | `30` | CPU sampler interval (collector). |
| `SINGULARITY_CPU_RETENTION_DAYS` | `30` | CPU sample retention. |
| `SINGULARITY_PUBLIC_URL` | empty | Optional public URL shown by `link`; does not enable Access by itself. |
| `SINGULARITY_ACCESS_TEAM` / `SINGULARITY_ACCESS_AUD` | empty | Optional Cloudflare Access team domain and audience **of your own** Access application. |
| `SINGULARITY_TENCENT_HOST` / `_PORT` | `127.0.0.1:8125` | Fixed loopback upstream for the Tencent panel. |
| `SINGULARITY_TENCENT_OWNER_KEY_FILE` | empty | Server-side key file. Empty means the panel reports *unconfigured*. |
| `TENCENT_PANEL_BASE` / `TENCENT_SKILL_GATEWAY_BASE` | empty | Loopback bases for the Tencent API proxy. |
| `SINGULARITY_OFFICE_HOST` / `_PORT` | `127.0.0.1:8001` | Office health probe and proxy upstream. |
| `CLAUDE_OFFICE_PUBLIC_URL` / `CLAUDE_OFFICE_EMBED_URL` | empty | Optional public Office URL and its embed launch URL. |
| `SINGULARITY_KANZO_HOST` / `_PORT` | `127.0.0.1:4242` | Fixed loopback upstream for the unmodified Kanzo board. |
| `SINGULARITY_AGENTCHAT_STATE_DIR` | `$STATE_DIR/agentchat` | Read-only agentchat inbox directory. |
| `SINGULARITY_OPENCHAMBER_SUMMARY_FILE` | empty | Optional OpenChamber usage summary JSON. |
| `SINGULARITY_FREEBUCKS_STATUS_MODULE` | empty | Optional Freebuff allowance helper module. |
| `SINGULARITY_HARNESS_DATA_DIR` | `$STATE_DIR/harness` | Harness telemetry inputs; user-owned, outside this tree. |
| `HARNESS_RUNS_DIR` / `HARNESS_HUB_DIR` / `HARNESS_AUDIT_LOG` | under the harness data dir | Optional existing harness ledgers to read. |
| `RUST_HARNESS_URL` / `RUST_HARNESS_TOKEN_FILE` | `http://127.0.0.1:7879`, empty | Optional coordinator read model (loopback only). |
| `UNIFIED_SERVICE_BASE` / `UNIFIED_GATEWAY_TOKEN_FILE` | `http://127.0.0.1:18101`, empty | Optional unified data plane (loopback only). |

See `.env.example` for a copy-ready file with these names and synthetic values.

## Panels and truthful states

Every page renders one of three honest states; none is faked:

| Panel | Healthy | Unconfigured | Failure |
| --- | --- | --- | --- |
| RepoQL host, index, files, knowledge, links, CPU, errors | Data from the `rql` CLI | — | `502` with the upstream error; the rest of the UI stays usable |
| Native RepoQL Control Panel (`/embed/repoql/`) | `rql dashboard --url` issues a login and the same-origin proxy serves it | `native_repoql_proxy_unconfigured` | `official_repoql_login_issuance_failed` |
| Tencent panel (`/embed/tencent/`) | Proxy reaches the configured loopback service with the key | `tencent_panel_unconfigured`, no key read | `502 tencent_upstream_unavailable` |
| Office (`/embed/office/`, `/api/harness/office`) | Health probe returns `status: ok` | No public/embed URL configured | `available: false` with the measured reason |
| Kanzo board (`/embed/kanzo/`) | `/api/ping` answers `kanzo` before a session cookie is issued | — | `503 local_kanzo_unavailable`; `/mcp` is always `403 kanzo_mcp_is_local_only` |
| Harness Control Center | Configured run ledgers produce events | Empty, bounded dataset | Panel reports `available: false` per source |
| Agentchat feed | Configured inbox directory | `Agent Chat state directory unavailable` | Empty feed, never fabricated messages |
| Unified graph / coordinator | Loopback service plus gateway token | `available: false, not_configured` | `available: false` with the error code |

The static UI keeps the operator's current look: Diagnostics tabs (CPU, errors,
indexing and health), Repository management inside **Indexing**, and graph labels
that appear on click rather than on hover. UI labels for Kanzo and agentchat are
part of that surface and are intentional.

## Security model

- **Loopback by default.** `127.0.0.1` plus an `allow_peers` CIDR gate. A peer
  outside the list is dropped without a response, so binding wider is not the
  same as publishing wider.
- **Generated, scoped capability token.** `<state_dir>/token`, `0600`, compared
  in constant time (`hmac.compare_digest`). No admin key, MemoryCore key or
  fleet credential is used by the dashboard.
- **Same-origin mutations.** State-changing API calls require the dashboard
  `Origin`, a bearer token (or a verified Access JWT), and the
  `X-Requested-With: repoql-dashboard` header. Cross-site forms and images cannot
  set that header.
- **HttpOnly, SameSite cookies** are used only for panel handshakes, scoped to
  the panel path, `Max-Age` bounded, and marked `Secure` when the request is
  HTTPS or Access-verified.
- **Fixed upstream allowlist.** Panel proxies accept only the three configured
  names (`tencent`, `office`, `kanzo`) on loopback. No request-supplied URL is
  ever dialled, which prevents SSRF. Kanzo's `/mcp` endpoint is blocked at the
  proxy.
- **Kanzo is unauthenticated by design.** Keep it on loopback. Never publish
  port 4242, `/mcp`, or an unauthenticated board to a LAN or the internet; this
  dashboard does not add authentication to Kanzo's own surface.
- **No auto-update, no outbound telemetry.** The dashboard does not phone home,
  check for updates, or send usage anywhere. Optional panel and Access calls go
  only to the endpoints you configure.
- **Optional Cloudflare Access.** If you front it with your own Access
  application, set your team domain and audience. There is no built-in tenant,
  operator email list or audience; a bare `Cf-Access-Authenticated-User-Email`
  header is ignored as spoofable.
- **State stays out of the tree.** Tokens, SQLite samples, exclusions and
  harness telemetry live in `SINGULARITY_STATE_DIR`, not in `dashboard/`.

## Docker Compose

`dashboard/docker-compose.yml` runs only the dashboard, with a memory limit,
CPU quota, PID limit, `read_only`, dropped capabilities, log rotation and
`restart: unless-stopped`. It publishes on `127.0.0.1:18100` only.

```sh
cd dashboard
cp .env.example .env                 # edit for your install
docker compose up -d
```

Two honest caveats:

1. The template does **not** start a second RepoQL or OpenChamber host.
2. A container often cannot see a host-installed `rql` client or its Unix
   socket. Container-mode RepoQL access depends on your installation (mount the
   CLI and its runtime read-only, or run the dashboard on the host). The compose
   file does not assume either; test `python3 dashboard/server.py check` inside
   your chosen environment before relying on it.

`env_file` uses the `required: false` form; use Compose 2.24 or newer.

## Validate

```sh
node --test tests/dashboard-portable.test.mjs   # portability + synthetic fixture integration
git diff --check
```

The Node test compiles every Python module without writing bytecode, scans the
shipped tree for fleet-private identifiers, checks the loopback/capability
defaults, and starts the server against a synthetic fixture to prove: static
serving, token authentication, same-origin mutation refusal, truthful
"unconfigured" panel responses, and the Kanzo `/mcp` block. It does not prove a
real RepoQL host, a real Kanzo/Tencent/Office deployment or browser
rendering.

## Provenance and licence

The projection is derived from the product's private `repoql-dashboard` source
(revision `0018622`, plus deployed working-tree modules), and distributed here
under the repository's MIT licence. Per-file source
and export hashes, the modified-module list and unresolved licence questions are
in `dashboard/PROVENANCE.md` and `dashboard/THIRD-PARTY-NOTICES.md`. Third-party
programs are integrated as separate processes and are not redistributed.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| "Fresh dashboard link required" | Run `python3 dashboard/server.py link`; the token lives in `<state_dir>/token`. |
| `502` on overview | `python3 dashboard/server.py check`; confirm `SINGULARITY_RQL_BIN` and that the workspace is the one RepoQL serves. |
| Panel says unconfigured | That is truthful: set the panel's host/port and credential file, or leave it off. |
| Kanzo page unavailable | Kanzo must be running and bound to the configured loopback host/port; `/api/ping` must return `kanzo`. |
| Board is reachable from another machine | Stop and fix: Kanzo has no authentication. Bind it to loopback and keep `SINGULARITY_ALLOW_PEERS` narrow. |
| Access redirect loop | Set both `SINGULARITY_ACCESS_TEAM` and `SINGULARITY_ACCESS_AUD` for your own application, install PyJWT, and restart. |
