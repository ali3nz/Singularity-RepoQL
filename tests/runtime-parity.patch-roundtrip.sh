#!/usr/bin/env bash
# Roundtrip proof for a curated memory patch series.
#
#   tests/runtime-parity.patch-roundtrip.sh --series <dir> --upstream-tarball <file>
#
# The repository does not redistribute the upstream engine, so the base tree is
# reconstructed from the pinned upstream tarball. The check is: extract the
# pinned tarball, apply the series, compare every head hash, reverse the series,
# compare every base hash, then apply again and compare the head hashes once
# more. A patch that cannot be reversed exactly is not a curated export.
#
# Exit codes: 0 pass, 1 mismatch, 2 usage, 77 skipped (no tarball supplied).
set -euo pipefail

SERIES=""
TARBALL=""
KEEP="${KEEP:-0}"

while [ $# -gt 0 ]; do
  case "$1" in
    --series) SERIES="${2:-}"; shift 2 ;;
    --upstream-tarball) TARBALL="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[ -n "$SERIES" ] || { echo "usage: $0 --series <dir> [--upstream-tarball <tar.gz>]" >&2; exit 2; }
[ -d "$SERIES" ] || { echo "series directory not found: $SERIES" >&2; exit 2; }
command -v node >/dev/null || { echo "node is required (Node 22)" >&2; exit 2; }

SERIES=$(readlink -f "$SERIES")
MANIFEST="$SERIES/series.json"
PATCH_FILE="$SERIES/$(node -e 'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).patch.file)' "$MANIFEST")"
PATCH_FILE=$(readlink -f "$PATCH_FILE")
[ -f "$PATCH_FILE" ] || { echo "patch file missing: $PATCH_FILE" >&2; exit 2; }

read -r EXPECTED_TARBALL SUBPATH <<EOF
$(node -e 'const s=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));console.log((s.upstream.tarball_sha256||"-")+" "+(s.upstream.subpath||"MemoryCore"))' "$MANIFEST")
EOF

if [ -z "$TARBALL" ]; then
  echo "SKIP: no --upstream-tarball supplied; base tree cannot be reconstructed without the upstream engine."
  echo "      The patch series is self-describing (base/head hashes in series.json) but apply/reverse is unproven here."
  exit 77
fi
[ -f "$TARBALL" ] || { echo "tarball not found: $TARBALL" >&2; exit 2; }

ACTUAL_TARBALL=$(sha256sum "$TARBALL" | cut -d' ' -f1)
if [ "$EXPECTED_TARBALL" != "-" ] && [ -n "$EXPECTED_TARBALL" ]; then
  if [ "$ACTUAL_TARBALL" != "$EXPECTED_TARBALL" ]; then
    echo "FAIL: upstream tarball sha256 $ACTUAL_TARBALL does not match pinned $EXPECTED_TARBALL" >&2
    exit 1
  fi
  echo "ok   upstream tarball matches pinned sha256"
else
  echo "note: series has no pinned tarball sha256; recording $ACTUAL_TARBALL for this run"
fi

WORK=$(mktemp -d "${TMPDIR:-/tmp}/rp-roundtrip.XXXXXX")
cleanup() { [ "$KEEP" = "1" ] && { echo "kept: $WORK"; return; }; rm -rf "$WORK"; }
trap cleanup EXIT

mkdir -p "$WORK/src"
tar xzf "$TARBALL" -C "$WORK/src" --strip-components=1
BASE_DIR="$WORK/src/$SUBPATH"
[ -d "$BASE_DIR" ] || { echo "FAIL: $SUBPATH not found in tarball" >&2; exit 1; }
cp "$PATCH_FILE" "$WORK/series.patch"

hashes() { # $1 = root, $2 = phase
  node - "$MANIFEST" "$1" "$2" <<'NODE'
const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const [manifest, root, phase] = process.argv.slice(2);
const series = JSON.parse(fs.readFileSync(manifest, "utf8"));
let bad = 0, checked = 0;
for (const entry of series.files) {
  const target = path.join(root, entry.path);
  const expected = phase === "head" ? entry.head_sha256 : entry.base_sha256;
  if (phase === "base" && entry.status === "added") {
    if (fs.existsSync(target)) { console.log(`FAIL ${entry.path}: added file survived reverse`); bad++; }
    else { checked++; }
    continue;
  }
  if (!fs.existsSync(target)) { console.log(`FAIL ${entry.path}: missing at ${phase}`); bad++; continue; }
  const actual = crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex");
  if (actual !== expected) { console.log(`FAIL ${entry.path}: ${phase} hash ${actual.slice(0, 12)} != ${String(expected).slice(0, 12)}`); bad++; }
  else checked++;
}
console.log(`${bad === 0 ? "ok  " : "FAIL"} ${phase}: ${checked} files checked, ${bad} mismatched`);
process.exit(bad === 0 ? 0 : 1);
NODE
}

cd "$BASE_DIR"
# GNU patch, not `git apply`: reversing a file creation with `git apply -R`
# leaves a zero-byte file behind, which would hide a series that cannot be
# reversed. `patch -E` removes a file the reversal emptied.
patch -p1 -E --batch --forward < "$WORK/series.patch" >/dev/null
echo "-- applied; verifying head hashes"
hashes "$BASE_DIR" head

echo "-- reversing"
patch -p1 -E --batch --reverse < "$WORK/series.patch" >/dev/null
echo "-- reversed; verifying base hashes"
hashes "$BASE_DIR" base

echo "-- re-applying (roundtrip)"
patch -p1 -E --batch --forward < "$WORK/series.patch" >/dev/null
hashes "$BASE_DIR" head

echo "PASS: apply -> verify head -> reverse -> verify base -> re-apply -> verify head"
