// lib/memory-orchestra/executors.mjs — MemOS gap-closure addendum (2026-10-23)
//
// Tombstone imports: the retrieval-side rejection evaluator binds to the
// legacy lib/memory-tombstone.mjs (loadTombstones + claimIsRejected); it is
// the single tombstone authority — no second store, no evaluator duplication.
// Directive §8: every channel is an OWNED-ENGINE call with pushed-down
// scope/filter/topK. The native clients speak their own APIs
// (lib/memorycore-client.mjs search/skillList; lib/repoql-client.mjs
// query/get), while runChannel() binds executors as
// holder[fn]({ query, scope, topK, intent, channel }) => { ok, results }.
// This module is the ADAPTER PLANE only: it never reformats stored content
// beyond row mapping, never widens scope, and never fabricates a result on
// failure — native typed failures pass through as { ok:false, code }, so a
// channel outage degrades typed (planner already handles that contract).
//
// Anything without a real fleet engine behind it (repoql.relationships graph
// views, temporal.recall) returns typed PENDING_VALIDATION — never a fake
// empty-success — and the caller may bind its own reader to light the channel
// up later. docs.read is now a real bounded hub-docs reader (P0 §9): the
// canonical documentation tree is read directly because the RepoQL host used
// here indexes the project checkout, not the hub docs.

import { readFileSync, readdirSync } from "node:fs";
import { join as joinPath } from "node:path";
import { loadTombstones, claimIsRejected } from "../memory-tombstone.mjs";
import { loadApprovedSkills } from "../skill-publish.mjs";

const pending = (code = "PENDING_VALIDATION") => ({ ok: false, code, results: [] });

// Default per-candidate tombstone evaluator (Sol close-out HOLD-2 contract:
// rejection is per candidate, and unavailable tombstone evidence fails
// closed — it is never an affirmative eligibility decision). Built over the
// EXISTING lib/memory-tombstone.mjs value-plane check (canonical claim
// equality, active tombstones only, scope applies); no second tombstone store.
// fn(candidate) => { evaluated, rejected, name? } — fusion's gateTombstones
// consumes exactly this shape and drops "tombstone:unevaluated" otherwise.
export function createDefaultTombstoneEval({ tombstonesDir = null } = {}) {
  let idx = null;
  try {
    idx = tombstonesDir != null ? loadTombstones(tombstonesDir) : loadTombstones();
  } catch (err) {
    idx = { ok: false, code: `TOMBSTONE_LOAD_THROW:${String(err?.name ?? err).slice(0, 24)}` };
  }
  return (cand) => {
    if (!idx?.ok) return { evaluated: false, rejected: false, name: null, code: `TOMBSTONE_INDEX_UNAVAILABLE:${idx?.code ?? "unknown"}` };
    const r = claimIsRejected({ claim: cand?.claimText ?? "", scope: cand?.scope?.team ?? null, tombstones: idx.tombstones });
    return { evaluated: true, rejected: !!r.blocked, name: r.tombstone?.name ?? r.tombstone?.file ?? null };
  };
}

// Map a native memorycore search row into the planner raw-row shape
// (toCandidate() normalizes further; unknown fields are dropped there).
function mcRow(mc) {
  return {
    id: mc.id,
    origin: "memorycore",
    layer: mc.layer ?? null,
    body: mc.body,
    title: mc.title,
    tags: mc.tags ?? [],
    created_at: mc.created_at,
    locator: mc.refs?.[0] ?? (mc.block ? `memorycore:block:${mc.block}` : null),
    validity: "CURRENT", // L0/L1 current-drawn rows only; supersession lives upstream
    verification: null,
    approvalStatus: "APPROVED",
    confidentiality: "normal",
    score: mc.score,
  };
}

function skillRow(s) {
  return {
    // Loader rows do not carry agent identity (the manifest key is noteId);
    // "*" keeps the stable-id shape without inventing an agent claim.
    id: `skill:${s.agent ?? "*"}:${s.name}:${s.version ?? "head"}`,
    origin: "memorycore",
    layer: "skill",
    // Round-5 (Sol HOLD G2): the FULL approved content rides the row body —
    // planner.toCandidate() bounds only the DISPLAY excerpt and computes the
    // claim digest over the full received text, so truncating here would feed
    // the digest a 400-char prefix and let two skills differing after char
    // 400 fold together. The served budget (loader budgetBytes) bounds size.
    body: s.content ?? s.description ?? null,
    tags: ["skill", s.approvalState ?? s.status ?? "APPROVED"],
    created_at: s.updated_at_ms ? new Date(s.updated_at_ms).toISOString() : null,
    locator: `memorycore:skill:${s.team ?? "*"}/${s.agent ?? "*"}/${s.name}@${s.version ?? "head"}`,
    validity: "CURRENT",
    // approvalStatus is the PUBLISHER-MANIFEST word (approval.state === APPROVED
    // for the exact served contentHash — lib/skill-publish.mjs loadApprovedSkills
    // is the authority; "the MemoryCore head status field is advisory only").
    // Sol close-out HOLD: skillList() previously surfaced the head "active"
    // status as approvalStatus:ACTIVE, which the fusion approval gate correctly
    // refused — binding the executor to the approved-manifest reader keeps the
    // gate strict (APPROVED only) without weakening the approval boundary.
    verification: s.contentHash ? `manifest-approved:${s.contentHash.slice(0, 16)}` : "manifest-approved",
    approvalStatus: String(s.approvalState ?? "APPROVED").toUpperCase(),
    confidentiality: "normal",
    score: null,
  };
}

// RepoQL rows come back as { uri, score, headline }; the evidence body is
// fulfilled by the orchestrator's evidence-follower (context.mjs uses locator
// fields), never silently expanded here.
// Build the single edit-batch address the concepts view can answer for.
// Supported forms (measured): a file address, or a DIRECTORY address. Joined
// `;` lists and `*`/`**` address forms return "No concepts are relevant".
function addressForPaths(paths) {
  const targets = [];
  for (const p of Array.isArray(paths) ? paths : []) {
    const s = String(p ?? "").trim();
    if (!s) continue;
    if (/^(concept|github|vocabulary):\/\//.test(s)) continue; // not edit targets
    // A single file must keep its file address: a bare directory returns a
    // directory-level concept set that omits file-specific concepts (measured
    // 2026-11-12: the capture-admission concept is applicable to the file
    // address but absent from its parent-directory address).
    if (/^file:\/\//.test(s)) targets.push(s);
    else if (s.startsWith("/")) targets.push("file://" + s);
  }
  if (!targets.length) return null;
  const dirs = targets.map((t) => t.replace(/[^/]*$/, ""));
  if (dirs.length === 1) return targets[0];
  const parts = dirs.map((d) => d.replace(/\/$/, "").split("/"));
  const min = Math.min(...parts.map((p) => p.length));
  let i = 0;
  while (i < min && parts.every((p) => p[i] === parts[0][i])) i++;
  // Too general (e.g. file:///opt/harness-unset/) is not a useful batch scope:
  // fall back to the first real target directory instead of a repo-wide sweep.
  if (i < 6) return dirs[0];
  return parts[0].slice(0, i).join("/") + "/";
}

function rqRow(r) {
  return {
    id: r.uri,
    origin: "repoql",
    layer: "repoql",
    body: r.headline ?? "",
    tags: [],
    created_at: null,
    locator: r.uri,
    validity: "CURRENT",
    verification: null,
    approvalStatus: "APPROVED",
    confidentiality: "normal",
    score: r.score,
    revision: r.revision ?? null,
  };
}

// q for RepoQL: whitespace trimmed, quotes/slashes neutralized deterministically.
function qForRepoQL(query) {
  return String(query ?? "").replace(/\s+/g, " ").trim().slice(0, 240).replace(/["']/g, " ");
}

export function createPlannerExecutors({ memorycore = null, repoql = null, l23 = null, docsReader = null, temporalRecall = null, relations = null, steps = null, tombstonePreliminary = null, approvedSkills = null, bindRequesterScope = false } = {}) {
  // bindRequesterScope (Sol round-3 P0): Requester identity is NEVER copied
  // onto returned rows as a substitute for source ownership. Scope envelopes
  // on rows come from exactly two provable sources: (a) `scopeProof:
  // "engine-agent-pushdown"` — the agent dimension was ENFORCED server-side
  // by the owned-engine call (the native memorycore boundary scopes L0/L1 by
  // agent; that is a verified transport property, not a copy), or (b) the
  // engine's own per-row scope envelope ("engine-row-scope").
  // bindRequesterScope=true additionally stamps requester team/user onto rows
  // and is ONLY for transports with independently verified push-down of those
  // dimensions (default OFF). Without a proof, fusion's scope gate drops the
  // row fail-closed (scope:missing / scope:incomplete) — absence of ownership
  // evidence is never an affirmative.
  // approvedSkillsRef: the approved-skill boundary. Explicit binding wins (test
  // injection / call-site reader); the default self-builds the EXISTING
  // authority — lib/skill-publish.mjs loadApprovedSkills() returns the async
  // approvedSkills reader directly (publisher-manifest APPROVED records with
  // live content-hash integrity), so a single factory call binds it. If the
  // manifest has nothing published yet it returns ok:true with an empty skill
  // list — a typed empty, not a fabricated or head-scanned result.
  const approvedSkillsRef = approvedSkills ?? loadApprovedSkills();
  const memorycoreHolder = {
    // tencent-l1-semantic / tencent-l0-keyword (agent-scope pushed down).
    // The engine call pushes the agent dimension down and the native boundary
    // enforces it server-side — that push-down is recorded as the row's scope
    // PROOF, not as copied requester identity. Engine-returned per-row scope
    // envelopes are carried verbatim ("engine-row-scope"); everything else is
    // left unset so the fusion scope gate fails closed.
    async search({ query, scope = {}, topK = 3, channel } = {}) {
      if (!memorycore) return pending("EXECUTOR_NOT_BOUND");
      const layer = String(channel ?? "").includes("l0") ? "L0" : "L1";
      const r = await memorycore.search({ agent: scope.agent ?? "general", query, layer, limit: topK });
      if (!r.ok) return r;
      return {
        ok: true,
        results: (r.results ?? []).map((x) => ({
          ...mcRow(x),
          scope: (x.scope && (x.scope.agent || x.scope.user))
            ? x.scope
            : { agent: scope.agent ?? "general" },
          scopeProof: (x.scope && (x.scope.agent || x.scope.user)) ? "engine-row-scope" : "engine-agent-pushdown",
        })),
      };
    },
    // skill-approved: reads the AUTHORITATIVE approved-skill boundary
    // (lib/skill-publish.mjs loadApprovedSkills — publisher-manifest APPROVED
    // records with contentHash integrity), NOT the MemoryCore head "active"
    // status scan (advisory only). opts.approvedSkills lets tests/call sites
    // bind their own reader; the default self-builds on the existing manifest.
    async skillList({ query, scope = {}, topK = 4 } = {}) {
      if (!approvedSkillsRef) return pending("EXECUTOR_NOT_BOUND");
      try {
        const r = await approvedSkillsRef({ topN: Math.max(1, Number.isFinite(topK) ? Math.floor(topK) : 4), namePrefix: null });
        if (!r.ok) return r;
        const q = String(query ?? "").toLowerCase().split(/\s+/)[0] ?? "";
        const skills = (r.skills ?? []).filter((s) => !q || q.length < 3 || String(s.skillName ?? s.name).toLowerCase().includes(q));
        return {
          ok: true,
          results: skills.slice(0, topK).map((s) => ({
            ...skillRow(s),
            // Approved skills are a PUBLISHER-APPROVED GLOBAL AUTHORITY: the
            // serving boundary (manifest APPROVED for the exact contentHash,
            // live-hash integrity, publisher provenance) already enforces
            // access — fusion's scope gate treats this channel as
            // authority-served (see gateScope) and does NOT require row
            // scope identity; requester identity is never copied onto rows.
            scope: {},
            scopeProof: "publisher-approval-boundary",
          })),
        };
      } catch (err) {
        return pending(`SKILL_READER_THROW:${String(err?.name ?? err).slice(0, 20)}`);
      }
    },
  };

  const repoqlHolder = {
    // repoql-code-symbol over the orchestra-code scope (uri-glob push-down lives in the client registry).
    async explore({ query, topK = 4, deadlineMs } = {}) {
      if (!repoql) return pending("EXECUTOR_NOT_BOUND");
      const r = await repoql.query({ q: qForRepoQL(query), scope: "orchestra-code", limit: topK, timeoutMs: deadlineMs });
      if (!r.ok) return r;
      return { ok: true, results: (r.results ?? []).map(rqRow) };
    },
    // repoql-concept over the concepts scope (gated knowledge leaves only).
    // Two documented paths, chosen by whether the caller knows the edit scope
    // (Sol 2026-10-24):
    //   * scope/targets known -> `read <scope> => concepts`, which returns the
    //     narrow AND universally applicable capsules for those files in one
    //     call (2.7 s measured), reused for the whole edit batch;
    //   * otherwise -> semantic explore over the concepts scope, unchanged.
    // The applicability path never claims proof: rows are navigation, and a
    // caller that acts on one reads the capsule.
    async concepts({ query, topK = 4, deadlineMs, scope = null } = {}) {
      if (!repoql) return pending("EXECUTOR_NOT_BOUND");
      // `documentationAuthoringAdvisory` already carries the paths it touched
      // (wire.mjs §17). Turn them into ONE supported address: the concepts view
      // evaluates one address, and `;`-joined lists are not a set for it
      // (measured 2026-10-24). A directory is the supported batch form, so the
      // common parent is used, falling back to the first target's directory when
      // the common parent would be too broad to be meaningful.
      const address = addressForPaths(scope?.affectedPaths ?? []);
      // DUO Phase 2 (Sol 2026-11-12): when the backing store is in local mode
      // with no scope registry, applicability is a retrieval dead end — it
      // returns ZERO_RESULTS while the concept itself is discoverable via the
      // semantic concepts query (probed 2026-11-12: 0.98). Fall through to the
      // semantic path below only for that dead-end shape; a legitimate zero
      // from a functioning registry keeps the existing handling, and semantic
      // rows stay suggestions (concept-gate), never proof of applicability.
      let applicabilityDeadEnd = false;
      if (address && typeof repoql.conceptApplicability === "function") {
        const a = await repoql.conceptApplicability({ scope: address, timeoutMs: deadlineMs });
        if (!a.ok) return a;
        applicabilityDeadEnd = a.status === "ZERO_RESULTS" && a.mode === "local" && a.evidence?.scopeRegistryVersion == null;
        if (!applicabilityDeadEnd) {
          // Return EVERY applicable concept; the planner/fusion stage applies the
          // channel's topK. Truncating here would silently drop universal capsules
          // that the view explicitly reported as applicable.
          const rows = (a.results ?? []).map((x) => ({
            ...rqRow({ uri: x.uri, headline: x.uri, score: 1 }),
            approvalStatus: "APPROVED",
            verification: "concept-applicability",
            applicability: a.status,
          }));
          return { ok: true, results: rows, applicabilityStatus: a.status, universalApplicable: a.universalApplicable ?? null, narrowShown: a.narrowShown ?? null, footer: a.footer ?? null };
        }
      }
      const r = await repoql.query({ q: qForRepoQL(query) || qForRepoQL(address ?? ""), scope: "concepts", limit: topK, timeoutMs: deadlineMs });
      if (!r.ok) return r;
      const semanticOut = { ok: true, results: (r.results ?? []).map((x) => ({ ...rqRow(x), approvalStatus: "APPROVED", verification: "concept-gate" })) };
      if (applicabilityDeadEnd) { semanticOut.applicabilityStatus = "ZERO_RESULTS"; semanticOut.applicabilityFallback = "semantic"; }
      return semanticOut;
    },
    // P1 §7 (2026-10-23 remediation): the graph channel now has a REAL reader
    // over the existing memory lineage store (lib/memory-lineage.mjs) — the
    // supported relationship authority — instead of a placeholder. Free-text
    // query without a record identity cannot address lineage edges, so it
    // returns a typed RELATIONSHIP_QUERY_UNSUPPORTED (never an empty success).
    // Callers may bind their own reader with opts.relations.
    async relationships({ query = "", scope = {}, topK = 4 } = {}) {
      if (typeof relations === "function") return relations({ query, scope, topK });
      const recordId = String(scope?.recordId ?? scope?.claimId ?? "").trim();
      if (!recordId) return { ok: false, code: "RELATIONSHIP_QUERY_UNSUPPORTED", results: [] };
      try {
        const { parentsOf, childrenOf } = await import("../memory-lineage.mjs");
        const rows = [];
        const parents = parentsOf(recordId);
        if (parents?.ok === false) return { ok: false, code: parents.code ?? "LINEAGE_READ_FAILED", results: [] };
        for (const p of parents?.parents ?? []) {
          rows.push({ id: `lineage:${recordId}:child-of:${p}`, origin: "lineage", layer: "graph",
            body: `${recordId} derived_from ${p}`, locator: `lineage/${recordId}`, validity: "CURRENT",
            verification: "lineage-edge", relationship: "derived_from", from: recordId, to: p, score: 1 });
        }
        const kids = childrenOf(recordId);
        if (kids?.ok === false) return { ok: false, code: kids.code ?? "LINEAGE_READ_FAILED", results: [] };
        for (const c of kids?.children ?? []) {
          rows.push({ id: `lineage:${recordId}:parent-of:${c}`, origin: "lineage", layer: "graph",
            body: `${c} derived_from ${recordId}`, locator: `lineage/${c}`, validity: "CURRENT",
            verification: "lineage-edge", relationship: "has_derived", from: recordId, to: c, score: 1 });
        }
        return { ok: true, results: rows.slice(0, Math.max(1, Number(topK) || 4)) };
      } catch (err) {
        return { ok: false, code: `LINEAGE_READER_ERROR:${String(err?.name ?? err).slice(0, 24)}`, results: [] };
      }
    },
  };

  // Current documentation is authoritative material and lives in the hub docs
  // index (RepoQL scopes hub-services / accepted-plans / agent-guides / tools).
  // P0 §9 (2026-10-23): this reader was a PENDING_VALIDATION placeholder even
  // while a RepoQL client was bound, so the docs channels never returned real
  // rows. It now queries the hub-docs glob directly; without a bound client it
  // degrades typed (EXECUTOR_NOT_BOUND), never a fake empty success.
  // The hub documentation tree is the canonical current-state source. The
  // RepoQL host used by this kit indexes the project checkout, NOT the hub
  // docs tree (verified 2026-10-23: `rql explore` over the hub glob returns
  // "No records"), so a RepoQL-only docs channel would always be empty while
  // looking healthy. This reader therefore scans the hub docs directly with a
  // bounded, deterministic term match (no embeddings, no full-corpus walk).
  const HUB_DOCS_ROOT = process.env.ORCH_HUB_DOCS_ROOT || "/opt/harness-unset/documentation";
  const DOCS_MAX_FILES = 600;
  const DOCS_MAX_BYTES = 64 * 1024; // per file: headings + head only
  function walkDocs(dir, out, depth = 0) {
    if (depth > 4 || out.length >= DOCS_MAX_FILES) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= DOCS_MAX_FILES) return;
      if (e.name.startsWith(".")) continue;
      const p = joinPath(dir, e.name);
      if (e.isDirectory()) walkDocs(p, out, depth + 1);
      else if (e.isFile() && e.name.endsWith(".md")) out.push(p);
    }
  }
  function docsScore(text, terms) {
    const low = text.toLowerCase();
    let hits = 0;
    for (const t of terms) if (low.includes(t)) hits++;
    return hits / Math.max(1, terms.length);
  }
  // P2 §10 (2026-10-23 remediation): RepoQL's INDEXED documentation scopes are
  // the primary discovery path; the bounded filesystem walk remains only as an
  // explicitly-degraded fallback (repoql client absent, or every indexed scope
  // empty). No second corpus, no duplicated index.
  const DOC_SCOPES = ["hub-services", "agent-guides", "tools", "accepted-plans"];
  async function repoqlDocs({ query, topK }) {
    if (!repoql || typeof repoql.query !== "function") return { ok: false, code: "EXECUTOR_NOT_BOUND" };
    const rows = [];
    for (const scope of DOC_SCOPES) {
      try {
        const r = await repoql.query({ q: qForRepoQL(query), scope, limit: topK });
        if (!r?.ok) continue;
        for (const x of r.results ?? []) {
          rows.push({
            id: `repoql-docs:${x.uri ?? x.id}`,
            origin: "docs",
            layer: "docs",
            body: String(x.headline ?? x.body ?? "").slice(0, 320),
            status: "APPROVED",
            verification: "repoql-index",
            sourceAuthority: "hub-docs",
            scopeProof: "hub-docs-authority",
            locator: x.uri ?? x.id,
            revision: x.revision ?? null,
            validity: "CURRENT",
            tags: ["hub-docs", "repoql-index"],
            retrievalScope: scope,
            score: x.score,
          });
        }
      } catch { /* try the next indexed scope */ }
    }
    return rows.length ? { ok: true, results: rows.slice(0, Math.max(1, Number(topK) || 3)) } : { ok: true, results: [], empty: true };
  }
  const docsHolder = {
    async read({ query = "", topK = 3 } = {}) {
      if (typeof docsReader === "function") return docsReader({ query, topK });
      const indexed = await repoqlDocs({ query, topK });
      if (indexed.ok && indexed.results?.length) return indexed;
      let files = [];
      walkDocs(HUB_DOCS_ROOT, files);
      if (!files.length) return pending("EXECUTOR_NOT_BOUND");
      const terms = String(query ?? "").toLowerCase().split(/[^a-z0-9_.-]+/)
        .filter((t) => t.length > 2).slice(0, 8);
      if (!terms.length) return { ok: true, results: [] };
      const rows = [];
      for (const f of files) {
        let head = "";
        try { head = readFileSync(f, "utf8").slice(0, DOCS_MAX_BYTES); } catch { continue; }
        const rel = f.slice(HUB_DOCS_ROOT.length + 1);
        // A path hit is a stronger signal than a passing mention in prose.
        const score = docsScore(rel + "\n" + head, terms)
          + 0.5 * docsScore(rel, terms);
        if (score <= 0) continue;
        const title = (head.match(/^#\s+(.+)$/m)?.[1] ?? rel).slice(0, 160);
        const snippet = head.replace(/\s+/g, " ").slice(0, 320);
        rows.push({
          id: `hub-docs:${rel}`,
          // §8: a docs row is authority-served, not a scoped personal memory.
          // origin "docs" + the explicit proof marker is what fusion's narrow
          // docs-authority exemption requires; a plain "kit" origin would be
          // treated as scoped memory and dropped for missing scope.
          origin: "docs",
          layer: "docs",
          body: snippet,
          status: "APPROVED",
          verification: "hub-doc-current",
          sourceAuthority: "hub-docs",
          scopeProof: "hub-docs-authority",
          locator: f,
          revision: title,
          validity: "CURRENT",
          tags: ["hub-docs"],
          score,
          degraded: "filesystem-scan",
        });
      }
      rows.sort((a, b) => b.score - a.score || a.locator.localeCompare(b.locator));
      return { ok: true, degraded: "filesystem-scan", results: rows.slice(0, Math.max(1, Number(topK) || 3)) };
    },
  };

  // P1 §7 (2026-10-23 remediation): real temporal reader over MemoryCore L0/L1
  // rows, using the EXISTING lib/memory-temporal.mjs validity semantics. Each
  // row is labelled CURRENT/HISTORICAL with its validity window; expired or
  // superseded capsules are returned ONLY for explicitly historical queries.
  const temporalHolder = {
    async recall({ query = "", topK = 3, asOf = null, historical = false } = {}) {
      if (typeof temporalRecall === "function") return temporalRecall({ query, topK, asOf, historical });
      if (!memorycore) return pending("EXECUTOR_NOT_BOUND");
      try {
        const r = await memorycore.search({ agent: "general", query, layer: "L1", limit: Math.max(3, (Number(topK) || 3) * 2) });
        if (!r?.ok) return { ok: false, code: r?.code ?? "TEMPORAL_SEARCH_FAILED", results: [] };
        const { candidateTemporal, extractTemporal, currentTruth, TEMPORAL_VERDICT } = await import("../memory-temporal.mjs");
        const iso = (v) => (v == null ? null : (typeof v === "number" ? new Date(v).toISOString() : String(v)));
        const out = [];
        for (const row of r.results ?? []) {
          const cand = { body: String(row.body ?? row.content ?? ""), observedAt: row.updated_at ?? row.created_at ?? null, validFrom: row.valid_from ?? null, validTo: row.valid_to ?? null };
          // Explicit row fields win; otherwise the capsule frontmatter is the
          // temporal source (both are supported shapes in memory-temporal).
          const hasExplicit = cand.validFrom != null || cand.validTo != null;
          const t = hasExplicit ? candidateTemporal(cand) : extractTemporal(cand.body);
          const truth = historical || asOf ? null : currentTruth({ capsuleBody: cand.body, temporal: t });
          // currentTruth returns a three-valued VERDICT (MATCH / NO_MATCH /
          // UNKNOWN), not an object: only a known-expired/known-future fact is
          // excluded from current retrieval (unknown metadata stays current).
          const isCurrent = truth == null ? null : truth === TEMPORAL_VERDICT.MATCH;
          if (!historical && !asOf && isCurrent === false) continue;
          out.push({
            id: `temporal:${row.id ?? out.length}`,
            origin: "memorycore",
            layer: "temporal",
            body: String(cand.body).slice(0, 320),
            locator: `memorycore/${row.id ?? "unknown"}`,
            validity: historical || asOf ? "HISTORICAL" : (isCurrent === false ? "HISTORICAL" : "CURRENT"),
            validFrom: iso(t?.validFrom ?? cand.validFrom),
            validTo: iso(t?.validTo ?? cand.validTo),
            observedAt: cand.observedAt,
            verification: "temporal-reader",
            scope: { agent: "general" },
            score: row.score ?? 0.5,
          });
        }
        return { ok: true, results: out.slice(0, Math.max(1, Number(topK) || 3)) };
      } catch (err) {
        return { ok: false, code: `TEMPORAL_READER_ERROR:${String(err?.name ?? err).slice(0, 24)}`, results: [] };
      }
    },
  };

  // P1 §6: L2 scenario / L3 core are wired through the EXISTING client, which
  // returns a typed NOT_SUPPORTED verdict when the deployed panel lacks the
  // route (observed 404 on 2026-10-23). Never fabricated, never silent.
  // L2/L3 need a MemoryCore scope (team + agent ids), while hook callers carry
  // an AGENT NAME ("opencode-go/beam-free"). Resolve the name through the same
  // block registry the L1 client uses; a name that cannot be mapped is a typed
  // SCOPE_UNRESOLVED, never a guess and never another scope's data.
  const SCOPE_PART = /^[A-Za-z0-9_-]{1,64}$/;
  async function l23Scope(scope = {}) {
    if (SCOPE_PART.test(String(scope.team ?? "")) && SCOPE_PART.test(String(scope.agent ?? ""))) {
      return { team: scope.team, agent: scope.agent, user: scope.user ?? "default" };
    }
    if (!memorycore || typeof memorycore.resolveBlocks !== "function") return null;
    try {
      const raw = await memorycore.resolveBlocks();
      const map = raw?.blocks ?? raw ?? {};
      const want = String(scope.agent ?? "").trim();
      const blockId = map[want] ?? map[want.split("/").pop()] ?? null;
      const m = /^chat_memory-(.+)-(agt-[A-Za-z0-9]+)$/.exec(String(blockId ?? ""));
      if (!m) return null;
      return { team: m[1], agent: m[2], user: scope.user ?? "default" };
    } catch { return null; }
  }

  // Candidate scope must speak the SAME identity space the caller/ctx uses
  // (an agent NAME), or fusion's strict pairwise scope check drops every row.
  // The resolved MemoryCore ids stay on the row as read provenance, never as
  // the claimed scope.
  const claimScope = (args, s) => ({
    team: s.team,
    agent: String(args?.scope?.agent ?? s.agent),
    user: String(args?.scope?.user ?? s.user),
    ...(args?.scope?.caseRun ? { caseRun: args.scope.caseRun } : {}),
  });

  const l23Holder = {
    // A scenario read addresses ONE named scenario file; pass { scope, file }.
    async scenarioRead(args = {}) {
      if (!l23) return pending("EXECUTOR_NOT_BOUND");
      const s = await l23Scope(args.scope);
      if (!s) return { ok: false, code: "SCOPE_UNRESOLVED", results: [] };
      const r = await l23.scenarioRead({ scope: s, file: args.file });
      if (!r?.ok) return { ok: false, code: r?.code ?? "L23_READ_FAILED", results: [] };
      return {
        ok: true,
        results: [{
          id: `l2:${r.file}`, origin: "memorycore", layer: "L2",
          body: String(r.content ?? "").slice(0, 320), locator: `memorycore/scenario/${r.file}`,
          validity: "CURRENT", verification: "l2-reader", scope: claimScope(args, s), scopeProof: "engine-row-scope", score: 0.6,
          tags: ["artifact-readonly"],
        }],
      };
    },
    // Newest scene block for the resolved scope (L2): list, then read one.
    async sceneTop(args = {}) {
      if (!l23) return pending("EXECUTOR_NOT_BOUND");
      const s = await l23Scope(args.scope);
      if (!s) return { ok: false, code: "SCOPE_UNRESOLVED", results: [] };
      const list = await l23.scenarioList({ scope: s, limit: 20 });
      if (!list?.ok) return { ok: false, code: list?.code ?? "L23_READ_FAILED", results: [] };
      const newest = (list.files ?? []).slice().sort((a, b) => String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")))[0];
      if (!newest) return { ok: false, code: "ARTIFACT_ABSENT", results: [] };
      const r = await l23.scenarioRead({ scope: s, file: newest.name });
      if (!r?.ok) return { ok: false, code: r?.code ?? "L23_READ_FAILED", results: [] };
      return {
        ok: true,
        results: [{
          id: `l2:${newest.name}`, origin: "memorycore", layer: "L2",
          body: String(r.content ?? "").slice(0, 320), locator: `memorycore/scenario/${newest.name}`,
          validity: "CURRENT", verification: "l2-reader", scope: claimScope(args, s), scopeProof: "engine-row-scope", score: 0.6,
          tags: ["artifact-readonly"],
        }],
      };
    },
    // L3 returns the scope's profile items (array or typed failure).
    async coreRead(args = {}) {
      if (!l23) return pending("EXECUTOR_NOT_BOUND");
      const s = await l23Scope(args.scope);
      if (!s) return { ok: false, code: "SCOPE_UNRESOLVED", results: [] };
      const r = await l23.coreRead({ scope: s });
      if (!r?.ok) return { ok: false, code: r?.code ?? "L23_READ_FAILED", results: [] };
      const items = Array.isArray(r.profile) ? r.profile : [];
      return {
        ok: true,
        results: items.slice(0, 4).map((x) => ({
          id: `l3:${x.id || "profile"}`, origin: "memorycore", layer: "L3",
          body: String(x.body ?? "").slice(0, 320), locator: "memorycore/core/profile",
          validity: "CURRENT", verification: "l3-reader", scope: claimScope(args, s), scopeProof: "engine-row-scope", score: 0.6,
          tags: ["artifact-readonly"],
        })),
      };
    },
  };

  return {
    memorycore: memorycoreHolder,
    repoql: repoqlHolder,
    l23: l23Holder,
    docs: docsHolder,
    temporal: temporalHolder,
    steps: steps ?? null,
    tombstonePreliminary,
  };
}
