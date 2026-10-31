#!/usr/bin/env bash
# Manifest drift gate: SHA256SUMS must byte-cover every tracked file of the
# repository (excluding SHA256SUMS itself) with correct hashes, and nothing
# else. A checkout that drifted from its published manifest fails.
#
# With .git present the gate builds a THROWAWAY index from the worktree and
# hashes the canonical git blobs for each path. That is the same byte stream a
# commit would store, so the gate passes on a clean tree even when .gitattributes
# checks a Windows script out as CRLF. It also means new untracked files are
# covered without staging anything in the real index.
#
# Without .git (a zip/source checkout) the gate hashes the listed files directly
# and normalises CRLF back to LF for the patterns .gitattributes marks eol=crlf.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

fail=0
echo "== manifest drift gate =="
if ! command -v sha256sum >/dev/null 2>&1; then
  echo "sha256sum not available — gate skipped (env without coreutils)"; exit 0
fi

if [ ! -r SHA256SUMS ]; then
  echo "FAILED: SHA256SUMS is missing or unreadable"
  exit 1
fi

tmp="$(mktemp)"
tmpidx="$(mktemp)"
expected="$(mktemp)"
actual_paths="$(mktemp)"
rm -f "$tmpidx"
trap 'rm -f "$tmp" "$tmpidx" "$expected" "$actual_paths"' EXIT

# Manifest paths, in the same "sha256sum" output shape used by generation.
sed -E 's/^[0-9a-f]{64}  //' SHA256SUMS | sort > "$actual_paths"
listed="$(wc -l < SHA256SUMS)"

if git rev-parse --git-dir >/dev/null 2>&1; then
  mode="git blobs"
  # Never touch the real index. The temporary index applies .gitattributes,
  # .gitignore and the same clean filters a commit would use.
  if ! GIT_INDEX_FILE="$tmpidx" git add -A -- . >/dev/null 2>&1; then
    echo "FAILED: could not build a temporary index for manifest validation"
    exit 1
  fi
  GIT_INDEX_FILE="$tmpidx" git ls-files | grep -v '^SHA256SUMS$' | sort > "$expected"

  bad=0
  ok=0
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    hash="${line:0:64}"
    if [ "${#line}" -lt 66 ] || [ "${line:64:2}" != "  " ] || ! [[ "$hash" =~ ^[0-9a-f]{64}$ ]]; then
      echo "FAILED: malformed SHA256SUMS line: $line"
      bad=$((bad + 1))
      continue
    fi
    path="${line:66}"
    if ! GIT_INDEX_FILE="$tmpidx" git cat-file -e ":$path" 2>/dev/null; then
      echo "FAILED: $path is listed but absent from the canonical tree"
      bad=$((bad + 1))
      continue
    fi
    actual="$(GIT_INDEX_FILE="$tmpidx" git cat-file blob ":$path" | sha256sum | awk '{print $1}')"
    if [ "$actual" = "$hash" ]; then
      ok=$((ok + 1))
    else
      echo "FAILED: $path has wrong hash (expected $hash, canonical blob $actual)"
      bad=$((bad + 1))
    fi
  done < SHA256SUMS
else
  mode="CRLF-normalised worktree"
  # .gitattributes is the only source of the eol=crlf set in a zip checkout.
  crlf_patterns=()
  if [ -r .gitattributes ]; then
    while IFS= read -r line; do
      case "$line" in ''|'#'*) continue;; esac
      # shellcheck disable=SC2086
      set -- $line
      [ "$#" -ge 2 ] || continue
      pat="$1"; shift
      attrs=" $* "
      case "$attrs" in *' eol=crlf '*) crlf_patterns+=("$pat");; esac
    done < .gitattributes
  fi
  is_crlf() {
    local p="$1" pat
    for pat in "${crlf_patterns[@]}"; do
      # shellcheck disable=SC2254
      case "$p" in $pat) return 0;; esac
    done
    return 1
  }

  bad=0
  ok=0
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    hash="${line:0:64}"
    if [ "${#line}" -lt 66 ] || [ "${line:64:2}" != "  " ] || ! [[ "$hash" =~ ^[0-9a-f]{64}$ ]]; then
      echo "FAILED: malformed SHA256SUMS line: $line"
      bad=$((bad + 1))
      continue
    fi
    path="${line:66}"
    if [ "$path" = "SHA256SUMS" ]; then
      echo "FAILED: SHA256SUMS must not list itself"
      bad=$((bad + 1))
      continue
    fi
    if [ ! -f "$path" ]; then
      echo "FAILED: $path is listed but missing"
      bad=$((bad + 1))
      continue
    fi
    if is_crlf "$path"; then
      actual="$(sed 's/\r$//' "$path" | sha256sum | awk '{print $1}')"
    else
      actual="$(sha256sum "$path" | awk '{print $1}')"
    fi
    if [ "$actual" = "$hash" ]; then
      ok=$((ok + 1))
    else
      echo "FAILED: $path has wrong hash (expected $hash, observed $actual)"
      bad=$((bad + 1))
    fi
  done < SHA256SUMS
  expected="$actual_paths"
fi

# The manifest must name exactly the canonical tree, plus no ghost entries.
missing="$(comm -23 "$expected" "$actual_paths")"
extra="$(comm -13 "$expected" "$actual_paths")"
if [ -n "$missing" ]; then echo "FAILED: tracked file(s) missing from SHA256SUMS:"; echo "$missing"; fail=1; fi
if [ -n "$extra" ]; then echo "FAILED: SHA256SUMS lists file(s) that are not tracked or no longer exist:"; echo "$extra"; fail=1; fi
if [ "$bad" != "0" ]; then fail=1; fi
if ! grep -q '"file_hashes": "SHA256SUMS"' MANIFEST.json 2>/dev/null; then
  echo "NOTE: MANIFEST.json does not reference SHA256SUMS via file_hashes"
fi
if [ "$fail" = "0" ]; then echo "DRIFT GATE OK ($mode) — $listed listed, $ok ok"; exit 0; fi
echo "DRIFT GATE FAILED ($mode) — regenerate with the temporary-index procedure in docs/RELEASE.md"
exit 1
