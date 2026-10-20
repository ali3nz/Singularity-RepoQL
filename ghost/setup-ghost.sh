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
if [[ ! -f "$ROOT/secrets/ghost.env" ]]; then
  umask 077
  cat > "$ROOT/secrets/ghost.env" <<'EOF'
# Ghost optional add-on configuration (mode 0600).
# Presence of secrets/ghost.env enables Ghost in scripts/start.sh.
GHOST_TIMEZONE=UTC
GHOST_UPSTREAM_BASE=http://proxy:8096/openai/default/v1
GHOST_DREAM_CHECK_INTERVAL_SEC=3600
EOF
  chmod 600 "$ROOT/secrets/ghost.env"
  log "created $ROOT/secrets/ghost.env (mode 0600)"
fi

log "Ghost clean-slate setup complete ($GHOST_DIR)"
