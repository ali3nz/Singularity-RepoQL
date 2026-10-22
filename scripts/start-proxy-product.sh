#!/usr/bin/env bash
# start-proxy-product.sh — Singularity wrapper for the vendored upstream
# proxy launcher, without touching the vendored tree.
#
# memory/upstream/ is a byte-exact copy of TencentCloud/TencentDB-Agent-Memory
# v2.0.2 (PROVENANCE.md lists the file checksums; "Local modifications: none").
# The upstream generator writes a minimal proxy config whose /v1/models
# catalog is empty — Singularity's model-lane gate can then never discover a
# model. The needed creditPricing.models section (PROXY_PRICING_MODELS="a,b,c",
# zero prices — the catalog is discovery, not billing) is injected on a COPY
# of the vendored script and the copy is executed. The canonical injection
# text lives OUTSIDE the vendored directory in scripts/proxy-pricing-block.sh;
# the vendored original is never modified.
#
# Usage: scripts/start-proxy-product.sh [--emit-patched OUT] [upstream args...]
#   --emit-patched OUT   write the generated patched copy to OUT instead of
#                        running it (used by the byte-parity test)
# Requires the same env as upstream start-proxy.sh (PROXY_IMAGE, PROXY_PORT,
# PROXY_UPSTREAM_URL/API_KEY/MODEL; optional PROXY_PRICING_MODELS).

set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO_ROOT/memory/upstream/start-proxy.sh"
GEN="$REPO_ROOT/scripts/proxy-pricing-block.sh"
PROV="$REPO_ROOT/memory/upstream/PROVENANCE.md"

# Guard: refuse to run over a drifted vendored file (pair with PROVENANCE).
WANT="$(awk -F'`' '$2 ~ /start-proxy\.sh/ {print $4; exit}' "$PROV")"
HAVE="$(sha256sum "$SRC" | cut -d" " -f1)"
if [[ "$WANT" != "$HAVE" ]]; then
  echo "start-proxy-product.sh: vendored start-proxy.sh drifted from provenance (have $HAVE, provenance $WANT) — refusing" >&2
  exit 2
fi
[[ -f "$GEN" ]] || { echo "start-proxy-product.sh: missing $GEN" >&2; exit 2; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
OUT="$TMP/start-proxy.sh"

python3 - "$SRC" "$GEN" "$OUT" <<'PYEOF'
import sys

src, gen, out = sys.argv[1], sys.argv[2], sys.argv[3]
lines = open(src, encoding="utf-8").read().split("\n")
GEN_TEXT = open(gen, encoding="utf-8").read().rstrip("\n")

GEN_ANCHOR = 'info "生成 proxy config'
GUARD_KEY = "costGuard:"
GUARD_VAL = "enabled: false"

res = []
gen_inserted = False
guard_injected = False
for line in lines:
    # 1) insert the PROXY_PRICING_MODELS generation block right before the
    #    upstream config-generation info line (once).
    if not gen_inserted and line.startswith(GEN_ANCHOR):
        gen_inserted = True
        res.extend(GEN_TEXT.split("\n"))
        res.append("")
        res.append(line)
        continue

    # 2) insert the ${CREDIT_PRICING_BLOCK} reference into the generated
    #    YAML: at the blank line that follows `costGuard:`/`enabled: false`
    #    inside the heredoc (once).
    if (not guard_injected and line == "" and len(res) >= 2
            and res[-2] == GUARD_KEY and res[-1].strip() == GUARD_VAL):
        guard_injected = True
        res.append(line)
        res.append("${CREDIT_PRICING_BLOCK}")
        res.append("")
        continue

    res.append(line)

if not gen_inserted or not guard_injected:
    sys.stderr.write(
        "start-proxy-product.sh: injection anchors not found in the vendored "
        "start-proxy.sh — upstream layout changed; update the wrapper\n")
    sys.exit(3)

open(out, "w", encoding="utf-8").write("\n".join(res))
PYEOF

if [[ "${1:-}" == "--emit-patched" ]]; then
  shift
  cp "$OUT" "$1"
  exit 0
fi

exec bash "$OUT" "$@"
