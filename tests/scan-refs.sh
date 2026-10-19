#!/usr/bin/env bash
# Scan the release tree for internal references that must never ship publicly.
# Patterns live in tests/forbidden-refs.txt; the pristine upstream vendoring
# (memory/upstream) is exempt by design — it is byte-exact third-party content.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PATTERNS="$ROOT/tests/forbidden-refs.txt"

cd "$ROOT"
CLEAN="$(mktemp)"
trap 'rm -f "$CLEAN"' EXIT
grep -vE '^[[:space:]]*(#|$)' "$PATTERNS" > "$CLEAN"
hits="$(grep -RnE -f "$CLEAN" \
  --exclude-dir=.git \
  --exclude-dir=upstream \
  --exclude-dir=node_modules \
  --exclude=forbidden-refs.txt \
  . || true)"

if [[ -n "$hits" ]]; then
  echo "FORBIDDEN REFERENCES FOUND:"
  echo "$hits"
  exit 1
fi
echo "ref scan: clean"
