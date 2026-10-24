#!/usr/bin/env bash
# Disclosure-guard regressions — run against THROWAWAY fixture trees, never the
# working checkout. Proves the scanner:
#   1. passes with the generic guard alone, the way public CI runs it,
#   2. rejects private inventory supplied by the local overlay,
#   3. rejects unqualified ticket identifiers but accepts qualified ones,
#   4. requires the overlay when FORBIDDEN_REFS_REQUIRE_LOCAL=1,
#   5. fails closed on a missing or malformed pattern file instead of scanning
#      clean.
#
# Run: bash tests/scan-refs.test.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCANNER="$ROOT/tests/scan-refs.sh"
GENERIC="$ROOT/tests/forbidden-refs.txt"

fail=0
note() { printf '%s\n' "$*"; }

# new_fixture <dir> — a minimal release tree carrying the real scanner and the
# real committed pattern file, so the suite tests what actually ships.
new_fixture() {
  local dir="$1"
  mkdir -p "$dir/tests"
  cp "$SCANNER" "$dir/tests/scan-refs.sh"
  cp "$GENERIC" "$dir/tests/forbidden-refs.txt"
}

expect() { # expect <want: clean|failed> <label> <fixture> [env assignments...]
  local want="$1" label="$2" fixture="$3"
  shift 3
  local out rc
  out="$(cd "$fixture" && env "$@" bash tests/scan-refs.sh 2>&1)"
  rc=$?
  if { [ "$want" = clean ] && [ "$rc" -eq 0 ]; } ||
     { [ "$want" = failed ] && [ "$rc" -ne 0 ]; }; then
    note "ok   $label"
  else
    note "FAIL $label — expected $want, rc=$rc"
    printf '%s\n' "$out" | sed 's/^/     | /' | head -8
    fail=1
  fi
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# 1. Public CI parity: generic guard alone, clean tree.
f="$tmp/public-clean"
new_fixture "$f"
printf '# Release notes\n\nOne diagnostic entrypoint: node scripts/doctor.mjs\n' >"$f/README.md"
expect clean "generic guard passes without the overlay" "$f"

# 2. A private value is only caught when the overlay supplies its pattern.
OV="\\bfleetname-alpha\\b"
f="$tmp/overlay-hit"
new_fixture "$f"
printf 'Runs on fleetname-alpha every night.\n' >"$f/NOTES.md"
expect clean "private name is invisible to the public guard alone" "$f"
{
  echo "# test overlay"
  echo "$OV"
} >"$f/tests/forbidden-refs.local.txt"
expect failed "overlay pattern catches the private name" "$f"

# 3. Unqualified ticket identifiers are rejected by the generic guard.
for bad in "issue 118" "issue#114" "issue 114/118" "P776" "run694" "kit D11"; do
  f="$tmp/bad-$$"
  new_fixture "$f"
  printf 'Fixes %s in the chat path.\n' "$bad" >"$f/NOTES.md"
  expect failed "unqualified identifier rejected: $bad" "$f"
done

# 4. Qualified upstream references stay legal.
f="$tmp/qualified"
new_fixture "$f"
cat >"$f/NOTES.md" <<'EOF'
See ali3nz/Singularity-RepoQL#123 for the original report.
Upstream detail: https://github.com/openchamber/openchamber/issues/4567
EOF
expect clean "qualified github references are accepted" "$f"

# 5. Address and path shapes are caught without any overlay.
for shape in "192.168.4.10" "10.2.3.4" "172.20.1.9" "/home/someone/docker/x" "/mnt/backups/x"; do
  f="$tmp/shape-$$"
  new_fixture "$f"
  printf 'host %s\n' "$shape" >"$f/NOTES.md"
  expect failed "private shape rejected: $shape" "$f"
done

# 5b. Documented CIDR blocks are not private addresses.
f="$tmp/cidr"
new_fixture "$f"
cat >"$f/OFFICE.md" <<'EOF'
CLAUDE_OFFICE_ALLOW_CIDR defaults to 127.0.0.0/8,172.16.0.0/12.
Cluster example: 10.0.0.0/8 is not a host address.
EOF
expect clean "documented CIDR ranges are accepted" "$f"

# 6. The release gate refuses to run without the overlay.
f="$tmp/require-absent"
new_fixture "$f"
printf 'clean tree\n' >"$f/NOTES.md"
expect failed "REQUIRE_LOCAL=1 without an overlay fails" "$f" FORBIDDEN_REFS_REQUIRE_LOCAL=1

f="$tmp/require-present"
new_fixture "$f"
printf 'clean tree\n' >"$f/NOTES.md"
printf '# test overlay\n\\bfleetname-alpha\\b\n' >"$f/tests/forbidden-refs.local.txt"
expect clean "REQUIRE_LOCAL=1 with an overlay passes" "$f" FORBIDDEN_REFS_REQUIRE_LOCAL=1

# 7. A missing or malformed guard must never read as clean.
f="$tmp/no-generic"
new_fixture "$f"
rm -f "$f/tests/forbidden-refs.txt"
expect failed "missing generic pattern file fails closed" "$f"

f="$tmp/bad-pattern"
new_fixture "$f"
printf '[unclosed\n' >"$f/tests/forbidden-refs.txt"
expect failed "malformed pattern fails closed" "$f"

f="$tmp/empty-generic"
new_fixture "$f"
printf '# only comments\n\n' >"$f/tests/forbidden-refs.txt"
expect failed "pattern file with no patterns fails closed" "$f"

# 8. The pattern files themselves are never scanned (no self-hit on \b words).
f="$tmp/no-self-hit"
new_fixture "$f"
printf 'ordinary text\n' >"$f/NOTES.md"
expect clean "pattern files are excluded from the scan" "$f"

if [[ $fail -ne 0 ]]; then
  echo
  echo "SCAN-REFS TESTS FAILED"
  exit 1
fi
echo
echo "SCAN-REFS OK"
