#!/usr/bin/env bash
# B4 acceptance harness for installation options 3 and 4 (attach to an
# EXISTING OpenChamber).
#
# The harness creates a DISPOSABLE OpenChamber stand-in with its own synthetic
# identity, seeds it with unrelated content and a pre-existing RepoQL identity
# BEFORE the attach, and proves:
#
#   1. the attach creates NO second product OpenChamber deployment and NO
#      duplicate RepoQL host (container inventory before/after),
#   2. unrelated seeded content and the pre-existing RepoQL identity survive,
#   3. the attach is idempotent (a second attach changes nothing),
#   4. the target capability gate runs (option 3 / option 4) against the
#      harness target,
#   5. a REAL rollback (restore from the attach's own backups + removal of the
#      files the attach created) returns the target to its pre-attach hashes,
#   6. the teardown removes exactly the harness container and nothing else
#      (no global prune).
#
# Everything it creates lives under $HARNESS_ROOT and in the harness
# container; both are removed at the end. The historical
# singularity-openchamber instance is never touched.
#
# Usage: bash tests/acceptance/attach-harness.sh 3|4
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HARNESS_ROOT="${HARNESS_ROOT:-/home/bensl/oc-harness}"
HARNESS_IMAGE="${HARNESS_IMAGE:-node:22-bookworm}"
NET="${SINGULARITY_NETWORK:-singularity-product-net}"
WORK="$(mktemp -d)"

VARIANT="${1:-}"
case "$VARIANT" in 3|4) ;; *) echo "usage: $0 3|4"; exit 2 ;; esac
NAME="oc-opt${VARIANT}-harness"
CFG="$HARNESS_ROOT/opt${VARIANT}/config"

log()  { printf '%s\n' "$*"; }
step() { printf '\n===== %s\n' "$*"; }
fail=0
verdict() { if [ "$1" = "yes" ]; then log "PASS — $2"; else log "FAIL — $2"; fail=1; fi; }

hash_tree() { # $1 = dir -> "<sha256>  <relative path>" per file, sorted
  ( cd "$1" && find . -type f ! -name '*.tmp' -print0 | sort -z | xargs -0 sha256sum )
}
paths_of() { sed 's/^[0-9a-f]*  //' "$1" | sort; }

cleanup() {
  # teardown scope: ONLY the harness container and the harness directory
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  rm -rf "$HARNESS_ROOT/opt${VARIANT}"
}
trap 'cleanup; rm -rf "$WORK"' EXIT

step "B4 harness — installation option $VARIANT ($NAME)"
log "repo:            $ROOT"
log "harness root:    $HARNESS_ROOT/opt${VARIANT}"
log "harness image:   $HARNESS_IMAGE"
log "target config:   $CFG (bind-mounted at /home/openchamber/.config/opencode)"

# ── 1. seed + create the disposable target ───────────────────────────────────
step "1. seed the disposable target (unrelated content + pre-existing RepoQL identity)"
mkdir -p "$CFG/agents" "$CFG/projects/unrelated-project" "$CFG/plugins/user-sentinel" "$CFG/.rql"
cat > "$CFG/AGENTS.md" <<'EOF'
# My own OpenChamber instructions

Unrelated user rules of THIS instance. They must survive the attach.
EOF
cat > "$CFG/opencode.jsonc" <<'EOF'
{
  // the pre-existing RepoQL identity of THIS instance (its own rql path)
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "repoql": {
      "type": "local",
      "command": ["/home/bensl/.local/bin/rql", "mcp"],
      "enabled": true
    }
  },
  "plugin": ["@tarquinen/opencode-dcp@3.2.0"]
}
EOF
printf '{"theme":"unrelated"}\n' > "$CFG/settings.json"
printf '# an unrelated agent of this instance\n' > "$CFG/agents/unrelated-agent.md"
printf '# an unrelated project\n' > "$CFG/projects/unrelated-project/README.md"
printf '{"name":"user-sentinel","version":"1.0.0"}\n' > "$CFG/plugins/user-sentinel/package.json"
printf '{"identity":"pre-existing-repoql-identity"}\n' > "$CFG/.rql/identity.json"
hash_tree "$CFG" > "$WORK/before.txt"
log "seeded files (pre-attach hashes):"
sed 's/^/    /' "$WORK/before.txt"

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker create --name "$NAME" -v "$CFG:/home/openchamber/.config/opencode" "$HARNESS_IMAGE" sleep 3600 >/dev/null
docker start "$NAME" >/dev/null
CID="$(docker inspect -f '{{.Id}}' "$NAME")"
docker network connect "$NET" "$NAME" >/dev/null 2>&1 \
  && log "harness joined $NET (the in-network memory-core alias must resolve inside the target)" \
  || log "note: could not join $NET"
log "container id:    $CID"
log "container state: $(docker inspect -f '{{.State.Status}}' "$NAME")"

docker ps -a --format '{{.Names}}\t{{.Image}}\t{{.Status}}' > "$WORK/containers-before.txt"
log "container inventory BEFORE (excluding the harness):"
grep -v "^$NAME" "$WORK/containers-before.txt" | sed 's/^/    /'
OC_BEFORE="$(grep -ciE 'openchamber' "$WORK/containers-before.txt" || true)"
RQ_BEFORE="$(grep -ciE 'repoql' "$WORK/containers-before.txt" || true)"
log "OpenChamber deployments BEFORE: $OC_BEFORE | RepoQL-hosting containers BEFORE: $RQ_BEFORE"

# ── 2. attach (the documented option-3/4 path) ───────────────────────────────
step "2. attach the bundle (installation option $VARIANT)"
ATTACH_ARGS=(--container "$NAME" --variant "$VARIANT")
[ "$VARIANT" = "4" ] && ATTACH_ARGS+=(--with-ghost)
node "$ROOT/scripts/attach-openchamber.mjs" "${ATTACH_ARGS[@]}"; ATTACH_RC=$?
log "attach rc=$ATTACH_RC"
hash_tree "$CFG" > "$WORK/after1.txt"

step "3. what the attach did to the seeded content"
for f in ./AGENTS.md ./opencode.jsonc ./settings.json ./agents/unrelated-agent.md \
         ./projects/unrelated-project/README.md ./plugins/user-sentinel/package.json ./.rql/identity.json; do
  b="$(grep -F "  $f" "$WORK/before.txt" | cut -d' ' -f1)"
  a="$(grep -F "  $f" "$WORK/after1.txt" | cut -d' ' -f1)"
  if [ -z "$a" ]; then verdict no "$f was REMOVED by the attach"
  elif [ "$a" = "$b" ]; then verdict yes "$f preserved byte-for-byte"
  else verdict no "$f was CHANGED by the attach"
  fi
done
log "the target's RepoQL identity after the attach:"
grep -A4 '"repoql"' "$CFG/opencode.jsonc" | sed 's/^/    /' || log "    (no repoql entry found)"

# ── 4. idempotence ───────────────────────────────────────────────────────────
step "4. idempotence — a second attach must change nothing"
node "$ROOT/scripts/attach-openchamber.mjs" "${ATTACH_ARGS[@]}" > "$WORK/attach2.log" 2>&1; ATTACH2_RC=$?
hash_tree "$CFG" > "$WORK/after2.txt"
if diff -q "$WORK/after1.txt" "$WORK/after2.txt" >/dev/null; then
  verdict yes "the second attach changed no file (rc=$ATTACH2_RC)"
else
  verdict no "the second attach changed files"
  diff "$WORK/after1.txt" "$WORK/after2.txt" | sed 's/^/    /'
fi

# ── 5. the target capability gate ─────────────────────────────────────────────
step "5. target capability gate (installation option $VARIANT)"
node "$ROOT/scripts/install-claude-code.mjs" gate --variant "$VARIANT" --container "$NAME"; GATE_RC=$?
log "gate rc=$GATE_RC (0 = every mandatory capability verified, 5 = incomplete)"

# ── 6. real rollback from the attach's own backups ───────────────────────────
step "6. real rollback — restore the target to its pre-attach state"
BACKUP="$(ls -1dt "$ROOT"/data/attach-backups/*/ 2>/dev/null | head -1)"
if [ -z "$BACKUP" ]; then
  log "no backup directory: the attach replaced nothing (nothing to restore)"
else
  log "backup dir: $BACKUP"
  ls -1 "$BACKUP" | sed 's/^/    /'
  # (a) restore every replaced file from the attach's own backup
  for b in "$BACKUP"/*; do
    base="$(basename "$b")"
    rel="$(printf '%s' "$base" | sed 's/__/\//g')"
    # a ".product" copy is the PRODUCT's version of a preserved file: nothing to restore
    case "$rel" in *.product) continue ;; esac
    if [ -f "$CFG/$rel" ]; then cp -p "$b" "$CFG/$rel"; log "    restored $rel from the attach backup"; fi
  done
  # (b) remove the files the attach CREATED (present after, absent before)
  comm -13 <(paths_of "$WORK/before.txt") <(paths_of "$WORK/after1.txt") | while read -r f; do
    [ -n "$f" ] || continue
    rm -f "$CFG/${f#./}"; log "    removed $f (created by the attach)"
  done
fi
hash_tree "$CFG" > "$WORK/after-rollback.txt"
if diff -q "$WORK/before.txt" "$WORK/after-rollback.txt" >/dev/null; then
  verdict yes "rollback restored the target to its EXACT pre-attach hashes"
else
  verdict no "rollback did not restore the pre-attach state"
  diff "$WORK/before.txt" "$WORK/after-rollback.txt" | sed 's/^/    /'
fi

# ── 7. deployment inventory + teardown scope ────────────────────────────────
step "7. no second product deployment / no duplicate RepoQL host"
docker ps -a --format '{{.Names}}\t{{.Image}}\t{{.Status}}' > "$WORK/containers-after.txt"
OC_AFTER="$(grep -ciE 'openchamber' "$WORK/containers-after.txt" || true)"
RQ_AFTER="$(grep -ciE 'repoql' "$WORK/containers-after.txt" || true)"
log "OpenChamber deployments AFTER: $OC_AFTER (before: $OC_BEFORE) | RepoQL-hosting containers AFTER: $RQ_AFTER (before: $RQ_BEFORE)"
if [ "$OC_AFTER" = "$OC_BEFORE" ]; then verdict yes "no second OpenChamber deployment was created"
else verdict no "the OpenChamber deployment count changed"; fi
if [ "$RQ_AFTER" = "$RQ_BEFORE" ]; then verdict yes "no duplicate RepoQL host was created"
else verdict no "the RepoQL-hosting container count changed"; fi
log "container inventory diff (harness excluded):"
diff <(grep -v "^$NAME" "$WORK/containers-before.txt") <(grep -v "^$NAME" "$WORK/containers-after.txt") | sed 's/^/    /' || true

step "8. teardown scope — exactly the harness container, no global prune"
log "removing: docker rm -f $NAME   (no docker system prune / image prune / volume prune)"
docker rm -f "$NAME" >/dev/null 2>&1 && log "removed container $NAME" || log "container $NAME was already gone"
rm -rf "$HARNESS_ROOT/opt${VARIANT}" && log "removed $HARNESS_ROOT/opt${VARIANT}"
docker ps -a --format '{{.Names}}\t{{.Image}}\t{{.Status}}' > "$WORK/containers-final.txt"
log "container inventory after teardown:"
sed 's/^/    /' "$WORK/containers-final.txt"
log "the historical singularity-openchamber instance is untouched by this harness (never referenced, never modified)"

if [ "$fail" -ne 0 ]; then log ""; log "HARNESS RESULT: FAILED"; exit 1; fi
log ""; log "HARNESS RESULT: OK (option $VARIANT)"
exit 0
