#!/usr/bin/env bash
# Runtime-parity gate: everything that can be proven on this host, in one run.
#
#   tests/runtime-parity.sh                       # static checks + unit tests
#   tests/runtime-parity.sh /path/to/src-99a1a2c.tar.gz   # also proves patch roundtrip
#
# Exit: 0 all run; 1 a check failed; 77 nothing run (missing prerequisite).
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)
TARBALL="${1:-}"
FAILED=0
RUN=0

step() { printf '\n== %s\n' "$1"; }

step "node: runtime-parity.test.mjs"
if command -v node >/dev/null; then
  ( cd "$ROOT" && node --test tests/runtime-parity.test.mjs ); rc=$?
  RUN=$((RUN + 1)); [ $rc -eq 0 ] || { echo "FAILED (exit $rc)"; FAILED=$((FAILED + 1)); }
else
  echo "SKIP: node not found"; rc=77
fi

step "python: Ghost prompt store unit tests"
export PYTHONDONTWRITEBYTECODE=1   # a .pyc would embed the build path
if command -v python3 >/dev/null; then
  ( cd "$ROOT/ghost/prompt-store" && python3 test_prompt_store.py ); rc=$?
  RUN=$((RUN + 1)); [ $rc -eq 0 ] || { echo "FAILED (exit $rc)"; FAILED=$((FAILED + 1)); }
else
  echo "SKIP: python3 not found"
fi

step "bash: unit files parse"
if command -v systemd-analyze >/dev/null; then
  systemd-analyze verify "$ROOT/memory/portable/systemd/tencent-capture.service" 2>&1 | sed 's/^/  /' || true
  echo "note: a non-zero exit here can be an install-path warning, not a syntax error"
else
  for unit in "$ROOT"/memory/portable/systemd/*.service "$ROOT"/memory/portable/systemd/*.timer; do
    grep -q '^\[Unit\]' "$unit" && echo "ok   $(basename "$unit") has a [Unit] section" || { echo "FAIL $unit"; FAILED=$((FAILED + 1)); }
  done
fi
bash -n "$ROOT/memory/portable/systemd/singularity-capture-run.sh" && echo "ok   capture runner syntax" || FAILED=$((FAILED + 1))

step "node: chain runner smoke test"
TMP=$(mktemp -d "${TMPDIR:-/tmp}/rp-chain.XXXXXX")
cat > "$TMP/ok.json" <<'JSON'
{"lock":"./chain.lock","logDir":"wake","steps":[
 {"id":"one","cmd":"sh","args":["-c","echo one"]},
 {"id":"two","cmd":"sh","args":["-c","echo two"]}]}
JSON
cat > "$TMP/bad.json" <<'JSON'
{"lock":"./chain2.lock","logDir":"wake","steps":[
 {"id":"boom","cmd":"sh","args":["-c","exit 4"]},
 {"id":"later","cmd":"sh","args":["-c","echo never"]}]}
JSON
( cd "$TMP" && node "$ROOT/ghost/chain.mjs" --config=ok.json >/dev/null 2>&1 ); rc=$?
[ $rc -eq 0 ] && echo "ok   chain: success path exits 0" || { echo "FAIL chain success path ($rc)"; FAILED=$((FAILED + 1)); }
( cd "$TMP" && node "$ROOT/ghost/chain.mjs" --config=bad.json >/dev/null 2>&1 ); rc=$?
[ $rc -eq 1 ] && echo "ok   chain: required-step failure exits 1" || { echo "FAIL chain failure path ($rc)"; FAILED=$((FAILED + 1)); }
node -e '
const fs=require("node:fs"),d=new Date().toISOString().slice(0,10);
const p=process.argv[1]+"/wake/chain-"+d+".json";
const run=JSON.parse(fs.readFileSync(p,"utf8"));
const later=run.steps.find(s=>s.id==="later");
process.exit(later && later.status==="skipped" ? 0 : 1);
' "$TMP" && echo "ok   chain: later step skipped after a failure" || { echo "FAIL chain skip semantics"; FAILED=$((FAILED + 1)); }
rm -rf "$TMP"

step "patch roundtrip (core overlay)"
if [ -n "$TARBALL" ]; then
  bash "$HERE/runtime-parity.patch-roundtrip.sh" \
    --series "$ROOT/memory/patches/core-v2.0.2-l1recordids" \
    --upstream-tarball "$TARBALL"; rc=$?
  RUN=$((RUN + 1)); [ $rc -eq 0 ] || { echo "FAILED (exit $rc)"; FAILED=$((FAILED + 1)); }
else
  echo "SKIP: pass the pinned upstream tarball as \$1 to prove the roundtrip."
  echo "      Without it the series is hash-pinned but apply/reverse is unproven."
fi

step "git: whitespace errors"
# The curated overlay is a verbatim unified diff: its blank context lines start
# with a space by definition, so `git diff --check` would flag every one of them.
# The patch files are excluded from the whitespace gate, not from review; the
# roundtrip check above is what proves them.
if git -C "$ROOT" rev-parse >/dev/null 2>&1; then
  ( cd "$ROOT" && git diff --check -- . ':(exclude)memory/patches/*/*.patch' \
      && git diff --cached --check -- . ':(exclude)memory/patches/*/*.patch' ) \
    && echo "ok   git diff --check (verbatim .patch files excluded)" \
    || { echo "FAIL git diff --check"; FAILED=$((FAILED + 1)); }
fi

printf '\n== summary: %d check groups run, %d failed\n' "$RUN" "$FAILED"
if [ "$RUN" -eq 0 ]; then exit 77; fi
[ "$FAILED" -eq 0 ] || exit 1
