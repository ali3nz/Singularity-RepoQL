#!/usr/bin/env bash
# Live RepoQL integration checks for this repository variant.
# Run after scripts/start.sh (needs Docker and a running OpenChamber stack).
set -uo pipefail

CONTAINER="${OPENCHAMBER_CONTAINER:-singularity-openchamber}"
fail=0
ok()  { printf 'ok   — %s\n' "$*"; }
bad() { printf 'FAIL — %s\n' "$*"; fail=1; }

if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "container $CONTAINER not found — run scripts/start.sh first"
  exit 2
fi

echo "== 1. rql in the container =="
if ver="$(docker exec "$CONTAINER" rql --version 2>/dev/null)" && [ -n "$ver" ]; then
  ok "rql $ver"
else
  bad "rql is not runnable in $CONTAINER — apply compose/repoql.override.yml with REPOQL_RQL_PATH set"
fi

echo "== 2. host status verdict =="
out="$(docker exec "$CONTAINER" rql host status 2>&1 || true)"
echo "$out" | head -4
case "$out" in
  *"ready"*|*"loading"*|*"usable"*|*"no host"*) ok "host status reports a normal state" ;;
  *) bad "unexpected rql host status output" ;;
esac

echo "== 3. MCP stdio handshake (against a scratch repository) =="
RUNTIME="$(docker exec "$CONTAINER" sh -lc 'command -v node || command -v bun' 2>/dev/null || true)"
if [ -z "${RUNTIME:-}" ]; then
  echo "note — no node/bun in $CONTAINER; skipping the handshake check"
else
  # The first MCP request starts an implicit host for the workspace it runs
  # in, so the handshake runs in a scratch repository, not the user project.
  docker exec "$CONTAINER" sh -lc 'rm -rf /tmp/repoql-validate-scratch; mkdir -p /tmp/repoql-validate-scratch; cd /tmp/repoql-validate-scratch; if command -v git >/dev/null 2>&1; then git init -q; git -c user.name=validate -c user.email=validate@example.invalid commit -q --allow-empty -m init; else rql init 2>/dev/null || true; fi' || true
  docker exec "$CONTAINER" sh -c 'cat > /tmp/repoql-mcp-check.js' <<'JS'
const { spawn } = require("child_process");
const NL = String.fromCharCode(10);
const p = spawn("rql", ["mcp"], { stdio: ["pipe", "pipe", "pipe"] });
const state = { data: "", settled: false };
const bail = function (msg) { console.error(msg); p.kill(); process.exit(2); };
setTimeout(function () { if (!state.settled) bail("timeout — no MCP response from rql mcp"); }, 20000);
p.stdout.on("data", function (d) {
  if (state.settled) return;
  state.data += d.toString();
  if (state.data.indexOf("serverInfo") !== -1) {
    state.settled = true;
    console.log(state.data.split(NL).filter(function (l) { return l.indexOf("serverInfo") !== -1; })[0].slice(0, 200));
    p.kill(); process.exit(0);
  }
});
p.stderr.on("data", function () {});
p.on("error", function (e) { bail(e.message); });
p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "validate-repoql", version: "0" } } }) + NL);
JS
  if docker exec "$CONTAINER" sh -lc 'cd /tmp/repoql-validate-scratch && '"$RUNTIME"' /tmp/repoql-mcp-check.js'; then
    ok "MCP initialize answered"
  else
    bad "no MCP response from rql mcp"
  fi
fi

echo
if [ $fail -eq 0 ]; then echo "REPOQL VALIDATION OK"; else echo "REPOQL VALIDATION FAILED"; exit 1; fi
