# Provenance — vendored upstream quickstart

- Upstream project: [TencentCloud/TencentDB-Agent-Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory)
- Revision: tag `v2.0.2`, commit `99a1a2c` — "feat: release v2.0.2"
- Source path upstream: `deploy/global-images/`
- Vendored into: `memory/upstream/`
- Local modifications: **none**. Every file is a byte-exact copy of the file at
  that revision. `LICENSE` is the repository-root license, also verbatim.
- License: MIT, Copyright (C) 2026 Tencent — see `LICENSE` in this directory.
  Note: some upstream documents (for example `README.docker.md`, not included
  here) carry proprietary-sounding wording; the repository's root license is
  MIT and is preserved as-is.

## File checksums (sha256)

| File | sha256 |
|---|---|
| `LICENSE` | `bcaf06dea1a63d27aab5633035b620e0127295583456c2a9402565ef63ecb0b0` |
| `.env.example` | `eb9f4d52cb3b0414fa069f65cd539ec144cbd6a08ac90b753d3d9099e82fe0cd` |
| `README.md` | `e97e839f88dc7c1e3e8158809f74744836b22cf0892cddddabf776fea3250cfd` |
| `_lib.sh` | `0ddd1a8abde29ca3520bfbc01a13db1e6380d73886dbea5866cc3a62b9c604f0` |
| `start-all.sh` | `f586edda5901eda28ef3788fe97f64724434be2e554c285750086d4f3d57c98e` |
| `start-all-mongo.sh` | `315ca22031152914a9124c0ea6b181d96366a97db440510ce5b06203da29024c` |
| `start-memory-core.sh` | `6087f794651db325a3e04a35c139e3c82a94ce2c9f5ffa5f9fbcac3637a65ffb` |
| `start-memory-hub.sh` | `a97f0784681e1f072367e77860b4999882f0141c88f6c5c54c5cc325c3d95bd4` |
| `start-proxy.sh` | `436b167c9ea46c07520cbb66c9e63945cc149fcffef318e306bbaf022f98e97e` |
| `stop-all.sh` | `267f16751b97c7af68653fa8843d4026196a561bd8dff8ef2c56a3bb4c52e5ed` |
| `verify.sh` | `fba5daf00890cd333307a865a2804407ab2c490fbb0318535100b14e14f1d544` |

## How Singularity uses these files

- `start-all.sh` boots memory-core → memory-hub → proxy on the Docker network
  `tdai-memory-stack` (created by the scripts if missing).
- `stop-all.sh` stops the trio (`--purge` also removes containers and volumes).
- `verify.sh` re-checks the environment and endpoints (`--skip-llm` for an
  offline check).
- An earlier change injected a `PROXY_PRICING_MODELS` block directly into
  `start-proxy.sh`, which broke the byte-exact claim above. That is fixed:
  the vendored copy of `start-proxy.sh` is byte-exact again (checksums in the
  table are re-verified), and Singularity patches **a copy** of it instead —
  run `scripts/start-proxy-product.sh` (same env and behavior as the upstream
  script, plus the client-facing model catalog from
  `scripts/proxy-pricing-block.sh`). The wrapper refuses to run if the
  vendored file ever drifts from the checksum in this document.
- Singularity's `scripts/start.sh` additionally attaches the
  `tdai-memory-core` container to the `singularity-product-net` network with
  the alias `memory-core` (the name the OpenChamber plugin resolves). This is
  done outside the vendored files, so they stay byte-exact.
