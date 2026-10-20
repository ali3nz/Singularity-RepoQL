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
#   3. attach the memory core (and the LLM proxy for the Ghost dream lane)
#      to it under the aliases `memory-core` / `proxy`
#   3c. find the EXISTING OpenChamber (installation options 3/4 attach and
#       never duplicate): attach the Singularity bundle into a foreign or
#       native instance via scripts/attach-openchamber.mjs, or reuse this
#       package's own compose-managed stack. A fresh singularity-openchamber
#       is NEVER created here and a whole config is never overwritten.
#   3a. seed per-agent MemoryCore profiles (non-fatal, bounded, idempotent)
#   3b. mount the rql binary into the compose-managed OpenChamber when present
#   4. compose-managed path only: start OpenChamber when a UI password exists
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

ATTACH_VARIANT="${SINGULARITY_VARIANT:-3}"
OC_MANAGED="singularity-openchamber"
MANAGED_EXISTS=0; docker inspect "$OC_MANAGED" >/dev/null 2>&1 && MANAGED_EXISTS=1
MANAGED_RUNNING="$(docker ps --format '{{.Names}}' 2>/dev/null | grep -x "$OC_MANAGED" || true)"
FOREIGN_OC="$(docker ps --format '{{.Names}} {{.Image}}' 2>/dev/null | grep -i openchamber | grep -v "singularity-openchamber" | awk '{print $1; exit}' || true)"
NATIVE_CONFIG="$HOME/.config/opencode"
MODE=""; ATTACH_CONFIG=""
if [[ -n "$FOREIGN_OC" ]]; then
  MODE="attach-container"; ATTACH_TARGET="$FOREIGN_OC"
elif [[ -d "$NATIVE_CONFIG" ]]; then
  MODE="attach-native"; ATTACH_TARGET="$NATIVE_CONFIG"
elif [[ "$MANAGED_EXISTS" == 1 ]]; then
  MODE="managed"; ATTACH_TARGET="$OC_MANAGED"
else
  fail "no existing OpenChamber found (running container or $NATIVE_CONFIG). Installation options 3/4 ATTACH to an existing OpenChamber and never install one — see docs/OPENCHAMBER-SETUP.md. Nothing was created."
fi
log "OpenChamber mode: $MODE (${ATTACH_TARGET:-${OC_MANAGED:-compose-managed default}})"

# In ALL modes the bundle is attached through the attach script: per-file
# backups, no deletions, unrelated files preserved. Provisioning runs with
# --variant so Office/Ghost credentials match the selected installation option.
# In managed mode the same script verifies the compose-managed instance's
# bundle and its rql mount; the compose `up` below (step 4) is the only piece
# that ever CREATES a container, and only then.
ATTACH_CONFIG=""
if [[ "$MODE" == attach-container ]]; then
  ATTACH_ARGS=(--container "$ATTACH_TARGET")
  docker network connect "$NET" "$ATTACH_TARGET" >/dev/null 2>&1 \
    || log "note: $ATTACH_TARGET is already on $NET (or could not be attached)"
elif [[ "$MODE" == attach-native ]]; then
  ATTACH_ARGS=(--config-dir "$NATIVE_CONFIG")
else
  ATTACH_ARGS=()
fi
if ! node "$ROOT/scripts/attach-openchamber.mjs" --variant "$ATTACH_VARIANT" "${ATTACH_ARGS[@]}"; then
  fail "attaching the Singularity bundle to the existing OpenChamber failed"
fi
# The attach script provisioned INTO the discovered config; point the
# profile seeder at THAT memory.json for this run.
if [[ "$MODE" == attach-container ]]; then
  ATTACH_CONFIG="$(node "$ROOT/scripts/attach-openchamber.mjs" --print-config --container "$ATTACH_TARGET")"
elif [[ "$MODE" == attach-native ]]; then
  ATTACH_CONFIG="$ATTACH_TARGET"
fi

# ── 3a. Agent MemoryCore profiles (non-fatal; idempotent) ────────────────────
# Gives each shipped OpenChamber agent its own persistent MemoryCore profile,
# the same way Ghost has one. Non-fatal: MemoryCore may still be warming up.
SEEDER_CONFIG="${SINGULARITY_MEMORY_CONFIG:-$ROOT/data/opencode/config/product-secrets/memory.json}"
if [[ -f "$SEEDER_CONFIG" ]]; then
  if command -v node >/dev/null 2>&1; then
    # Bounded: a stalled MemoryCore must not add minutes to every start.
    if ! SINGULARITY_MEMORY_CONFIG="$SEEDER_CONFIG" timeout 120 node "$ROOT/scripts/setup-agent-profiles.mjs"; then
      log "WARNING: agent MemoryCore profiles incomplete — fix MemoryCore, then re-run: node scripts/setup-agent-profiles.mjs"
    fi
  else
    log "WARNING: node not found — agent MemoryCore profiles not provisioned (node scripts/setup-agent-profiles.mjs)"
  fi
fi

# ── 3b'. the Ghost dream lane needs the LLM proxy resolvable by name ─────────
# ghost-dream (compose) calls GATEWAY_URL=http://proxy:8096/…; the proxy lives
# on the memory-stack network, so it is joined here under the alias `proxy`
# (add-only and reversible with `docker network disconnect`). Loopback
# publishing and every firewall boundary are unchanged by a network member.
PROXY_CONTAINER="$(docker ps --format '{{.Names}} {{.Image}}' 2>/dev/null | awk '/memory-proxy/{print $1; exit}')"
if [[ -n "$PROXY_CONTAINER" ]]; then
  net_members="$(docker network inspect "$NET" --format '{{range .Containers}}{{.Name}} {{end}}' 2>/dev/null)"
  if [[ " $net_members " != *" $PROXY_CONTAINER "* ]]; then
    docker network connect --alias proxy "$NET" "$PROXY_CONTAINER" >/dev/null 2>&1 \
      && log "attached $PROXY_CONTAINER to $NET as proxy" \
      || log "note: could not attach the proxy container to $NET — ghost-dream resolves it another way or fails visibly"
  fi
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
if [[ "${APPLY:-0}" == 1 && "$MODE" == "managed" ]]; then
  mkdir -p "$ROOT/data/repoql"
  export REPOQL_RQL_PATH
  REPOQL_COMPOSE=(-f "$ROOT/compose/repoql.override.yml")
  log "RepoQL enabled ($REPOQL_RQL_PATH) — the rql binary will be mounted into the compose-managed OpenChamber"
elif [[ "${APPLY:-0}" == 1 ]]; then
  log "RepoQL detected ($REPOQL_RQL_PATH) — in attach mode YOUR instance needs the rql mount (see the attach script output); the Claude Code integration can use it directly"
fi

# ── 4. OpenChamber (compose-managed path only; attach starts nothing) ────────
if [[ "$MODE" == "managed" ]]; then
  if [[ -z "${OPENCHAMBER_UI_PASSWORD:-}" && -f "$ROOT/secrets/openchamber.env" ]]; then
    set -a
    # shellcheck disable=SC1091
    . "$ROOT/secrets/openchamber.env"
    set +a
  fi
  if [[ -n "${OPENCHAMBER_UI_PASSWORD:-}" ]]; then
    docker compose -f "$ROOT/compose/compose.yml" ${REPOQL_COMPOSE[@]+"${REPOQL_COMPOSE[@]}"} up -d
  else
    log "skipping OpenChamber start: set OPENCHAMBER_UI_PASSWORD or create secrets/openchamber.env"
  fi
else
  log "attach mode: $ATTACH_TARGET is YOUR existing OpenChamber — restart it yourself to load the plugins; this script never restarts it"
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
