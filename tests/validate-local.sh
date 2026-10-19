#!/usr/bin/env bash
# Static validation for a checkout of this repository — no containers required.
# Runs: syntax checks, unit tests, JSON/JSONC parse, compose config (when the
# docker CLI is present) and the internal-reference scan.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
fail=0
step() { printf '\n== %s\n' "$*"; }
check() { if "$@"; then :; else fail=1; echo "   ^^ FAILED: $*"; fi; }

step "shell syntax"
for f in memory/upstream/*.sh scripts/*.sh tests/*.sh; do check bash -n "$f"; done

step "python syntax"
for f in scripts/*.py; do check python3 -m py_compile "$f"; done
rm -rf scripts/__pycache__ 2>/dev/null || true

step "node syntax"
for f in scripts/*.mjs openchamber/plugins/product-office/*.js; do check node --check "$f"; done

step "unit tests"
check node --test scripts/cohere-quota.test.mjs
for f in openchamber/plugins/product-office/*.test.mjs; do check node --test "$f"; done

step "json parses"
for f in openchamber/package.json openchamber/plugins/product-office/package.json \
         adapters/claude-code/settings-snippet.json; do
  check node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" "$f"
done

step "jsonc parses (comments stripped)"
for f in openchamber/opencode.jsonc openchamber/dcp.jsonc openchamber/examples/*.jsonc; do
  check node -e "
    const s = require('fs').readFileSync(process.argv[1],'utf8')
      .replace(/\/\*[\s\S]*?\*\//g,'').replace(/^[ \t]*\/\/.*$/gm,'');
    JSON.parse(s);" "$f"
done

step "repoql bundle"
check node -e 'const fs=require("fs");const s=fs.readFileSync("openchamber/opencode.jsonc","utf8").replace(/\/\*[\s\S]*?\*\//g,"").replace(/^[ \t]*\/\/.*$/gm,"");const d=JSON.parse(s);if(!d.mcp||!d.mcp.repoql||d.mcp.repoql.type!=="local")throw new Error("repoql MCP entry missing");if(!JSON.stringify(d.mcp.repoql).includes("rql"))throw new Error("repoql MCP entry must call rql");'
check test -f docs/REPOQL-SETUP.md
check test -f compose/repoql.override.yml
check grep -qi "repoql" openchamber/AGENTS.md

step "compose config (when docker is available)"
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  check env OPENCHAMBER_UI_PASSWORD=validation docker compose -f compose/compose.yml config -q
  check env CLAUDE_OFFICE_ENV_FILE=../templates/product.env.example \
    docker compose -f office/office.compose.yml config -q
  check env OPENCHAMBER_UI_PASSWORD=validation REPOQL_RQL_PATH=/bin/true \
    docker compose -f compose/compose.yml -f compose/repoql.override.yml config -q
  check docker compose -f compose/extraction-failover.compose.yml config -q
else
  echo "   docker not available — skipped"
fi

step "internal-reference scan"
check tests/scan-refs.sh

if [[ $fail -ne 0 ]]; then echo; echo "VALIDATION FAILED"; exit 1; fi
echo; echo "VALIDATION OK"
