#!/usr/bin/env bash
# Manifest gate regressions — run against a THROWAWAY git fixture, never
# against the working checkout. Proves the drift gate actually fails when:
#   1. a tracked file is not listed in SHA256SUMS,
#   2. a listed file's bytes changed,
#   3. a listed file is missing,
# and that it passes on a clean tree, on a CRLF checkout of an eol=crlf file,
# and in a zip-style tree with no .git.
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
    printf '%s\n' "$out" | sed 's/^/     | /' | head -12
    fail=1
  fi
}

regen() { # regen <fixture>: canonical git blobs, never the CRLF worktree bytes
  local d="$1" idx
  idx="$(mktemp)"
  rm -f "$idx"
  (
    cd "$d"
    GIT_INDEX_FILE="$idx" git add -A
    GIT_INDEX_FILE="$idx" git ls-files | grep -v '^SHA256SUMS$' | sort | while IFS= read -r f; do
      h="$(GIT_INDEX_FILE="$idx" git cat-file blob ":$f" | sha256sum | cut -d' ' -f1)"
      printf '%s  %s\n' "$h" "$f"
    done > SHA256SUMS
  )
  rm -f "$idx"
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fixture="$tmp/fixture"
mkdir -p "$fixture/tests"
cp "$GATE" "$fixture/tests/validate-manifest.sh"
printf 'alpha\n' > "$fixture/alpha.txt"
printf 'beta\n' > "$fixture/beta.txt"
printf '* text=auto eol=lf\n*.ps1 text eol=crlf\n' > "$fixture/.gitattributes"
printf 'Write-Host "ok"\r\n' > "$fixture/script.ps1"
(
  cd "$fixture"
  git init -q .
  git config user.email "manifest-regression@example.invalid"
  git config user.name "manifest regression"
  git add -A
  git commit -qm "fixture"
)
regen "$fixture"

note "== manifest gate regressions (throwaway fixture) =="

# The fixture must actually exercise the CRLF path: the blob is LF, the
# checkout is CRLF, and the manifest records the canonical blob hash.
if LC_ALL=C grep -q $'\r' "$fixture/script.ps1"; then
  note "ok   fixture keeps a CRLF working-tree script"
else
  note "FAIL fixture script.ps1 is not CRLF"
  fail=1
fi

# 0. a clean fixture passes
expect ok "clean tree passes the drift gate" "$fixture"

# 0b. the CRLF checkout validates against canonical blobs
expect ok "CRLF working tree validates against canonical git blobs" "$fixture"

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

# 5. a zip/source checkout without .git validates the same canonical manifest
zip="$tmp/zip-checkout"
mkdir -p "$zip"
cp -a "$fixture/." "$zip/"
rm -rf "$zip/.git"
expect ok "zip checkout without .git passes with CRLF normalisation" "$zip"

# 6. a raw-CRLF manifest cannot sneak into the zip checkout
(
  cd "$zip"
  while IFS= read -r f; do
    [ "$f" = "SHA256SUMS" ] && continue
    printf '%s  %s\n' "$(sha256sum "$f" | cut -d' ' -f1)" "$f"
  done < <(sort SHA256SUMS | sed -E 's/^[0-9a-f]{64}  //') > SHA256SUMS.raw
  mv SHA256SUMS.raw SHA256SUMS
)
expect failed "raw-CRLF hashes are rejected in a zip checkout" "$zip"

if [ "$fail" -ne 0 ]; then
  note "MANIFEST REGRESSIONS FAILED"
  exit 1
fi
note "MANIFEST REGRESSIONS OK"
exit 0
