#!/usr/bin/env bash
# One-shot MemoryCore capture runner, invoked by tencent-capture.service.
#
# Capture is ENABLED only through the env file below; the executable itself
# stays disabled by default, and an absent env file is a clean no-op (exit 0)
# rather than a failed unit on every tick.
#
# Ported from the live runner. Every host-specific value (root, identity,
# network, image, source directory) is a variable with a documented default;
# TEAM_ID and USER_ID have no default and must be chosen.
set -euo pipefail

ENVF="${CAPTURE_ENV_FILE:-/etc/singularity/capture.env}"
if [[ ! -r "$ENVF" ]]; then
  echo "singularity-capture: $ENVF absent -- capture stays DISABLED (nothing read, nothing written)" >&2
  exit 0
fi
# shellcheck source=/dev/null
. "$ENVF"

if [[ "${CAPTURE_ENABLED:-0}" != "1" ]]; then
  echo "singularity-capture: CAPTURE_ENABLED=${CAPTURE_ENABLED:-0} -- disabled, nothing read" >&2
  exit 0
fi
if [[ -z "${TEAM_ID:-}" || -z "${USER_ID:-}" ]]; then
  echo "singularity-capture: TEAM_ID and USER_ID are required when capture is enabled" >&2
  exit 2
fi

SELF_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
APP_DIR=$(cd "$SELF_DIR/.." && pwd)
SRC_DIR="${SRC_DIR:-$HOME/.local/share/opencode/share}"
if [[ ! -d "$SRC_DIR" ]]; then
  echo "singularity-capture: SRC_DIR does not exist: $SRC_DIR" >&2
  exit 2
fi
SRC_DIR=$(cd "$SRC_DIR" && pwd)

IMG="${CAPTURE_IMAGE:-tencent-memorycore:v2.0.2-99a1a2c-l1recordids1}"
NET="${MEMORY_NETWORK:-tdai-memory-stack}"
LEDGER_DIR="${LEDGER_DIR:-/var/lib/singularity/capture-ledger}"
LEDGER_NAME="${LEDGER_NAME:-capture-ledger.json}"
mkdir -p "$LEDGER_DIR"

# FIXED container name: docker itself makes concurrency impossible. Even if an
# age-based ledger lock expires while an earlier consumer is still alive, a
# second `docker run --name` fails immediately ("name already in use") instead
# of writing concurrently. It fails LOUDLY and never double-runs.
CNAME="${CAPTURE_CONTAINER_NAME:-singularity-capture}"

# OWN-CONTAINER-ONLY cleanup. Removing by NAME would let a run that failed to
# acquire the fixed name delete the container of the run that HOLDS it. Each
# run records its own id via --cidfile and removes only that id.
CID_DIR=$(mktemp -d)
CID_FILE="$CID_DIR/container.id"
cleanup() {
  if [[ -s "$CID_FILE" ]]; then
    local cid
    IFS= read -r cid < "$CID_FILE"
    docker rm -f "$cid" >/dev/null 2>&1 || true
  fi
  rm -f -- "$CID_FILE"
  rmdir -- "$CID_DIR" 2>/dev/null || true
}
trap cleanup EXIT

ENV_ARGS=()
if [[ -n "${GATEWAY_ENV_FILE:-}" && -r "${GATEWAY_ENV_FILE}" ]]; then
  ENV_ARGS=(--env-file "${GATEWAY_ENV_FILE}")
fi

docker run --rm \
  --name "$CNAME" \
  --cidfile "$CID_FILE" \
  --network "$NET" \
  --read-only \
  --tmpfs /tmp \
  --cap-drop=ALL \
  --security-opt=no-new-privileges \
  --user 1000:1000 \
  "${ENV_ARGS[@]}" \
  -e "DEST_URL=${DEST_URL:-http://tencent-memorycore:8420}" \
  -e "TEAM_ID=${TEAM_ID}" \
  -e "USER_ID=${USER_ID}" \
  -e "TDAI_SERVICE_ID=${TDAI_SERVICE_ID:-default}" \
  -e "SRC_DB=/src/opencode.db" \
  -e "LEDGER_PATH=/ledger/${LEDGER_NAME}" \
  -e "STABILITY_SECONDS=${STABILITY_SECONDS:-900}" \
  -e "CAPTURE_ENABLED=${CAPTURE_ENABLED:-0}" \
  -e "CAPTURE_ALLOW_AGENTS=${CAPTURE_ALLOW_AGENTS:-}" \
  -e "CAPTURE_DAILY_MAX_UNITS=${CAPTURE_DAILY_MAX_UNITS:-500}" \
  -e "CAPTURE_DAILY_MAX_MESSAGES=${CAPTURE_DAILY_MAX_MESSAGES:-20000}" \
  -e "CONSUMER_MAX_FAILURES=${CONSUMER_MAX_FAILURES:-5}" \
  -e "MAX_UNITS=${MAX_UNITS:-50}" \
  -v "$SRC_DIR":/src:ro \
  -v "$LEDGER_DIR":/ledger \
  -v "$APP_DIR":/app:ro \
  --entrypoint node "$IMG" /app/capture-consumer.mjs
