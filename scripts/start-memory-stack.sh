#!/usr/bin/env bash
# Safe wrapper around the byte-exact TencentDB Agent Memory quickstart.
# Redacts key-shaped output and validates auth/verify's data.valid field.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UPSTREAM="$ROOT/memory/upstream"

load_upstream_env() {
  if [[ -f "$UPSTREAM/.env" ]]; then
    set -a
    # shellcheck disable=SC1091
    . "$UPSTREAM/.env"
    set +a
  fi
}
load_upstream_env
ADMIN_KEY_FILE="${MEMORY_CORE_ADMIN_KEY_FILE:-$UPSTREAM/.admin-key}"
if [[ "$ADMIN_KEY_FILE" != /* ]]; then ADMIN_KEY_FILE="$UPSTREAM/$ADMIN_KEY_FILE"; fi

# ── pre-start security preflight: stop wildcard exposure BEFORE it exists ────
# Two layers:
#   1. Creation-time enforcement (preferred): a scoped `docker` CLI shim is put
#      at the front of PATH for the upstream startup invocation ONLY — upstream
#      _lib.sh resolves the Docker CLI with find_docker() (first `docker` on
#      PATH), so the shim re-binds every -p/--publish to 127.0.0.1 before
#      containers are created. Wildcard bindings then CANNOT exist; there is
#      nothing to detect or unwind afterwards. The shim lives in a per-run
#      private directory, never replaces the host's global Docker CLI, and is
#      byte-exact-transparent for every non-run subcommand. Disable with
#      SINGULARITY_ALLOW_WIDE_MEMORY_PORTS=1 (escape hatch below).
#   2. Inventory policy: even with the shim, refuse to start while a
#      PRE-EXISTING tdai-* container holds wildcard bindings (reusing it would
#      re-expose those ports; removal is the operator's call). The shim does
#      not change pre-existing containers — they keep their own bindings.
# Reuse policy check: SINGULARITY_ALLOW_WIDE_MEMORY_PORTS=1 is the only
# operator-controlled escape hatch (see the post-start enforcement below).
ALLOW_WIDE_MEMORY_PORTS=0
if [[ "${SINGULARITY_ALLOW_WIDE_MEMORY_PORTS:-}" == "1" ]]; then ALLOW_WIDE_MEMORY_PORTS=1; fi
BOUNDARY="$ROOT/scripts/memory-port-boundary.sh"
LOOPBACK_SHIM="$ROOT/scripts/memory-loopback-docker.sh"
baseline_file="$(mktemp /tmp/singularity-memory-baseline.XXXXXX)"
shim_dir=""
cleanup() { rm -f "$baseline_file"; [[ -z "$shim_dir" ]] || rm -rf "$shim_dir"; return 0; }
trap cleanup EXIT
if command -v docker >/dev/null 2>&1 && [[ ! -f "$BOUNDARY" ]]; then
  echo 'FAILED: scripts/memory-port-boundary.sh is missing — refusing an unauditable startup while docker is present.' >&2
  echo '        Re-install the Singularity memory wrapper collection (scripts/) or remove docker from PATH.' >&2
  rm -f "$baseline_file"
  exit 1
fi
if command -v docker >/dev/null 2>&1 && [[ ! -f "$LOOPBACK_SHIM" ]]; then
  echo 'FAILED: scripts/memory-loopback-docker.sh is missing — refusing a startup that could publish wildcard host bindings.' >&2
  rm -f "$baseline_file"
  exit 1
fi
if ! command -v docker >/dev/null 2>&1; then
  echo 'note: docker CLI not found — the loopback publishing preflight is deferred to the post-start check on hosts where docker exists.' >&2
else
  if ! "$BOUNDARY" --baseline "$baseline_file"; then
    echo 'FAILED: deployment preflight could not snapshot the container inventory; refusing an unauditable startup.' >&2
    rm -f "$baseline_file"
    exit 1
  fi
  # Bindings of RUNNING containers are authoritative; STOPPED tdai-* containers
  # holding wildcard PortBindings would re-expose their ports on start — refuse
  # before upstream touches anything.
  if [[ "$ALLOW_WIDE_MEMORY_PORTS" != 1 ]]; then
    if ! "$BOUNDARY" --check; then
      cat >&2 <<'EOS'
FAILED: security preflight refused startup — an existing tdai-* container is
bound to the wildcard interface (0.0.0.0/::). Memory services never start in
this state: recreate the offending container(s) with loopback bindings
e.g. "ports: ['127.0.0.1:8420:8420']" (compose) or "-p 127.0.0.1:8420:8420"
(docker run), or set SINGULARITY_ALLOW_WIDE_MEMORY_PORTS=1 ONLY if a host
firewall guarantees the trusted-interface boundary. The agent-facing plugin
speaks to the core over the internal docker network, so loopback is enough.
EOS
      rm -f "$baseline_file"
      exit 1
    fi
    printf 'preflight: no tdai-* container binds wildcard ports\n'
  fi
  # Install the creation-time loopback shim in a PRIVATE per-run directory so
  # upstream `find_docker()` (first `docker` on PATH) resolves the shim for
  # this startup invocation only. Under SINGULARITY_ALLOW_WIDE_MEMORY_PORTS=1
  # the shim is still installed (it honours that variable by passing
  # everything through), keeping the runtime path identical in both modes.
  if [[ "$ALLOW_WIDE_MEMORY_PORTS" != 1 ]]; then
    shim_dir="$(mktemp -d /tmp/singularity-docker-shim.XXXXXX)"
    cp "$LOOPBACK_SHIM" "$shim_dir/docker"
  fi
fi

set +e
(
  cd "$UPSTREAM"
  if [[ -n "$shim_dir" ]]; then
    # Creation-time enforcement: upstream sees the loopback shim as `docker`.
    PATH="$shim_dir:$PATH" ./start-all.sh
  else
    ./start-all.sh
  fi
) 2>&1 | python3 "$ROOT/scripts/redact-memory-startup.py" "$ADMIN_KEY_FILE"
pipeline_status=("${PIPESTATUS[@]}")
set -e
upstream_status="${pipeline_status[0]:-1}"
filter_status="${pipeline_status[1]:-1}"
if [[ "$filter_status" != 0 ]]; then
  echo 'FAILED: safe startup output filter failed; inspect the local Python installation.' >&2
  exit 1
fi
if [[ "$upstream_status" != 0 ]]; then
  printf 'FAILED: upstream memory startup exited with status %s.\n' "$upstream_status" >&2
  exit "$upstream_status"
fi

# ── post-start enforcement: newly created services must never stay exposed ──
# If upstream containers unexpectedly publish wildcard ports at creation time,
# stop ONLY the containers this run created (pre-existing containers are
# untouched) and fail. Never mask a failed preflight with a running service.
if command -v docker >/dev/null 2>&1; then
  if [[ "$ALLOW_WIDE_MEMORY_PORTS" != 1 ]]; then
    if ! "$BOUNDARY" --enforce "$baseline_file"; then
      echo 'FAILED: newly created Memory Core services were stopped: wildcard exposure detected after start.' >&2
      echo '        Recreate with loopback host bindings (see the preflight guidance above).' >&2
      rm -f "$baseline_file"
      exit 1
    fi
  fi
fi
rm -f "$baseline_file"

# ── post-start loopback-only boundary check (kept; runs after enforcement) ───
# The upstream helper checks only HTTP 200; auth/verify also uses HTTP 200 for
# invalid keys. Source the saved endpoint configuration and require data.valid.
load_upstream_env
if [[ ! -s "$ADMIN_KEY_FILE" ]]; then
  echo 'FAILED: admin key file is missing or empty; no key value was displayed.' >&2
  exit 1
fi
chmod 600 "$ADMIN_KEY_FILE"
python3 "$ROOT/scripts/verify-memory-user-key.py" "$ADMIN_KEY_FILE"

# ── deployment boundary: loopback-only host publishing ───────────────────────
# The vendored upstream startup scripts publish MemoryCore (8420), the memory
# hub Panel/Knowledge (:8125/:8424) and the LLM proxy (:8096) on all host
# interfaces, while the default gateway key starts empty. Exposure still
# depends on the host firewall — so enforce the boundary here, on OUR side,
# without forking the byte-exact upstream files. Unless explicitly overridden,
# anything published on the wildcard (0.0.0.0/::) must be re-bound to loopback
# (127.0.0.1) or deserve an explicit escape hatch.
ALLOW_WIDE_MEMORY_PORTS=0
if [[ "${SINGULARITY_ALLOW_WIDE_MEMORY_PORTS:-}" == "1" ]]; then ALLOW_WIDE_MEMORY_PORTS=1; fi
# NOTE: under `set -euo pipefail` a command substitution is fatal when any
# pipeline member exits nonzero (e.g. grep with no matches on hosts whose
# containers are not tdai-*-named), so the loop greps inside the body and only
# `echo` (rc=0) can end it. Wide publishing means the HOST IP is the wildcard
# (see `docker port` output: 8420/tcp -> 0.0.0.0:8420).
wide=""
if command -v docker >/dev/null 2>&1; then
  wide="$(docker ps --format '{{.Names}}' | while read -r name; do
    case "$name" in
      tdai-*)
        docker port "$name" 2>/dev/null | awk -v n="$name" '
          { h = $NF; sub(/:[0-9]+$/, "", h); if (h == "0.0.0.0" || h == "::" || h == "[::]") print n, $0 }
        '
        ;;
    esac
  done
  )"
else
  # No docker CLI on this host: there is no publishing topology to inspect.
  # The boundary check still runs unchanged on any host where docker exists.
  echo 'note: docker CLI not found — the loopback publishing boundary was not checked on this host.' >&2
fi
if [[ -n "$wide" ]]; then
  if [[ "$ALLOW_WIDE_MEMORY_PORTS" == 1 ]]; then
    echo 'WARNING: Memory Core ports are published on the wildcard interface:' >&2
    echo "$wide" >&2
    echo '        continuing because SINGULARITY_ALLOW_WIDE_MEMORY_PORTS=1 — make sure a host firewall enforces the boundary.' >&2
  else
    echo 'FAILED: Memory Core ports are published on the wildcard interface (0.0.0.0/::):' >&2
    echo "$wide" >&2
    cat >&2 <<'EOS'
    The quickstart upstream publishes these on all interfaces by default;
    re-bind them to loopback (e.g. in your own compose override: "ports: ['127.0.0.1:8420:8420']")
    or pass SINGULARITY_ALLOW_WIDE_MEMORY_PORTS=1 ONLY if your host firewall
    guarantees the trusted-interface boundary. The agent-facing plugin speaks
    to the core over the internal docker network, so loopback publishing is
    enough.
EOS
    exit 1
  fi
fi
printf 'boundary ok: Memory Core host publishing is loopback-only\n'
