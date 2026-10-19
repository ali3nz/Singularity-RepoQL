# product-office plugin

One OpenChamber plugin, two responsibilities, both optional at runtime:

1. **Memory capture (core).** On completed sessions the plugin reconciles the
   session's conversation into Memory Core (`/v3/conversation/…`), using the
   read → reconcile → write → verify pattern. Only sessions under the capture
   roots are ingested (see Capture roots). Requires `memory.json`.
2. **Office events (optional).** Session and tool lifecycle events are queued
   to plugin storage and POSTed to Claude Office with dedup markers; the same capture roots gate
   which sessions appear. Requires
   `office.json`.

If a config file is missing, that channel reports `not-configured` and stays
off; if it holds an invalid endpoint, `invalid-endpoint`. The plugin never
throws on missing configuration, and it never sends traffic anywhere except
the validated in-network endpoints:

- memory: `http://memory-core:8420` (host and port pinned)
- office: `http://product-office:8000` (host and port pinned)

## Configuration

| File (default) | Env override | Shape |
|---|---|---|
| `/home/openchamber/.config/opencode/product-secrets/memory.json` | `SINGULARITY_MEMORY_CONFIG` | `{"baseUrl":"http://memory-core:8420","authPrefix":"Bearer ","gatewayKey":"","serviceId":"openchamber","userKey":"sk-mem-…"}` |
| `/home/openchamber/.config/opencode/product-secrets/office.json` | `SINGULARITY_OFFICE_CONFIG` | `{"endpoint":"http://product-office:8000/api/v1/events","ingestKey":"…"}` |

Generate both with [`../../scripts/provision-secrets.py`](../../scripts/provision-secrets.py)
and keep them mode 0600.

### Capture roots

Both channels ingest sessions whose directory lies under the capture roots.
Default: the OpenChamber home (`/home/openchamber`), covering the default
project and `workspaces/`. Override with `SINGULARITY_MEMORY_ROOTS`
(comma-separated absolute prefixes; blank entries, `/`, and non-absolute
entries are ignored). Sessions outside every root are skipped.

## Files

| File | Role |
|---|---|
| `index.js` | plugin entrypoint (`id: product.office-events`) |
| `memory-reconcile.js` | scope derivation + conversation reconcile/verify |
| `office-events.js` | OpenCode event → Office event mapping |
| `office-transport.js` | deduplicated queue flush with sent markers |
| `native-contract.js` | helpers for the native OpenCode client/storage envelope |
| `*.test.mjs` | unit tests (`node --test`) |

## Tests

```bash
node --test openchamber/plugins/product-office/*.test.mjs
```

## Install

Copy this directory into the instance's OpenCode config `plugins/` directory —
see [`../../../docs/OPENCHAMBER-SETUP.md`](../../../docs/OPENCHAMBER-SETUP.md).
