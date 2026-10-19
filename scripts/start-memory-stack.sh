#!/usr/bin/env bash
# Safe wrapper around the byte-exact TencentDB Agent Memory quickstart.
# Redacts key-shaped output and validates auth/verify's data.valid field.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UPSTREAM="$ROOT/memory/upstream"

load_upstream_env() {
  if [[ -f "$UPSTREAM/.env" ]]; then
    set -a
    # shellcheck disable=SC1091
    . "$UPSTREAM/.env"
    set +a
  fi
}
load_upstream_env
ADMIN_KEY_FILE="${MEMORY_CORE_ADMIN_KEY_FILE:-$UPSTREAM/.admin-key}"
if [[ "$ADMIN_KEY_FILE" != /* ]]; then ADMIN_KEY_FILE="$UPSTREAM/$ADMIN_KEY_FILE"; fi

set +e
(
  cd "$UPSTREAM" && ./start-all.sh
) 2>&1 | python3 "$ROOT/scripts/redact-memory-startup.py" "$ADMIN_KEY_FILE"
pipeline_status=("${PIPESTATUS[@]}")
set -e
upstream_status="${pipeline_status[0]:-1}"
filter_status="${pipeline_status[1]:-1}"
if [[ "$filter_status" != 0 ]]; then
  echo 'FAILED: safe startup output filter failed; inspect the local Python installation.' >&2
  exit 1
fi
if [[ "$upstream_status" != 0 ]]; then
  printf 'FAILED: upstream memory startup exited with status %s.\n' "$upstream_status" >&2
  exit "$upstream_status"
fi

# The upstream helper checks only HTTP 200; auth/verify also uses HTTP 200 for
# invalid keys. Source the saved endpoint configuration and require data.valid.
load_upstream_env
if [[ ! -s "$ADMIN_KEY_FILE" ]]; then
  echo 'FAILED: admin key file is missing or empty; no key value was displayed.' >&2
  exit 1
fi
chmod 600 "$ADMIN_KEY_FILE"
python3 "$ROOT/scripts/verify-memory-user-key.py" "$ADMIN_KEY_FILE"
