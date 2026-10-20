#!/usr/bin/env bash
# Deployment boundary for the TencentDB Agent Memory stack: loopback-only
# host publishing by default, enforced BEFORE services become externally
# reachable and re-checked after startup — a failed preflight must never leave
# freshly created containers running exposed.
#
# Modes:
#   --check             List tdai-* port bindings published on the wildcard
#                       interface (0.0.0.0/::/::). rc=1 when any exist.
#                       Covers RUNNING containers (via `docker port`) AND
#                       STOPPED containers (via HostConfig.PortBindings,
#                       because reusing them would re-expose the same ports).
#   --baseline <file>   Write the current tdai-* container names (one per line)
#                       so a later enforcement pass can identify what THIS run
#                       created.
#   --enforce <baseline>  Stop ONLY containers created since the baseline that
#                       publish wildcard ports (unset pre-existing containers
#                       are never touched). rc=1 when something was stopped.
#
# Wide exposure stays available ONLY through SINGULARITY_ALLOW_WIDE_MEMORY_PORTS=1
# (checked by the caller, scripts/start-memory-stack.sh) — this tool refuses
# wide bindings unconditionally so its caller decides policy.
set -euo pipefail

tdai_containers() {
  docker ps -a --format '{{.Names}}' 2>/dev/null | grep '^tdai-' || true
}

# Print "<container>:<binding>" for every wildcard-published port.
# NOTE: the wildcard hosts are compared as PLAIN STRINGS — `awk -v re="$re"`
# escape-processes variable values differently across awk variants (mawk
# strips `\.` / `\[`), so a regex handed in via a variable is not portable.
wide_bindings() {
  for name in $(tdai_containers); do
    # RUNNING containers: docker port shows the actual host bindings.
    if docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null | grep -q '^true$'; then
      docker port "$name" 2>/dev/null | awk -v n="$name" \
        '{ h = $NF; sub(/:[0-9]+$/, "", h);
           if (h == "" || h == "0.0.0.0" || h == "::" || h == "[::]") print n ":" $0 }'
    else
      # STOPPED containers: inspect their intended publishing config so a
      # `start` of such a container cannot surprise-expose ports.
      docker inspect -f '{{json .HostConfig.PortBindings}}' "$name" 2>/dev/null \
        | awk -v n="$name" \
          '{ while (match($0, /"HostIp":"[^"]*"/)) {
               ip = substr($0, RSTART + 10, RLENGTH - 11);
               if (ip == "" || ip == "0.0.0.0" || ip == "::" || ip == "[::]") { print n ":stopped-binding(" ip ")"; }
               $0 = substr($0, RSTART + RLENGTH);
             } }'
    fi
  done
}

case "${1:-}" in
  --check)
    wide="$(wide_bindings)"
    if [[ -n "$wide" ]]; then
      echo "WIDE-PUBLISH: tdai containers publish ports on the wildcard interface:" >&2
      printf '%s\n' "$wide" >&2
      exit 1
    fi
    exit 0 ;;
  --baseline)
    tdai_containers > "${2:?usage: $0 --baseline <file>}"
    exit 0 ;;
  --enforce)
    base="${2:?usage: $0 --enforce <baseline-file>}"
    declare -A old=()
    while read -r n; do [[ -n "$n" ]] && old[$n]=1; done < "$base"
    stopped=0
    wide="$(wide_bindings)"
    while read -r line; do
      [[ -z "$line" ]] && continue
      n="${line%%:*}"
      [[ -n "${old[$n]:-}" ]] && continue  # pre-existing container: never touch
      docker stop "$n" >/dev/null 2>&1 || true
      echo "stopped newly created container with wildcard exposure: $n" >&2
      stopped=$((stopped + 1))
    done <<< "$wide"
    [[ "$stopped" -gt 0 ]] && exit 1
    exit 0 ;;
  *)
    echo "usage: $(basename "$0") --check | --baseline <file> | --enforce <baseline-file>" >&2
    exit 2 ;;
esac
