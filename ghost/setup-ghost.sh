#!/usr/bin/env bash
# Initialize the optional Ghost persistent companion agent add-on (clean slate).
#
# What this script does (idempotent, never overwrites existing user memories):
#   1. Creates data/ghost/{memory,dreams,conversations,current-state}
#   2. Copies clean seed templates (persona.md, MEMORY.md, digest.md) if absent
#   3. Initializes a local git repository in data/ghost/memory/ for dream commits
#   4. Installs openchamber/agents/ghost.md into data/opencode/config/agents/
#      when the OpenChamber config directory exists
#   5. Creates secrets/ghost.env (mode 0600) with default settings if absent
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
GHOST_DIR="${GHOST_DATA_DIR:-$ROOT/data/ghost}"

log() { printf '%s [ghost-setup] %s\n' "$(date -u +%FT%TZ)" "$*"; }

mkdir -p \
  "$GHOST_DIR/memory" \
  "$GHOST_DIR/dreams" \
  "$GHOST_DIR/conversations" \
  "$GHOST_DIR/current-state"

if [[ ! -f "$GHOST_DIR/memory/persona.md" ]]; then
  cp "$SCRIPT_DIR/seed/persona.md" "$GHOST_DIR/memory/persona.md"
  log "seeded $GHOST_DIR/memory/persona.md"
fi

if [[ ! -f "$GHOST_DIR/memory/MEMORY.md" ]]; then
  cp "$SCRIPT_DIR/seed/MEMORY.md" "$GHOST_DIR/memory/MEMORY.md"
  log "seeded $GHOST_DIR/memory/MEMORY.md"
fi

if [[ ! -f "$GHOST_DIR/current-state/digest.md" ]]; then
  cp "$SCRIPT_DIR/seed/digest.md" "$GHOST_DIR/current-state/digest.md"
  log "seeded $GHOST_DIR/current-state/digest.md"
fi

if command -v git >/dev/null 2>&1 && [[ ! -d "$GHOST_DIR/memory/.git" ]]; then
  git -C "$GHOST_DIR/memory" init -q
  git -C "$GHOST_DIR/memory" add -A
  git -C "$GHOST_DIR/memory" \
    -c user.email="dream@singularity.local" \
    -c user.name="ghost-seed" \
    commit -q -m "initial clean-slate Ghost memory seed" || true
  log "initialized git repository in $GHOST_DIR/memory"
fi

if [[ -d "$ROOT/data/opencode/config/agents" ]]; then
  cp "$ROOT/openchamber/agents/ghost.md" "$ROOT/data/opencode/config/agents/ghost.md"
  log "installed openchamber/agents/ghost.md -> data/opencode/config/agents/ghost.md"
fi

mkdir -p "$ROOT/secrets"
chmod 700 "$ROOT/secrets"
# The model lane is DERIVED from the canonical memory-stack configuration (the
# same proxy port, lane and space id as the main-agent memory) — never a
# hardcoded route: a lane the proxy does not register answers with a routing
# error ("spaceId is required in the request path"), not with a model.
PROXY_PORT="$(sed -n 's/^PROXY_PORT=\([0-9][0-9]*\).*/\1/p' "$ROOT/memory/upstream/.env" 2>/dev/null | head -n1 || true)"
PROXY_PORT="${PROXY_PORT:-8096}"
MODEL_LANE="${SINGULARITY_MODEL_LANE:-claude-code}"
MODEL_SPACE="${SINGULARITY_MODEL_SPACE_ID:-${MEMORY_SERVICE_ID:-default}}"
MODEL_BASE="http://proxy:${PROXY_PORT}/${MODEL_LANE}/${MODEL_SPACE}/v1"
GHOST_BACKEND="${GHOST_BACKEND:-openchamber}"
if [[ ! -f "$ROOT/secrets/ghost.env" ]]; then
  umask 077
  cat > "$ROOT/secrets/ghost.env" <<EOF
# Ghost optional add-on configuration (mode 0600).
# Presence of secrets/ghost.env enables Ghost in scripts/start.sh.
GHOST_TIMEZONE=UTC
GHOST_UPSTREAM_BASE=${MODEL_BASE}
GHOST_DREAM_GATEWAY_URL=${MODEL_BASE}
GHOST_BACKEND=${GHOST_BACKEND}
GHOST_DREAM_CHECK_INTERVAL_SEC=3600
EOF
  chmod 600 "$ROOT/secrets/ghost.env"
  log "created $ROOT/secrets/ghost.env (mode 0600)"
elif grep -qE '^GHOST_(UPSTREAM_BASE|DREAM_GATEWAY_URL)=http://proxy:[0-9]+/openai/default/v1$' "$ROOT/secrets/ghost.env"; then
  # Repair a structurally invalid lane; every other value is preserved.
  sed -i -E "s#^GHOST_(UPSTREAM_BASE|DREAM_GATEWAY_URL)=.*#GHOST_\1=${MODEL_BASE}#" "$ROOT/secrets/ghost.env"
  log "repaired the structurally invalid Ghost model lane in $ROOT/secrets/ghost.env -> ${MODEL_BASE}"
fi

log "Ghost clean-slate setup complete ($GHOST_DIR)"
