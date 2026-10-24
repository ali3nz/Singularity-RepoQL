#!/usr/bin/env bash
# Scan the release tree for internal references that must never ship publicly.
#
# Patterns are layered:
#   tests/forbidden-refs.txt        committed, generic disclosure shapes only
#   tests/forbidden-refs.local.txt  gitignored private inventory (release host)
#
# The public guard alone must pass in CI. The operator's release gate sets
# FORBIDDEN_REFS_REQUIRE_LOCAL=1 so a missing overlay is a hard failure rather
# than a silently weaker scan. The pristine upstream vendoring (memory/upstream)
# is exempt by design — it is byte-exact third-party content.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GENERIC="$ROOT/tests/forbidden-refs.txt"
LOCAL="$ROOT/tests/forbidden-refs.local.txt"
REQUIRE_LOCAL="${FORBIDDEN_REFS_REQUIRE_LOCAL:-0}"

die() { echo "ref scan: FAILED — $*" >&2; exit 2; }

[[ -r "$GENERIC" ]] || die "generic pattern file missing or unreadable: $GENERIC"

CLEAN="$(mktemp)"
trap 'rm -f "$CLEAN"' EXIT
: > "$CLEAN"

add_patterns() { # add_patterns <file> <label>
  local f="$1" label="$2" n
  [[ -r "$f" ]] || die "$label pattern file missing or unreadable: $f"
  n="$(grep -cvE '^[[:space:]]*(#|$)' "$f" || true)"
  [[ "${n:-0}" -gt 0 ]] || die "$label pattern file contains no patterns: $f"
  grep -vE '^[[:space:]]*(#|$)' "$f" >>"$CLEAN" ||
    die "could not read $label patterns: $f"
}

add_patterns "$GENERIC" "generic"

MODE="public guard"
if [[ -f "$LOCAL" ]]; then
  add_patterns "$LOCAL" "local overlay"
  MODE="public guard + local overlay"
elif [[ "$REQUIRE_LOCAL" == "1" ]]; then
  die "FORBIDDEN_REFS_REQUIRE_LOCAL=1 but no local overlay at $LOCAL"
else
  echo "ref scan: local overlay absent (public mode)" >&2
fi

# Every pattern must be a valid ERE. A broken guard must fail, never scan clean.
while IFS= read -r pat; do
  set +e
  grep -qE -- "$pat" /dev/null 2>/dev/null
  prc=$?
  set -e
  [[ $prc -le 1 ]] || die "invalid pattern in the guard: $pat"
done <"$CLEAN"

cd "$ROOT"
# The scan targets what would SHIP. Runtime/generated directories are covered
# by .gitignore (never committed) and are excluded from the release tree, so
# grep must exclude them here too — otherwise a working checkout with local
# runtime state always fails in CI-fresh terms.
set +e
# -I: binary files are skipped here on purpose. A PNG cannot be judged by
# grep, so image metadata is inspected explicitly in the release gate
# (docs/RELEASE.md) instead of being reported as a noisy false positive.
hits="$(grep -RnIE -f "$CLEAN" \
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
  --exclude=forbidden-refs.local.txt \
  --exclude=scan-refs.test.sh \
  .)"
rc=$?
set -e

# 0 = hits, 1 = no hits, anything else means the scan itself failed.
[[ $rc -le 1 ]] || die "grep exited $rc (unreadable input or I/O error)"

if [[ -n "$hits" ]]; then
  echo "FORBIDDEN REFERENCES FOUND ($MODE):"
  echo "$hits"
  exit 1
fi
echo "ref scan: clean ($MODE)"
