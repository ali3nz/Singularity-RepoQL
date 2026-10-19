#!/usr/bin/env bash
# Start the Singularity product stack.
#
# Prerequisites:
#   1. memory stack running:   cd memory/upstream && ./start-all.sh
#   2. plugin secrets:         python3 scripts/provision-secrets.py
#
# What this script does, in order (idempotent):
#   1. sanity-check Docker and the memory stack
#   2. create the product network when missing
#   3. attach the memory core to it under the alias `memory-core`
#   3b. mount the rql binary into OpenChamber when RepoQL is present
#   4. start OpenChamber (compose/compose.yml) when a UI password is available
#   5. start Claude Office (office/office.compose.yml) when its env file exists
#   6. print the readiness table
#
# Run from the repository root:  scripts/start.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
NET="${SINGULARITY_NETWORK:-singularity-product-net}"
MEMORY_CONTAINER="${MEMORY_CORE_CONTAINER:-tdai-memory-core}"

log()  { printf '%s [start] %s\n' "$(date -u +%FT%TZ)" "$*"; }
fail() { log "FAILED: $*"; exit 1; }

command -v docker >/dev/null 2>&1 || fail "docker not found on PATH"

# ── 1. memory stack ──────────────────────────────────────────────────────────
docker inspect "$MEMORY_CONTAINER" >/dev/null 2>&1 \
  || fail "$MEMORY_CONTAINER not found — run memory/upstream/start-all.sh first"

# ── 2. product network ───────────────────────────────────────────────────────
if ! docker network inspect "$NET" >/dev/null 2>&1; then
  log "creating network $NET"
  docker network create "$NET" >/dev/null
fi

# ── 3. memory-core alias on the product network ──────────────────────────────
aliases="$(docker inspect "$MEMORY_CONTAINER" \
  --format "{{range \$k,\$v := .NetworkSettings.Networks}}{{if eq \$k \"$NET\"}}{{range \$v.Aliases}}{{.}} {{end}}{{end}}{{end}}")"
if [[ " $aliases " == *" memory-core "* ]]; then
  log "alias memory-core already present on $NET"
else
  docker network disconnect "$NET" "$MEMORY_CONTAINER" >/dev/null 2>&1 || true
  docker network connect --alias memory-core "$NET" "$MEMORY_CONTAINER"
  log "attached $MEMORY_CONTAINER to $NET as memory-core"
fi

if [[ ! -f "$ROOT/data/opencode/config/product-secrets/memory.json" ]]; then
  log "note: plugin secrets not provisioned yet — run python3 scripts/provision-secrets.py"
fi

# ── 3b. RepoQL (optional) ────────────────────────────────────────────────────
REPOQL_COMPOSE=()
if [[ -n "${REPOQL_RQL_PATH:-}" ]]; then
  # An explicitly set path must resolve to an executable file: Docker would
  # silently create a directory where a bind source is missing.
  REPOQL_RQL_PATH="$(readlink -f -- "$REPOQL_RQL_PATH" 2>/dev/null || true)"
  if [[ -n "$REPOQL_RQL_PATH" && -f "$REPOQL_RQL_PATH" && -x "$REPOQL_RQL_PATH" ]]; then
    APPLY=1
  else
    fail "REPOQL_RQL_PATH is set but does not resolve to an executable file — unset it or fix the path"
  fi
elif [[ -e "$HOME/.local/bin/rql" ]]; then
  REPOQL_RQL_PATH="$(readlink -f -- "$HOME/.local/bin/rql" 2>/dev/null || true)"
  if [[ -n "$REPOQL_RQL_PATH" && -f "$REPOQL_RQL_PATH" && -x "$REPOQL_RQL_PATH" ]]; then
    APPLY=1
  else
    APPLY=0
    log "found $HOME/.local/bin/rql but it does not resolve to an executable file — skipping the rql mount"
  fi
else
  APPLY=0
  log "RepoQL not detected — skipping the rql mount (see docs/REPOQL-SETUP.md)"
fi
if [[ "${APPLY:-0}" == 1 ]]; then
  mkdir -p "$ROOT/data/repoql"
  export REPOQL_RQL_PATH
  REPOQL_COMPOSE=(-f "$ROOT/compose/repoql.override.yml")
  log "RepoQL enabled ($REPOQL_RQL_PATH) — the rql binary will be mounted into OpenChamber"
fi

# ── 4. OpenChamber ───────────────────────────────────────────────────────────
if [[ -z "${OPENCHAMBER_UI_PASSWORD:-}" && -f "$ROOT/secrets/openchamber.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT/secrets/openchamber.env"
  set +a
fi
if [[ -n "${OPENCHAMBER_UI_PASSWORD:-}" ]]; then
  docker compose -f "$ROOT/compose/compose.yml" ${REPOQL_COMPOSE[@]+"${REPOQL_COMPOSE[@]}"} up -d
else
  log "skipping OpenChamber: set OPENCHAMBER_UI_PASSWORD or create secrets/openchamber.env"
fi

# ── 5. Claude Office (optional) ──────────────────────────────────────────────
if [[ -f "$ROOT/secrets/claude-office.env" ]]; then
  docker compose -f "$ROOT/office/office.compose.yml" up -d
else
  log "skipping Claude Office: secrets/claude-office.env missing (run scripts/provision-secrets.py)"
fi

# ── 6. readiness ─────────────────────────────────────────────────────────────
log "readiness:"
docker ps --format '{{.Names}}\t{{.Status}}' | grep -E 'tdai-|singularity-' || true
log "done"
