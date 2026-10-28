#!/usr/bin/env bash
# apply.sh — apply (or reverse) the recorded OpenChamber delta against a checkout.
#
# Safety contract:
#   * dry-run by default: nothing is applied unless --apply/--reverse is passed;
#   * refuses when `series` lists no patches (the recorded state today) instead of
#     reporting a false success;
#   * verifies each patch's base commit object exists before applying;
#   * refuses a dirty checkout (uncommitted tracked changes);
#   * never commits, tags, pushes or rewrites history.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SERIES="$HERE/series"
MODE=dry-run
CHECKOUT=""

usage() {
  cat <<'USAGE'
usage: apply.sh --checkout <openchamber-checkout> [--apply|--reverse|--dry-run]

  --checkout DIR   a git checkout of openchamber/openchamber at the recorded base
  --dry-run        report what would happen (default)
  --apply          apply the series with `git apply --check` first
  --reverse        unapply the series in reverse order
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --checkout) CHECKOUT=${2:-}; shift 2 ;;
    --apply) MODE=apply; shift ;;
    --reverse) MODE=reverse; shift ;;
    --dry-run) MODE=dry-run; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "apply.sh: unknown argument $1" >&2; usage; exit 64 ;;
  esac
done

[ -n "$CHECKOUT" ] || { echo "apply.sh: --checkout is required" >&2; exit 64; }
[ -d "$CHECKOUT/.git" ] || { echo "apply.sh: $CHECKOUT is not a git checkout" >&2; exit 66; }
cd "$CHECKOUT"

BASE_COMMIT=$(sed -n 's/^base_commit=//p' "$SERIES" | head -1)
BASE_TAG=$(sed -n 's/^base_tag=//p' "$SERIES" | head -1)
PATCHES=$(grep -vE '^#|^base_|^fork_|^expected_|^$' "$SERIES" || true)

if [ -z "${PATCHES}" ]; then
  cat >&2 <<MSG
apply.sh: the recorded series contains NO patches.

  Reason: the fleet delta head is not reproducible from published sources (see
  README.md §What is NOT verifiable). Nothing will be applied, and this is not a
  success.
MSG
  exit 3
fi

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "apply.sh: $CHECKOUT has uncommitted tracked changes; refusing to touch it" >&2
  exit 65
fi

HEAD_SHA=$(git rev-parse HEAD)
echo "checkout HEAD: $HEAD_SHA"
echo "recorded base: ${BASE_TAG:-?} ${BASE_COMMIT:-?}"

if [ -n "$BASE_COMMIT" ] && ! git cat-file -e "${BASE_COMMIT}^{commit}" 2>/dev/null; then
  echo "apply.sh: base commit $BASE_COMMIT is not present in this checkout; fetch upstream history first:" >&2
  echo "  git fetch --tags origin" >&2
  exit 67
fi

if [ -n "$BASE_COMMIT" ] && [ "$HEAD_SHA" != "$BASE_COMMIT" ]; then
  echo "apply.sh: WARNING checkout is not at the recorded base; patches assume $BASE_COMMIT" >&2
fi

apply_one() {
  local patch="$1" extra="$2"
  echo "  git apply $extra $patch"
  case "$MODE" in
    dry-run) git apply --check $extra "$HERE/$patch" ;;
    apply) git apply --check "$HERE/$patch" && git apply "$HERE/$patch" ;;
    reverse) git apply --reverse --check "$HERE/$patch" && git apply --reverse "$HERE/$patch" ;;
  esac
}

if [ "$MODE" = reverse ]; then
  ORDER=$(printf '%s\n' "$PATCHES" | tac)
else
  ORDER=$PATCHES
fi

echo "mode: $MODE"
for p in $ORDER; do
  [ -f "$HERE/$p" ] || { echo "apply.sh: missing patch $p" >&2; exit 68; }
  apply_one "$p" "$([ "$MODE" = dry-run ] && echo --check || true)"
done

if [ "$MODE" = dry-run ]; then
  echo "dry-run complete: $(printf '%s\n' "$PATCHES" | wc -l) patch(es) would apply cleanly"
else
  echo "$MODE complete: $(printf '%s\n' "$PATCHES" | wc -l) patch(es)"
fi
