// lib/memorycore-client.mjs — ticket 736 (operator unified knowledge/memory plan).
// The ONE bounded, read-only Tencent MemoryCore retrieval boundary for kit
// context packs. Mirrors lib/repoql-client.mjs shape: every op returns
// { ok:true, ... } or { ok:false, code } — NEVER throws; a MemoryCore outage
// degrades like RepoQL trouble and never blocks a pack (fail-open).
//
// Installed interface (verified live on controller 2026-10-19, ticket 726/732):
//   Hub panel  POST :8125 /api/v1/chat-memory/team-assets { team_id }
//              -> data.items[{ id: "chat_memory-team-<team>-agt-<id>", title: "Memory of <agent>" }]
//              POST :8125 /api/v1/chat-memory/search { block_id, query, layer:"L0"|"L1", limit }
//              -> { code:0, data:{ items:[{ id, role, title, body, tags, refs, score, created_at }] } }
//   Auth: x-tdai-user-key = shared agents reader key (usr-djhn2kpkkc); the key
//   file (0600, read at call time) is NEVER logged, echoed into errors or
//   returned. Second header is always x-tdai-service-id: default.
//   Team plane: the Fleet team (ticket 732 unified registered-ID plane).
//
// Layer support (installed v2.0.2 read path): L0 (conversation excerpts) and
// L1 (atomic extracted memories) only. L2/L3 are NOT exposed here.
//
// ticket 738 (Sol-approved changeset 2026-10-22, consult 08-12-50): ADDITIVE
// skill read surface — skillList() over the panel /api/v1/skill/list proxy,
// bounded by topN/byte budget, publisher-namespace scoped. WRITE paths live in
// lib/skill-publish.mjs (same credential file; publisher is a dedicated agent).
// opts.post allows a transport override for offline tests.
//
// Budgets (operator plan §6.4 — applied as plain constants/env, not a new
// config framework): L1 limit 5, L0 limit 3, ≈1500-token byte budget per
// search response. Provenance is always returned (id, score, created_at,
// block, layer). Search-side dedup against the authoritative RepoQL plane is
// implemented in lib/context-pack.mjs (stable identity, never similarity-only).

import { readFileSync } from "node:fs";

const HUB_BASE = process.env.MEMORYCORE_HUB_URL ?? "http://127.0.0.1:8125";
const KEY_FILE = process.env.MEMORYCORE_KEY_FILE ?? "/opt/harness-unset/tencent-memory-hub/.agents-read-key";
const SERVICE_ID = process.env.MEMORYCORE_SERVICE_ID ?? "default";
const DEFAULT_TEAM = process.env.MEMORYCORE_TEAM_ID ?? "team-c3helqsfu6";
const DEFAULT_TIMEOUT_MS = _posInt(process.env.MEMORYCORE_TIMEOUT_MS, 6000);
const BLOCK_TTL_MS = _posInt(process.env.MEMORYCORE_BLOCK_TTL_MS, 600000);

// ticket 738: dedicated publisher namespace read defaults (must match
// lib/skill-publish.mjs so recall reads exactly what the publisher owns).
const SKILL_TEAM = process.env.MEMORYCORE_SKILL_TEAM ?? "team-c3helqsfu6";
const SKILL_AGENT = process.env.MEMORYCORE_SKILL_AGENT ?? "agt-k6e4ftbqu3";

// Response budgets — plan §6.4 starting limits.
function _posInt(v, d) { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.floor(n) : d; }
export const MEMORYCORE_LIMITS = {
  l1: _posInt(process.env.MEMORYCORE_L1_LIMIT, 5),
  l0: _posInt(process.env.MEMORYCORE_L0_LIMIT, 3),
  budgetBytes: _posInt(process.env.MEMORYCORE_BUDGET_BYTES, 6000), // ≈1500 tokens
  // ticket 738 skill-injection starting budget (separate from chat-memory recall)
  skillTopN: _posInt(process.env.MEMORYCORE_SKILL_TOP_N, 6),
  skillBudgetBytes: _posInt(process.env.MEMORYCORE_SKILL_BUDGET_BYTES, 4000),
};

function _readKey() {
  const t = readFileSync(KEY_FILE, "utf8").trim();
  const last = t.split(/\r?\n/).pop().trim();
  if (!last) throw new Error("empty key file");
  return last;
}

export function createMemorycoreClient(opts = {}) {
  const team = String(opts.teamId ?? DEFAULT_TEAM);
  const postImpl = typeof opts.post === "function" ? opts.post : null; // test/overlay transport
  let blocks = null;
  let blocksAt = 0;

  async function _post(path, body) {
    if (postImpl) return postImpl(path, body);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), DEFAULT_TIMEOUT_MS);
    try {
      const res = await fetch(HUB_BASE + path, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tdai-user-key": _readKey(), "x-tdai-service-id": SERVICE_ID },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      let json = null;
      try { json = await res.json(); } catch { json = null; }
      return { status: res.status, json };
    } catch (err) {
      const reason = String(err?.cause?.code ?? err?.name ?? err).slice(0, 40);
      return { status: 0, json: null, netReason: reason };
    } finally { clearTimeout(timer); }
  }

  async function resolveBlocks({ refresh = false } = {}) {
    if (!refresh && blocks && Date.now() - blocksAt < BLOCK_TTL_MS) return { ok: true, blocks };
    const r = await _post("/api/v1/chat-memory/team-assets", { team_id: team });
    if (r.status !== 200) {
      const code = r.netReason ? `NETWORK:${r.netReason}` : r.status === 401 || r.status === 403 ? "AUTH_FAILED" : "TEAM_ASSETS_FAILED";
      return { ok: false, code, http: r.status || undefined };
    }
    // Ticket 776 P0-2: full application-level validation. HTTP 200 with a
    // non-JSON body, a failing application code, or a schema-violating payload
    // is a typed FAILURE — never a silent empty success.
    if (r.json === null || typeof r.json !== "object") return { ok: false, code: "TEAM_ASSETS_PARSE_FAILED", http: r.status };
    if (typeof r.json.code === "number" && r.json.code !== 0) return { ok: false, code: `CORE:${r.json.code}` };
    const rawItems = r.json?.data?.items;
    if (rawItems !== undefined && !Array.isArray(rawItems)) return { ok: false, code: "TEAM_ASSETS_SCHEMA_INVALID" };
    const items = Array.isArray(rawItems) ? rawItems : [];
    const map = {};
    for (const it of items) {
      const m = /^Memory of (.+)$/u.exec(String(it.title ?? ""));
      if (m && it.id) map[m[1]] = String(it.id);
    }
    blocks = map;
    blocksAt = Date.now();
    return { ok: true, blocks: map };
  }

  // ticket 738 — raw list over the panel skill proxy. Bounded: topN cap 12,
  // provenance fields only (no content). Approved-only filtering and content
  // fetch live in lib/skill-publish.mjs loadApprovedSkills().
  async function skillList({ namePrefix, status = "active", topN } = {}) {
    try {
      const lim = Math.min(_posInt(topN, MEMORYCORE_LIMITS.skillTopN), 12);
      const filters = {};
      if (namePrefix != null && String(namePrefix).trim()) filters.name_prefix = String(namePrefix).trim().slice(0, 64);
      if (status) filters.status = [String(status)];
      const r = await _post("/api/v1/skill/list", { team_id: SKILL_TEAM, agent_id: SKILL_AGENT, filters, pagination: { limit: lim } });
      if (r.netReason || !r.json) {
        return { ok: false, code: r.netReason ? `NETWORK:${r.netReason}` : "SKILL_LIST_FAILED", http: r.status || undefined };
      }
      const p = r.json;
      if (p.code !== 0) return { ok: false, code: `CORE:${p.code ?? "NO_ENVELOPE"}` };
      const items = p.data?.items ?? [];
      const skills = [];
      let bytes = 0;
      for (const it of items.slice(0, lim)) {
        const out = {
          name: String(it.name ?? ""),
          skillId: String(it.skill_id ?? ""),
          version: Number.isFinite(Number(it.version)) ? Number(it.version) : null,
          isHead: !!it.is_head,
          status: String(it.status ?? "active"),
          description: String(it.description ?? "").slice(0, 200),
          team: String(it.team_id ?? SKILL_TEAM),
          agent: String(it.owner_agent_id ?? SKILL_AGENT),
          updated_at_ms: it.updated_at_ms ?? null,
          metadata: (it.metadata && typeof it.metadata === "object") ? it.metadata : null,
        };
        bytes += Buffer.byteLength(JSON.stringify(out), "utf8");
        skills.push(out);
      }
      return { ok: true, skills, bytesUsed: bytes };
    } catch (err) {
      return { ok: false, code: "UNEXPECTED" };
    }
  }

  return {
    mode: "local",
    team,
    resolveBlocks,

    // search({ agent, query, layer, limit }) — bounded L0/L1 recall with provenance.
    async search({ agent = "general", query, layer = "L1", limit } = {}) {
      try {
        if (!String(query ?? "").trim()) return { ok: false, code: "EMPTY_QUERY" };
        const want = String(layer).toUpperCase() === "L0" ? MEMORYCORE_LIMITS.l0 : MEMORYCORE_LIMITS.l1;
        const lim = Math.min(_posInt(limit, want), 10);
        const blk = await resolveBlocks({});
        if (!blk.ok) return { ok: false, code: blk.code };
        // Ticket 776 P0-1 (memory identity + isolation): STRICT agent-scope
        // resolution. A specialist agent whose block does not exist NEVER
        // silently reads another agent's (general) block. "general" resolving
        // empty is a genuine no-memory-found state; a specialist resolving
        // empty is a typed degraded result — the caller can fall back to the
        // general block ONLY be explicitly requesting agent:"general".
        const bid = blk.blocks[String(agent)] ?? null;
        if (!bid) {
          if (String(agent) === "general") return { ok: false, code: "BLOCK_NOT_FOUND", agent: String(agent) };
          return { ok: false, code: "AGENT_BLOCK_NOT_FOUND", agent: String(agent), note: "strict identity: no fallback to another agent's block (ticket 776)" };
        }
        const r = await _post("/api/v1/chat-memory/search", { block_id: bid, query, layer: String(layer).toUpperCase(), limit: lim });
        if (r.status !== 200) {
          const code = r.netReason ? `NETWORK:${r.netReason}` : r.status === 401 || r.status === 403 ? "AUTH_FAILED" : r.status === 404 ? "BLOCK_NOT_FOUND" : "SEARCH_FAILED";
          return { ok: false, code, http: r.status || undefined };
        }
        // Ticket 776 P0-2: the same validation contract as resolveBlocks —
        // HTTP 200 with a failing app code / non-JSON body / bad schema is a
        // typed failure, never an empty success.
        if (r.json === null || typeof r.json !== "object") return { ok: false, code: "SEARCH_PARSE_FAILED", http: r.status };
        if (typeof r.json.code === "number" && r.json.code !== 0) return { ok: false, code: `CORE:${r.json.code}` };
        const items = r.json?.data?.items;
        if (!Array.isArray(items)) return { ok: false, code: "SEARCH_SCHEMA_INVALID" };
        // Byte budget: keep first-N provenance-complete items under the budget.
        let bytes = 0;
        const results = [];
        for (const it of items.slice(0, lim)) {
          const out = {
            id: String(it.id ?? ""),
            score: Number.isFinite(Number(it.score)) ? Number(it.score) : 0,
            created_at: it.created_at ?? it.timestamp ?? null,
            title: String(it.title ?? ""),
            body: String(it.body ?? it.content ?? ""),
            tags: Array.isArray(it.tags) ? it.tags : [],
            refs: Array.isArray(it.refs) ? it.refs : [],
            block: bid,
            layer: String(layer).toUpperCase(),
          };
          const b = Buffer.byteLength(out.body, "utf8");
          if (bytes + b > MEMORYCORE_LIMITS.budgetBytes) {
            const room = Math.max(0, MEMORYCORE_LIMITS.budgetBytes - bytes);
            out.body = out.body.slice(0, room);
            out.truncated = true;
            results.push(out);
            bytes += room;
            break;
          }
          bytes += b;
          results.push(out);
        }
        return { ok: true, block: bid, agent: String(agent), layer: String(layer).toUpperCase(), results, bytesUsed: bytes };
      } catch (err) {
        return { ok: false, code: "UNEXPECTED" };
      }
    },

    // ticket 738 — raw list over the panel skill proxy (bounded topN ≤12,
    // provenance only). Approved-only filtering + content fetch live in
    // lib/skill-publish.mjs loadApprovedSkills(); context-pack uses that
    // helper directly with this client's transport.
    skillList,
  };
}
