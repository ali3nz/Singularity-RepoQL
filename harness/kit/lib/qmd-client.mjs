// lib/qmd-client.mjs — V3.4.0 Phase 5 (plan §10.5). Smallest QMD interface:
// status / query / get over the HTTP MCP transport (POST /mcp) with typed
// failures and timeouts. NO write authority (QMD is read/index only from the
// Orchestra side — D01/D02). Failure NEVER breaks a run (plan §10.7): every
// method returns a typed result instead of throwing for transport problems.
// QMD may be unavailable: callers get { ok:false, code:"UNAVAILABLE" } and the
// context builder falls back to direct authoritative reads.
const MCP_PATH = "/mcp";
const DEFAULT_TIMEOUT_MS = 15_000;
// Ticket 091 (2026-09-25): default search type is LEXICAL (BM25) — the hyde/
// vec paths run the 1.7B query-expansion LLM + 0.6B reranker on CPU per call
// (90–150 s, measured) which starves context packs; lex returns in <200 ms
// over the same curated corpus. Override with QMD_SEARCH_TYPE=hyde|vec|lex.
const SEARCH_TYPE = process.env.QMD_SEARCH_TYPE ?? "lex";

function typedFail(code, detail) { return { ok: false, code, detail: String(detail ?? "").slice(0, 200) }; }

async function mcpCall(baseUrl, method, params, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(baseUrl.replace(/\/$/, "") + MCP_PATH, {
      method: "POST",
      // Upstream MCP HTTP transport REQUIRES accepting both application/json
      // and text/event-stream (406 otherwise). Responses come back as SSE
      // frames ("event: message\ndata: {...}") in stateless mode.
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name: method, arguments: params ?? {} } }),
      signal: ctl.signal,
    });
    if (!res.ok) return { transportError: `HTTP ${res.status}` };
    const raw = await res.text();
    // Parse JSON or SSE-framed JSON (data: lines).
    let body = null;
    try { body = JSON.parse(raw); }
    catch {
      for (const line of raw.split("\n")) {
        if (line.startsWith("data:")) {
          try { body = JSON.parse(line.slice(5).trim()); break; } catch { /* keep scanning */ }
        }
      }
    }
    if (!body) return { transportError: "unparseable MCP response" };
    if (body?.error) return { transportError: body.error.message ?? "mcp error" };
    const content = body?.result?.content;
    const text = Array.isArray(content) ? content.filter((c) => c.type === "text").map((c) => c.text).join("\n") : (typeof content === "string" ? content : JSON.stringify(body?.result ?? {}));
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    return { value: parsed ?? text };
  } catch (e) {
    const msg = e?.name === "AbortError" ? `timeout after ${timeoutMs}ms` : String(e?.message ?? e);
    return { transportError: msg };
  } finally { clearTimeout(timer); }
}

export function createQmdClient({ baseUrl = "http://127.0.0.1:8181", timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return {
    async status() {
      // Liveness via GET /health first (cheap), then MCP status tool.
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), Math.min(timeoutMs, 4000));
      try {
        const h = await fetch(baseUrl.replace(/\/$/, "") + "/health", { signal: ctl.signal });
        if (!h.ok) return typedFail("UNHEALTHY", `health HTTP ${h.status}`);
        let health = null; try { health = await h.json(); } catch { health = null; }
        const st = await mcpCall(baseUrl, "status", {}, timeoutMs);
        if (st.transportError) return typedFail("UNAVAILABLE", st.transportError);
        return { ok: true, health, status: st.value };
      } catch (e) {
        return typedFail("UNAVAILABLE", e?.name === "AbortError" ? "health timeout" : String(e?.message ?? e));
      } finally { clearTimeout(timer); }
    },
    async query({ q, collections = null, limit = 8, minScore = 0 } = {}) {
      const args = { searches: [{ query: String(q ?? ""), type: SEARCH_TYPE }], limit, minScore };
      if (collections && collections.length) args.collections = collections; // ARRAY ONLY (upstream contract)
      const r = await mcpCall(baseUrl, "query", args, timeoutMs);
      if (r.transportError) return typedFail("UNAVAILABLE", r.transportError);
      const v = r.value;
      // Ticket 091: the lex-type search path returns a human-readable blob
      // ("Found N results ...\n#docid 77% collection/path - Title") instead of
      // JSON — parse that shape so context packs keep structured results.
      const blobHits = typeof v === "string" && v.startsWith("Found ")
        ? [...v.matchAll(/^#(\S+)\s+(\d+)%\s+(\S+)\s+-\s+(.+)$/gm)].map((m) => ({
            docid: m[1], score: Number(m[2]) / 100, file: m[3], title: m[4],
          }))
        : null;
      const results = blobHits
        ?? (Array.isArray(v) ? v : (Array.isArray(v?.results) ? v.results : (Array.isArray(v?.matches) ? v.matches : [])));
      return {
        ok: true,
        results: results.map((x) => ({
          file: x.file ?? x.path ?? x.docid ?? null, // qmd://collection/path URI retained (plan §4.4)
          title: x.title ?? null,
          score: typeof x.score === "number" ? x.score : null,
          snippet: typeof x.snippet === "string" ? x.snippet.slice(0, 400) : null,
        })),
      };
    },
    async get({ file, fromLine = null, maxLines = null } = {}) {
      const args = { file: String(file ?? "") };
      if (fromLine != null) args.fromLine = fromLine;
      if (maxLines != null) args.maxLines = maxLines;
      const r = await mcpCall(baseUrl, "get", args, timeoutMs);
      if (r.transportError) return typedFail("UNAVAILABLE", r.transportError);
      const v = r.value;
      return { ok: true, content: typeof v === "string" ? v : (v?.content ?? JSON.stringify(v ?? "")) };
    },
  };
}
