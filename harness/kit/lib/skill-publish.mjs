// lib/skill-publish.mjs — kit-governed publisher for MemoryCore-native Skills
// (ticket 738 plan; Sol-approved changeset in consult 2026-10-22T08-12-50-875-165303).
//
// Publishes harvest-produced kit/skills notes as versioned MemoryCore skills,
// THROUGH the memory-hub panel data-plane proxy (POST /api/v1/skill/*), into the
// DEDICATED publisher namespace (agt-k6e4ftbqu3 under team-c3helqsfu6, owner
// usr-djhn2kpkkc). Never publishes into the RepoQL-mirror or template agents.
//
// Invariants (pinned live on the ephemeral sandbox, 2026-10-22):
//   - create: {team_id, agent_id, name<=64, content>=1, metadata free-form}
//     duplicate name → code 42201 SKILL_NAME_DUPLICATE
//   - update: full content overwrite with expected_version (int>=1);
//     missing → 40001; stale → 40901 SKILL_VERSION_STALE (+current_version)
//   - metadata is set at create and NOT carried by update → every rewrite
//     re-proves ownership from the SERVER-side head metadata before update
//   - get-by-name is (team_id, agent_id, skill_name); wrong context → 40401
//   - delete is soft (archive); archived heads vanish from get-by-name
//   - skill name MUST match ^[a-z0-9][a-z0-9-]*$ AND equal the content
//     frontmatter `name:` (live round 2, 2026-10-22: uppercase kit note id
//     → 42203 SKILL_FRONTMATTER_INVALID). Remote name is the LOWERCASED slug
//     of the note id; the raw note id is preserved as metadata.kitNoteId.
//
// Sol binding safeguards (consult 08-12-50):
//   1. An existing skill is updated ONLY if head metadata.source ===
//      'ai-orchestra-kit' AND head metadata.kitNoteId === the note's id.
//      Name collision with a foreign namespace (RepoQL mirror, templates,
//      manual skills) REFUSES — never adopted, never overwritten.
//   2. Change detection: sha-256 over the SANITISED bytes we would publish,
//      compared against the live head CONTENT (fetched), not the manifest.
//      PUBLISHED.json is bookkeeping, not proof of remote state.
//   3. Retry discipline on 40901: re-read head ONCE; proceed only if the
//      head still carries our provenance AND its content still equals the
//      version we based the decision on; otherwise refuse (CONFlictGATE),
//      never a blind overwrite.
//   4. v1 is operator-gated: `bun orchestrate.mjs skill-publish [--all|<id>] [--dry]`.
//      No auto-fire from closeout (stage 6 deferred).
//   5. loadApprovedSkills() is the read path for recall: it serves ONLY skills
//      that are (a) in the publisher manifest, (b) present under the dedicated
//      agent, (c) still carrying the publisher provenance, and (d) whose live
//      content hash equals the manifest hash. Isolation ≠ editorial approval.
//
// Sol round-3 corrections (consult 2026-10-22T09-19-08 APPROVE_WITH_CHANGES):
//   - createHeadReader: server-side name_prefix + paginated listing; absence
//     is PROVEN (short page / total reached) else typed failure
//     (LIST_INDETERMINATE); list→get race guarded by skill_id+name equality.
//   - loadApprovedSkills: LIVE content hash must equal manifest hash; a stale
//     metadata hash vouches for nothing (safeguard 5 strict).
//   - publishNote: no decision without string head content (HEAD_CONTENT_MISSING)
//   - 40901 retry: only against the byte-identical head we based the decision
//     on (skill_id + content equality) else CONFLICT_CONTENT_DRIFT refusal.
//   - aggregate ok:false on refused receipts (operator-gated semantics).

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const HUB_BASE = process.env.MEMORYCORE_HUB_URL ?? "http://127.0.0.1:8125";
const KEY_FILE = process.env.MEMORYCORE_KEY_FILE ?? "/opt/harness-unset/tencent-memory-hub/.agents-read-key";
const SERVICE_ID = process.env.MEMORYCORE_SERVICE_ID ?? "default";
// Publisher namespace (provisioned 2026-10-22, Sol-guarded one-time meta write).
const TEAM = process.env.MEMORYCORE_SKILL_TEAM ?? "team-c3helqsfu6";
const AGENT = process.env.MEMORYCORE_SKILL_AGENT ?? "agt-k6e4ftbqu3";
const OWNER = process.env.MEMORYCORE_SKILL_OWNER ?? "usr-djhn2kpkkc";
const TIMEOUT_MS = Number(process.env.MEMORYCORE_TIMEOUT_MS) > 0 ? Number(process.env.MEMORYCORE_TIMEOUT_MS) : 8000;
export const SKILL_SOURCE = "ai-orchestra-kit";
// Ticket 776 P0-5 / directive §4 — pre-activation skill governance.
// A published note does NOT become recall-eligible by existing. Approval
// states (fail-closed; enforced here at the loadApprovedSkills() retrieval
// boundary, regardless of what the MemoryCore head status field says):
//   STAGED            — published/updated bytes, not owner-approved yet
//   AWAITING_APPROVAL — evidence verified by tools/skill-approve --verify,
//                       explicit owner action still outstanding
//   APPROVED          — owner approves the EXACT contentHash; recall serves it
//   REVOKED           — operator withdrawal; recall refuses
// Supersession (approved → unapproved content change): the LAST APPROVED
// content (bounded, hash-bound) stays served labelled SUPERSEDED_PENDING
// until its replacement is approved. Hash-chained audit: skills/APPROVALS.jsonl.
export const SKILL_APPROVAL_STATES = Object.freeze(["STAGED", "AWAITING_APPROVAL", "APPROVED", "REVOKED"]);
/**
 * Post-publish approval record for a changed note.
 * oldApproval: previous manifest approval record (or null).
 * newContentHash: hash of the NEW content being recorded.
 */
export function nextApprovalRecord(oldApproval, newContentHash) {
  void newContentHash;
  const out = { state: "STAGED", resetAt: new Date().toISOString(), approvedHash: null };
  // Round-5 (Sol HOLD G3): the retained approved family must survive ANY
  // number of consecutive staging operations until an explicit approval or
  // revocation lands — through STAGED and AWAITING_APPROVAL alike. Retention
  // sources, strictly:
  // (a) the previous record was APPROVED → its approved fields MAY be the
  // family, but ONLY when the bytes hash-check to approvedHash (a corrupted
  // approved block is discarded, never retained);
  // (b) the previous record was STAGED or AWAITING_APPROVAL → an approval-
  // provenance family can NEVER be conjured from its own fields (an
  // AWAITING record's approvedContent has no proven APPROVED origin; adopting
  // it would invent approval). Retention ONLY continues an EXISTING previous
  // family: approvedHash must name previous.contentHash AND the retained
  // bytes must hash-check equal to it. (b) requires approvedHash to still
  // name the retained family AND the retained bytes to hash-check equal to
  // it — a corrupted retained family is dropped (serveApprovedContent would
  // refuse it anyway; propagating intact-by-construction is safer).
  const h = (s) => hashBytes(String(s ?? ""));
  // (a) APPROVED: the record's own approved block, hash-verified (Sol round-7:
  //     a corrupted approved block is discarded, never retained).
  const fromApproved =
    oldApproval && oldApproval.state === "APPROVED" && oldApproval.approvedContent && oldApproval.approvedHash
      && h(oldApproval.approvedContent) === String(oldApproval.approvedHash)
      ? { contentHash: String(oldApproval.approvedHash), content: oldApproval.approvedContent }
      : null;
  // (b) STAGED/AWAITING: continue ONLY an existing retained family — never
  // mint one from the record's own approval fields (approval provenance:
  // Sol round-7; an AWAITING record's approvedContent has no proven APPROVED
  // origin). approvedHash must name previous.contentHash AND the retained
  // bytes must hash-check equal to it.
  const fromPrevious =
    oldApproval && (oldApproval.state === "STAGED" || oldApproval.state === "AWAITING_APPROVAL")
      && oldApproval.approvedHash
      && oldApproval.previous && oldApproval.previous.content && oldApproval.previous.contentHash
      && oldApproval.approvedHash === oldApproval.previous.contentHash
      && h(oldApproval.previous.content) === oldApproval.previous.contentHash
      ? { contentHash: oldApproval.previous.contentHash, content: oldApproval.previous.content }
      : null;
  const prevFam = fromApproved ?? fromPrevious;
  if (prevFam) {
    // The retained approved version remains the only recall-eligible one
    // until the replacement is verified and explicitly approved.
    out.previous = prevFam;
    // approvedHash keeps pointing at the previously approved content hash
    // during supersession (serveApprovedContent's retained lane compares
    // prev.contentHash to approval.approvedHash). The explicit approve tool
    // stamps it to the NEW content hash on real approval.
    out.approvedHash = prevFam.contentHash;
  }
  return out;
}

export function defaultSkillsDir() { return join(process.cwd(), "skills"); }
export function manifestPath(dir = defaultSkillsDir()) { return join(dir, "PUBLISHED.json"); }

function hashBytes(s) { return createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex"); }
function shortHash(s) { return hashBytes(s).slice(0, 16); }

// ---------------------------------------------------------------- transport --
// Default transport: memory-hub panel data-plane proxy (same credential file
// and header pattern as lib/memorycore-client.mjs). Injectable for tests.
export function createHubProxyTransport({ hubBase = HUB_BASE, keyFile = KEY_FILE, serviceId = SERVICE_ID, timeoutMs = TIMEOUT_MS, gatewayApiKey = process.env.MEMORYCORE_GATEWAY_API_KEY ?? null, routeMode = process.env.MEMORYCORE_SKILL_ROUTE_MODE ?? "panel" } = {}) {
  const mapPath = routeMode === "direct" ? (p) => p.replace(/^\/api\/v1\//, "/v3/") : (p) => p;
  return async function proxyPost(path, body) {
    let key;
    try { key = readKeyAt(keyFile); } catch { return { status: 0, json: null, netReason: "KEY_READ" }; }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(hubBase + mapPath(path), {
        method: "POST",
        // Two auth layers, per the installed surface: hub-panel proxies need
        // only the user key header; a direct gateway (ephemeral test cores)
        // additionally needs `Authorization: Bearer <gateway key>`.
        headers: { "Content-Type": "application/json", "x-tdai-user-key": key, "x-tdai-service-id": serviceId,
          ...(gatewayApiKey ? { Authorization: `Bearer ${gatewayApiKey}` } : {}) },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      let json = null;
      try { json = await res.json(); } catch { /* non-json */ }
      return { status: res.status, json };
    } catch (err) {
      return { status: 0, json: null, netReason: String(err?.cause?.code ?? err?.name ?? err).slice(0, 40) };
    } finally { clearTimeout(timer); }
  };
}
function readKeyAt(keyFile) {
  if (!keyFile) throw new Error("MEMORYCORE_KEY_FILE not set");
  const t = readFileSync(keyFile, "utf8");
  const line = t.trim().split(/\r?\n/).pop().trim();
  if (!line) throw new Error("empty key file");
  return line;
}

// ------------------------------------------------------- head reads (panel) --
// The memory-hub panel data-plane proxy allow-list has NO get-by-name (live
// round 3, 2026-10-22: /api/v1/skill/get-by-name → 404 UNKNOWN_SKILL_ACTION);
// panel reads are composed from 'list' (exact name_prefix) + 'get' (skill_id).
// A direct-gateway transport (routeMode "direct") normally has get-by-name; a
// composed read against it fails safely via the list→exact-name match too.
export function createHeadReader(post) {
  return async function readHeadByName(identity, skillName, { includeContent = true } = {}) {
    // Paginate the list with a server-side name_prefix filter until absence
    // is PROVEN (Sol round-3: an incomplete lookup must be a typed failure,
    // never a silent missing:true). Prefix keeps pages exact-name-scoped.
    const PAGE = 50;
    let offset = 0, pages = 0, hit = null;
    while (hit === null) {
      const lr = await post("/api/v1/skill/list", { ...identity, filters: { name_prefix: skillName, status: ["active"] }, pagination: { limit: PAGE, offset } });
      if (lr.status === 0) return { ok: false, code: `NETWORK:${lr.netReason}` };
      const lp = lr.json ?? {};
      if (lp.code !== 0) return { ok: false, code: `CORE:${lp.code ?? lr.status}`, message: String(lp.message ?? "").slice(0, 120) };
      // Sol rd-8f: items MUST be an array; contradictory page/total counts and
      // an empty page with a claimed positive remainder are UNRELIABLE evidence
      // of absence — typed LIST_INDETERMINATE, never missing:true. A full page
      // with no total simply keeps paginating; a short page ends the scan.
      if (!Array.isArray(lp.data?.items)) return { ok: false, code: "LIST_INDETERMINATE" };
      const items = lp.data.items;
      hit = items.find((x) => String(x?.name ?? "") === String(skillName)) ?? null;
      const total = typeof lp.data?.total === "number" ? lp.data.total : null;
      if (total !== null && offset + items.length > total) return { ok: false, code: "LIST_INDETERMINATE" }; // page/total contradiction
      offset += items.length;
      pages++;
      if (hit) break;
      if (items.length === 0) {
        if (total !== null && total > offset) return { ok: false, code: "LIST_INDETERMINATE" }; // empty page, positive remainder
        return { ok: true, missing: true };
      }
      if (total !== null && offset >= total) return { ok: true, missing: true };
      if (total === null && items.length < PAGE) return { ok: true, missing: true };
      if (pages > 50) return { ok: false, code: "LIST_INDETERMINATE" };
    }
    if (!includeContent) return { ok: true, missing: false, head: hit, provenance: hit.metadata ?? null, content: null };
    const gr = await post("/api/v1/skill/get", { ...identity, skill_id: hit.skill_id, include_content: true });
    if (gr.status === 0) return { ok: false, code: `NETWORK:${gr.netReason}` };
    const gp = gr.json ?? {};
    if (gp.code !== 0) return { ok: false, code: `CORE:${gp.code ?? gr.status}`, message: String(gp.message ?? "").slice(0, 120) };
    const d = gp.data ?? {};
    // list→get race guard: the fetched head must still be the skill we matched
    if (String(d.skill_id ?? "") !== String(hit.skill_id) || String(d.name ?? "") !== String(hit.name)) {
      return { ok: false, code: "GET_MISMATCH" };
    }
    return { ok: true, missing: false, head: d, provenance: d.metadata ?? null, content: typeof d.content === "string" ? d.content : null };
  };
}

// ------------------------------------------------------------------- notes --
// Parse a kit skill note file (frontmatter + body, as produced by skill-harvest).
export function parseNoteFile(raw) {
  const text = String(raw ?? "");
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!m) return { ok: false, reason: "no frontmatter" };
  const fm = {};
  for (const line of m[1].split("\n")) {
    const kv = /^(\w[\w-]*):\s*(.*)$/.exec(line.trim());
    if (!kv) continue;
    let v = kv[2].trim();
    if (v.startsWith("[") && v.endsWith("]")) v = v.slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean);
    fm[kv[1].toLowerCase()] = v;
  }
  return { ok: true, fm, body: m[2] ?? "" };
}

// Remote skill name: lowercased slug of the note id (core regex
// ^[a-z0-9][a-z0-9-]*$, ≤64 bytes). Returns null when no valid slug exists.
export function skillNameFromNoteId(noteId) {
  const slug = String(noteId ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
  if (!slug || !/^[a-z0-9][a-z0-9-]*$/.test(slug) || Buffer.byteLength(slug, "utf8") > 64) return null;
  return slug;
}

// Compose the published SKILL.md content for a note. Description is the H1
// title line (or note title in fm), max 200 chars.
export function composeSkillContent({ noteId, skillName, fm, body }) {
  const title = /^#\s+(.+)$/m.exec(String(body ?? ""))?.[1]?.trim() ?? String(fm.title ?? noteId);
  const desc = title.slice(0, 200);
  const tags = Array.isArray(fm.tags) ? fm.tags : [];
  const lines = [
    "---",
    `name: ${skillName ?? noteId}`,
    `description: ${desc}`,
    tags.length ? `tags: [${tags.join(", ")}]` : null,
    "---",
    "",
  ].filter((l) => l !== null);
  const content = lines.join("\n") + String(body ?? "").trim() + "\n";
  // memorycore name cap is 64 — kit note ids are short, guard anyway
  if (Buffer.byteLength(noteId, "utf8") > 64) return { ok: false, reason: "note id exceeds 64-byte skill name cap" };
  return { ok: true, content, contentHash: shortHash(content), fullHash: hashBytes(content), title: desc };
}

// ---------------------------------------------------------------- publisher --
export function createSkillPublisher(opts = {}) {
  const post = opts.post ?? createHubProxyTransport({ gatewayApiKey: opts.gatewayApiKey, routeMode: opts.routeMode, hubBase: opts.hubBase, keyFile: opts.keyFile });
  const skillsDir = opts.skillsDir ?? defaultSkillsDir();
  const readHead = createHeadReader(post);
  const identity = {
    team_id: opts.teamId ?? TEAM, agent_id: opts.agentId ?? AGENT, owner_user_id: opts.owner ?? OWNER,
  };
  function loadManifest() {
    const p = manifestPath(skillsDir);
    if (!existsSync(p)) return { schema: 1, updatedAt: null, notes: {} };
    try { return JSON.parse(readFileSync(p, "utf8")); } catch { return { schema: 1, updatedAt: null, notes: {} }; }
  }
  function saveManifest(m) {
    m.schema = 1;
    m.updatedAt = new Date().toISOString();
    writeFileSync(manifestPath(skillsDir), JSON.stringify(m, null, 2) + "\n");
  }

  async function getHead(skillName) {
    return readHead(identity, skillName, { includeContent: true });
  }

  function provenanceOk(meta, noteId) {
    return !!meta
      && meta.source === SKILL_SOURCE
      && String(meta.kitNoteId ?? "") === String(noteId);
  }

  // Publish one note. Returns a typed receipt. NEVER throws.
  async function publishNote(note, { dry = false } = {}) {
    const { noteId, fm, body } = note;
    const base = { noteId };
    const skip = (action, code) => ({ ...base, action, code });
    // Ticket 776 §4: skills missing provenance/evidence stay QUARANTINED —
    // a note that cannot name its supporting evidence is never published,
    // so it can never reach recall.
    if (!String(fm?.evidence ?? "").trim()) return skip("refused", "QUARANTINE_NO_EVIDENCE");
    if (!String(fm?.sourcerun ?? fm?.sourceRun ?? "").trim()) return skip("refused", "QUARANTINE_NO_SOURCE_RUN");
    const skillName = skillNameFromNoteId(noteId);
    if (!skillName) return skip("refused", "BAD_SKILL_NAME (no valid lowercase slug)");
    const composed = composeSkillContent({ noteId, skillName, fm, body });
    if (!composed.ok) return skip("refused", "COMPOSE_FAILED");
    const meta = {
      source: SKILL_SOURCE,
      kitNoteId: noteId,
      sourceRun: String(fm.sourcerun ?? fm.sourceRun ?? ""),
      evidence: String(fm.evidence ?? ""),
      contentHash: composed.fullHash,
      publishedAt: new Date().toISOString(),
    };

    const head = await getHead(skillName);
    if (!head.ok) return skip("failed", head.code);
    if (head.missing) {
      if (dry) return { ...base, skillName, action: "would-create", bytes: Buffer.byteLength(composed.content, "utf8") };
      const r = await post("/api/v1/skill/create", { ...identity, name: skillName, content: composed.content, metadata: meta });
      if (r.status === 0) return skip("failed", `NETWORK:${r.netReason}`);
      const p = r.json ?? {};
      if (p.code === 0) {
        const d = p.data ?? {};
        return { ...base, skillName, action: "created", skillId: d.skill_id, version: d.version, contentHash: composed.fullHash };
      }
      return { ...base, action: "failed", code: `CORE:${p.code}`, message: String(p.message ?? "").slice(0, 120) };
    }

    if (!provenanceOk(head.provenance, noteId)) {
      const src = head.provenance?.source ?? "<none>";
      return skip("refused", `FOREIGN_NAMESPACE source=${src}`);
    }
    // Sol round-3: without live content we cannot prove change state — never
    // update blind on metadata alone.
    if (typeof head.content !== "string") return skip("failed", "HEAD_CONTENT_MISSING");
    const headLive = head.content;
    if (headLive === composed.content) {        return { ...base, skillName, action: "noop-identical", skillId: head.head.skill_id, version: head.head.version, contentHash: composed.fullHash };
    }
    if (dry) { return { ...base, skillName, action: "would-update", skillId: head.head.skill_id, version: head.head.version, bytes: Buffer.byteLength(composed.content, "utf8") }; }
    return await updateWithRetry({ noteId, skillName, composed, head });
  }

  async function updateWithRetry({ noteId, skillName, composed, head }) {
    const attempt = async (expectedVersion) =>
      post("/api/v1/skill/update", { ...identity, skill_id: head.head.skill_id, expected_version: expectedVersion, content: composed.content });
    let r = await attempt(head.head.version);
    if (r.status === 0) return { noteId, action: "failed", code: `NETWORK:${r.netReason}` };
    let p = r.json ?? {};
    if (p.code === 40901) {
      // Sol safeguard 3: one re-read + one retry, gated on provenance AND
      // content state we based the decision on.
      const again = await getHead(skillName);
      if (!again.ok || again.missing) return { noteId, action: "failed", code: "RECHECK_FAILED" };
      if (!provenanceOk(again.provenance, noteId)) return { noteId, action: "refused", code: "FOREIGN_NAMESPACE (recheck)" };
      // Sol round-4: IDENTITY first — the rechecked head must be the very skill
      // we based the change decision on, before any success path.
      if (String(again.head?.skill_id ?? "") !== String(head.head?.skill_id ?? "")) {
        return { noteId, skillName, action: "refused", code: `CONFLICT_CONTENT_DRIFT (head v${again.head?.version} vs decision v${head.head?.version})` };
      }
      if (typeof again.content === "string" && again.content === composed.content) {
        // content byte-equals what we would have published — a receipt WITH the
        // hash, so manifest bookkeeping stays well-formed (Sol round-4).
        return { noteId, skillName, action: "noop-identical", skillId: again.head.skill_id, version: again.head.version, contentHash: composed.fullHash };
      }
      // Sol round-3: retry is only authorised against the EXACT content state
      // we based the change decision on — byte-equal.
      if (typeof again.content !== "string"
        || again.content !== head.content) {
        return { noteId, skillName, action: "refused", code: `CONFLICT_CONTENT_DRIFT (head v${again.head?.version} vs decision v${head.head?.version})` };
      }
      if ((again.head?.updated_at_ms ?? null) !== (head.head?.updated_at_ms ?? null)
        || (again.head?.version ?? null) !== (head.head?.version ?? null)) {
        // another writer moved the skill between our read and retry → refuse
        return { noteId, action: "refused", code: `CONFLICT concurrent change (head v${again.head?.version})` };
      }
      r = await attempt(again.head.version);
      if (r.status === 0) return { noteId, action: "failed", code: `NETWORK:${r.netReason}` };
      p = r.json ?? {};
    }
    if (p.code === 0) {
      const d = p.data ?? {};
      return { noteId, skillName, action: "updated", skillId: d.skill_id ?? head.head.skill_id, version: d.version, contentHash: composed.fullHash };
    }
    return { noteId, action: "failed", code: `CORE:${p.code ?? r.status}`, message: String(p.message ?? "").slice(0, 120) };
  }

  // Publish selected notes.
  // select: "all" | array of note ids. Stale notes (fm.stale true) are skipped
  // under "all" unless explicitly named.
  // Ticket 776 §4: created/updated notes land STAGED in the manifest approval
  // control-plane; they stay recall-ineligible until tools/skill-approve.
  async function publish({ select = "all", dry = false } = {}) {
    const files = readdirSync(skillsDir).filter((f) => f.startsWith("S-") && f.endsWith(".md")).sort();
    const targets = [];
    for (const f of files) {
      const parsed = parseNoteFile(readFileSync(join(skillsDir, f), "utf8"));
      const id = (typeof parsed?.fm?.id === "string" ? parsed.fm.id : null) ?? parsed?.fm?.id;
      if (!parsed.ok || !parsed.fm?.id) continue;
      const note = { noteId: String(parsed.fm.id), fm: parsed.fm, body: parsed.body, file: f };
      if (Array.isArray(select)) { if (select.includes(note.noteId)) targets.push(note); continue; }
      if (parsed.fm.stale === true || parsed.fm.stale === "true") continue; // stale excluded (V3.3.5 invariant)
      targets.push(note);
    }
    const receipts = [];
    for (const note of targets) {
      let receipt;
      try { receipt = await publishNote(note, { dry }); }
      catch (err) { receipt = { noteId: note.noteId, action: "failed", code: "UNEXPECTED", message: String(err?.message ?? err).slice(0, 120) }; }
      receipts.push(receipt);
    }
    // manifest bookkeeping from ACTUAL successes only
    if (!dry && receipts.some((r) => r.action === "created" || r.action === "updated" || r.action === "noop-identical")) {
      const m = loadManifest();
      for (const r of receipts) {
        if (r.action === "created" || r.action === "updated") {
          const old = m.notes[r.noteId];
          m.notes[r.noteId] = {
            skillName: r.skillName, contentHash: r.contentHash, skillId: r.skillId, version: r.version,
            publishedAt: old?.publishedAt ?? new Date().toISOString(),
            approval: nextApprovalRecord(old?.approval ?? null, r.contentHash),
          };
        } else if (r.action === "noop-identical" && m.notes[r.noteId]) {
          m.notes[r.noteId].skillId = r.skillId;
          m.notes[r.noteId].version = r.version;
          // content byte-verified identical this publish — keep the manifest
          // hash aligned with the live-verified value. An existing APPROVAL
          // stays INTACT (idempotent content); a STAGED/AWAITING note stays non-
          // approved (approval tracks the hash, not the metadata round).
          if (m.notes[r.noteId].approval?.approvedHash && m.notes[r.noteId].approval.approvedHash !== r.contentHash) {
            m.notes[r.noteId].approval.state = "STAGED"; // hash drift under an approval state is impossible here, keep fail-closed
          }
          m.notes[r.noteId].contentHash = r.contentHash;
        }
      }
      saveManifest(m);
    }
    return { ok: receipts.every((r) => r.action !== "failed" && r.action !== "refused"), dry, receipts, counts: countReceipts(receipts) };
  }

  function countReceipts(receipts) {
    const counts = {};
    for (const r of receipts) counts[r.action] = (counts[r.action] ?? 0) + 1;
    return counts;
  }

  return { identity, publish, publishNote, getHead, loadManifest };
}

// ----------------------------------------------------- approved-skills read --
// Recall-read path (Sol safeguard 3 + ticket 776 §4 activation boundary): a
// skill is served ONLY when ALL of these hold —
//   (a) it is in the publisher manifest,
//   (b) present under the dedicated agent with publisher provenance,
//   (c) content integrity proven by hash,
//   (d) manifest approval.state === "APPROVED" for the EXACT contentHash being
//       served (live head or the retained previously-approved bytes on
//       supersession, labelled SUPERSEDED_PENDING),
// The MemoryCore head status field is advisory only; this boundary decides.
export function loadApprovedSkills(opts = {}) {
  const skillsDir = opts.skillsDir ?? defaultSkillsDir();
  const p = opts.post ?? createHubProxyTransport({ gatewayApiKey: opts.gatewayApiKey, routeMode: opts.routeMode, hubBase: opts.hubBase, keyFile: opts.keyFile });
  const identity = {
    team_id: opts.teamId ?? TEAM, agent_id: opts.agentId ?? AGENT,
  };
  return async function approvedSkills({ topN = 6, budgetBytes = 4000, namePrefix } = {}) {
    const mp = manifestPath(skillsDir);
    if (!existsSync(mp)) return { ok: true, skills: [], bytesUsed: 0, skipped: 0, reason: "nothing published yet" };
    let m;
    try { m = JSON.parse(readFileSync(mp, "utf8")); } catch { return { ok: false, code: "MANIFEST_UNREADABLE" }; }
    const readHead = createHeadReader(p);
    const entries = Object.entries(m.notes ?? {}).slice(0, 64);
    const out = [];
    let bytes = 0, skipped = 0;
    const skipReasons = [];
    for (const [noteId, rec] of entries) {
      if (out.length >= topN) break;
      if (namePrefix && !noteId.startsWith(namePrefix)) continue;
      const approval = rec.approval ?? (rec.approvedAt ? { state: "STAGED", resetAt: null } : { state: "STAGED" });
      // legacy manifests (no approval field anywhere, i.e. pre-issue-776):
      // migrate to STAGED unless the manifest was explicitly stamped by the
      // skill-approve tool ( APPROVED carry state.rec ). Missing approval =
      // fail-closed STAGED, never silently eligible.
      if (approval.state === "APPROVED" && !approval.approvedHash) { skipped++; skipReasons.push(`${noteId}: approval-record-missing-hash`); continue; }
      const rider = await serveApprovedContent(rec, approval, noteId, identity, readHead);
      if (rider.skip) { skipped++; skipReasons.push(rider.reason); continue; }
      const b = Buffer.byteLength(rider.content, "utf8");
      if (bytes + b > budgetBytes) { break; } // budget is a hard stop, not a truncation
      bytes += b;
      out.push({ name: noteId, skillName: rec.skillName ?? skillNameFromNoteId(noteId), skillId: rider.skillId, version: rider.version, title: String(rider.title ?? noteId).slice(0, 200), content: rider.content, bytes: b, approvalState: rider.approvalState ?? approval.state });
    }
    return { ok: true, skills: out, bytesUsed: bytes, skipped, skipReasons };
  };
}

// Internal serving guard for one manifest entry (ticket 776 §4). Resolves the
// bytes that may be served under a given approval record and runs every
// integrity/provenance check; return { skip:true, reason } when the entry is
// not eligible.
async function serveApprovedContent(rec, approval, noteId, identity, readHead) {
  if (approval.state === "REVOKED") return { skip: true, reason: `${noteId}: revoked` };
  const skillName = rec.skillName ?? skillNameFromNoteId(noteId);
  if (!skillName) return { skip: true, reason: `${noteId}: no-slug` };
  // Supersession lane: a previously APPROVED content (approval.approvedHash +
  // integrity-retained bytes) stays recall-eligible, labelled
  // SUPERSEDED_PENDING, while the NEW head content is STAGED/unverified. The
  // unverified bytes are NEVER served — the boundary decides, not the head.
  const prev = approval.previous ?? null;
  const prevIntact = prev?.content && prev?.contentHash
    && hashBytes(String(prev.content)) === String(prev.contentHash)
    && String(prev.contentHash) === String(approval.approvedHash ?? "");
  if (approval.state !== "APPROVED" && !prevIntact) return { skip: true, reason: `${noteId}: not-approved (${approval.state})` };
  const head = await readHead(identity, skillName, { includeContent: true });
  if (!head.ok || head.missing) return { skip: true, reason: `${noteId}: fetch/${head.ok ? "40401" : head.code}` };
  const d = head.head ?? {};
  const prov = head.provenance ?? d.metadata ?? {};
  if (prov.source !== SKILL_SOURCE || String(prov.kitNoteId ?? "") !== noteId) return { skip: true, reason: `${noteId}: provenance/${String(prov.source ?? "none")}` };
  const live = String(head.content ?? "");
  const liveHash = hashBytes(live);
  if (approval.state === "APPROVED" && liveHash === String(approval.approvedHash ?? "")) {
    // exactly the approved bytes, live — serve
    return { content: live, skillId: d.skill_id ?? rec.skillId, version: d.version, title: String(d.description ?? noteId).slice(0, 200), approvalState: "APPROVED" };
  }
  if (prevIntact) {
    return { content: String(prev.content), skillId: d.skill_id ?? rec.skillId, version: d.version, title: String(d.description ?? noteId).slice(0, 200), approvalState: "SUPERSEDED_PENDING" };
  }
  return { skip: true, reason: `${noteId}: approved-hash/live drift (fail-closed)` };
}
// The unverified head bytes are intentionally UNREACHABLE here: if head drifts
// away from the approved hash and no retained approved bytes exist, the entry
// drops out of recall until the operator re-publishes and re-approves.
