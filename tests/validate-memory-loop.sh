#!/usr/bin/env bash
# End-to-end check of the memory loop against a running installation.
#
# Proves three things with real API calls to the local Memory Core:
#   1. capture   — a conversation unit can be added
#   2. retrieval — the unit is searchable back out
#   3. knowledge — propose → promote → index → searchable
#
# Requires the memory stack running and plugin secrets provisioned:
#   python3 scripts/provision-secrets.py
# Run from the repository root:  tests/validate-memory-loop.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
MEMORY_BASE="${MEMORY_BASE_URL:-http://127.0.0.1:8420}"
MEMORY_SECRETS="${MEMORY_SECRETS:-$ROOT/data/opencode/config/product-secrets/memory.json}"
MARKER="loopcheck-$(date -u +%Y%m%dT%H%M%SZ)"

fail() { echo "FAIL: $*"; exit 1; }

[[ -f "$MEMORY_SECRETS" ]] || fail "plugin secrets missing: $MEMORY_SECRETS (run scripts/provision-secrets.py)"

echo "== 1/3 capture: add a conversation unit ($MARKER)"
MEMORY_BASE="$MEMORY_BASE" MEMORY_SECRETS="$MEMORY_SECRETS" MARKER="$MARKER" python3 - <<'PY'
import json, os, time, urllib.request
base = os.environ["MEMORY_BASE"]; cfg = json.load(open(os.environ["MEMORY_SECRETS"])); marker = os.environ["MARKER"]
scope = {"team_id": "loop-check", "user_id": "loop-check", "agent_id": "loop-check"}
now = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
req = urllib.request.Request(base.rstrip("/") + "/v3/conversation/add",
    data=json.dumps({**scope, "session_id": "loop-check", "task_id": marker, "messages": [
        {"role": "user", "content": f"Loop check marker {marker}.", "recorded_at": now},
        {"role": "assistant", "content": f"Acknowledged {marker}.", "recorded_at": now},
    ]}).encode(),
    headers={"Content-Type": "application/json",
             "Authorization": cfg.get("authPrefix", "") + cfg.get("gatewayKey", ""),
             "x-tdai-service-id": cfg.get("serviceId", ""),
             "x-tdai-user-key": cfg.get("userKey", "")})
with urllib.request.urlopen(req, timeout=15) as r:
    json.loads(r.read().decode())
print("   add: ok")
PY

echo "== 2/3 retrieval: search the marker back"
MEMORY_BASE="$MEMORY_BASE" MEMORY_SECRETS="$MEMORY_SECRETS" MARKER="$MARKER" python3 - <<'PY'
import json, os, time, urllib.request
base = os.environ["MEMORY_BASE"]; cfg = json.load(open(os.environ["MEMORY_SECRETS"])); marker = os.environ["MARKER"]
scope = {"team_id": "loop-check", "user_id": "loop-check", "agent_id": "loop-check"}
def search():
    req = urllib.request.Request(base.rstrip("/") + "/v3/conversation/search",
        data=json.dumps({**scope, "query": marker, "limit": 5}).encode(),
        headers={"Content-Type": "application/json",
                 "Authorization": cfg.get("authPrefix", "") + cfg.get("gatewayKey", ""),
                 "x-tdai-service-id": cfg.get("serviceId", ""),
                 "x-tdai-user-key": cfg.get("userKey", "")})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read().decode())
deadline = time.time() + 30
while True:
    msgs = (search().get("data") or {}).get("messages") or []
    if any(marker in (m.get("content") or "") for m in msgs):
        print("   search: marker found — capture and retrieval work")
        break
    if time.time() > deadline:
        raise SystemExit("marker not searchable after 30 s")
    time.sleep(3)
PY

echo "== 3/3 knowledge loop: propose → promote → index → search"
TMP_SRC="${TMPDIR:-/tmp}/loop-check-source.$$"
echo "Source record for the loop check ($MARKER)." > "$TMP_SRC"
PROPOSAL="$(MEMORY_SECRETS="$MEMORY_SECRETS" python3 scripts/knowledge-promotion.py \
  --propose "Loop check $MARKER" "The memory loop validated on $MARKER." "$TMP_SRC" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["proposal"])')"
PROMOTE_OUT="$(KNOWLEDGE_INDEX_BASE_URL="$MEMORY_BASE" MEMORY_SECRETS="$MEMORY_SECRETS" \
  python3 scripts/knowledge-promotion.py --promote "$PROPOSAL" --truth-name "loop-check-$MARKER")"
echo "   $PROMOTE_OUT"
echo "$PROMOTE_OUT" | python3 -c '
import json, sys
d = json.load(sys.stdin)
assert d.get("ok"), d
idx = d.get("index") or {}
assert idx.get("indexed") or idx.get("reason") == "already-indexed", idx
print("   promote: ok, indexed")' || fail "knowledge promotion indexing failed"
rm -f "$TMP_SRC"

MEMORY_BASE="$MEMORY_BASE" MEMORY_SECRETS="$MEMORY_SECRETS" MARKER="$MARKER" python3 - <<'PY'
import json, os, time, urllib.request
base = os.environ["MEMORY_BASE"]; cfg = json.load(open(os.environ["MEMORY_SECRETS"])); marker = os.environ["MARKER"]
scope = {"team_id": "knowledge", "user_id": "operator", "agent_id": "knowledge-promotion"}
def search():
    req = urllib.request.Request(base.rstrip("/") + "/v3/conversation/search",
        data=json.dumps({**scope, "query": "kpromo-", "limit": 5}).encode(),
        headers={"Content-Type": "application/json",
                 "Authorization": cfg.get("authPrefix", "") + cfg.get("gatewayKey", ""),
                 "x-tdai-service-id": cfg.get("serviceId", ""),
                 "x-tdai-user-key": cfg.get("userKey", "")})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read().decode())
deadline = time.time() + 30
while True:
    msgs = (search().get("data") or {}).get("messages") or []
    if any("kpromo-" in (m.get("content") or "") and marker in (m.get("content") or "") for m in msgs):
        print("   knowledge index: promoted note searchable")
        break
    if time.time() > deadline:
        raise SystemExit("promoted knowledge note not searchable after 30 s")
    time.sleep(3)
PY

echo
echo "LOOP OK — capture, retrieval and knowledge promotion verified."
echo
echo "Manual step (LLM path): chat in OpenChamber, then confirm the session"
echo "appears in the Panel (http://127.0.0.1:8125) and, after extraction, is"
echo "recalled in a following conversation."
