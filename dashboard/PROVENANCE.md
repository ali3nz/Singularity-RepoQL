# Dashboard projection provenance

This directory is a portable projection of the product's live RepoQL
dashboard. It is not a second implementation: the modules and static
assets below were exported from the running source, then edited only where
a private host, path, identity, credential or endpoint had to become
configuration. Behaviour was kept; readiness claims were made truthful.

## Source record

| Item | Value |
| --- | --- |
| Source repository | `repoql-dashboard` (private projection source; not distributed) |
| Source revision | `0018622` (deployed working tree) |
| Working-tree state at export | 34 uncommitted entries; the deployed working tree was authoritative |
| Export date | 2026-10-28 |
| Exported allowlist | 32 files: 19 Python modules plus `static/**` |
| Recorded authors | the upstream source's commit history (identities not reproduced here) |
| Licence | MIT, per the product root `LICENSE` (© 2026 Ali3nz) |

The export read the live source **read-only**. No stash, commit, checkout,
restart, service change or configuration mutation was performed on the
source host, and no runtime state (`token`, `cpu.db`, exclusions, logs,
`state/`, `unified-usage/`, `.repoql/cache/`) was copied.

## Modified for portability

| File | Change |
| --- | --- |
| `access.py` | Docstring only: no operator tenant or hostname. |
| `agentchat_feed.py` | Inbox root under the configured state directory. |
| `embed_config.py` | Tencent panel reports `configured: false` unless a credential source is configured (was unconditionally true). |
| `freebuff_allowance.py` | Allowance helper optional and env-configured; child environment inherited selectively; host label configurable. |
| `ghost_bridge.py` | Snapshot and control socket from env; absent configuration reports `unknown`/`unconfigured` instead of probing a fleet path. |
| `harness_rust.py` | Coordinator token path follows the configured state directory. |
| `harness_telemetry.py` | Harness inputs default under the configured state directory; no operator directories are named. |
| `native_panel_proxy.py` | Upstream host/port from env (fixed names only), key file from env, credential absence returns `503 *_panel_unconfigured`, WebSocket Host header follows the configured upstream. |
| `office_bridge.py` | Reachability message names the configured port, not a fleet host. |
| `repo_query_usage.py` | Default receipt path under the configured state directory. |
| `repoql_bridge.py` | Config loader accepts an absent JSON file and `SINGULARITY_*`/`RQLDASH_*` env overrides; neutral defaults (loopback, `$HOME`, state under `~/.local/state`). |
| `repoql_native_auth.py` | Login file, `rql` binary and workspace resolved from env instead of fleet paths. |
| `server.py` | Config/env-driven OpenChamber summary path; generic capability-link guidance; no fleet host names. |
| `unified_bridge.py` | Gateway token path under the configured state directory. |
| `static/app.js` | Generic signpost command; neutral host label. |
| `static/app_test.mjs` | Comment only. |
| `static/ghost/index.html` | Removed operator GitHub/WikiJS links and operator timezone label. |
| `static/index.html` | Neutral data-source wording. |
| `static/repoql_cheatsheet.js` | Neutral host wording. |
| `static/workflow_graphs.js` | Reference labels use a configured host/workspace description. |

Everything else is byte-identical to the exported source:

`collector.py`, `graph_annotations.py`, `harness_api.py`, `repoql_connectors.py`, `tencent_panel_proxy.py`, `static/app.css`, `static/ghost/api.js`, `static/ghost/dashboard.js`, `static/ghost/tasks.js`, `static/navigation_ui.js`, `static/observability.js`, `static/repoql_guidance.js`

## Rust subcomponent

The source tree also contains an optional Rust data plane. It is **not**
exported: it is a separate service with its own configuration and it is not
required for the dashboard projection to run. `harness_rust.py` talks to an
externally installed loopback coordinator and reports `not_configured` when
none is present.

## File hashes

Full SHA-256 of the exported file, with the source hash it was derived from.

| File | Source SHA-256 | Export SHA-256 |
| --- | --- | --- |
| `access.py` | `4936f8ba64f9ac123d81ab7f1548a25a84188833067b185d277e1b53e0b8e097` | `b91adf3e5432b25d4a0a0a6ddf013d2027ac1d3a03869d8b6ef3c198592b590f` |
| `agentchat_feed.py` | `2e3ecc0b2791ec741486ce6fa492c9c635ea9c3ecc386ff374a065ba6043474a` | `026ced3ad4e2d34ba44f6ca1d3987bf38f01a531aa762b37ca88ab03a7fed727` |
| `collector.py` | `117c1cd46fe82e5af2d93addc0dbcac34db00a9ccd079824737c626faae4a1c8` | `117c1cd46fe82e5af2d93addc0dbcac34db00a9ccd079824737c626faae4a1c8` |
| `embed_config.py` | `44e453397a75f4be3e263f9e8e39bf95d4bdfb82e9daca73dfa9a312e6c38a0d` | `ca2e1aefea88f0def8779ac68bb2f066d00e87ab7bd1e6928d9db27c627ab4ac` |
| `freebuff_allowance.py` | `09b3559b1d1dd6670391a5377609dccb5e399700f33eb1b3886e94f269b45acd` | `55d688007af59adcfc5a17390972db77639f9950e82c4e5c38cb5f214501d30b` |
| `ghost_bridge.py` | `819d150613dcba2d0e45227caf914af21de8460bf79f94c18bdbaad9f8556546` | `d15752278abbbc3e69b312a4adda02f0f5cee877c1a41e7c87bbe268388d4b92` |
| `graph_annotations.py` | `0ddd3aa6935b3414184957c162eccf8ff603a5c5aa84d4914fb9b03ae4de54f6` | `0ddd3aa6935b3414184957c162eccf8ff603a5c5aa84d4914fb9b03ae4de54f6` |
| `harness_api.py` | `d6f31edb01e711676b0b20bd534c1e33388c517545af23670cce7e3f59accab6` | `d6f31edb01e711676b0b20bd534c1e33388c517545af23670cce7e3f59accab6` |
| `harness_rust.py` | `1fc90b12fd15329e105c20b35c24a8de291d7f6284259cbc91654469186dcdd4` | `0ae9d45adb4bce3a36e2e0e8485f773284e01c69d16198cc0b0639cbb34b308b` |
| `harness_telemetry.py` | `91585c21c36fd866ebd3189d8246ccff0fc2f3c447b7a6f7cc4e7fb833a714bf` | `e9484ccf0a3e1919d578fcbce311ae527e6b8f293b098dec5e8f7d4b4fa0b321` |
| `native_panel_proxy.py` | `65fd8e031e919981d896486d9ec0d64f1435843a2af6de508141ab60f6294916` | `4d82b7ebd979ed1a1be5f7130c329fb45491101cc722e4be3b07be3322176377` |
| `office_bridge.py` | `b14771596bcf4367e4158c351540f91b856e6feb2f6575952deac6c6a6cd6d6f` | `d9bc660c9d3826babb0febc7441738fd6f2f31f0102d47cb2ed778ac296e54b8` |
| `repo_query_usage.py` | `cc96abd8875325bbcde83155ed9ce75a59c79826ec3c27b405cd6b0e415a4efd` | `53c491c24eacf440e47f8906b26bde1b176ba37e27bf5cd3f1459b3645f4e656` |
| `repoql_bridge.py` | `2ce7c232995672e8544de3a0df97307b7f006b46b0048b6e6dd5dc925462dd8c` | `739ef007a3b7098207f48a8a259feafb5dbfa535d5261513f5861eb2ea068325` |
| `repoql_connectors.py` | `0784b92358bd1cb68d16459b00fdbacb06a6c7a98b56b75694fb20167b14233e` | `0784b92358bd1cb68d16459b00fdbacb06a6c7a98b56b75694fb20167b14233e` |
| `repoql_native_auth.py` | `dd343da0ad61d24696fe587b6c511d9650adfab60bd90b5dd40a2121dce79ad0` | `338570d45de498da26fdf0fd5a00def99f1ed735d649eb50e5dae3da30e13233` |
| `server.py` | `dfd80486daa9898b9b3cfd1d6c989c3c1a02e113e3420055c022643e83eb790c` | `dd70c22e2dbc5a2fb6e75b86f816df691e66204949f4997ec1cd1c3f6a803496` |
| `tencent_panel_proxy.py` | `c92984cff180515008a5ccfe54968af3c6304afebbc8ac300ddcc98369361d4d` | `c92984cff180515008a5ccfe54968af3c6304afebbc8ac300ddcc98369361d4d` |
| `unified_bridge.py` | `3ce646babc93951564314caa82b9ef715ecf6a12d236ffce53e36810e88552d8` | `ba5e6a08a74dba7872a820b20f2d904943f983c19b6803ff0569846f2d8a7a13` |
| `static/app.css` | `a51822c93fb3b1b391c6f74475a17237e4c9ab8042d89a7d90bf0254f0981d6e` | `a51822c93fb3b1b391c6f74475a17237e4c9ab8042d89a7d90bf0254f0981d6e` |
| `static/app.js` | `a205867c737f520da2ae1ceb5225c506efead8bd291f9477d7b99b771eb60236` | `26c1658357abaf3d538021f6564621800e7c9257a5d75e1f4a47574f0939d723` |
| `static/app_test.mjs` | `7d480e845d822d56cb4d603486c444178c7e4ee74b6bc48aee4f6a6bbd27c8e1` | `7cc23469c9eb9ab96fdfbbe8365242d36f4fcfbba635063c779ecf6b72653cc6` |
| `static/ghost/api.js` | `c60d849637236483f74a7554a7cf32e23bdc052432d1d29ece61c1266e345dc8` | `c60d849637236483f74a7554a7cf32e23bdc052432d1d29ece61c1266e345dc8` |
| `static/ghost/dashboard.js` | `8246a422eb1f831911b4a19e7aac437efa75485e6887c67351bb75562bf19a77` | `8246a422eb1f831911b4a19e7aac437efa75485e6887c67351bb75562bf19a77` |
| `static/ghost/index.html` | `5cad149d862e3667ed92b8aef491f7e47464e86431f14b5ee127233134c4faee` | `4a5f10b1cfb5488fb649c4c145701d51061f08cb38e8ab12fcdf9eaf9a1f4910` |
| `static/ghost/tasks.js` | `f9fc3ff887cb4307909b5166f21c868509850ebd2abf94676e2b08ef99fc7ada` | `f9fc3ff887cb4307909b5166f21c868509850ebd2abf94676e2b08ef99fc7ada` |
| `static/index.html` | `b01b3ee71a137d6d685e72983940bddcf79b44ef6b02d5abbc2a45947f0eb47b` | `5c67cb686fee4914d4e699c453274ea345cd4a81b247d790850685fa6eab57f2` |
| `static/navigation_ui.js` | `49a2ea6208700cc863463366ac5f062ed68a789c2d686580e0e99275128f1006` | `49a2ea6208700cc863463366ac5f062ed68a789c2d686580e0e99275128f1006` |
| `static/observability.js` | `553c2d1769714d33882b5c4bf2cf1f9c1498e7cf5feaf92d05f53844fbca3454` | `553c2d1769714d33882b5c4bf2cf1f9c1498e7cf5feaf92d05f53844fbca3454` |
| `static/repoql_cheatsheet.js` | `30662eebf0f97b6b6d0f52d25550b44e73daeefc11a9bdc7c3b20b2b53fbef80` | `0692bd160586c964c41a6b9308a0c2094c4807fcc5cbb253c7377b0b0966ab7e` |
| `static/repoql_guidance.js` | `da2af9df03b175796f64d650137d403531af9382080187b48b624649503f58d9` | `da2af9df03b175796f64d650137d403531af9382080187b48b624649503f58d9` |
| `static/workflow_graphs.js` | `afe4a81cf6874c62b26c2e6a75a4c7188f27f88ee01a1c1592b3989eed99a9ca` | `a4aeb2bd2bd5a7159346fe334d9f24999311283f87ccba5efd26361e629beb30` |

## Unresolved licence questions

See `THIRD-PARTY-NOTICES.md`: Kanzo is an unmodified AGPL-3.0-only separate
process (not redistributed), and the RepoQL runtime, Tencent panel, Claude
Office and Ghost are external services, not bundled here.
