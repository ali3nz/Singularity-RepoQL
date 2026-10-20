#!/usr/bin/env bash
# Manifest drift gate: SHA256SUMS must byte-cover every tracked file of the
# repository (excluding SHA256SUMS itself) with correct hashes, and nothing
# else. A checkout that drifted from its published manifest fails.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

fail=0
echo "== manifest drift gate =="
if ! command -v sha256sum >/dev/null 2>&1; then
  echo "sha256sum not available — gate skipped (env without coreutils)"; exit 0
fi
git rev-parse --git-dir >/dev/null 2>&1 || { echo "SKIP: not a git checkout"; exit 0; }

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
git ls-files | grep -v '^SHA256SUMS$' | sort > "$tmp"

actual="$(sha256sum -c SHA256SUMS 2>&1 | grep -c ': OK$' || true)"
listed="$(wc -l < SHA256SUMS)"
expected="$(wc -l < "$tmp")"
bad="$(sha256sum -c SHA256SUMS 2>/dev/null | grep -vc ': OK$' || true)"
if [ "$bad" != "0" ]; then
  echo "FAILED: $bad listed file(s) with wrong hash:"; sha256sum -c SHA256SUMS 2>/dev/null | grep -v ': OK$' || true
  fail=1
fi
missing="$(comm -23 "$tmp" <(cut -d' ' -f3 SHA256SUMS | sort))"
extra="$(comm -13 "$tmp" <(cut -d' ' -f3 SHA256SUMS | sort))"
if [ -n "$missing" ]; then echo "FAILED: tracked file(s) missing from SHA256SUMS:"; echo "$missing"; fail=1; fi
if [ -n "$extra" ]; then echo "FAILED: SHA256SUMS lists file(s) that are not tracked or no longer exist:"; echo "$extra"; fail=1; fi
if ! grep -q '"file_hashes": "SHA256SUMS"' MANIFEST.json 2>/dev/null; then
  echo "NOTE: MANIFEST.json does not reference SHA256SUMS via file_hashes"
fi
if [ "$fail" = "0" ]; then echo "DRIFT GATE OK — $listed listed, $actual ok, expected $expected"; exit 0; fi
echo "DRIFT GATE FAILED — regenerate: git ls-files | grep -v '^SHA256SUMS$' | sort | xargs sha256sum > SHA256SUMS-style update"
exit 1
