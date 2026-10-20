#!/usr/bin/env bash
# Manifest gate regressions — run against a THROWAWAY git fixture, never
# against the working checkout. Proves the drift gate actually fails when:
#   1. a tracked file is not listed in SHA256SUMS,
#   2. a listed file's bytes changed,
#   3. a listed file is missing,
# and that it passes on a clean tree.
#
# Run: bash tests/manifest-regression.test.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GATE="$ROOT/tests/validate-manifest.sh"

fail=0
note() { printf '%s\n' "$*"; }
expect() { # expect <want: ok|failed> <label> <fixture>
  local want="$1" label="$2" fixture="$3" out rc
  out="$(cd "$fixture" && bash tests/validate-manifest.sh 2>&1)"
  rc=$?
  if { [ "$want" = "ok" ] && [ "$rc" -eq 0 ]; } || { [ "$want" = "failed" ] && [ "$rc" -ne 0 ]; }; then
    note "ok   $label"
  else
    note "FAIL $label — expected $want, rc=$rc"
    printf '%s\n' "$out" | sed 's/^/     | /' | head -8
    fail=1
  fi
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fixture="$tmp/fixture"
mkdir -p "$fixture/tests"
cp "$GATE" "$fixture/tests/validate-manifest.sh"
printf 'alpha\n' > "$fixture/alpha.txt"
printf 'beta\n' > "$fixture/beta.txt"
(
  cd "$fixture"
  git init -q .
  git config user.email "manifest-regression@example.invalid"
  git config user.name "manifest regression"
  git add -A
  git commit -qm "fixture"
  git ls-files | grep -v '^SHA256SUMS$' | sort | xargs sha256sum > SHA256SUMS
)

note "== manifest gate regressions (throwaway fixture) =="

# 0. a clean fixture passes
expect ok "clean tree passes the drift gate" "$fixture"

# 1. a new TRACKED file that is not listed must fail
printf 'gamma\n' > "$fixture/gamma.txt"
(cd "$fixture" && git add gamma.txt && git commit -qm "add unlisted file")
expect failed "a tracked file missing from SHA256SUMS fails the gate" "$fixture"
(cd "$fixture" && git rm -q gamma.txt && git commit -qm "remove unlisted file")

# 2. changed bytes must fail
printf 'alpha modified\n' > "$fixture/alpha.txt"
expect failed "modified bytes fail the gate" "$fixture"
(cd "$fixture" && git checkout -q -- alpha.txt)

# 3. a listed file that is missing must fail
mv "$fixture/beta.txt" "$tmp/beta.txt.away"
expect failed "a listed file that is missing fails the gate" "$fixture"
mv "$tmp/beta.txt.away" "$fixture/beta.txt"

# 4. and the fixture is clean again afterwards
expect ok "restored fixture passes the drift gate again" "$fixture"

if [ "$fail" -ne 0 ]; then
  note "MANIFEST REGRESSIONS FAILED"
  exit 1
fi
note "MANIFEST REGRESSIONS OK"
exit 0
