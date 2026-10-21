#!/usr/bin/env bash
# tests/memory-loopback-docker.test.sh — regression tests for the scoped docker
# CLI shim used by scripts/start-memory-stack.sh to enforce loopback-only host
# publishing BEFORE container creation (§3, requirement 7).
#
# Covers:
#   --rewrite-spec:  wildcard/implicit/empty host sides → 127.0.0.1; explicit
#                    hosts (loopback, interface IP, [::1]) untouched; ranges,
#                    protocols, ephemeral ports preserved; escape hatch passes
#                    everything through.
#   Full shim:       run invocations re-shaped before the real CLI sees them;
#                    non-run subcommands pass through verbatim; -P refused
#                    without touching the real CLI; escape-hatch passthrough; a
#                    `docker` symlink into the shim's own dir never resolved.
# Run: tests/memory-loopback-docker.test.sh
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SHIM="$ROOT/scripts/memory-loopback-docker.sh"

pass=0; fail=0
ok()  { pass=$((pass + 1)); echo "ok    - $1"; }
bad() { fail=$((fail + 1)); echo "NOT OK - $1"; }
eq()  { if [[ "$1" == "$2" ]]; then ok "$3"; else bad "$3 — want [$2], got [$1]"; fi; }

# ---- --rewrite-spec mode -----------------------------------------------------
eq "$(bash "$SHIM" --rewrite-spec '8420:8420')"           '127.0.0.1:8420:8420'  "implicit host: 8420:8420 re-bound"
eq "$(bash "$SHIM" --rewrite-spec '8420:8420/udp')"       '127.0.0.1:8420:8420/udp' "implicit host with protocol re-bound"
eq "$(bash "$SHIM" --rewrite-spec '8420')"                '127.0.0.1::8420'      "container-only publish gets loopback + ephemeral"
eq "$(bash "$SHIM" --rewrite-spec '0.0.0.0:8420:8420')"   '127.0.0.1:8420:8420'  "explicit wildcard IPv4 re-bound"
eq "$(bash "$SHIM" --rewrite-spec '[::]:8420:8420')"      '127.0.0.1:8420:8420'  "explicit wildcard IPv6 re-bound"
eq "$(bash "$SHIM" --rewrite-spec '::8420:8420')"         '127.0.0.1:8420:8420'  "unbracketed :: host re-bound"
eq "$(bash "$SHIM" --rewrite-spec ':8420:8420')"          '127.0.0.1:8420:8420'  "empty host re-bound"
eq "$(bash "$SHIM" --rewrite-spec '8100-8110:8100-8110')" '127.0.0.1:8100-8110:8100-8110' "port range preserved"
eq "$(bash "$SHIM" --rewrite-spec '127.0.0.1:8420:8420')" '127.0.0.1:8420:8420'  "loopback host untouched"
eq "$(bash "$SHIM" --rewrite-spec '127.0.0.1::8420')"     '127.0.0.1::8420'      "loopback ephemeral untouched"
eq "$(bash "$SHIM" --rewrite-spec '198.51.100.7:8096:8096')" '198.51.100.7:8096:8096' "explicit interface IP untouched"
eq "$(bash "$SHIM" --rewrite-spec '[::1]:8420:8420')"     '[::1]:8420:8420'      "explicit IPv6 loopback untouched"
eq "$(SINGULARITY_ALLOW_WIDE_MEMORY_PORTS=1 bash "$SHIM" --rewrite-spec '8420:8420')"       '8420:8420'         "escape hatch passes implicit binding through"
eq "$(SINGULARITY_ALLOW_WIDE_MEMORY_PORTS=1 bash "$SHIM" --rewrite-spec '0.0.0.0:8420:8420')" '0.0.0.0:8420:8420' "escape hatch passes explicit wildcard through"

# ---- full-shim behavior against a stubbed real docker ------------------------
# The shim is placed under the name `docker` in its own dir (as
# start-memory-stack.sh does); the real docker records its NUL-separated argv
# into $REC.
REC="$(mktemp)"; : > "$REC"; export REC
real_dir="$(mktemp -d "${TMPDIR:-/tmp}/shimtest-real.XXXXXX")"
shim_dir="$(mktemp -d "${TMPDIR:-/tmp}/shimtest-shim.XXXXXX")"
cat > "$real_dir/docker" <<'EOF'
#!/usr/bin/env bash
printf '%s\0' "$@" >> "$REC"
EOF
chmod +x "$real_dir/docker"
cp "$SHIM" "$shim_dir/docker"; chmod +x "$shim_dir/docker"

E="PATH=$shim_dir:$real_dir:\$PATH REC=\$REC"   # env(1) prefixes
argv_line() { tr '\0' '\n' < "$REC" | paste -sd' '; }

env PATH="$shim_dir:$real_dir:$PATH" REC="$REC" "$shim_dir/docker" run \
  -d --name c1 --network tdai-mem --network-alias memory-core \
  -p 8420:8420 -p 8125:8125 --publish=8096:8096 -e VAR=1 img:tag
eq "$(argv_line)" \
  "run -d --name c1 --network tdai-mem --network-alias memory-core -p 127.0.0.1:8420:8420 -p 127.0.0.1:8125:8125 --publish=127.0.0.1:8096:8096 -e VAR=1 img:tag" \
  "docker run: every publish mapping re-shaped before the real CLI"

: > "$REC"
env PATH="$shim_dir:$real_dir:$PATH" REC="$REC" "$shim_dir/docker" run -p 8420:8420/udp img:tag
eq "$(argv_line)" "run -p 127.0.0.1:8420:8420/udp img:tag" "protocol preserved"

: > "$REC"
env PATH="$shim_dir:$real_dir:$PATH" REC="$REC" "$shim_dir/docker" ps -a --format '{{.Names}}'
eq "$(argv_line)" "ps -a --format {{.Names}}" "ps subcommand untouched"

: > "$REC"
env PATH="$shim_dir:$real_dir:$PATH" REC="$REC" "$shim_dir/docker" inspect -f T tdai-memory-core
eq "$(argv_line)" "inspect -f T tdai-memory-core" "inspect subcommand untouched"

: > "$REC"
if env PATH="$shim_dir:$real_dir:$PATH" REC="$REC" "$shim_dir/docker" run -P -d img:tag >/dev/null 2>&1; then
  bad "-P should be refused"
else ok "-P refused"; fi
eq "$(argv_line)" "" "-P refusal never reached the real docker CLI"

: > "$REC"
if env PATH="$shim_dir:$real_dir:$PATH" REC="$REC" "$shim_dir/docker" run --publish-all img:tag >/dev/null 2>&1; then
  bad "--publish-all should be refused"
else ok "--publish-all refused"; fi
eq "$(argv_line)" "" "--publish-all refusal never reached the real docker CLI"

: > "$REC"
env PATH="$shim_dir:$real_dir:$PATH" REC="$REC" SINGULARITY_ALLOW_WIDE_MEMORY_PORTS=1 "$shim_dir/docker" run -p 8420:8420 img:tag
eq "$(argv_line)" "run -p 8420:8420 img:tag" "escape hatch: bindings pass through unchanged"

# A `docker` entry symlinked INTO the shim's own directory is never resolved as
# the real CLI (loop protection) — resolution reaches the real dir instead.
alias_dir="$(mktemp -d "${TMPDIR:-/tmp}/shimtest-alias.XXXXXX")"
ln -s "$SHIM" "$alias_dir/docker"
: > "$REC"
env PATH="$shim_dir:$alias_dir:$real_dir:$PATH" REC="$REC" "$shim_dir/docker" ps >/dev/null
eq "$(argv_line)" "ps" "docker symlinked into the shim dir is not mistaken for the real CLI"

# Cleanup
rm -rf "$real_dir" "$shim_dir" "$alias_dir" "$REC"

echo "pass=$pass failures=$fail"
[[ "$fail" -eq 0 ]]
