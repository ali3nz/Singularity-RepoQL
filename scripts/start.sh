#!/usr/bin/env bash
# Start the Singularity product stack.
#
# Prerequisites:
#   1. memory stack running:   scripts/start-memory-stack.sh
#   2. plugin secrets:         python3 scripts/provision-secrets.py
#
# What this script does, in order (idempotent):
#   1. sanity-check Docker and the memory stack
#   1b. pre-create writable bind-mount directories for the UID-1000 apps
#   2. create the external product network when missing
#   3. attach the memory core to it under the alias `memory-core`
#   3b. mount the rql binary into OpenChamber when RepoQL is present
#   4. start OpenChamber (compose/compose.yml) when a UI password is available
#   5. start Claude Office (office/office.compose.yml) when its env file exists
#   5b. start Ghost (ghost/ghost.compose.yml) when secrets/ghost.env exists
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
  || fail "$MEMORY_CONTAINER not found — run scripts/start-memory-stack.sh first"

# ── 1b. bind-mount directories ────────────────────────────────────────────────
# Create these as the invoking WSL/Linux user before Compose can create them as
# root. Check access for the OpenChamber and Office UID:GID, not just the caller.
container_uid_can_write() {
  local path="$1" owner group mode relevant
  owner="$(stat -c %u -- "$path")" || return 1
  group="$(stat -c %g -- "$path")" || return 1
  mode="$(stat -c %a -- "$path")" || return 1
  mode="${mode: -3}"
  if [[ "$owner" == 1000 ]]; then
    relevant="${mode:0:1}"
  elif [[ "$group" == 1000 ]]; then
    relevant="${mode:1:1}"
  else
    relevant="${mode:2:1}"
  fi
  (( (8#$relevant & 3) == 3 ))
}
for dir in \
  "$ROOT/data/openchamber" \
  "$ROOT/data/opencode/share" \
  "$ROOT/data/opencode/state" \
  "$ROOT/data/opencode/config" \
  "$ROOT/data/ssh" \
  "$ROOT/data/office" \
  "$ROOT/data/ghost" \
  "$ROOT/workspaces"; do
  mkdir -p "$dir"
  container_uid_can_write "$dir" \
    || fail "bind-mount path is not writable by container UID:GID 1000:1000: $dir (fix the directory owner/mode or run as the matching WSL/Linux user)"
done

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

# ── 5b. Ghost — persistent agent that dreams (optional) ──────────────────────
if [[ -f "$ROOT/secrets/ghost.env" ]]; then
  bash "$ROOT/ghost/setup-ghost.sh"
  docker compose -f "$ROOT/ghost/ghost.compose.yml" up -d
else
  log "skipping Ghost: secrets/ghost.env missing (run bash ghost/setup-ghost.sh or python3 scripts/provision-secrets.py --with-ghost)"
fi

# ── 6. readiness ─────────────────────────────────────────────────────────────
log "readiness:"
docker ps --format '{{.Names}}\t{{.Status}}' | grep -E 'tdai-|singularity-' || true
log "done"
