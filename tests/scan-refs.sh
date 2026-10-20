#!/usr/bin/env bash
# Scan the release tree for internal references that must never ship publicly.
# Patterns live in tests/forbidden-refs.txt; the pristine upstream vendoring
# (memory/upstream) is exempt by design — it is byte-exact third-party content.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PATTERNS="$ROOT/tests/forbidden-refs.txt"

cd "$ROOT"
# The scan targets what would SHIP. Runtime/generated directories are covered
# by .gitignore (never committed) and are excluded from the release tree, so
# grep must exclude them here too — otherwise a working checkout with local
# runtime state always fails in CI-fresh terms.
CLEAN="$(mktemp)"
trap 'rm -f "$CLEAN"' EXIT
grep -vE '^[[:space:]]*(#|$)' "$PATTERNS" > "$CLEAN"
hits="$(grep -RnE -f "$CLEAN" \
  --exclude-dir=.git \
  --exclude-dir=upstream \
  --exclude-dir=node_modules \
  --exclude-dir=.repoql \
  --exclude-dir=data \
  --exclude-dir=state \
  --exclude-dir=workspaces \
  --exclude-dir=knowledge-store \
  --exclude-dir=evidence \
  --exclude-dir=backups \
  --exclude=forbidden-refs.txt \
  . || true)"

if [[ -n "$hits" ]]; then
  echo "FORBIDDEN REFERENCES FOUND:"
  echo "$hits"
  exit 1
fi
echo "ref scan: clean"
